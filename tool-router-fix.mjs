import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { generateText } from './ai-runtime.mjs';

const dbPath = process.env.DB_PATH || './data/sq-ai.sqlite';
let db; try { db = new Database(dbPath); db.pragma('busy_timeout=5000'); } catch {}
const mediaDir = path.join(path.dirname(path.resolve(dbPath)), 'generated-media');
fs.mkdirSync(mediaDir, {recursive:true});
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
function cookies(req){const out={};for(const p of String(req.headers.cookie||'').split(';')){const i=p.indexOf('=');if(i>0){try{out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1))}catch{}}}return out;}
function getUser(req){const c=cookies(req).sqai_session;if(c&&db){const s=db.prepare("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>datetime('now')").get(hash(c));if(s)return db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id)}const k=req.get('x-api-key');return k&&db?db.prepare('SELECT u.* FROM users u JOIN api_keys a ON a.user_id=u.id WHERE a.key=?').get(k)||null:null;}
function charge(id,endpoint){if(!db)return false;return db.transaction(()=>{const r=db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>0').run(id);if(!r.changes)return false;db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(id,endpoint);return true})()}
function refund(id,endpoint){if(!db)return;db.transaction(()=>{db.prepare('UPDATE users SET credits=credits+1 WHERE id=?').run(id);db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(id,`${endpoint}:refunded`)})()}
async function fetchBuf(url,opt={},timeout=120000){const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);try{const r=await fetch(url,{...opt,signal:c.signal});const buf=Buffer.from(await r.arrayBuffer());if(!r.ok)throw Object.assign(new Error(`provider_http_${r.status}`),{status:r.status});return {r,buf};}catch(e){if(e?.name==='AbortError')throw Object.assign(new Error('provider_timeout'),{status:504});throw e}finally{clearTimeout(t)}}
function saveAudio(buf,ext='mp3'){if(!buf?.length)throw Object.assign(new Error('audio_output_empty'),{status:502});if(buf.length>30*1024*1024)throw Object.assign(new Error('audio_output_too_large'),{status:502});const name=`audio-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;fs.writeFileSync(path.join(mediaDir,name),buf);return `/generated-media/${name}`;}
function pcmToWav(pcm,sampleRate=24000,channels=1,bits=16){const blockAlign=channels*bits/8,byteRate=sampleRate*blockAlign,header=Buffer.alloc(44);header.write('RIFF',0);header.writeUInt32LE(36+pcm.length,4);header.write('WAVE',8);header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(channels,22);header.writeUInt32LE(sampleRate,24);header.writeUInt32LE(byteRate,28);header.writeUInt16LE(blockAlign,32);header.writeUInt16LE(bits,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);return Buffer.concat([header,pcm]);}
function findAudio(value){if(!value)return null;if(typeof value==='string')return value;if(Array.isArray(value)){for(const x of value){const f=findAudio(x);if(f)return f}return null}if(typeof value==='object'){if(value.type==='audio'&&value.data)return value.data;return findAudio(value.data)||findAudio(value.output_audio)||findAudio(value.content)||findAudio(value.steps)}return null;}
async function geminiTts(text,voice='Kore'){const key=process.env.GEMINI_API_KEY;if(!key)throw Object.assign(new Error('gemini_tts_not_configured'),{status:503});const model=process.env.GEMINI_TTS_MODEL||'gemini-3.1-flash-tts-preview';const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/interactions`,{method:'POST',headers:{'x-goog-api-key':key,'Api-Revision':'2026-05-20','Content-Type':'application/json'},body:JSON.stringify({model,input:text,response_format:{type:'audio'},generation_config:{speech_config:[{voice}]}})});const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(d?.error?.message||`gemini_tts_${r.status}`),{status:r.status});const b64=findAudio(d);if(!b64)throw Object.assign(new Error('gemini_tts_audio_missing'),{status:502});return{audio_url:saveAudio(pcmToWav(Buffer.from(b64,'base64')),'wav'),provider:'google-gemini-tts',model};}
async function elevenTts(text,voice){const key=process.env.ELEVENLABS_API_KEY;if(!key)throw Object.assign(new Error('elevenlabs_not_configured'),{status:503});const id=voice||process.env.ELEVENLABS_VOICE_ID||'JBFqnCBsd6RMkjVDRZzb';const model=process.env.ELEVENLABS_MODEL||'eleven_multilingual_v2';const url=`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_44100_128`;const {buf}=await fetchBuf(url,{method:'POST',headers:{'xi-api-key':key,'Content-Type':'application/json'},body:JSON.stringify({text,model_id:model})},180000);return{audio_url:saveAudio(buf,'mp3'),provider:'elevenlabs',model};}
const VOICE_TOOLS=new Set(['voiceover']);
const TEXT_ONLY_TOOLS=new Set(['subtitles','translation','resize','silence','noise']);
const originalPost=express.application.post;
if(!express.application.__sqaiToolRouterFix){
  express.application.__sqaiToolRouterFix=true;
  express.application.post=function(route,...handlers){
    if(route==='/api/tools/generate'&&handlers.length){
      const wrapped=async function(req,res,next){
        const raw=String(req.body?.tool||'').trim();
        const tool={video_script:'script-video',ad_video:'ad-video',product_video:'product-video',shorts:'reels',long_to_shorts:'long-shorts',hooks:'hooks-video'}[raw]||raw;
        const prompt=String(req.body?.prompt??req.body?.input??'').trim().slice(0,12000);
        const u=req.user?.id?req.user:getUser(req);
        if(!u||!prompt)return handlers[handlers.length-1](req,res,next);
        if(VOICE_TOOLS.has(tool)){
          if(!charge(u.id,`tool:${tool}`))return res.status(402).json({error:'credits_exhausted'});
          try{
            const voice=String(req.body?.voice||'').trim()||undefined;
            const d=process.env.ELEVENLABS_API_KEY?await elevenTts(prompt,voice):await geminiTts(prompt,voice||'Kore');
            const fresh=db.prepare('SELECT credits FROM users WHERE id=?').get(u.id);
            return res.json({ok:true,result:d.audio_url,audio_url:d.audio_url,provider:d.provider,model:d.model,credits_remaining:fresh?.credits??0});
          }catch(e){refund(u.id,`tool:${tool}`);return res.status(Number(e?.status||502)).json({error:e?.message||'voice_generation_failed',message:'تعذر إنشاء الصوت وتم إرجاع الـCredit.'});}
        }
        if(TEXT_ONLY_TOOLS.has(tool)){
          if(!charge(u.id,`tool:${tool}`))return res.status(402).json({error:'credits_exhausted'});
          try{
            const language=String(req.body?.language||'English').slice(0,50);
            const task=tool==='subtitles'?'Create accurate subtitles/captions for the supplied content, with natural line breaks and timing-ready segments.':tool==='translation'?'Translate the supplied content accurately while preserving meaning, tone, names and formatting.':tool==='resize'?'Create a precise resize/reformat specification for the supplied media, including target aspect ratio, dimensions, safe areas and cropping guidance.':tool==='silence'?'Create an exact editing specification for removing silence, pauses and dead air while preserving natural speech.':'Create an exact audio cleanup specification for reducing noise while preserving speech and music quality.';
            const result=await generateText({capability:'text',messages:[{role:'system',content:`You are SQ AI's ${tool} tool. ${task} Return only the finished usable result. Language: ${language}.`},{role:'user',content:prompt}]});
            if(!result?.text?.trim())throw Object.assign(new Error('ai_empty_result'),{status:502});
            const fresh=db.prepare('SELECT credits FROM users WHERE id=?').get(u.id);
            return res.json({ok:true,result:result.text,provider:result.provider,model:result.model,credits_remaining:fresh?.credits??0});
          }catch(e){refund(u.id,`tool:${tool}`);return res.status(Number(e?.status||502)).json({error:e?.code||'tool_generation_failed',message:'فشل المولد وتم إرجاع الـCredit.'});}
        }
        return handlers[handlers.length-1](req,res,next);
      };
      return originalPost.call(this,route, ...handlers.slice(0,-1), wrapped);
    }
    return originalPost.call(this,route,...handlers);
  };
}
console.log('SQ AI Tool Router loaded: voice + text/edit tools routed to real generators');
