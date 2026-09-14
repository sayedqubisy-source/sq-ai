import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { InferenceClient } from '@huggingface/inference';
import { generateText } from './ai-runtime.mjs';

const app = express();
app.disable('x-powered-by');
app.set('etag', 'strong');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '64kb' }));

// HTML changes frequently enough to stay revalidated, while versioned/static assets
// can be cached for a long time. This avoids repeated downloads of the frontend JS/CSS.
app.use(express.static('public', {
  etag: true,
  lastModified: true,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    } else if (['.js', '.css', '.svg', '.woff2', '.png', '.jpg', '.jpeg', '.webp', '.ico'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

const dbPath = process.env.DB_PATH || './data/sq-ai.sqlite';
const generatedVideoDir = path.join(path.dirname(path.resolve(dbPath)), 'generated-videos');
fs.mkdirSync(generatedVideoDir, { recursive: true });
app.use('/generated-videos', express.static(generatedVideoDir, { maxAge:'1h', fallthrough:false }));

a
const db = new Database(dbPath);
db.pragma('journal_mode=WAL');
db.pragma('busy_timeout=5000');
db.pragma('synchronous=NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT UNIQUE NOT NULL,name TEXT DEFAULT '',password_hash TEXT,plan TEXT NOT NULL DEFAULT 'starter',credits INTEGER NOT NULL DEFAULT 100,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,key TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,endpoint TEXT NOT NULL,units INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,token_hash TEXT UNIQUE NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,type TEXT NOT NULL DEFAULT 'Project',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);
for (const statement of ["ALTER TABLE users ADD COLUMN name TEXT DEFAULT ''","ALTER TABLE users ADD COLUMN password_hash TEXT","ALTER TABLE usage ADD COLUMN endpoint TEXT DEFAULT 'unknown'"]) { try { db.exec(statement); } catch {} }

const plans = { starter:{name:'Starter',credits:100,price_usd:19}, growth:{name:'Growth',credits:500,price_usd:49}, scale:{name:'Scale',credits:2000,price_usd:149} };
const makeToken=()=>crypto.randomBytes(32).toString('hex');
const hashToken=token=>crypto.createHash('sha256').update(token).digest('hex');
async function hashPassword(password){const salt=crypto.randomBytes(16);const key=await new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,{N:16384,r:8,p:1},(e,k)=>e?reject(e):resolve(k)));return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;}
async function verifyPassword(password,stored){if(!stored?.startsWith('scrypt:'))return false;const [,saltHex,keyHex]=stored.split(':');const original=Buffer.from(keyHex||'','hex');if(!original.length||!saltHex)return false;const key=await new Promise((resolve,reject)=>crypto.scrypt(password,Buffer.from(saltHex,'hex'),original.length,{N:16384,r:8,p:1},(e,k)=>e?reject(e):resolve(k)));return original.length===key.length&&crypto.timingSafeEqual(original,key);}
function parseCookies(req){const cookies={};for(const part of(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i!==-1){try{cookies[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());}catch{}}}return cookies;}
function setSessionCookie(res,token){const secure=process.env.NODE_ENV==='production'?'; Secure':'';res.setHeader('Set-Cookie',`sqai_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);}
function clearSessionCookie(res){res.setHeader('Set-Cookie','sqai_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');}
function getUserById(id){return db.prepare('SELECT * FROM users WHERE id=?').get(id);}
function publicUser(user){return{id:user.id,email:user.email,name:user.name||'',plan:user.plan,credits:user.credits,created_at:user.created_at};}
function getUserFromSession(req){const token=parseCookies(req).sqai_session;if(!token)return null;const session=db.prepare("SELECT * FROM sessions WHERE token_hash=? AND expires_at > datetime('now')").get(hashToken(token));return session?getUserById(session.user_id):null;}
function getUserFromApiKey(req){const key=req.get('x-api-key');if(!key||key.length>200)return null;return db.prepare('SELECT u.* FROM users u JOIN api_keys a ON a.user_id=u.id WHERE a.key=?').get(key)||null;}
function auth(req,res,next){const user=getUserFromSession(req)||getUserFromApiKey(req);if(!user)return res.status(401).json({error:'authentication_required'});req.user=user;next();}
const limitText=(value,max=4000)=>String(value??'').trim().slice(0,max);
const validEmail=email=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
const loginFailures=new Map();
function loginGuard(email){const record=loginFailures.get(email);if(!record)return false;if(record.resetAt<=Date.now()){loginFailures.delete(email);return false}return record.count>=8;}
function recordLoginFailure(email){const now=Date.now(),record=loginFailures.get(email);if(!record||record.resetAt<=now)loginFailures.set(email,{count:1,resetAt:now+15*60*1000});else record.count+=1;}
function clearLoginFailures(email){loginFailures.delete(email);}
setInterval(()=>{const now=Date.now();for(const [email,record] of loginFailures)if(record.resetAt<=now)loginFailures.delete(email);try{db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();}catch{}},60*60*1000).unref();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fetchJsonWithTimeout(url,options={},timeoutMs=90000){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);try{return await fetch(url,{...options,signal:controller.signal});}catch(e){if(e?.name==='AbortError')throw Object.assign(new Error('ai_provider_timeout'),{code:'ai_provider_timeout',status:504});throw e;}finally{clearTimeout(timer);}}
function shouldRetry(status){return status===408||status===409||status===425||status===429||status>=500;}
async function openRouterImage(prompt,model){const key=process.env.OPENROUTER_API_KEY;if(!key)throw Object.assign(new Error('openrouter_not_configured'),{code:'openrouter_not_configured',status:502});const selectedModel=model||process.env.OPENROUTER_IMAGE_MODEL||'google/gemini-3.1-flash-image';let lastError;for(let attempt=0;attempt<2;attempt++){try{const r=await fetchJsonWithTimeout('https://openrouter.ai/api/v1/images',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','HTTP-Referer':process.env.APP_URL||'http://localhost:3000','X-Title':'SQ AI'},body:JSON.stringify({model:selectedModel,prompt,n:1,size:'1024x1024'})},120000);const data=await r.json().catch(()=>({}));if(r.ok)return data;lastError=Object.assign(new Error(data?.error?.message||'openrouter_image_request_failed'),{code:'openrouter_image_request_failed',status:r.status});if(!shouldRetry(r.status))throw lastError;if(attempt===0)await sleep(1000);}catch(e){lastError=e;if(e?.code==='openrouter_image_request_failed'&&!shouldRetry(e.status))throw e;if(attempt===0)await sleep(1000);}}throw lastError||Object.assign(new Error('openrouter_image_request_failed'),{code:'openrouter_image_request_failed',status:502});}
async function saveVideoBlob(blob){const contentType=blob?.type||'video/mp4',extension=contentType.includes('webm')?'webm':contentType.includes('quicktime')?'mov':'mp4',bytes=Buffer.from(await blob.arrayBuffer());if(!bytes.length)throw Object.assign(new Error('video_provider_empty_output'),{code:'video_provider_empty_output',status:502});if(bytes.length>60*1024*1024)throw Object.assign(new Error('video_output_too_large'),{code:'video_output_too_large',status:502});const filename=`${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extension}`;fs.writeFileSync(path.join(generatedVideoDir,filename),bytes);return `/generated-videos/${filename}`;}
async function generateWithHuggingFace({prompt}){const token=process.env.HF_TOKEN;if(!token)throw Object.assign(new Error('huggingface_not_configured'),{code:'huggingface_not_configured',status:502});const model=process.env.HF_VIDEO_MODEL||'Wan-AI/Wan2.2-TI2V-5B',provider=process.env.HF_VIDEO_PROVIDER||'fal-ai',client=new InferenceClient(token),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000);try{const blob=await client.textToVideo({model,inputs:prompt},{provider,signal:controller.signal});return{provider:'huggingface',model,video_url:await saveVideoBlob(blob)};}catch(e){if(e?.name==='AbortError')throw Object.assign(new Error('video_provider_timeout'),{code:'video_provider_timeout',status:504});throw Object.assign(new Error(e?.message||'huggingface_video_request_failed'),{code:'huggingface_video_request_failed',status:e?.status||502});}finally{clearTimeout(timer);}}
async function secureVideoGenerate({tool,prompt,language,platform}){const normalizedPrompt=limitText(`${prompt||''}${language?`\nLanguage: ${language}`:''}${platform?`\nPlatform: ${platform}`:''}`,6000);if(!normalizedPrompt)throw Object.assign(new Error('video_prompt_required'),{code:'video_prompt_required',status:400});if(process.env.HF_TOKEN)return generateWithHuggingFace({prompt:normalizedPrompt});const url=process.env.VIDEO_API_URL,key=process.env.VIDEO_API_KEY;if(!url||!key)throw Object.assign(new Error('video_provider_not_configured'),{code:'video_provider_not_configured',status:502});let endpoint;try{endpoint=new URL(url);}catch{throw Object.assign(new Error('video_provider_url_invalid'),{code:'video_provider_url_invalid',status:500});}if(!['https:','http:'].includes(endpoint.protocol))throw Object.assign(new Error('video_provider_url_invalid'),{code:'video_provider_url_invalid',status:500});const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),300000);try{const body={tool,prompt:normalizedPrompt,language:language||'English',platform:platform||'General'};if(process.env.VIDEO_MODEL&&process.env.PAID_VIDEO_ENABLED==='true')body.model=process.env.VIDEO_MODEL;const r=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','X-Title':'SQ AI'},body:JSON.stringify(body),signal:controller.signal});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data?.error?.message||data?.message||'video_provider_request_failed'),{code:'video_provider_request_failed',status:r.status});return data;}catch(e){if(e?.name==='AbortError')throw Object.assign(new Error('video_provider_timeout'),{code:'video_provider_timeout',status:504});throw e;}finally{clearTimeout(timer);}}
function consumeCredit(userId,endpoint){const tx=db.transaction(()=>{const u=db.prepare('SELECT credits FROM users WHERE id=?').get(userId);if(!u||u.credits<1)return false;const r=db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>0').run(userId);if(!r.changes)return false;db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(userId,endpoint);return true;});return tx();}
const TOOL_ALIASES={video_script:'script-video',ad_video:'ad-video',product_video:'product-video',shorts:'reels',long_to_shorts:'long-shorts',hooks:'hooks-video',voiceover:'voiceover',subtitles:'subtitles',image_prompt:'text-image',product_image:'product-image',ad_creative:'ad-creative',thumbnail:'thumbnail',background:'background',variations:'variations'};
const imageTools=new Set(['text-image','product-image','ad-creative','background','enhance','thumbnail','social-image','variations']);
const videoTools=new Set(['text-video','image-video','ad-video','product-video','reels','long-shorts','script-video','voiceover','subtitles','translation','resize','silence','noise','hooks-video']);
app.get('/api/health',(req,res)=>res.json({ok:true,service:'SQ AI',version:'3.8.0',video_mode:process.env.PAID_VIDEO_ENABLED==='true'?'paid':'free'}));
app.get('/api/plans',(req,res)=>res.json(plans));

app.post('/api/auth/signup',async(req,res)=>{try{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||''),name=limitText(req.body.name,100);if(!validEmail(email))return res.status(400).json({error:'valid_email_required'});if(password.length<8)return res.status(400).json({error:'password_min_8_characters'});if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return res.status(409).json({error:'email_already_registered'});const hash=await hashPassword(password),r=db.prepare("INSERT INTO users(email,name,password_hash,plan,credits) VALUES(?,?,?,'starter',?)").run(email,name,hash,plans.starter.credits),token=makeToken();db.prepare("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,datetime('now','+30 days'))").run(r.lastInsertRowid,hashToken(token));setSessionCookie(res,token);return res.status(201).json({user:publicUser(getUserById(r.lastInsertRowid))});}catch(e){console.error('signup_failed',e?.message||e);return res.status(500).json({error:'signup_failed'});}});
app.post('/api/auth/login',async(req,res)=>{try{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');if(!validEmail(email))return res.status(400).json({error:'valid_email_required'});if(loginGuard(email))return res.status(429).json({error:'too_many_login_attempts'});const u=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!u||!u.password_hash||!(await verifyPassword(password,u.password_hash))){recordLoginFailure(email);return res.status(401).json({error:'invalid_email_or_password'});}clearLoginFailures(email);const token=makeToken();db.prepare("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,datetime('now','+30 days'))").run(u.id,hashToken(token));setSessionCookie(res,token);return res.json({user:publicUser(getUserById(u.id))});}catch(e){console.error('login_failed',e?.message||e);return res.status(500).json({error:'login_failed'});}});
app.post('/api/auth/logout',(req,res)=>{const token=parseCookies(req).sqai_session;if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));clearSessionCookie(res);res.json({ok:true});});
app.get('/api/me',auth,(req,res)=>res.json({user:publicUser(getUserById(req.user.id))});