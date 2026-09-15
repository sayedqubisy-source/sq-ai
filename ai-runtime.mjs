import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { AI_PROVIDERS, ROUTE_POLICY, chooseProvider } from './ai-provider-registry.mjs';
const db=new Database(process.env.DB_PATH||'./data/sq-ai.sqlite');db.pragma('busy_timeout=5000');db.pragma('journal_mode=WAL');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fail=(code,status=502,message=code)=>Object.assign(new Error(message),{code,status});
function text(v){
  if(v==null)return '';
  if(typeof v==='string')return v.trim();
  if(typeof v==='number'||typeof v==='boolean')return String(v);
  if(Array.isArray(v))return v.map(text).filter(Boolean).join('\n').trim();
  if(typeof v==='object'){
    const preferred=['text','content','value','output_text','generated_text','response','answer','message','parts','output'];
    for(const k of preferred){const out=text(v[k]);if(out)return out}
  }
  return '';
}
function extractResponse(d){
  const candidates=[
    d?.choices?.[0]?.message?.content,
    d?.choices?.[0]?.message?.text,
    d?.choices?.[0]?.message,
    d?.choices?.[0]?.text,
    d?.output_text,
    d?.output,
    d?.response,
    d?.answer,
    d?.generated_text,
    d?.candidates?.[0]?.content?.parts,
    d?.candidates?.[0]?.content,
    d?.candidates?.[0]?.text,
    d?.content,
    d?.text
  ];
  for(const c of candidates){const out=text(c);if(out)return out}
  return '';
}
async function req(url,opt={},timeout=90000){const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);try{return await fetch(url,{...opt,signal:c.signal})}catch(e){if(e?.name==='AbortError')throw fail('ai_provider_timeout',504);throw e}finally{clearTimeout(t)}}
const cookieReq=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return[i<0?x:x.slice(0,i),i<0?'':decodeURIComponent(x.slice(i+1))]}));
const hash=t=>crypto.createHash('sha256').update(t).digest('hex');
function user(req){const c=cookieReq(req).sqai_session;if(c){const s=db.prepare("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>datetime('now')").get(hash(c));if(s)return db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id)}const k=req.get('x-api-key');return k&&k.length<=200?db.prepare('SELECT u.* FROM users u JOIN api_keys a ON a.user_id=u.id WHERE a.key=?').get(k)||null:null}
const compat={openrouter:['OPENROUTER_API_KEY','https://openrouter.ai/api/v1',()=>process.env.OPENROUTER_MODEL||'openrouter/free'],openai:['OPENAI_API_KEY','https://api.openai.com/v1',()=>process.env.OPENAI_MODEL||'gpt-5-mini'],deepseek:['DEEPSEEK_API_KEY','https://api.deepseek.com/v1',()=>process.env.DEEPSEEK_MODEL||'deepseek-chat'],groq:['GROQ_API_KEY','https://api.groq.com/openai/v1',()=>process.env.GROQ_MODEL||'llama-3.3-70b-versatile'],mistral:['MISTRAL_API_KEY','https://api.mistral.ai/v1',()=>process.env.MISTRAL_MODEL||'mistral-small-latest'],together:['TOGETHER_API_KEY','https://api.together.xyz/v1',()=>process.env.TOGETHER_MODEL||'meta-llama/Llama-3.3-70B-Instruct-Turbo'],fireworks:['FIREWORKS_API_KEY','https://api.fireworks.ai/inference/v1',()=>process.env.FIREWORKS_MODEL||'accounts/fireworks/models/llama-v3p1-70b-instruct']};
const supportedProviders=new Set(Object.keys(compat).concat(['gemini','anthropic']));
const textCapabilities=new Set(['text','reasoning','coding']);
async function compatible(id,messages,model){const [env,base,def]=compat[id],key=process.env[env];if(!key)throw fail(id+'_not_configured');const m=model||def();let last;for(let a=0;a<2;a++){try{const h={Authorization:`Bearer ${key}`,'Content-Type':'application/json','X-Title':'SQ AI'};if(id==='openrouter')h['HTTP-Referer']=process.env.APP_URL||'http://localhost:3000';const r=await req(`${base}/chat/completions`,{method:'POST',headers:h,body:JSON.stringify({model:m,messages,stream:false})});const d=await r.json().catch(()=>({}));if(r.ok){const out=extractResponse(d);if(out)return{text:out,provider:id,model:m,usage:d?.usage||null};console.error(`[SQ AI] ${id} empty response shape:`,JSON.stringify({keys:Object.keys(d||{}),choiceKeys:Object.keys(d?.choices?.[0]||{}),messageKeys:Object.keys(d?.choices?.[0]?.message||{})}).slice(0,2000));last=fail('ai_empty_result',502,`${id} returned an empty response`)}else{last=fail(id+'_request_failed',r.status,d?.error?.message||d?.message||'Provider request failed')}}catch(e){last=e}if(a===0)await sleep(500)}throw last||fail('ai_provider_failed')}
async function gemini(messages,model){const key=process.env.GEMINI_API_KEY;if(!key)throw fail('gemini_not_configured');const m=model||process.env.GEMINI_MODEL||'gemini-2.5-flash';const contents=messages.filter(x=>x.role!=='system').map(x=>({role:x.role==='assistant'?'model':'user',parts:[{text:String(x.content||'')}]}));const system=messages.filter(x=>x.role==='system').map(x=>String(x.content||'')).join('\n');if(system)contents.unshift({role:'user',parts:[{text:system}]});const r=await req(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents,generationConfig:{temperature:0.7,maxOutputTokens:4096}})});const d=await r.json().catch(()=>({}));if(!r.ok)throw fail('gemini_request_failed',r.status,d?.error?.message||'Gemini request failed');const out=extractResponse(d);if(!out)throw fail('ai_empty_result',502,'Gemini returned an empty response');return{text:out,provider:'gemini',model:m,usage:d?.usageMetadata||null}}
async function anthropic(messages,model){const key=process.env.ANTHROPIC_API_KEY;if(!key)throw fail('anthropic_not_configured');const m=model||process.env.ANTHROPIC_MODEL||'claude-3-5-haiku-latest';const system=messages.filter(x=>x.role==='system').map(x=>x.content).join('\n');const body={model:m,max_tokens:4096,messages:messages.filter(x=>x.role!=='system').map(x=>({role:x.role==='assistant'?'assistant':'user',content:String(x.content||'')}))};if(system)body.system=system;const r=await req('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw fail('anthropic_request_failed',r.status,d?.error?.message||'Anthropic request failed');const out=extractResponse(d);if(!out)throw fail('ai_empty_result',502,'Anthropic returned an empty response');return{text:out,provider:'anthropic',model:m,usage:d?.usage||null}}
async function invoke(id,msgs,model){if(!supportedProviders.has(id))throw fail('provider_not_supported',501);if(compat[id])return compatible(id,msgs,model);if(id==='gemini')return gemini(msgs,model);if(id==='anthropic')return anthropic(msgs,model);throw fail('provider_not_supported',501)}
export async function generateText({messages,model,capability='text'}){if(!Array.isArray(messages)||!messages.length)throw fail('messages_required',400);const cap=String(capability||'text').trim().toLowerCase();if(!textCapabilities.has(cap))throw fail('text_capability_required',400,'This text endpoint supports text, reasoning, or coding only.');const p=chooseProvider(cap,process.env);const ids=[...(ROUTE_POLICY[cap]||ROUTE_POLICY.text)];if(p)ids.unshift(p.id);const candidates=[...new Set(ids)].filter(id=>supportedProviders.has(id)&&AI_PROVIDERS.some(x=>x.id===id&&x.env&&process.env[x.env]));if(!candidates.length)throw fail('no_ai_provider_configured',503,'No supported AI provider is configured.');let last;for(const id of candidates){try{return await invoke(id,messages,id===p?.id?model:undefined)}catch(e){last=e;console.error(`SQ AI provider ${id} failed:`,e?.code||e?.message||e)}}throw last||fail('all_ai_providers_failed',503)}
function reserve(id,ep){return db.transaction(()=>{const r=db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>0').run(id);if(!r.changes)return false;db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(id,ep+':reserved');return true})()}
function refund(id,ep){db.transaction(()=>{db.prepare('UPDATE users SET credits=credits+1 WHERE id=?').run(id);db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(id,ep+':refunded')})()}
export function installAiRuntime(app){app.post('/api/ai/generate',async(req,res)=>{const u=user(req);if(!u)return res.status(401).json({error:'authentication_required'});const prompt=String(req.body?.prompt||'').trim().slice(0,12000);if(!prompt)return res.status(400).json({error:'prompt_required'});const ep='/api/ai/generate';if(!reserve(u.id,ep))return res.status(402).json({error:'insufficient_credits'});try{const result=await generateText({capability:String(req.body?.capability||'text'),messages:[{role:'system',content:String(req.body?.system||'You are SQ AI. Answer accurately and clearly.').slice(0,4000)},{role:'user',content:prompt}],model:req.body?.model?String(req.body.model).slice(0,160):undefined});db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(u.id,`${ep}:${result.provider}:${result.model}`);const fresh=db.prepare('SELECT credits FROM users WHERE id=?').get(u.id);res.json({ok:true,result:result.text,provider:result.provider,model:result.model,credits_charged:1,credits_remaining:fresh?.credits??null})}catch(e){refund(u.id,ep);const s=Number.isInteger(e?.status)?e.status:502;res.status(s).json({error:e?.code||'ai_generation_failed',message:e?.message||'AI generation failed. Your credit was refunded.',credits_refunded:true})}});app.get('/api/ai/runtime',(req,res)=>{const configured=AI_PROVIDERS.filter(p=>p.env&&supportedProviders.has(p.id)&&process.env[p.env]).map(p=>({id:p.id,name:p.name,capabilities:p.capabilities}));res.json({ok:true,strategy:'automatic-provider-fallback',configuredProviders:configured,count:configured.length,supportedProviders:[...supportedProviders],textCapabilities:[...textCapabilities]})})}
