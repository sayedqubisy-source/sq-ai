import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

const dbPath = process.env.DB_PATH || './data/sq-ai.sqlite';
let db;
try {
  db = new Database(dbPath);
  db.pragma('journal_mode=WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_jobs (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tool TEXT NOT NULL,
      prompt TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      provider TEXT NOT NULL DEFAULT 'huggingface-zero-gpu',
      video_url TEXT,
      error TEXT,
      credits_reserved INTEGER NOT NULL DEFAULT 0,
      credits_remaining INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_video_jobs_user_created ON video_jobs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_video_jobs_status_created ON video_jobs(status, created_at ASC);
  `);

  // A process restart cannot safely resume a provider request that was already running.
  // Mark those jobs failed and return their reserved credit before accepting new work.
  db.transaction(() => {
    const running = db.prepare("SELECT id,user_id FROM video_jobs WHERE status='running' AND credits_reserved=1").all();
    for (const job of running) {
      db.prepare('UPDATE users SET credits=credits+1 WHERE id=?').run(job.user_id);
      db.prepare("UPDATE video_jobs SET status='failed',error='server_restarted',credits_reserved=0,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);
    }
  })();
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

function normalizeTool(raw) {
  const value = String(raw || '').trim();
  return ALIASES[value] || value;
}
function isVideoRequest(req) {
  const raw = String(req.body?.tool || '').trim();
  return VIDEO_TOOLS.has(raw) || VIDEO_TOOLS.has(normalizeTool(raw));
}
function publicJob(job) {
  return {
    job_id:job.id,
    status:job.status,
    result:job.video_url || null,
    video_url:job.video_url || null,
    provider:job.provider || 'huggingface-zero-gpu',
    credits_remaining:job.credits_remaining ?? null,
    error:job.error || null,
    created_at:job.created_at,
    started_at:job.started_at || null,
    completed_at:job.completed_at || null
  };
}
function getJob(id) {
  return db?.prepare('SELECT * FROM video_jobs WHERE id=?').get(id) || null;
}

function reserveCreditAndCreateJob({ userId, tool, prompt, language, platform }) {
  if (!db) throw new Error('video_jobs_db_unavailable');
  const id = crypto.randomUUID();
  const tx = db.transaction(() => {
    const user = db.prepare('SELECT credits FROM users WHERE id=?').get(userId);
    if (!user || Number(user.credits) < 1) return null;
    db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>0').run(userId);
    db.prepare(`INSERT INTO video_jobs
      (id,user_id,tool,prompt,language,platform,status,credits_reserved)
      VALUES(?,?,?,?,?,?, 'queued', 1)`).run(id,userId,tool,prompt,language,platform);
    return id;
  });
  return tx();
}

function finalizeSuccess(id, videoUrl) {
  const tx = db.transaction(() => {
    const job = db.prepare('SELECT * FROM video_jobs WHERE id=?').get(id);
    if (!job || job.status !== 'running' || !job.credits_reserved) return false;
    db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(job.user_id, `tool:${job.tool}`);
    const user = db.prepare('SELECT credits FROM users WHERE id=?').get(job.user_id);
    db.prepare(`UPDATE video_jobs
      SET status='completed',video_url=?,error=NULL,credits_reserved=0,credits_remaining=?,completed_at=CURRENT_TIMESTAMP
      WHERE id=?`).run(videoUrl, user?.credits ?? null, id);
    return true;
  });
  return tx();
}

function finalizeFailure(id, errorMessage) {
  const tx = db.transaction(() => {
    const job = db.prepare('SELECT * FROM video_jobs WHERE id=?').get(id);
    if (!job || job.status === 'completed') return;
    if (job.credits_reserved) db.prepare('UPDATE users SET credits=credits+1 WHERE id=?').run(job.user_id);
    const user = db.prepare('SELECT credits FROM users WHERE id=?').get(job.user_id);
    db.prepare(`UPDATE video_jobs
      SET status='failed',error=?,credits_reserved=0,credits_remaining=?,completed_at=CURRENT_TIMESTAMP
      WHERE id=?`).run(String(errorMessage || 'video_generation_failed').slice(0,500), user?.credits ?? null, id);
  });
  tx();
}

async function runJob(id) {
  if (!db) return;
  const claimed = db.prepare("UPDATE video_jobs SET status='running',started_at=CURRENT_TIMESTAMP WHERE id=? AND status='queued'").run(id);
  if (!claimed.changes) return;
  const job = getJob(id);
  if (!job) return;

  try {
    const port = Number(process.env.PORT || 3000);
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/videos`, {
      method:'POST',
      headers:{ Authorization:'Bearer free-local-video', 'Content-Type':'application/json', 'X-Title':'SQ AI' },
      body:JSON.stringify({ tool:job.tool, prompt:job.prompt, language:job.language || 'English', platform:job.platform || 'General' })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || data?.message || 'video_provider_request_failed');
    const videoUrl = data?.video_url || data?.url || data?.output?.video_url || data?.output?.url ||
      (Array.isArray(data?.output) ? data.output.find(x => typeof x === 'string' && /^(?:https?:\/\/|\/)/.test(x)) : null);
    if (!videoUrl) throw new Error('video_provider_invalid_output');
    if (!finalizeSuccess(id, videoUrl)) throw new Error('video_job_finalize_failed');
  } catch (error) {
    console.error('SQ AI video job failed', id, error?.message || error);
    finalizeFailure(id, error?.message || 'video_generation_failed');
  }
}

let queueRunning = false;
async function processQueue() {
  if (queueRunning || !db) return;
  queueRunning = true;
  try {
    while (true) {
      const next = db.prepare("SELECT id FROM video_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get();
      if (!next) break;
      await runJob(next.id);
    }
  } finally {
    queueRunning = false;
  }
}

const originalPost = express.application.post;
express.application.post = function(path, ...handlers) {
  if (path === '/api/tools/generate' && handlers.length) {
    const originalHandler = handlers[handlers.length - 1];
    handlers[handlers.length - 1] = async function(req, res, next) {
      if (!isVideoRequest(req)) return originalHandler(req, res, next);
      const user = req.user?.id ? req.user : authenticatedUser(req);
      if (!user) return originalHandler(req, res, next);

      const tool = normalizeTool(req.body?.tool);
      const prompt = String(req.body?.prompt ?? req.body?.input ?? '').trim().slice(0,6000);
      const language = String(req.body?.language || '').trim().slice(0,50);
      const platform = String(req.body?.platform || '').trim().slice(0,50);
      if (!tool || !prompt) return res.status(400).json({ error:'tool_and_prompt_required' });

      try {
        const id = reserveCreditAndCreateJob({ userId:user.id, tool, prompt, language, platform });
        if (!id) return res.status(402).json({ error:'credits_exhausted' });
        const job = getJob(id);
        res.status(202).json({ ...publicJob(job), async:true, message:'Video generation queued.' });
        void processQueue();
      } catch (error) {
        console.error('SQ AI video job creation failed:', error?.message || error);
        return res.status(503).json({ error:'video_queue_unavailable' });
      }
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
      const job = getJob(req.params.id);
      if (!job) return res.status(404).json({ error:'video_job_not_found' });
      if (Number(user.id) !== Number(job.user_id)) return res.status(403).json({ error:'forbidden' });
      return res.json(publicJob(job));
    });
  }
  return result;
};

setInterval(() => {
  if (!db) return;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try { db.prepare("DELETE FROM video_jobs WHERE completed_at IS NOT NULL AND completed_at < ?").run(cutoff); } catch {}
}, 60 * 60 * 1000).unref();

setTimeout(() => { void processQueue(); }, 1000).unref();
