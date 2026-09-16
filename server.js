import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { installAgentRoute } from './agent-orchestrator.mjs';

const app = express();
const dbPath = process.env.DB_PATH || './data/sq-ai.sqlite';

fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode=WAL');
db.pragma('busy_timeout=5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT '',
    password_hash TEXT,
    plan TEXT NOT NULL DEFAULT 'starter',
    credits INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    units INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'Project',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

for (const statement of [
  "ALTER TABLE users ADD COLUMN name TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN password_hash TEXT",
  "ALTER TABLE usage ADD COLUMN endpoint TEXT DEFAULT 'unknown'",
]) {
  try {
    db.exec(statement);
  } catch {
    // Column already exists.
  }
}

const plans = {
  starter: { name: 'Starter', credits: 100, price_usd: 19 },
  growth: { name: 'Growth', credits: 500, price_usd: 49 },
  scale: { name: 'Scale', credits: 2000, price_usd: 149 },
};

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(32).toString('hex');
const clean = (value, maxLength = 6000) => String(value ?? '').trim().slice(0, maxLength);

function cookies(req) {
  const result = {};

  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;

    try {
      result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1));
    } catch {
      // Ignore malformed cookies.
    }
  }

  return result;
}

function user(req) {
  const session = cookies(req).sqai_session;

  if (session) {
    const record = db
      .prepare("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')")
      .get(hash(session));

    if (record) {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(record.user_id);
    }
  }

  const apiKey = req.get('x-api-key');
  if (!apiKey || apiKey.length > 200) return null;

  return db
    .prepare('SELECT u.* FROM users u JOIN api_keys a ON a.user_id = u.id WHERE a.key = ?')
    .get(apiKey) || null;
}

function auth(req, res, next) {
  const currentUser = user(req);
  if (!currentUser) {
    return res.status(401).json({ error: 'authentication_required' });
  }

  req.user = currentUser;
  next();
}

function publicUser(currentUser) {
  return {
    id: currentUser.id,
    email: currentUser.email,
    name: currentUser.name || '',
    plan: currentUser.plan,
    credits: currentUser.credits,
    created_at: currentUser.created_at,
  };
}

async function password(value) {
  const salt = crypto.randomBytes(16);
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(value, salt, 64, { N: 16384, r: 8, p: 1 }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });

  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

async function verifyPassword(value, stored) {
  if (!stored?.startsWith('scrypt:')) return false;

  const [, saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(
      value,
      Buffer.from(saltHex, 'hex'),
      expected.length,
      { N: 16384, r: 8, p: 1 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });

  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

function chargeCredit(userId, endpoint) {
  return db.transaction(() => {
    const current = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
    if (!current || current.credits < 1) return false;

    const result = db
      .prepare('UPDATE users SET credits = credits - 1 WHERE id = ? AND credits > 0')
      .run(userId);

    if (!result.changes) return false;

    db.prepare('INSERT INTO usage(user_id, endpoint, units) VALUES (?, ?, 1)').run(userId, endpoint);
    return true;
  })();
}

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
installAgentRoute(app);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }

  next();
});

app.use(express.static('public', { etag: true, lastModified: true, maxAge: 0 }));

const videoDir = path.join(path.dirname(path.resolve(dbPath)), 'generated-videos');
fs.mkdirSync(videoDir, { recursive: true });
app.use('/generated-videos', express.static(videoDir, { maxAge: '1h', fallthrough: false }));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'SQ AI',
    version: '4.0.1',
    video_mode: process.env.PAID_VIDEO_ENABLED === 'true' ? 'paid' : 'free',
  });
});

app.get('/api/plans', (req, res) => res.json(plans));

app.post('/api/auth/signup', async (req, res) => {
  try {
    const email = clean(req.body.email, 200).toLowerCase();
    const passwordValue = String(req.body.password || '');
    const name = clean(req.body.name, 100);
    const domain = email.split('@')[1] || '';

    if (!email.includes('@') || !domain.includes('.') || email.startsWith('@') || email.endsWith('@')) {
      return res.status(400).json({ error: 'valid_email_required' });
    }

    if (passwordValue.length < 8) {
      return res.status(400).json({ error: 'password_min_8_characters' });
    }

    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      return res.status(409).json({ error: 'email_already_registered' });
    }

    const result = db
      .prepare("INSERT INTO users(email, name, password_hash, plan, credits) VALUES (?, ?, ?, 'starter', ?)")
      .run(email, name, await password(passwordValue), plans.starter.credits);

    const sessionToken = token();
    db.prepare(
      "INSERT INTO sessions(user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+30 days'))",
    ).run(result.lastInsertRowid, hash(sessionToken));

    res.setHeader(
      'Set-Cookie',
      `sqai_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${
        process.env.NODE_ENV === 'production' ? '; Secure' : ''
      }`,
    );

    return res.status(201).json({
      user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid)),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'signup_failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = clean(req.body.email, 200).toLowerCase();
    const passwordValue = String(req.body.password || '');
    const currentUser = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!currentUser || !(await verifyPassword(passwordValue, currentUser.password_hash))) {
      return res.status(401).json({ error: 'invalid_email_or_password' });
    }

    const sessionToken = token();
    db.prepare(
      "INSERT INTO sessions(user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+30 days'))",
    ).run(currentUser.id, hash(sessionToken));

    res.setHeader(
      'Set-Cookie',
      `sqai_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${
        process.env.NODE_ENV === 'production' ? '; Secure' : ''
      }`,
    );

    return res.json({ user: publicUser(currentUser) });
  } catch {
    return res.status(500).json({ error: 'login_failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const session = cookies(req).sqai_session;
  if (session) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(session));
  }

  res.setHeader('Set-Cookie', 'sqai_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch('/api/account', auth, (req, res) => {
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(clean(req.body.name, 100), req.user.id);
  return res.json({
    user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)),
  });
});

