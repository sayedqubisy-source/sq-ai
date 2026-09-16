import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './config/env.mjs';
import { db, closeDatabase, cleanupSessions } from './database/index.mjs';
import { findUser, requireAuth, consumeCredit, remainingCredits } from './auth/service.mjs';
import { generateText } from './ai/runtime.mjs';
import { mediaRoot, videoRoot } from './media/store.mjs';
import authRoutes from './routes/auth.mjs';
import projectRoutes from './routes/projects.mjs';
import aiRoutes from './routes/ai.mjs';
import agentRoutes from './routes/agent.mjs';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

const plans = {
  starter: { name: 'Starter', credits: 100, price_usd: 19 },
  growth: { name: 'Growth', credits: 500, price_usd: 49 },
  scale: { name: 'Scale', credits: 2000, price_usd: 149 },
};

function clean(value, max) { return String(value ?? '').trim().slice(0, max); }

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/health', (_req, res) => {
  let database = 'ok';
  try { db.prepare('SELECT 1 AS ok').get(); } catch { database = 'error'; }
  res.json({ ok: database === 'ok', service: 'SQ AI', version: '5.1.0', database, video_mode: env.paidVideoEnabled ? 'paid' : 'free' });
});
app.get('/api/plans', (_req, res) => res.json(plans));
app.use('/api', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/agent', agentRoutes);

// Internal bridge used by the asynchronous video worker. The bridge secret is
// generated per process unless explicitly supplied by the deployment environment.
// The old public bearer token was intentionally removed because it was exposed in
// the repository and could be replayed by an external caller.
const videoBridgeSecret = process.env.SQ_AI_VIDEO_BRIDGE_SECRET || globalThis.__sqAiVideoBridgeSecret;
app.post('/api/v1/videos', async (req, res) => {
  const suppliedSecret = req.get('x-sq-ai-internal-secret');
  if (!videoBridgeSecret || !suppliedSecret || suppliedSecret !== videoBridgeSecret) {
    return res.status(401).json({ error: 'internal_video_route' });
  }
  const prompt = clean(req.body?.prompt || req.body?.input, 6000);
  if (!prompt) return res.status(400).json({ error: 'prompt_required' });
  try {
    const response = await fetch(`http://127.0.0.1:${env.port}/api/v1/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SQ-AI-Provider-Bridge': '1', 'X-SQ-AI-Internal-Secret': videoBridgeSecret },
      body: JSON.stringify({ prompt, platform: clean(req.body?.platform, 50) || 'vertical', tool: clean(req.body?.tool, 100) }),
    });
    const text = await response.text();
    res.status(response.status).type(response.headers.get('content-type') || 'application/json').send(text);
  } catch (error) {
    res.status(502).json({ error: 'video_provider_request_failed', message: error?.message || 'Video provider request failed.' });
  }
});

app.post('/api/tools/generate', requireAuth, async (req, res, next) => {
  const tool = clean(req.body?.tool, 100).toLowerCase();
  const prompt = clean(req.body?.prompt || req.body?.input, 12000);
  if (!tool || !prompt) return res.status(400).json({ error: 'tool_and_prompt_required' });
  if (remainingCredits(req.user.id) < 1) return res.status(402).json({ error: 'credits_exhausted' });
  try {
    const result = await generateText({ messages: [
      { role: 'system', content: `You are SQ AI. Complete the ${tool} task. Return production-ready content only.` },
      { role: 'user', content: prompt },
    ] });
    if (!consumeCredit(req.user.id, `tool:${tool}`)) return res.status(402).json({ error: 'credits_exhausted' });
    res.json({ result: result.text, provider: result.provider, model: result.model, credits_remaining: remainingCredits(req.user.id) });
  } catch (error) { next(error); }
});

app.post('/api/campaigns/generate', requireAuth, async (req, res, next) => {
  const input = clean(req.body?.input || req.body?.prompt || req.body?.product, 12000);
  if (!input) return res.status(400).json({ error: 'input_required' });
  if (remainingCredits(req.user.id) < 1) return res.status(402).json({ error: 'credits_exhausted' });
  try {
    const result = await generateText({ messages: [
      { role: 'system', content: 'You are SQ AI marketing strategist. Build a practical campaign with audience, offer, angles, creatives, copy, CTA, and measurement plan.' },
      { role: 'user', content: input },
    ] });
    if (!consumeCredit(req.user.id, 'campaign:generate')) return res.status(402).json({ error: 'credits_exhausted' });
    res.json({ result: result.text, provider: result.provider, model: result.model, credits_remaining: remainingCredits(req.user.id) });
  } catch (error) { next(error); }
});

app.post('/api/billing/checkout', requireAuth, (_req, res) => res.status(501).json({ error: 'payment_provider_not_configured' }));

function protectMedia(req, res, next) {
  if (!findUser(req)) return res.status(401).json({ error: 'authentication_required' });
  next();
}

fs.mkdirSync(mediaRoot, { recursive: true });
fs.mkdirSync(videoRoot, { recursive: true });
app.use('/generated-media', protectMedia, express.static(mediaRoot, { fallthrough: false, maxAge: '1h' }));
app.use('/generated-videos', protectMedia, express.static(videoRoot, { fallthrough: false, maxAge: '1h' }));

app.use(express.static(path.resolve('public'), { etag: true, lastModified: true, maxAge: 0 }));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  next();
});

app.use((error, _req, res, _next) => {
  console.error('sqai_error', error);
  res.status(Number(error?.status) || 500).json({ error: error?.code || 'server_error', message: env.isProduction ? 'Request failed.' : error?.message });
});

cleanupSessions();
const cleanupTimer = setInterval(cleanupSessions, 6 * 60 * 60 * 1000);
cleanupTimer.unref();

const server = app.listen(env.port, '0.0.0.0', () => console.log(`SQ AI listening on 0.0.0.0:${env.port}`));

function shutdown(signal) {
  console.log(`SQ AI shutting down (${signal})`);
  clearInterval(cleanupTimer);
  server.close(() => { closeDatabase(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
