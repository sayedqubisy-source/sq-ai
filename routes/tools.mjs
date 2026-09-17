import crypto from 'node:crypto';
import express from 'express';
import { db } from '../database/index.mjs';
import { env } from '../config/env.mjs';
import { requireAuth, consumeCredit, refundCredit, remainingCredits } from '../auth/service.mjs';
import { generateText } from '../ai/runtime.mjs';
import { generateImage, generateVideo } from '../agent/service.mjs';
import { freeVideo } from '../video-fix.mjs';
import { generateMusic } from '../media/music.mjs';
import { enhanceMediaPrompt, mediaToolGroups } from '../prompts/media.mjs';

const router = express.Router();
const { IMAGE_TOOLS, VIDEO_TOOLS, MUSIC_TOOLS } = mediaToolGroups;
const aliases = Object.freeze({ video_script: 'script-video', ad_video: 'ad-video', product_video: 'product-video', shorts: 'reels', long_to_shorts: 'long-shorts', hooks: 'hooks-video' });
const clean = (value, max) => String(value ?? '').trim().slice(0, max);
const normalizeTool = value => aliases[clean(value, 100).toLowerCase()] || clean(value, 100).toLowerCase();

function createVideoJob(userId, tool, prompt, language, platform) {
  const id = crypto.randomUUID();
  return db.transaction(() => {
    const reserved = db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>0').run(userId);
    if (!reserved.changes) return null;
    db.prepare(`INSERT INTO video_jobs(id,user_id,tool,prompt,language,platform,status,provider,credits_reserved,started_at)
      VALUES(?,?,?,?,?,?,'running',?,1,CURRENT_TIMESTAMP)`).run(id, userId, tool, prompt, language, platform, env.paidVideoEnabled ? 'paid-video' : 'huggingface-zero-gpu');
    return id;
  })();
}

function completeVideoJob(id, url, provider) {
  db.transaction(() => {
    const job = db.prepare("SELECT * FROM video_jobs WHERE id=? AND status='running'").get(id);
    if (!job || !job.credits_reserved) return;
    db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(job.user_id, `tool:${job.tool}`);
    const credits = remainingCredits(job.user_id);
    db.prepare("UPDATE video_jobs SET status='completed',video_url=?,provider=?,error=NULL,credits_reserved=0,credits_remaining=?,completed_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(url, provider || job.provider, credits, id);
  })();
}

function failVideoJob(id, error) {
  db.transaction(() => {
    const job = db.prepare("SELECT * FROM video_jobs WHERE id=? AND status='running'").get(id);
    if (!job) return;
    if (job.credits_reserved) db.prepare('UPDATE users SET credits=credits+1 WHERE id=?').run(job.user_id);
    const credits = remainingCredits(job.user_id);
    db.prepare("UPDATE video_jobs SET status='failed',error=?,credits_reserved=0,credits_remaining=?,completed_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(clean(error?.message || error || 'video_generation_failed', 500), credits, id);
  })();
}

async function runVideoJob(id) {
  const job = db.prepare('SELECT * FROM video_jobs WHERE id=?').get(id);
  if (!job) return;
  try {
    if (env.paidVideoEnabled) {
      const aspectRatio = /vertical|tiktok|reels|shorts|9:16/i.test(job.platform) ? '9:16' : '16:9';
      const result = await generateVideo(job.prompt, { aspectRatio, resolution: '720p' });
      return completeVideoJob(id, result.url, result.provider);
    }
    const response = await freeVideo({ prompt: job.prompt, platform: job.platform, tool: job.tool });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || data?.message || data?.error?.code || `video_provider_${response.status}`);
    if (!data.video_url) throw new Error('video_provider_invalid_output');
    completeVideoJob(id, data.video_url, data.provider);
  } catch (error) {
    console.error('sqai_video_job_failed', { id, error: error?.message || String(error) });
    failVideoJob(id, error);
  }
}

router.use(requireAuth);

router.post('/generate', async (req, res, next) => {
  const tool = normalizeTool(req.body?.tool);
  const prompt = clean(req.body?.prompt || req.body?.input, 12000);
  if (!tool || !prompt) return res.status(400).json({ error: 'tool_and_prompt_required' });
  const enhancedPrompt = enhanceMediaPrompt(tool, prompt, req.body);

  if (VIDEO_TOOLS.has(tool)) {
    const id = createVideoJob(req.user.id, tool, enhancedPrompt, clean(req.body?.language, 50), clean(req.body?.platform || req.body?.aspectRatio, 50));
    if (!id) return res.status(402).json({ error: 'credits_exhausted' });
    setImmediate(() => runVideoJob(id));
    return res.status(202).json({ async: true, job_id: id, status: 'running', provider: env.paidVideoEnabled ? 'paid-video' : 'huggingface-zero-gpu', free: !env.paidVideoEnabled, credits_reserved: 1 });
  }

  const endpoint = `tool:${tool}`;
  if (!consumeCredit(req.user.id, endpoint)) return res.status(402).json({ error: 'credits_exhausted' });
  try {
    if (IMAGE_TOOLS.has(tool)) {
      const ratio = ['1:1', '9:16', '16:9'].includes(req.body?.aspectRatio) ? req.body.aspectRatio : '1:1';
      const result = await generateImage(enhancedPrompt, ratio);
      return res.json({ ok: true, result: result.url, image_url: result.url, provider: result.provider, model: result.model, credits_remaining: remainingCredits(req.user.id) });
    }
    if (MUSIC_TOOLS.has(tool)) {
      const result = await generateMusic(enhancedPrompt);
      return res.json({ ok: true, result: result.url, audio_url: result.url, provider: result.provider, model: result.model, credits_remaining: remainingCredits(req.user.id) });
    }
    const result = await generateText({ messages: [
      { role: 'system', content: `You are SQ AI. Complete the ${tool} task and return production-ready content only.` },
      { role: 'user', content: prompt },
    ] });
    return res.json({ result: result.text, provider: result.provider, model: result.model, credits_remaining: remainingCredits(req.user.id) });
  } catch (error) {
    refundCredit(req.user.id, endpoint);
    return next(error);
  }
});

router.get('/video-job/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM video_jobs WHERE id=?').get(clean(req.params.id, 100));
  if (!job) return res.status(404).json({ error: 'video_job_not_found' });
  if (Number(job.user_id) !== Number(req.user.id)) return res.status(403).json({ error: 'forbidden' });
  return res.json({ job_id: job.id, status: job.status, result: job.video_url || null, video_url: job.video_url || null, provider: job.provider, credits_remaining: job.credits_remaining ?? null, error: job.error || null, attempts: Number(job.attempts || 0), max_attempts: Number(job.max_attempts || 1), created_at: job.created_at, started_at: job.started_at, completed_at: job.completed_at });
});

export function recoverVideoJobs() {
  const jobs = db.prepare("SELECT id FROM video_jobs WHERE status='running'").all();
  for (const job of jobs) failVideoJob(job.id, 'video_job_interrupted_by_restart');
}

export function cleanupVideoJobs() {
  db.prepare("DELETE FROM video_jobs WHERE completed_at IS NOT NULL AND completed_at < datetime('now','-24 hours')").run();
}

export default router;
