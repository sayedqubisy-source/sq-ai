import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './config/env.mjs';
import { db, closeDatabase, cleanupSessions } from './database/index.mjs';
import { findUser, plans, requireAuth, consumeCredit, refundCredit, remainingCredits } from './auth/service.mjs';
import { createCheckout, registerBillingWebhook } from './billing-fix.mjs';
import { generateText } from './ai/runtime.mjs';
import { mediaRoot, videoRoot } from './media/store.mjs';
import { securityMiddleware, stopSecurityCleanup } from './middleware/security.mjs';
import authRoutes from './routes/auth.mjs';
import projectRoutes from './routes/projects.mjs';
import aiRoutes from './routes/ai.mjs';
import agentRoutes from './routes/agent.mjs';
import toolsRoutes, { cleanupVideoJobs, recoverVideoJobs } from './routes/tools.mjs';

const app = express();
const clean = (value, max) => String(value ?? '').trim().slice(0, max);
app.disable('x-powered-by');
app.set('trust proxy', env.trustProxy);
app.use(securityMiddleware);
registerBillingWebhook(app);
// Image-to-video accepts an authenticated base64 image (8 MB max before
// encoding). Keep this bounded so uploads cannot grow request memory freely.
app.use(express.json({ limit: '12mb' }));

app.get('/api/health', (_req, res) => {
  let database = 'ok';
  try { db.prepare('SELECT 1 AS ok').get(); } catch { database = 'error'; }
  res.status(database === 'ok' ? 200 : 503).json({ ok: database === 'ok', service: 'SQ AI', version: '5.2.0', database, video_mode: env.paidVideoEnabled ? 'paid' : 'free', uptime_seconds: Math.floor(process.uptime()) });
});
app.get('/api/plans', (_req, res) => res.json(plans));
app.use('/api', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/tools', toolsRoutes);

app.post('/api/campaigns/generate', requireAuth, async (req, res, next) => {
  const input = clean(req.body?.input || req.body?.prompt || req.body?.product, 12000);
  if (!input) return res.status(400).json({ error: 'input_required' });
  if (!consumeCredit(req.user.id, 'campaign:generate')) return res.status(402).json({ error: 'credits_exhausted' });
  try {
    const result = await generateText({ messages: [
      { role: 'system', content: 'You are SQ AI marketing strategist. Build a practical campaign with audience, offer, angles, creatives, copy, CTA, and measurement plan.' },
      { role: 'user', content: input },
    ] });
    res.json({ result: result.text, provider: result.provider, model: result.model, credits_remaining: remainingCredits(req.user.id) });
  } catch (error) { refundCredit(req.user.id, 'campaign:generate'); next(error); }
});

app.post('/api/billing/checkout', requireAuth, createCheckout);

function protectMedia(req, res, next) {
  if (!findUser(req)) return res.status(401).json({ error: 'authentication_required' });
  res.setHeader('Cache-Control', 'private, no-store');
  next();
}

fs.mkdirSync(mediaRoot, { recursive: true });
fs.mkdirSync(videoRoot, { recursive: true });
app.use('/generated-media', protectMedia, express.static(mediaRoot, { fallthrough: false, cacheControl: false }));
app.use('/generated-videos', protectMedia, express.static(videoRoot, { fallthrough: false, cacheControl: false }));

app.use(express.static(path.resolve('public'), {
  etag: true,
  lastModified: true,
  maxAge: '1h',
  setHeaders(res, file) {
    if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  next();
});

app.use((error, _req, res, _next) => {
  console.error('sqai_error', error);
  const requestedStatus = Number(error?.status);
  const status = requestedStatus >= 400 && requestedStatus <= 599 ? requestedStatus : 500;
  res.status(status).json({ error: error?.code || 'server_error', message: env.isProduction ? 'Request failed.' : error?.message });
});

cleanupSessions();
recoverVideoJobs();
function cleanupGeneratedFiles(directory) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(directory, entry.name);
    try { if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true }); } catch (error) { console.warn('sqai_cleanup_file_failed', { file: entry.name, error: error?.message }); }
  }
}
function maintenance() {
  cleanupSessions();
  cleanupVideoJobs();
  cleanupGeneratedFiles(mediaRoot);
  cleanupGeneratedFiles(videoRoot);
}
const cleanupTimer = setInterval(maintenance, 6 * 60 * 60 * 1000);
cleanupTimer.unref();

const server = app.listen(env.port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'sqai_started', host: '0.0.0.0', port: env.port, env: env.nodeEnv, pid: process.pid })));
server.on('error', error => {
  console.error('sqai_listen_failed', error);
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`SQ AI shutting down (${signal})`);
  clearInterval(cleanupTimer);
  stopSecurityCleanup();
  server.close(() => { closeDatabase(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', error => { console.error('sqai_unhandled_rejection', error); shutdown('unhandledRejection'); });
process.on('uncaughtException', error => { console.error('sqai_uncaught_exception', error); shutdown('uncaughtException'); });
