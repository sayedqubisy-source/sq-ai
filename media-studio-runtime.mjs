import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { generateText } from './ai-runtime.mjs';

const appUse = express.application.use;
const dbPath = process.env.DB_PATH || './data/sq-ai.sqlite';
const db = new Database(dbPath);
db.pragma('journal_mode=WAL');
db.pragma('busy_timeout=5000');
const mediaDir = path.join(path.dirname(path.resolve(dbPath)), 'generated-media');
fs.mkdirSync(mediaDir, { recursive: true });

db.exec(`CREATE TABLE IF NOT EXISTS media_jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  prompt TEXT NOT NULL,
  enhanced_prompt TEXT,
  options_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error TEXT,
  reserved INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT
);`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const limitText = (v, max = 12000) => String(v ?? '').trim().slice(0, max);
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return out;
}
function userFromRequest(req) {
  const cookie = parseCookies(req).sqai_session;
  if (cookie) {
    const session = db.prepare("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at > datetime('now')").get(hashToken(cookie));
    if (session) return db.prepare('SELECT * FROM users WHERE id=?').get(session.user_id);
  }
  const key = req.get('x-api-key');
  if (key && key.length <= 200) return db.prepare('SELECT u.* FROM users u JOIN api_keys a ON a.user_id=u.id WHERE a.key=?').get(key) || null;
  return null;
}
function auth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'authentication_required' });
  req.user = user;
  next();
}
function reserveCredit(userId, endpoint) {
  return db.transaction(() => {
    const r = db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>0').run(userId);
    if (!r.changes) return false;
    db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(userId, `${endpoint}:reserved`);
    return true;
  })();
}
function refundCredit(job) {
  if (!job?.reserved) return;
  db.transaction(() => {
    db.prepare('UPDATE users SET credits=credits+1 WHERE id=?').run(job.user_id);
    db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(job.user_id, `media:${job.kind}:refunded`);
    db.prepare('UPDATE media_jobs SET reserved=0 WHERE id=?').run(job.id);
  })();
}
function finalizeCredit(job) {
  if (!job?.reserved) return;
  db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(job.user_id, `media:${job.kind}`);
  db.prepare('UPDATE media_jobs SET reserved=0 WHERE id=?').run(job.id);
}
async function enhancePrompt(prompt, kind, options) {
  if (process.env.MEDIA_PROMPT_ENHANCER === 'false') return prompt;
  try {
    const result = await generateText({
      capability: 'text',
      messages: [
        { role: 'system', content: 'You are SQ AI Prompt Director. Rewrite the user idea into a production-ready prompt for generative media. Preserve the user intent. For video include subject, action, setting, camera movement, lens/framing, lighting, physics, realism, continuity and audio cues. For music include genre, tempo, instrumentation, structure, mood and mix direction. Return only the final prompt.' },
        { role: 'user', content: `MEDIA TYPE: ${kind}\nOPTIONS: ${JSON.stringify(options)}\nUSER IDEA: ${prompt}` }
      ]
    });
    return result?.text?.trim() || prompt;
  } catch (error) {
    console.warn('media_prompt_enhancement_skipped', error?.message || error);
    return prompt;
  }
}
async function googleFetch(url, options = {}, timeoutMs = 300000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally { clearTimeout(timer); }
}
async function parseJsonResponse(r) {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || data?.message || `provider_http_${r.status}`), { status: r.status });
  return data;
}
async function generateVeo(prompt, options = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Object.assign(new Error('gemini_api_key_missing'), { status: 503 });
  const model = options.model || process.env.VEO_MODEL || 'veo-3.1-generate-preview';
  const body = { instances: [{ prompt }], parameters: { aspectRatio: options.aspectRatio === '9:16' ? '9:16' : '16:9', resolution: ['720p','1080p','4k'].includes(options.resolution) ? options.resolution : '1080p' } };
  const start = await googleFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:predictLongRunning`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body)
  });
  const op = await parseJsonResponse(start);
  if (!op.name) throw new Error('veo_operation_missing');
  let state = op;
  for (let i = 0; i < 90; i++) {
    if (state.done) break;
    await sleep(10000);
    const r = await googleFetch(`https://generativelanguage.googleapis.com/v1beta/${state.name}`, { headers: { 'x-goog-api-key': key } }, 60000);
    state = await parseJsonResponse(r);
  }
  if (!state.done) throw Object.assign(new Error('veo_generation_timeout'), { status: 504 });
  if (state.error) throw Object.assign(new Error(state.error.message || 'veo_generation_failed'), { status: 502 });
  const uri = state?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (!uri) throw Object.assign(new Error('veo_video_uri_missing'), { status: 502 });
  const video = await googleFetch(uri, { headers: { 'x-goog-api-key': key } }, 180000);
  if (!video.ok) throw Object.assign(new Error(`veo_download_failed_${video.status}`), { status: 502 });
  const filename = `video-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.mp4`;
  fs.writeFileSync(path.join(mediaDir, filename), Buffer.from(await video.arrayBuffer()));
  return { type: 'video', url: `/generated-media/${filename}`, model, provider: 'google-veo' };
}
async function generateLyria(prompt, options = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Object.assign(new Error('gemini_api_key_missing'), { status: 503 });
  const model = options.model || process.env.LYRIA_MODEL || 'lyria-3.5';
  const r = await googleFetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ model, input: prompt, response_format: { type: 'audio' } })
  }, 300000);
  const data = await parseJsonResponse(r);
  const audio = data?.output_audio?.data;
  if (!audio) throw Object.assign(new Error('lyria_audio_missing'), { status: 502 });
  const filename = `audio-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.mp3`;
  fs.writeFileSync(path.join(mediaDir, filename), Buffer.from(audio, 'base64'));
  return { type: 'audio', url: `/generated-media/${filename}`, model, provider: 'google-lyria', lyrics: data?.output_text || null };
}
async function processJob(job) {
  db.prepare("UPDATE media_jobs SET status='processing',started_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);
  try {
    const options = JSON.parse(job.options_json || '{}');
    const enhanced = job.enhanced_prompt || await enhancePrompt(job.prompt, job.kind, options);
    db.prepare('UPDATE media_jobs SET enhanced_prompt=? WHERE id=?').run(enhanced, job.id);
    const results = [];
    if (job.kind === 'video' || job.kind === 'both') results.push(await generateVeo(enhanced, options));
    if (job.kind === 'audio' || job.kind === 'both') results.push(await generateLyria(`${enhanced}\nCreate audio that matches the visual mood, pacing and scene transitions.`, options));
    db.prepare("UPDATE media_jobs SET status='completed',result_json=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify({ results }), job.id);
    finalizeCredit(job);
  } catch (e) {
    const fresh = db.prepare('SELECT * FROM media_jobs WHERE id=?').get(job.id);
    refundCredit(fresh);
    db.prepare("UPDATE media_jobs SET status='failed',error=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(limitText(e?.message || 'generation_failed', 500), job.id);
  }
}
let workerRunning = false;
async function workerLoop() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (true) {
      const job = db.prepare("SELECT * FROM media_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get();
      if (!job) break;
      await processJob(job);
    }
  } finally { workerRunning = false; }
}
setInterval(() => workerLoop().catch(e => console.error('media_worker_error', e?.message || e)), 1500).unref();

const router = express.Router();
router.get('/api/media/config', auth, (req, res) => res.json({ video: !!process.env.GEMINI_API_KEY, audio: !!process.env.GEMINI_API_KEY, veo_model: process.env.VEO_MODEL || 'veo-3.1-generate-preview', lyria_model: process.env.LYRIA_MODEL || 'lyria-3.5', queue: 'sqlite-sequential' }));
router.post('/api/media/jobs', auth, async (req, res) => {
  const kind = ['video','audio','both'].includes(req.body?.kind) ? req.body.kind : 'video';
  const prompt = limitText(req.body?.prompt, 12000);
  if (!prompt) return res.status(400).json({ error: 'prompt_required' });
  if (!reserveCredit(req.user.id, `media:${kind}`)) return res.status(402).json({ error: 'credits_exhausted' });
  const id = crypto.randomUUID();
  const options = { aspectRatio: req.body?.aspectRatio === '9:16' ? '9:16' : '16:9', resolution: ['720p','1080p','4k'].includes(req.body?.resolution) ? req.body.resolution : '1080p', model: limitText(req.body?.model, 100) };
  db.prepare('INSERT INTO media_jobs(id,user_id,kind,prompt,options_json) VALUES(?,?,?,?,?)').run(id, req.user.id, kind, prompt, JSON.stringify(options));
  workerLoop().catch(e => console.error('media_worker_start_error', e?.message || e));
  res.status(202).json({ id, status: 'queued', credits_remaining: (db.prepare('SELECT credits FROM users WHERE id=?').get(req.user.id)?.credits ?? 0) });
});
router.get('/api/media/jobs/:id', auth, (req, res) => {
  const job = db.prepare('SELECT * FROM media_jobs WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  res.json({ id: job.id, kind: job.kind, status: job.status, prompt: job.prompt, enhanced_prompt: job.enhanced_prompt, result: job.result_json ? JSON.parse(job.result_json) : null, error: job.error, created_at: job.created_at, completed_at: job.completed_at });
});
router.get('/api/media/jobs', auth, (req, res) => {
  const jobs = db.prepare('SELECT id,kind,status,prompt,created_at,completed_at,error,result_json FROM media_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 30').all(req.user.id).map(j => ({ ...j, result: j.result_json ? JSON.parse(j.result_json) : null, result_json: undefined }));
  res.json({ jobs });
});

const originalUse = express.application.use;
if (!express.application.__sqaiMediaStudioPatched) {
  express.application.__sqaiMediaStudioPatched = true;
  express.application.use = function (...args) {
    const fn = args[0];
    const looksLikeFinalApi404 = typeof fn === 'function' && String(fn).includes("req.path.startsWith('/api/')") && String(fn).includes('status(404)');
    if (looksLikeFinalApi404) originalUse.call(this, router);
    return originalUse.apply(this, args);
  };
}

process.on('exit', () => { try { db.close(); } catch {} });
console.log('SQ AI Media Studio runtime loaded: Veo/Lyria queue ready');
