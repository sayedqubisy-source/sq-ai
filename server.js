import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { InferenceClient } from '@huggingface/inference';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static('public'));

const dbPath = process.env.DB_PATH || './data/sq-ai.sqlite';
const generatedVideoDir = path.join(path.dirname(path.resolve(dbPath)), 'generated-videos');
fs.mkdirSync(generatedVideoDir, { recursive: true });
app.use('/generated-videos', express.static(generatedVideoDir, { maxAge: '1h' }));
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(generatedVideoDir)) {
    const full = path.join(generatedVideoDir, file);
    try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch {}
  }
}, 6 * 60 * 60 * 1000).unref();
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode=WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT UNIQUE NOT NULL,name TEXT DEFAULT '',password_hash TEXT,plan TEXT NOT NULL DEFAULT 'starter',credits INTEGER NOT NULL DEFAULT 100,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,key TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,endpoint TEXT NOT NULL,units INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,token_hash TEXT UNIQUE NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,type TEXT NOT NULL DEFAULT 'Project',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);
for (const statement of [
  "ALTER TABLE users ADD COLUMN name TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN password_hash TEXT",
  "ALTER TABLE usage ADD COLUMN endpoint TEXT DEFAULT 'unknown'"
]) { try { db.exec(statement); } catch {} }

const plans = {
  starter: { name: 'Starter', credits: 100, price_usd: 19 },
  growth: { name: 'Growth', credits: 500, price_usd: 49 },
  scale: { name: 'Scale', credits: 2000, price_usd: 149 }
};

const makeToken = () => crypto.randomBytes(32).toString('hex');
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? reject(e) : resolve(k)));
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  if (!stored?.startsWith('scrypt:')) return false;
  const [, saltHex, keyHex] = stored.split(':');
  const original = Buffer.from(keyHex || '', 'hex');
  if (!original.length || !saltHex) return false;
  const key = await new Promise((resolve, reject) => crypto.scrypt(password, Buffer.from(saltHex, 'hex'), original.length, { N: 16384, r: 8, p: 1 }, (e, k) => e ? reject(e) : resolve(k)));
  return original.length === key.length && crypto.timingSafeEqual(original, key);
}
function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1) { try { cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return cookies;
}
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sqai_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
}
function clearSessionCookie(res) { res.setHeader('Set-Cookie', 'sqai_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); }
function getUserById(id) { return db.prepare('SELECT * FROM users WHERE id=?').get(id); }
function publicUser(user) { return { id: user.id, email: user.email, name: user.name || '', plan: user.plan, credits: user.credits, created_at: user.created_at }; }
function getUserFromSession(req) {
  const token = parseCookies(req).sqai_session;
  if (!token) return null;
  const session = db.prepare("SELECT * FROM sessions WHERE token_hash=? AND expires_at > datetime('now')").get(hashToken(token));
  return session ? getUserById(session.user_id) : null;
}
function getUserFromApiKey(req) {
  const key = req.get('x-api-key');
  if (!key || key.length > 200) return null;
  return db.prepare('SELECT u.* FROM users u JOIN api_keys a ON a.user_id=u.id WHERE a.key=?').get(key) || null;
}
function auth(req, res, next) {
  const user = getUserFromSession(req) || getUserFromApiKey(req);
  if (!user) return res.status(401).json({ error: 'authentication_required' });
  req.user = user; next();
}
const limitText = (value, max=4000) => String(value ?? '').trim().slice(0, max);
const validEmail = email => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fetchJsonWithTimeout(url, options={}, timeoutMs=90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw Object.assign(new Error('ai_provider_timeout'), { code:'ai_provider_timeout', status:504 });
    throw e;
  } finally { clearTimeout(timer); }
}
function modelList(primary) {
  const defaults = ['openrouter/free'];
  return [...new Set([primary, ...defaults].filter(Boolean))];
}
function shouldRetry(status) { return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500; }

async function openRouterChat(messages, model) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw Object.assign(new Error('openrouter_not_configured'), { code: 'openrouter_not_configured', status: 502 });
  let lastError;
  for (const candidate of modelList(model || process.env.OPENROUTER_MODEL)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetchJsonWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
          method:'POST',
          headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json', 'HTTP-Referer':process.env.APP_URL || 'http://localhost:3000', 'X-Title':'SQ AI' },
          body:JSON.stringify({ model:candidate, messages })
        }, 90000);
        const data = await r.json().catch(()=>({}));
        if (r.ok) {
          const text = data?.choices?.[0]?.message?.content;
          if (typeof text === 'string' && text.trim()) return text;
          lastError = Object.assign(new Error('ai_empty_result'), { code:'ai_empty_result', status:502 });
          break;
        }
        lastError = Object.assign(new Error(data?.error?.message || 'openrouter_request_failed'), { code:'openrouter_request_failed', status:r.status });
        if (!shouldRetry(r.status)) throw lastError;
        if (attempt === 0) await sleep(700);
      } catch (e) {
        lastError = e;
        if (e?.code === 'openrouter_request_failed' && !shouldRetry(e.status)) throw e;
        if (attempt === 0) await sleep(700);
      }
    }
  }
  throw lastError || Object.assign(new Error('openrouter_request_failed'), { code:'openrouter_request_failed', status:502 });
}