app.get('/api/usage', auth, (req, res) => {
  const current = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id);
  const total = db
    .prepare("SELECT COALESCE(SUM(units), 0) n FROM usage WHERE user_id = ? AND endpoint NOT LIKE '%:refunded'")
    .get(req.user.id).n;

  return res.json({ credits: current.credits, total_units: total });
});

app.get('/api/projects', auth, (req, res) => {
  const projects = db
    .prepare('SELECT id, title, content, type, created_at FROM projects WHERE user_id = ? ORDER BY id DESC LIMIT 100')
    .all(req.user.id);

  return res.json({ projects });
});

app.post('/api/projects', auth, (req, res) => {
  const content = clean(req.body.content, 20000);
  if (!content) return res.status(400).json({ error: 'content_required' });

  const result = db
    .prepare('INSERT INTO projects(user_id, title, content, type) VALUES (?, ?, ?, ?)')
    .run(
      req.user.id,
      clean(req.body.title, 200) || 'Untitled',
      content,
      clean(req.body.type, 50) || 'Project',
    );

  return res.status(201).json({
    project: db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid),
  });
});

app.delete('/api/projects/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: 'invalid_project_id' });
  }

  const result = db
    .prepare('DELETE FROM projects WHERE id = ? AND user_id = ?')
    .run(id, req.user.id);

  if (!result.changes) return res.status(404).json({ error: 'project_not_found' });
  return res.json({ ok: true });
});

app.post('/api/tools/generate', auth, async (req, res, next) => {
  try {
    if (req.user.credits < 1) return res.status(402).json({ error: 'credits_exhausted' });

    const tool = clean(req.body.tool, 80).toLowerCase();
    const prompt = clean(req.body.prompt || req.body.input, 6000);

    if (!tool || !prompt) {
      return res.status(400).json({ error: 'tool_and_prompt_required' });
    }

    const videoTool =
      tool.includes('video') ||
      ['reels', 'shorts', 'long-shorts', 'text-video', 'image-video'].includes(tool);

    if (videoTool) {
      const url = process.env.VIDEO_API_URL;
      const key = process.env.VIDEO_API_KEY;
      if (!url || !key) return res.status(502).json({ error: 'video_provider_not_configured' });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool,
          prompt,
          language: req.body.language || 'English',
          platform: req.body.platform || 'General',
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(
          new Error(data?.error?.message || data?.message || 'video_provider_request_failed'),
          { status: response.status },
        );
      }

      const videoUrl = data.video_url || data.url || data.output?.video_url || data.output?.url;
      if (!videoUrl) {
        throw Object.assign(new Error('video_provider_invalid_output'), { status: 502 });
      }

      if (!chargeCredit(req.user.id, `tool:${tool}`)) {
        return res.status(402).json({ error: 'credits_exhausted' });
      }

      return res.json({
        result: videoUrl,
        video_url: videoUrl,
        provider: data.provider || 'custom',
        model: data.model || null,
        credits_remaining: db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id).credits,
      });
    }

    const { generateText } = await import('./ai-runtime.mjs');
    const result = await generateText({
      capability: 'text',
      messages: [
        { role: 'system', content: `You are SQ AI. Produce the finished output for tool ${tool}.` },
        { role: 'user', content: prompt },
      ],
    });

    if (!result?.text) return res.status(502).json({ error: 'ai_empty_result' });
    if (!chargeCredit(req.user.id, `tool:${tool}:${result.provider}:${result.model}`)) {
      return res.status(402).json({ error: 'credits_exhausted' });
    }

    return res.json({
      result: result.text,
      provider: result.provider,
      model: result.model,
      credits_remaining: db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id).credits,
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/campaigns/generate', auth, async (req, res, next) => {
  try {
    if (req.user.credits < 1) return res.status(402).json({ error: 'credits_exhausted' });

    const { generateText } = await import('./ai-runtime.mjs');
    const input = clean(req.body.input || req.body.prompt || req.body.product, 6000);
    if (!input) return res.status(400).json({ error: 'input_required' });

    const result = await generateText({
      capability: 'text',
      messages: [
        { role: 'system', content: 'You are SQ AI. Build a practical advertising campaign.' },
        { role: 'user', content: input },
      ],
    });

    if (!result?.text) return res.status(502).json({ error: 'ai_empty_result' });
    if (!chargeCredit(req.user.id, 'campaign:generate')) {
      return res.status(402).json({ error: 'credits_exhausted' });
    }

    return res.json({
      result: result.text,
      provider: result.provider,
      model: result.model,
      credits_remaining: db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id).credits,
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/billing/checkout', auth, (req, res) => {
  return res.status(501).json({ error: 'payment_provider_not_configured' });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  next();
});

app.use((error, req, res, next) => {
  console.error('api_error', error);
  return res.status(Number(error?.status) || 500).json({
    error: error?.code || 'server_error',
    message: process.env.NODE_ENV === 'production' ? 'Request failed.' : error?.message,
  });
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`SQ AI listening on 0.0.0.0:${port}`);
});

function shutdown() {
  server.close(() => db.close());
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
