import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
const dbPath=process.env.DB_PATH||'./data/sq-ai.sqlite';
const mediaDir=path.join(path.dirname(path.resolve(dbPath)),'generated-media');
const db=new (await import('better-sqlite3')).default(dbPath);
const hashToken=token=>crypto.createHash('sha256').update(token).digest('hex');
function cookies(req){const out={};for(const part of(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i!==-1){try{out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim())}catch{}}}return out}
function authorized(req){const token=cookies(req).sqai_session;if(token){const s=db.prepare("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at > datetime('now')").get(hashToken(token));if(s)return true}const key=req.get('x-api-key');return !!(key&&key.length<=200&&db.prepare('SELECT 1 FROM api_keys WHERE key=?').get(key));}
const router=express.Router();
router.get('/generated-media/:file',(req,res)=>{if(!authorized(req))return res.status(401).json({error:'authentication_required'});const file=path.basename(req.params.file);if(!/^[A-Za-z0-9._-]+\.(?:mp3|mp4|png|jpg|jpeg|webp)$/.test(file))return res.status(400).json({error:'invalid_media_file'});res.setHeader('Cache-Control','private, no-store');res.sendFile(path.join(mediaDir,file),err=>{if(err&&!res.headersSent)res.status(err.code==='ENOENT'?404:500).json({error:'media_not_found'})})});
const originalUse=express.application.use;
if(!express.application.__sqaiMediaAssetsPatched){express.application.__sqaiMediaAssetsPatched=true;express.application.use=function(...args){const fn=args[0];const finalApi=typeof fn==='function'&&String(fn).includes("req.path.startsWith('/api/')")&&String(fn).includes('status(404)');if(finalApi)originalUse.call(this,router);return originalUse.apply(this,args)}}
process.on('exit',()=>{try{db.close()}catch{}});