async function openRouterImage(prompt, model) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw Object.assign(new Error('openrouter_not_configured'), { code: 'openrouter_not_configured', status: 502 });
  const selectedModel = model || process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-3.1-flash-image-preview';
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchJsonWithTimeout('https://openrouter.ai/api/v1/images', {
        method:'POST',
        headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json', 'HTTP-Referer':process.env.APP_URL || 'http://localhost:3000', 'X-Title':'SQ AI' },
        body:JSON.stringify({ model:selectedModel, prompt, n:1, size:'1024x1024' })
      }, 120000);
      const data = await r.json().catch(()=>({}));
      if (r.ok) return data;
      lastError = Object.assign(new Error(data?.error?.message || 'openrouter_image_request_failed'), { code:'openrouter_image_request_failed', status:r.status });
      if (!shouldRetry(r.status)) throw lastError;
      if (attempt === 0) await sleep(1000);
    } catch (e) {
      lastError = e;
      if (e?.code === 'openrouter_image_request_failed' && !shouldRetry(e.status)) throw e;
      if (attempt === 0) await sleep(1000);
    }
  }
  throw lastError || Object.assign(new Error('openrouter_image_request_failed'), { code:'openrouter_image_request_failed', status:502 });
}

async function saveVideoBlob(blob) {
  const contentType = blob?.type || 'video/mp4';
  const extension = contentType.includes('webm') ? 'webm' : contentType.includes('quicktime') ? 'mov' : 'mp4';
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (!bytes.length) throw Object.assign(new Error('video_provider_empty_output'), { code:'video_provider_empty_output', status:502 });
  if (bytes.length > 60 * 1024 * 1024) throw Object.assign(new Error('video_output_too_large'), { code:'video_output_too_large', status:502 });
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extension}`;
  fs.writeFileSync(path.join(generatedVideoDir, filename), bytes);
  return `/generated-videos/${filename}`;
}
async function generateWithHuggingFace({ prompt }) {
  const token = process.env.HF_TOKEN;
  if (!token) throw Object.assign(new Error('huggingface_not_configured'), { code:'huggingface_not_configured', status:502 });
  const model = process.env.HF_VIDEO_MODEL || 'Wan-AI/Wan2.2-TI2V-5B';
  const provider = process.env.HF_VIDEO_PROVIDER || 'fal-ai';
  const client = new InferenceClient(token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const blob = await client.textToVideo({ model, inputs: prompt }, { provider, signal: controller.signal });
    const videoUrl = await saveVideoBlob(blob);
    return { provider:'huggingface', model, video_url:videoUrl };
  } catch (e) {
    if (e?.name === 'AbortError') throw Object.assign(new Error('video_provider_timeout'), { code:'video_provider_timeout', status:504 });
    throw Object.assign(new Error(e?.message || 'huggingface_video_request_failed'), { code:'huggingface_video_request_failed', status:e?.status || 502 });
  } finally { clearTimeout(timer); }
}
async function secureVideoGenerate({ tool, prompt, language, platform }) {
  const normalizedPrompt = limitText(`${prompt || ''}${language ? `\nLanguage: ${language}` : ''}${platform ? `\nPlatform: ${platform}` : ''}`, 6000);
  if (!normalizedPrompt) throw Object.assign(new Error('video_prompt_required'), { code:'video_prompt_required', status:400 });
  if (process.env.HF_TOKEN) return generateWithHuggingFace({ prompt: normalizedPrompt });
  const url = process.env.VIDEO_API_URL;
  const key = process.env.VIDEO_API_KEY;
  if (!url || !key) throw Object.assign(new Error('video_provider_not_configured'), { code:'video_provider_not_configured', status:502 });
  let endpoint; try { endpoint = new URL(url); } catch { throw Object.assign(new Error('video_provider_url_invalid'), { code:'video_provider_url_invalid' }); }
  if (!['https:','http:'].includes(endpoint.protocol)) throw Object.assign(new Error('video_provider_url_invalid'), { code:'video_provider_url_invalid' });
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 300000);
  try {
    const body = { tool, prompt:normalizedPrompt, language:language || 'English', platform:platform || 'General' };
    if (process.env.VIDEO_MODEL && process.env.PAID_VIDEO_ENABLED === 'true') body.model = process.env.VIDEO_MODEL;
    const r = await fetch(endpoint, { method:'POST', headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json', 'X-Title':'SQ AI' }, body:JSON.stringify(body), signal:controller.signal });
    const data = await r.json().catch(()=>({}));
    if (!r.ok) throw Object.assign(new Error(data?.error?.message || data?.message || 'video_provider_request_failed'), { code:'video_provider_request_failed', status:r.status });
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') throw Object.assign(new Error('video_provider_timeout'), { code:'video_provider_timeout', status:504 });
    throw e;
  } finally { clearTimeout(timer); }
}

function consumeCredit(userId, endpoint) {
  const tx = db.transaction(() => {
    const u = db.prepare('SELECT credits FROM users WHERE id=?').get(userId);
    if (!u || u.credits < 1) return false;
    db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>0').run(userId);
    db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(userId, endpoint);
    return true;
  }); return tx();
}

const TOOL_ALIASES = {
  video_script:'script-video', ad_video:'ad-video', product_video:'product-video', shorts:'reels',
  long_to_shorts:'long-shorts', hooks:'hooks-video', voiceover:'voiceover', subtitles:'subtitles',
  image_prompt:'text-image', product_image:'product-image', ad_creative:'ad-creative', thumbnail:'thumbnail',
  background:'background', variations:'variations'
};
const imageTools = new Set(['text-image','product-image','ad-creative','background','enhance','thumbnail','social-image','variations']);
const videoTools = new Set(['text-video','image-video','ad-video','product-video','reels','long-shorts','script-video','voiceover','subtitles','translation','resize','silence','noise','hooks-video']);

app.get('/api/health', (req,res)=>res.json({ ok:true, service:'SQ AI', version:'3.6.0', video_mode:process.env.PAID_VIDEO_ENABLED === 'true' ? 'paid' : 'free' }));
app.get('/api/plans', (req,res)=>res.json(plans));
app.post('/api/auth/signup', async (req,res)=>{
  try {
    const email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||''), name=limitText(req.body.name,100);
    if(!validEmail(email)) return res.status(400).json({error:'valid_email_required'});
    if(password.length<8)return res.status(400).json({error:'password_min_8_characters'});
    if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return res.status(409).json({error:'email_already_registered'});
    const hash=await hashPassword(password);const r=db.prepare("INSERT INTO users(email,name,password_hash,plan,credits) VALUES(?,?,?,'starter',?)").run(email,name,hash,plans.starter.credits);
    const token=makeToken();db.prepare("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,datetime('now','+30 days'))").run(r.lastInsertRowid,hashToken(token));setSessionCookie(res,token);res.status(201).json({user:publicUser(getUserById(r.lastInsertRowid))});
  }catch(e){console.error(e);res.status(500).json({error:'signup_failed'});}
});
app.post('/api/auth/login',async(req,res)=>{try{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');const u=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!u||!u.password_hash||!(await verifyPassword(password,u.password_hash)))return res.status(401).json({error:'invalid_email_or_password'});const token=makeToken();db.prepare("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,datetime('now','+30 days'))").run(u.id,hashToken(token));setSessionCookie(res,token);res.json({user:publicUser(u)});}catch(e){console.error(e);res.status(500).json({error:'login_failed'});}});
app.post('/api/auth/logout',(req,res)=>{const token=parseCookies(req).sqai_session;if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));clearSessionCookie(res);res.json({ok:true});});
app.get('/api/me',auth,(req,res)=>res.json({user:publicUser(getUserById(req.user.id))}));
app.post('/api/auth/set-password',auth,async(req,res)=>{const password=String(req.body.password||'');if(password.length<8)return res.status(400).json({error:'password_min_8_characters'});db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(password),req.user.id);res.json({ok:true});});
app.patch('/api/account',auth,async(req,res,next)=>{try{const name=limitText(req.body.name,100);db.prepare('UPDATE users SET name=? WHERE id=?').run(name,req.user.id);res.json({user:publicUser(getUserById(req.user.id))});}catch(e){next(e);}});
app.post('/api/signup',(req,res)=>res.status(410).json({error:'legacy_signup_disabled',message:'Use /api/auth/signup.'}));
app.get('/api/usage',auth,(req,res)=>{const u=db.prepare('SELECT credits FROM users WHERE id=?').get(req.user.id);const total=db.prepare('SELECT COALESCE(SUM(units),0) n FROM usage WHERE user_id=?').get(req.user.id).n;res.json({credits:u.credits,total_units:total});});
app.get('/api/projects',auth,(req,res)=>res.json({projects:db.prepare('SELECT id,title,content,type,created_at FROM projects WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id)}));
app.post('/api/projects',auth,(req,res)=>{const title=limitText(req.body.title,200)||'Untitled',content=limitText(req.body.content,20000),type=limitText(req.body.type,50)||'Project';if(!content)return res.status(400).json({error:'content_required'});const r=db.prepare('INSERT INTO projects(user_id,title,content,type) VALUES(?,?,?,?)').run(req.user.id,title,content,type);res.status(201).json({project:db.prepare('SELECT id,title,content,type,created_at FROM projects WHERE id=?').get(r.lastInsertRowid)});});
app.delete('/api/projects/:id',auth,(req,res)=>{const id=Number(req.params.id);if(!Number.isInteger(id))return res.status(400).json({error:'invalid_project_id'});const r=db.prepare('DELETE FROM projects WHERE id=? AND user_id=?').run(id,req.user.id);if(!r.changes)return res.status(404).json({error:'project_not_found'});res.json({ok:true});});

app.post('/api/tools/generate',auth,async(req,res,next)=>{
  try{
    if(req.user.credits<1)return res.status(402).json({error:'credits_exhausted'});
    const rawTool=limitText(req.body.tool,80),tool=TOOL_ALIASES[rawTool]||rawTool,prompt=limitText(req.body.prompt||req.body.input,6000),language=limitText(req.body.language,50),platform=limitText(req.body.platform,50);
    if(!tool||!prompt)return res.status(400).json({error:'tool_and_prompt_required'});
    if(videoTools.has(tool)){
      const data=await secureVideoGenerate({tool,prompt,language,platform});
      const videoUrl=data?.video_url||data?.url||data?.output?.video_url||data?.output?.url||(Array.isArray(data?.output)?data.output.find(x=>typeof x==='string'&&/^https?:\/\//.test(x)):null);
      if(!videoUrl)return res.status(502).json({error:'video_provider_invalid_output'});
      if(!consumeCredit(req.user.id,`tool:${tool}`))return res.status(402).json({error:'credits_exhausted'});
      const fresh=db.prepare('SELECT credits FROM users WHERE id=?').get(req.user.id);
      return res.json({result:videoUrl,video_url:videoUrl,provider:data?.provider||'custom',model:data?.model||null,free:data?.free===true,credits_remaining:fresh.credits});
    }
    if(imageTools.has(tool)){
      const data=await openRouterImage(`${prompt}\nPlatform: ${platform||'general'}\nLanguage/context: ${language||'English'}`,process.env.OPENROUTER_IMAGE_MODEL);const first=data?.data?.[0];
      if(!first?.b64_json&&!first?.url)throw Object.assign(new Error('image_data_missing'),{code:'image_data_missing',status:502});
      const imageResult=first.b64_json?`data:${first.media_type||'image/png'};base64,${first.b64_json}`:first.url;
      if(!consumeCredit(req.user.id,`tool:${tool}`))return res.status(402).json({error:'credits_exhausted'});
      const fresh=db.prepare('SELECT credits FROM users WHERE id=?').get(req.user.id);return res.json({result:imageResult,image_url:imageResult,credits_remaining:fresh.credits});
    }
    const text=await openRouterChat([{role:'system',content:`You are SQ AI, a professional creative assistant. Generate useful, specific output for the requested tool. Tool: ${tool}. Return only the finished result, no meta commentary.`},{role:'user',content:`Request: ${prompt}\nLanguage: ${language||'English'}\nPlatform: ${platform||'General'}`}],process.env.OPENROUTER_MODEL);
    if(!text.trim())return res.status(502).json({error:'ai_empty_result'});
    if(!consumeCredit(req.user.id,`tool:${tool}`))return res.status(402).json({error:'credits_exhausted'});
    const fresh=db.prepare('SELECT credits FROM users WHERE id=?').get(req.user.id);res.json({result:text,credits_remaining:fresh.credits});
  }catch(e){next(e);}
});

app.post('/api/campaigns/generate',auth,async(req,res,next)=>{try{if(req.user.credits<1)return res.status(402).json({error:'credits_exhausted'});const product=limitText(req.body.product,1000),audience=limitText(req.body.audience,1000),goal=limitText(req.body.goal,100),platform=limitText(req.body.platform,100),input=limitText(req.body.input||req.body.prompt,4000);if(!product)return res.status(400).json({error:'product_required'});const prompt=`Product/service: ${product}\nTarget audience: ${audience||'Not specified'}\nGoal: ${goal||'Sales'}\nPlatform: ${platform||'Multi-platform'}\nAdditional information: ${input||'None'}\n\nCreate a practical campaign including audience, offer, strategy, hooks, ad copy, creative directions, video script, CTA, budget split, KPIs and testing plan.`;const text=await openRouterChat([{role:'system',content:'You are SQ AI. Build a practical advertising campaign. Use clear headings and actionable recommendations.'},{role:'user',content:prompt}],process.env.OPENROUTER_MODEL);if(!text.trim())return res.status(502).json({error:'ai_empty_result'});if(!consumeCredit(req.user.id,'campaign:generate'))return res.status(402).json({error:'credits_exhausted'});const fresh=db.prepare('SELECT credits FROM users WHERE id=?').get(req.user.id);res.json({result:text,credits_remaining:fresh.credits});}catch(e){next(e);}});
app.post('/api/billing/checkout',auth,(req,res)=>res.status(501).json({error:'payment_provider_not_configured',message:'Paddle checkout is not wired into the server yet.'}));

app.use((err,req,res,next)=>{console.error('api_error',err);res.status(err.status||500).json({error:err.code||'server_error',message:process.env.NODE_ENV==='production'?'Request failed.':err.message});});
const port=Number(process.env.PORT||3000);
app.listen(port,'0.0.0.0',()=>console.log(`SQ AI listening on 0.0.0.0:${port}`));
