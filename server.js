import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const dbPath = process.env.DB_PATH || '/app/data/adflow.sqlite';
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    plan TEXT NOT NULL DEFAULT 'starter',
    credits INTEGER NOT NULL DEFAULT 100,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    password_hash TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    key TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    tool TEXT,
    units INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'content',
    title TEXT NOT NULL,
    input TEXT,
    output TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS video_jobs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    provider_job_id TEXT UNIQUE NOT NULL,
    tool TEXT,
    model TEXT,
    status TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}
if (!columnExists('users', 'password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
if (!columnExists('users', 'updated_at')) db.exec('ALTER TABLE users ADD COLUMN updated_at TEXT');
if (!columnExists('usage', 'tool')) db.exec('ALTER TABLE usage ADD COLUMN tool TEXT');

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
  if (!saltHex || !keyHex) return false;
  const original = Buffer.from(keyHex, 'hex');
  const key = await new Promise((resolve, reject) => crypto.scrypt(password, Buffer.from(saltHex, 'hex'), original.length, { N: 16384, r: 8, p: 1 }, (e, k) => e ? reject(e) : resolve(k)));
  return original.length === key.length && crypto.timingSafeEqual(original, key);
}

function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1) {
      try { cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
    }
  }
  return cookies;
}
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `adflow_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'adflow_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function getUserById(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
function publicUser(user) { return { id: user.id, email: user.email, plan: user.plan, credits: user.credits, created_at: user.created_at }; }
function getUserFromApiKey(req) {
  const key = req.get('x-api-key');
  if (!key || key.length > 200) return null;
  return db.prepare('SELECT u.* FROM users u JOIN api_keys a ON a.user_id = u.id WHERE a.key = ?').get(key) || null;
}
function getUserFromSession(req) {
  const token = parseCookies(req).adflow_session;
  if (!token) return null;
  const session = db.prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')").get(hashToken(token));
  return session ? getUserById(session.user_id) : null;
}
function auth(req, res, next) {
  const user = getUserFromSession(req) || getUserFromApiKey(req);
  if (!user) return res.status(401).json({ error: 'authentication_required' });
  req.user = user;
  next();
}

const rateBuckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}
function generationLimit(req, res, next) {
  const key = `gen:${req.user?.id || req.ip}`;
  if (!rateLimit(key, 20, 60_000)) return res.status(429).json({ error: 'rate_limit_exceeded', message: 'Too many generations. Please wait a minute and try again.' });
  next();
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [key, value] of rateBuckets) if (value.startedAt < cutoff) rateBuckets.delete(key);
}, 60_000).unref();

function spendCredit(userId, endpoint, tool) {
  const result = db.transaction(() => {
    const current = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
    if (!current || current.credits < 1) return false;
    db.prepare("UPDATE users SET credits = credits - 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND credits > 0").run(userId);
    db.prepare("INSERT INTO usage (user_id, endpoint, tool, units) VALUES (?, ?, ?, 1)").run(userId, endpoint, tool);
    return true;
  })();
  return result;
}
function refundCredit(userId, endpoint, tool) {
  db.transaction(() => {
    db.prepare('UPDATE users SET credits = credits + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    db.prepare("INSERT INTO usage (user_id, endpoint, tool, units) VALUES (?, ?, ?, -1)").run(userId, endpoint, tool);
  })();
}

const VIDEO_UI_PATCH = `
<script>
(function () {
  async function pollVideoJob(jobId, result, actions) {
    const maxAttempts = 100;
    const delayMs = 3000;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      result.textContent = 'Generating your video... ' + attempt + '/' + maxAttempts;
      const response = await fetch('/api/video/jobs/' + encodeURIComponent(jobId), { credentials: 'include', headers: { Accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || 'Video status request failed.');
      const status = String(data.status || '').toLowerCase();
      if (status === 'completed' || data.ready === true) {
        result.innerHTML = '';
        const video = document.createElement('video');
        video.controls = true; video.playsInline = true; video.preload = 'metadata'; video.style.width = '100%'; video.style.maxHeight = '620px'; video.style.borderRadius = '16px'; video.style.background = '#000';
        video.src = '/api/video/jobs/' + encodeURIComponent(jobId) + '/content?index=0';
        result.appendChild(video); actions.classList.remove('hidden'); return data;
      }
      if (['failed', 'cancelled', 'canceled', 'expired'].includes(status)) throw new Error(data.error || data.message || 'Video generation failed.');
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    throw new Error('Video generation timed out. Please try again.');
  }
  window.generateTool = async function (category, toolId) {
    const input = document.getElementById(category + 'ToolInput').value.trim();
    const result = document.getElementById(category + 'Result');
    const button = document.getElementById(category + 'GenerateButton');
    const actions = document.getElementById(category + 'ResultActions');
    if (!input) { showToast('Write what you want to create first.'); return; }
    button.classList.add('loading'); button.textContent = 'Generating...'; actions.classList.add('hidden'); result.textContent = 'Creating your result...';
    try {
      const data = await API.generateTool({ tool: toolId, type: category, input, prompt: input });
      if (data && data.video_job) { await pollVideoJob(data.video_job, result, actions); await refreshData(); return; }
      const output = typeof extractOutput === 'function' ? extractOutput(data) : (data && (data.output || data.result || data.text || data.content || data.message || ''));
      result.textContent = output || 'The AI returned an empty result.'; actions.classList.remove('hidden'); await refreshData();
    } catch (err) { result.textContent = 'Error: ' + (err.message || err); }
    finally { button.classList.remove('loading'); button.textContent = 'Generate'; }
  };
})();
</script>`;

app.get(['/', '/index.html'], (req, res, next) => {
  fs.readFile(path.join(process.cwd(), 'public', 'index.html'), 'utf8', (error, html) => {
    if (error) return next(error);
    res.type('html').send(html.replace('</body>', VIDEO_UI_PATCH + '</body>'));
  });
});
app.use(express.static('public'));
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'SQ AI', version: '3.3.0' }));
app.get('/api/plans', (req, res) => res.json(plans));

app.post('/api/auth/signup', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'valid_email_required' });
    if (password.length < 8) return res.status(400).json({ error: 'password_min_8_characters' });
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'email_already_registered' });
    const hash = await hashPassword(password);
    const result = db.prepare("INSERT INTO users (email, password_hash, plan, credits, updated_at) VALUES (?, ?, 'starter', ?, CURRENT_TIMESTAMP)").run(email, hash, plans.starter.credits);
    const user = getUserById(result.lastInsertRowid);
    const token = makeToken();
    db.prepare("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+30 days'))").run(user.id, hashToken(token));
    setSessionCookie(res, token);
    res.status(201).json({ user: publicUser(user) });
  } catch (e) { console.error('signup_error', e); res.status(500).json({ error: 'signup_failed' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ error: 'invalid_email_or_password' });
    if (!user.password_hash) return res.status(409).json({ error: 'legacy_account_requires_password_setup' });
    if (!(await verifyPassword(password, user.password_hash))) return res.status(401).json({ error: 'invalid_email_or_password' });
    const token = makeToken();
    db.prepare("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+30 days'))").run(user.id, hashToken(token));
    setSessionCookie(res, token);
    res.json({ user: publicUser(user) });
  } catch (e) { console.error('login_error', e); res.status(500).json({ error: 'login_failed' }); }
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req).adflow_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  clearSessionCookie(res); res.json({ ok: true });
});
app.post('/api/auth/set-password', auth, async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'password_min_8_characters' });
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(await hashPassword(password), req.user.id);
  res.json({ ok: true, message: 'password_created' });
});
app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(getUserById(req.user.id)) }));

// The old signup endpoint exposed an existing user's API key to anyone who knew their email.
// Keep the route only as a migration-safe response; do not create or reveal credentials.
app.post('/api/signup', (req, res) => res.status(410).json({ error: 'legacy_signup_disabled', message: 'Use /api/auth/signup.' }));

app.get('/api/usage', auth, (req, res) => {
  const total = db.prepare('SELECT COALESCE(SUM(units),0) total FROM usage WHERE user_id = ?').get(req.user.id);
  res.json({ credits: req.user.credits, total_units: total.total });
});

const TOOL_REGISTRY = {
  video: ['video_script','ad_video','product_video','shorts','long_to_shorts','hooks','voiceover','subtitles'],
  image: ['image_prompt','product_image','ad_creative','thumbnail','background','variations'],
  content: ['writer','ad_copy','content_hooks','captions','script','product_description','cta','rewrite','summarize','translate','content_calendar','persona','audience_analysis'],
  ads: ['campaign_generator','audience','strategy','ad_hooks','ad_copy_ads','creative_concepts','video_script_ads','campaign_cta','campaign_plan','competitor_analysis','budget_roas']
};
const TOOL_META = {
  video_script: ['video','AI Video Script'], ad_video: ['video','Ad Video'], product_video: ['video','Product Video'], shorts: ['video','Reels / Shorts'], long_to_shorts: ['video','Long Video → Shorts'], hooks: ['video','Video Hooks'], voiceover: ['video','Voice-over'], subtitles: ['video','Subtitles'],
  image_prompt: ['image','Text → Image'], product_image: ['image','Product Image'], ad_creative: ['image','Ad Creative'], thumbnail: ['image','Thumbnail'], background: ['image','Background'], variations: ['image','Creative Variations'],
  writer: ['content','AI Writer'], ad_copy: ['content','Ad Copy'], content_hooks: ['content','Hooks'], captions: ['content','Captions'], script: ['content','Scripts'], product_description: ['content','Product Description'], cta: ['content','CTA'], rewrite: ['content','Rewrite'], summarize: ['content','Summarize'], translate: ['content','Translate'], content_calendar: ['content','Content Calendar'], persona: ['content','Customer Persona'], audience_analysis: ['content','Audience Analysis'],
  campaign_generator: ['ads','Campaign Generator'], audience: ['ads','Audience'], strategy: ['ads','Strategy'], ad_hooks: ['ads','Ad Hooks'], ad_copy_ads: ['ads','Ad Copy'], creative_concepts: ['ads','Creative Concepts'], video_script_ads: ['ads','Video Script'], campaign_cta: ['ads','CTA'], campaign_plan: ['ads','Campaign Plan'], competitor_analysis: ['ads','Competitor Analysis'], budget_roas: ['ads','Budget / ROAS']
};
const TOOL_ALIASES = { 'ai-writer':'writer', 'ad-copy':'ad_copy', 'scripts':'script', 'campaign':'campaign_generator', 'product-description':'product_description' };
function allTools() { return Object.entries(TOOL_REGISTRY).flatMap(([category, ids]) => ids.map(id => ({ id, category, name: TOOL_META[id]?.[1] || id }))); }
function normalizeToolId(raw) { const value = String(raw || '').trim(); return TOOL_ALIASES[value] || value; }
function getTool(raw) { const id = normalizeToolId(raw); return allTools().find(t => t.id === id) || null; }
function providerStatus(type) {
  const envName = { text:'AI_TEXT_PROVIDER', image:'AI_IMAGE_PROVIDER', video:'AI_VIDEO_PROVIDER', audio:'AI_AUDIO_PROVIDER' }[type] || 'AI_TEXT_PROVIDER';
  return { configured:Boolean(process.env[envName]), provider:process.env[envName] || null, envName };
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_VIDEO_URL = 'https://openrouter.ai/api/v1/videos';
const OPENROUTER_DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
// Never silently choose a paid video model. Set OPENROUTER_VIDEO_MODEL explicitly after choosing one.
const OPENROUTER_VIDEO_DEFAULT_MODEL = process.env.OPENROUTER_VIDEO_MODEL || '';

function openRouterHeaders() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  return { Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json', 'HTTP-Referer':process.env.OPENROUTER_SITE_URL || 'https://sq-ai.bonto.run/', 'X-OpenRouter-Title':'SQ AI' };
}
function normalizeTextContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : (part?.text || part?.content || '')).join('').trim();
  return '';
}

async function callOpenRouter(prompt, options = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok:false, error:'provider_not_configured', message:'OPENROUTER_API_KEY is not configured.' };
  const body = { model: options.model || OPENROUTER_DEFAULT_MODEL, messages:[{role:'system',content:'You are SQ AI, a professional AI creation assistant. Produce useful, polished output. Follow the user request exactly.'},{role:'user',content:prompt}], temperature:options.temperature ?? 0.7, max_tokens:options.max_tokens ?? 1200 };
  try {
    const response = await fetch(OPENROUTER_URL, { method:'POST', headers:openRouterHeaders(), body:JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('openrouter_error', response.status, data);
      const error = data?.error || {};
      return { ok:false, error:response.status === 429 ? 'provider_rate_limited' : response.status === 401 || response.status === 403 ? 'provider_auth_failed' : 'provider_request_failed', message:error.message || `OpenRouter returned HTTP ${response.status}.`, status:response.status };
    }
    const output = normalizeTextContent(data?.choices?.[0]?.message?.content);
    if (!output) return { ok:false, error:'provider_empty_response', message:'OpenRouter returned an empty response.' };
    return { ok:true, output, provider:'openrouter', model:data?.model || body.model };
  } catch (error) {
    console.error('openrouter_network_error', error);
    return { ok:false, error:'provider_request_failed', message:'Could not reach OpenRouter.' };
  }
}

function normalizeVideoOptions(request = {}, toolId) {
  const aspectRatio = String(request.aspect_ratio || request.aspectRatio || (toolId === 'shorts' ? '9:16' : '16:9'));
  const duration = Math.max(4, Math.min(15, Number(request.duration || 4)));
  const resolution = String(request.resolution || '720p');
  const generateAudio = request.generate_audio === undefined ? false : Boolean(request.generate_audio);
  return { duration, resolution, aspect_ratio:aspectRatio, generate_audio:generateAudio };
}

async function submitOpenRouterVideo(prompt, options = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok:false, error:'provider_not_configured', message:'OPENROUTER_API_KEY is not configured.' };
  const model = options.model || OPENROUTER_VIDEO_DEFAULT_MODEL;
  if (!model) return { ok:false, error:'video_model_not_configured', message:'Set OPENROUTER_VIDEO_MODEL to a currently supported video model before generating videos.' };
  if (model.endsWith(':free')) return { ok:false, error:'video_model_invalid', message:'The configured video model uses a free/retired model slug. Choose a currently supported video model.' };
  const body = { model, prompt, duration:options.duration ?? 4, resolution:options.resolution || '720p', aspect_ratio:options.aspect_ratio || '16:9', generate_audio:options.generate_audio ?? false };
  try {
    const response = await fetch(OPENROUTER_VIDEO_URL, { method:'POST', headers:openRouterHeaders(), body:JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('openrouter_video_error', response.status, data);
      return { ok:false, error:response.status === 429 ? 'video_provider_rate_limited' : response.status === 401 || response.status === 403 ? 'video_provider_auth_failed' : 'video_generation_failed', message:data?.error?.message || `OpenRouter video API returned HTTP ${response.status}.`, status:response.status, upstream_status:response.status };
    }
    if (!data?.id) return { ok:false, error:'video_job_missing', message:'OpenRouter did not return a video job id.' };
    return { ok:true, job_id:data.id, status:data.status || 'pending', polling_url:data.polling_url || `${OPENROUTER_VIDEO_URL}/${data.id}`, provider:'openrouter', model:body.model, options:body };
  } catch (error) {
    console.error('openrouter_video_network_error', error);
    return { ok:false, error:'video_generation_failed', message:'Could not reach OpenRouter video API.' };
  }
}

async function getOpenRouterVideoJob(jobId) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok:false, error:'provider_not_configured', message:'OPENROUTER_API_KEY is not configured.' };
  try {
    const response = await fetch(`${OPENROUTER_VIDEO_URL}/${encodeURIComponent(jobId)}`, { headers:openRouterHeaders() });
    const raw = await response.text();
    let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw_response: raw.slice(0,2000) }; }
    if (!response.ok) return { ok:false, error:'video_job_status_failed', message:data?.error?.message || data?.message || `OpenRouter returned HTTP ${response.status} while checking the video job.`, status:response.status, upstream_status:response.status, details:data };
    return { ok:true, ...data };
  } catch (error) {
    console.error('openrouter_video_status_network_error', error);
    return { ok:false, error:'video_job_status_failed', message:'Could not reach OpenRouter video status endpoint.' };
  }
}

function buildToolPrompt(tool, input, request = {}) {
  const context = request.context ? `\nAdditional context:\n${String(request.context).slice(0,5000)}` : '';
  const instructions = {
    video_script:'Create a complete video script with hook, scene-by-scene visuals, spoken narration, on-screen text, and CTA.', ad_video:'Create a conversion-focused advertising video concept and script with hook, scenes, voice-over, text overlays, and CTA.', product_video:'Create a professional product video script showing the product, benefits, use cases, scenes, narration, and CTA.', shorts:'Create a short-form vertical video script optimized for Reels/Shorts, with a strong opening, fast pacing, and CTA.', long_to_shorts:'Turn the supplied idea or transcript into several short-video concepts. Give hooks, key segment, caption, and CTA for each.', hooks:'Generate 10 strong hooks tailored to the request. Keep them varied and scroll-stopping.', voiceover:'Write a natural voice-over script suitable for the requested video or advertisement.', subtitles:'Create concise subtitle-ready lines with natural breaks and readable pacing.', image_prompt:'Create a detailed professional image-generation prompt describing subject, composition, lighting, camera, style, environment, and quality.', product_image:'Create a premium product photography prompt with clean composition, realistic materials, lighting, and commercial presentation.', ad_creative:'Create a professional advertising visual concept and image prompt designed for conversion.', thumbnail:'Create a high-click thumbnail concept and image-generation prompt.', background:'Create a clean, realistic background prompt suitable for product or advertising creatives.', variations:'Create 5 distinct creative variations based on the request.', writer:'Write polished content for the request with clear structure and engaging language.', ad_copy:'Write conversion-focused ad copy with headline, primary text, benefits, and CTA.', content_hooks:'Generate strong content hooks tailored to the audience and topic.', captions:'Create engaging social-media captions with suitable CTA options.', script:'Write a complete content script with an engaging opening, useful body, and CTA.', product_description:'Write a persuasive product description highlighting benefits, features, audience, and CTA.', cta:'Generate 10 concise CTA options matched to the request.', rewrite:'Rewrite the supplied text to be clearer, stronger, and more professional while preserving its meaning.', summarize:'Summarize the supplied content into clear, useful key points.', translate:'Translate the supplied text accurately while preserving meaning, tone, and formatting.', content_calendar:'Create a practical 30-day content calendar with topics, formats, hooks, and CTAs.', persona:'Create a detailed customer persona including needs, pain points, motivations, objections, and messaging angles.', audience_analysis:'Analyze the target audience and provide demographics, pain points, desires, objections, and content angles.', campaign_generator:'Create a complete advertising campaign plan including objective, audience, offer, funnel, creatives, copy, and CTA.', audience:'Define the best target audience for the request with segments, interests, pain points, and buying triggers.', strategy:'Create a practical advertising strategy with positioning, funnel, creative direction, and optimization plan.', ad_hooks:'Generate high-converting advertising hooks for the request.', ad_copy_ads:'Create multiple ad-copy variants for testing, each with headline, primary text, and CTA.', creative_concepts:'Create multiple advertising creative concepts with visual direction and messaging.', video_script_ads:'Create a conversion-focused ad video script with scenes, narration, text overlays, and CTA.', campaign_cta:'Generate campaign CTA variants matched to the offer and audience.', campaign_plan:'Create a structured campaign plan covering objective, audience, offer, channels, creatives, budget logic, and KPIs.', competitor_analysis:'Create a competitor-analysis framework and actionable positioning recommendations based on the supplied information.', budget_roas:'Create a practical budget and ROAS planning framework with assumptions, KPIs, and optimization steps.'
  };
  return `${instructions[tool.id] || 'Create the best possible result for the request.'}\n\nUser request:\n${input}${context}\n\nReturn only the useful result, without discussing internal tools or providers.`;
}

const TEXT_TOOL_IDS = new Set(['video_script','hooks','voiceover','subtitles','long_to_shorts','writer','ad_copy','content_hooks','captions','script','product_description','cta','rewrite','summarize','translate','content_calendar','persona','audience_analysis','campaign_generator','audience','strategy','ad_hooks','ad_copy_ads','creative_concepts','video_script_ads','campaign_cta','campaign_plan','competitor_analysis','budget_roas']);
const VIDEO_GENERATION_TOOL_IDS = new Set(['ad_video','product_video','shorts']);
function isTextGenerationTool(tool) { return TEXT_TOOL_IDS.has(tool.id); }

async function aiEngine({ tool, type, input, request }) {
  if (VIDEO_GENERATION_TOOL_IDS.has(tool.id)) {
    if (!process.env.AI_VIDEO_PROVIDER) return { ok:false, error:'provider_not_configured', message:'No video AI provider is configured yet.', tool:tool.id, category:tool.category, engine:'SQ AI Engine', provider:null };
    if (process.env.AI_VIDEO_PROVIDER !== 'openrouter') return { ok:false, error:'provider_adapter_not_implemented', message:`Provider ${process.env.AI_VIDEO_PROVIDER} is configured but its video adapter is not implemented yet.`, tool:tool.id, category:tool.category, engine:'SQ AI Engine', provider:process.env.AI_VIDEO_PROVIDER };
    const promptResult = await callOpenRouter(buildToolPrompt(tool, input, request), { model:process.env.OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODEL, max_tokens:900 });
    if (!promptResult.ok) return promptResult;
    const videoPrompt = `Create the actual video described below. Do not return a script or explanation. Generate realistic, polished visual motion suitable for a commercial SaaS creator.\n\n${promptResult.output}`;
    return submitOpenRouterVideo(videoPrompt, { model:process.env.OPENROUTER_VIDEO_MODEL || OPENROUTER_VIDEO_DEFAULT_MODEL, ...normalizeVideoOptions(request, tool.id) });
  }
  const requestedKind = ['video','image','audio','text'].includes(type) ? type : null;
  const kind = isTextGenerationTool(tool) ? 'text' : (requestedKind || (tool.category === 'image' ? 'image' : 'text'));
  const status = providerStatus(kind);
  if (!status.configured) return { ok:false, error:'provider_not_configured', message:`No ${kind} AI provider is configured yet.`, tool:tool.id, category:tool.category, engine:'SQ AI Engine', provider:null };
  if (status.provider === 'openrouter' && kind === 'text') return callOpenRouter(buildToolPrompt(tool, input, request), { model:process.env.OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODEL });
  return { ok:false, error:'provider_adapter_not_implemented', message:`Provider ${status.provider} is configured but its ${kind} adapter is not implemented yet.`, tool:tool.id, category:tool.category, engine:'SQ AI Engine', provider:status.provider };
}

app.get('/api/tools', (req,res) => res.json({ tools:allTools(), registry:TOOL_REGISTRY }));
app.get('/api/diagnostics/ai', auth, (req,res) => {
  const videoModel = process.env.OPENROUTER_VIDEO_MODEL || null;
  res.json({ text:{provider:process.env.AI_TEXT_PROVIDER || null, api_key_configured:Boolean(process.env.OPENROUTER_API_KEY), model:OPENROUTER_DEFAULT_MODEL}, video:{provider:process.env.AI_VIDEO_PROVIDER || null, api_key_configured:Boolean(process.env.OPENROUTER_API_KEY), model:videoModel, configured:Boolean(videoModel)}, note:'Secrets are never returned.' });
});

app.post('/api/tools/generate', auth, generationLimit, async (req,res) => {
  const tool = getTool(req.body.tool);
  const input = String(req.body.input ?? req.body.prompt ?? '').trim().slice(0,12000);
  const requestedType = String(req.body.type || '').trim().toLowerCase();
  if (!tool) return res.status(400).json({ error:'unknown_tool', message:'The requested tool is not registered.' });
  if (!input) return res.status(400).json({ error:'input_required' });
  if (req.user.credits < 1) return res.status(402).json({ error:'credits_exhausted' });
  const result = await aiEngine({ tool, type:requestedType || tool.category, input, request:req.body });
  if (!result.ok) return res.status(result.status || 503).json(result);
  if (!spendCredit(req.user.id,'/api/tools/generate',tool.id)) return res.status(402).json({ error:'credits_exhausted' });
  if (result.job_id) {
    try {
      db.prepare('INSERT INTO video_jobs (user_id, provider_job_id, tool, model, status) VALUES (?, ?, ?, ?, ?)').run(req.user.id, result.job_id, tool.id, result.model || null, result.status || 'pending');
    } catch (error) {
      refundCredit(req.user.id,'/api/tools/generate-refund',tool.id);
      console.error('video_job_persist_error', error);
      return res.status(500).json({ error:'video_job_persist_failed', message:'The video was submitted but could not be registered safely. The credit was restored.' });
    }
    return res.status(202).json({ video_job:result.job_id, status:result.status, polling_url:`/api/video/jobs/${encodeURIComponent(result.job_id)}`, provider:result.provider, model:result.model, options:result.options, credits_remaining:getUserById(req.user.id).credits });
  }
  res.json({ output:result.output, data:result.output, provider:result.provider, model:result.model, credits_remaining:getUserById(req.user.id).credits });
});

function ownedVideoJob(userId, providerJobId) {
  return db.prepare('SELECT * FROM video_jobs WHERE user_id = ? AND provider_job_id = ?').get(userId, providerJobId);
}
app.get('/api/video/jobs/:id', auth, async (req,res) => {
  const job = ownedVideoJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error:'video_job_not_found' });
  const result = await getOpenRouterVideoJob(req.params.id);
  if (!result.ok) return res.status(result.status || 502).json(result);
  const status = String(result.status || job.status || 'pending');
  db.prepare('UPDATE video_jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, job.id);
  const payload = { id:result.id || req.params.id, status, provider:'openrouter', model:result.model || job.model || null, ready:status === 'completed' };
  if (result.error) payload.error = result.error;
  if (result.unsigned_urls) payload.video_url = result.unsigned_urls[0] || null;
  if (result.polling_url) payload.polling_url = result.polling_url;
  res.json(payload);
});

app.get('/api/video/jobs/:id/content', auth, async (req,res) => {
  if (!ownedVideoJob(req.user.id, req.params.id)) return res.status(404).json({ error:'video_job_not_found' });
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error:'provider_not_configured', message:'OPENROUTER_API_KEY is not configured.' });
  try {
    const index = Math.max(0, Math.min(9, Number(req.query.index || 0)));
    const response = await fetch(`${OPENROUTER_VIDEO_URL}/${encodeURIComponent(req.params.id)}/content?index=${index}`, { headers:openRouterHeaders() });
    if (!response.ok) {
      const data = await response.text(); let details = {}; try { details = data ? JSON.parse(data) : {}; } catch { details = { raw_response:data.slice(0,2000) }; }
      return res.status(response.status).json({ error:'video_content_not_ready', message:details?.error?.message || details?.message || 'Video content is not ready.', upstream_status:response.status, details });
    }
    res.setHeader('Content-Type', response.headers.get('content-type') || 'video/mp4');
    const contentLength = response.headers.get('content-length'); if (contentLength) res.setHeader('Content-Length', contentLength);
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('video_content_error', error); res.status(502).json({ error:'video_download_failed', message:'Could not download the generated video.' });
  }
});

app.post('/api/generate', auth, generationLimit, (req,res) => {
  if (!spendCredit(req.user.id,'/api/generate','legacy-generate')) return res.status(402).json({ error:'credits_exhausted' });
  const product = String(req.body.product || 'product').slice(0,200);
  const data = { hook:`Stop scrolling — discover ${product} made for people who want more.`, angles:['Problem → solution','Benefit-led','Social proof'], cta:'Try it today', formats:['9:16','1:1','16:9'] };
  res.json({ data, credits_remaining:getUserById(req.user.id).credits });
});

app.get('/api/projects', auth, (req,res) => res.json({ projects:db.prepare('SELECT id,type,title,input,output,created_at,updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC').all(req.user.id) }));
app.post('/api/projects', auth, (req,res) => {
  const type=String(req.body.type||'content').slice(0,50), title=String(req.body.title||'Untitled Project').slice(0,150);
  const input=req.body.input==null?'':JSON.stringify(req.body.input), output=req.body.output==null?'':JSON.stringify(req.body.output);
  const r=db.prepare('INSERT INTO projects (user_id,type,title,input,output) VALUES (?,?,?,?,?)').run(req.user.id,type,title,input,output);
  res.status(201).json({ project:db.prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid) });
});
app.get('/api/projects/:id', auth, (req,res) => { const project=db.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(Number(req.params.id),req.user.id); if(!project)return res.status(404).json({error:'project_not_found'}); res.json({project}); });
app.delete('/api/projects/:id', auth, (req,res) => { const r=db.prepare('DELETE FROM projects WHERE id=? AND user_id=?').run(Number(req.params.id),req.user.id); if(!r.changes)return res.status(404).json({error:'project_not_found'}); res.json({ok:true}); });

app.post('/api/campaigns/generate', auth, generationLimit, (req,res) => {
  if (req.user.credits < 1) return res.status(402).json({error:'credits_exhausted'});
  const product=String(req.body.product||'Your Product').slice(0,200), audience=String(req.body.audience||'General Audience').slice(0,200), platform=String(req.body.platform||'Facebook').slice(0,50);
  const campaign={product,audience,platform,objective:'Conversions',strategy:'Problem → Solution → Proof → CTA',hooks:[`Stop scrolling: ${product}`,`What if ${product} could solve your biggest problem?`,`People are choosing ${product} for a reason.`],ad_copy:`Discover ${product} designed for ${audience}.`,cta:'Get started today',formats:['9:16','1:1','16:9']};
  if(!spendCredit(req.user.id,'/api/campaigns/generate','campaign'))return res.status(402).json({error:'credits_exhausted'});
  db.prepare('INSERT INTO campaigns (user_id,name,data) VALUES (?,?,?)').run(req.user.id,`${product} Campaign`,JSON.stringify(campaign));
  res.json({campaign,credits_remaining:getUserById(req.user.id).credits});
});

app.post('/api/billing/checkout', auth, (req,res) => res.status(501).json({error:'payment_provider_not_configured',message:'Paddle integration is not connected yet.'}));
app.use((err,req,res,next) => { console.error('internal_error',err); res.status(500).json({error:'internal_error'}); });
const port=Number(process.env.PORT||3000);
app.listen(port,()=>console.log(`SQ AI listening on port ${port}`));
