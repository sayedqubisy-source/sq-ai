import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

const jobs = new Map();
const dbPath = process.env.DB_PATH || './data/sq-ai.sqlite';
let db;
try {
  db = new Database(dbPath);
  db.pragma('journal_mode=WAL');
} catch (error) {
  console.error('SQ AI video jobs DB init failed:', error?.message || error);
}

const VIDEO_TOOLS = new Set([
  'text-video','image-video','ad-video','product-video','reels','long-shorts',
  'script-video','voiceover','subtitles','translation','resize','silence','noise','hooks-video',
  'video_script','shorts','long_to_shorts','hooks'
]);
const ALIASES = {
  video_script:'script-video', ad_video:'ad-video', product_video:'product-video', shorts:'reels',
  long_to_shorts:'long-shorts', hooks:'hooks-video'
};

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return cookies;
}
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function authenticatedUser(req) {
  if (!db) return null;
  const apiKey = req.get('x-api-key');
  if (apiKey && apiKey.length <= 200) {
    const user = db.prepare('SELECT u.* FROM users u JOIN api_keys a ON a.user_id=u.id WHERE a.key=?').get(apiKey);
    if (user) return user;
  }
  const sessionToken = parseCookies(req).sqai_session;
  if (!sessionToken) return null;
  const session = db.prepare("SELECT * FROM sessions WHERE token_hash=? AND expires_at > datetime('now')").get(hashToken(sessionToken));
  return session ? db.prepare('SELECT * FROM users WHERE id=?').get(session.user_id) : null;
}

function isVideoRequest(req) {
  const raw = String(req.body?.tool || '').trim();
  return VIDEO_TOOLS.has(raw) || VIDEO_TOOLS.has(ALIASES[raw]);
}

function normalizeUser(req) {
  return req.user?.id ? req.user : authenticatedUser(req);
}

function consumeCredit(userId, endpoint) {
  if (!db) return false;
  try {
    const tx = db.transaction(() => {
      const u = db.prepare('SELECT credits FROM users WHERE id=?').get(userId);
      if (!u || u.credits < 1) return false;
      db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>0').run(userId);
      db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(userId, endpoint);
      return true;
    });
    return tx();
  } catch (error) {
    console.error('SQ AI video credit commit failed:', error?.message || error);
    return false;
  }
}

async function runJob(job) {
  job.status = 'running';
  job.started_at = new Date().toISOString();
  try {
    const port = Number(process.env.PORT || 3000);
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/videos`, {
      method:'POST',
      headers:{ Authorization:'Bearer free-local-video', 'Content-Type':'application/json', 'X-Title':'SQ AI' },
      body:JSON.stringify({ tool:job.tool, prompt:job.prompt, language:job.language || 'English', platform:job.platform || 'General' })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data?.error?.message || data?.message || 'video_provider_request_failed'), { status:response.status });
    const videoUrl = data?.video_url || data?.url || data?.output?.video_url || data?.output?.url ||
      (Array.isArray(data?.output) ? data.output.find(x => typeof x === 'string' && /^https?:\/\//.test(x)) : null);
    if (!videoUrl) throw new Error('video_provider_invalid_output');
    if (!consumeCredit(job.user_id, `tool:${job.tool}`)) throw new Error('credits_exhausted');
    const fresh = db?.prepare('SELECT credits FROM users WHERE id=?').get(job.user_id);
    job.status = 'completed';
    job.video_url = videoUrl;
    job.result = videoUrl;
    job.credits_remaining = fresh?.credits ?? null;
    job.completed_at = new Date().toISOString();
  } catch (error) {
    job.status = 'failed';
    job.error = error?.message || 'video_generation_failed';
    job.completed_at = new Date().toISOString();
  }
}

function publicJob(job) {
  return {
    job_id:job.id, status:job.status, result:job.result || null, video_url:job.video_url || null,
    provider:'huggingface-zero-gpu', credits_remaining:job.credits_remaining ?? null,
    error:job.error || null, created_at:job.created_at, started_at:job.started_at || null,
    completed_at:job.completed_at || null
  };
}

const originalPost = express.application.post;
express.application.post = function(path, ...handlers) {
  if (path === '/api/tools/generate' && handlers.length) {
    const originalHandler = handlers[handlers.length - 1];
    handlers[handlers.length - 1] = async function(req, res, next) {
      if (!isVideoRequest(req)) return originalHandler(req, res, next);
      const user = normalizeUser(req);
      if (!user) return originalHandler(req, res, next);
      if (Number(user.credits || 0) < 1) return res.status(402).json({ error:'credits_exhausted' });
      const id = crypto.randomUUID();
      const job = {
        id, user_id:user.id,
        tool:ALIASES[String(req.body.tool || '').trim()] || String(req.body.tool || '').trim(),
        prompt:String(req.body.prompt ?? req.body.input ?? '').trim().slice(0,6000),
        language:String(req.body.language || '').trim().slice(0,50),
        platform:String(req.body.platform || '').trim().slice(0,50), status:'queued', created_at:new Date().toISOString()
      };
      jobs.set(id, job);
      res.status(202).json({ ...publicJob(job), async:true, message:'Video generation started.' });
      void runJob(job);
    };
  }
  return originalPost.call(this, path, ...handlers);
};

const originalGet = express.application.get;
express.application.get = function(path, ...handlers) {
  const result = originalGet.call(this, path, ...handlers);
  if (!this.__sqAiVideoJobsRouteInstalled) {
    this.__sqAiVideoJobsRouteInstalled = true;
    originalGet.call(this, '/api/tools/video-job/:id', (req, res) => {
      const user = authenticatedUser(req);
      if (!user) return res.status(401).json({ error:'authentication_required' });
      const job = jobs.get(req.params.id);
      if (!job) return res.status(404).json({ error:'video_job_not_found' });
      if (Number(user.id) !== Number(job.user_id)) return res.status(403).json({ error:'forbidden' });
      return res.json(publicJob(job));
    });
  }
  return result;
};

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.completed_at && new Date(job.completed_at).getTime() < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();
