import express from 'express';
import { runAgent } from '../agent/service.mjs';
import { requireAuth, consumeCredit, refundCredit, remainingCredits } from '../auth/service.mjs';

const router = express.Router();
const clean = (value, max) => String(value ?? '').trim().slice(0, max);
router.use(requireAuth);

router.post('/generate', async (req, res) => {
  const prompt = clean(req.body?.prompt || req.body?.input, 16000);
  if (!prompt) return res.status(400).json({ error: 'prompt_required' });
  if (remainingCredits(req.user.id) < 1) return res.status(402).json({ error: 'credits_exhausted' });

  const mode = ['video', 'image', 'voice', 'all'].includes(req.body?.mode) ? req.body.mode : 'video';
  const endpoint = `agent:${mode}`;
  if (!consumeCredit(req.user.id, endpoint)) return res.status(402).json({ error: 'credits_exhausted' });

  try {
    const result = await runAgent(prompt, {
      mode,
      voice: req.body?.voice === true,
      voiceId: clean(req.body?.voiceId, 200) || undefined,
      aspectRatio: req.body?.aspectRatio === '9:16' ? '9:16' : '16:9',
      resolution: ['720p', '1080p', '4k'].includes(req.body?.resolution) ? req.body.resolution : '720p',
      maxImages: Math.min(3, Math.max(1, Number(req.body?.maxImages) || 3)),
    });
    const hasVideo = result.outputs.some(item => item.type === 'video');
    const hasRequestedOutput = mode === 'video' ? hasVideo : result.outputs.length > 0;
    if (!hasRequestedOutput) throw Object.assign(new Error(result.warnings?.[0]?.error || 'agent_generation_failed'), { status: 502 });
    res.json({ ok: true, mode, ...result, credits_remaining: remainingCredits(req.user.id) });
  } catch (error) {
    try { refundCredit(req.user.id, endpoint); } catch {}
    res.status(Number(error?.status) || 502).json({ error: error?.message || 'agent_generation_failed', credits_remaining: remainingCredits(req.user.id) });
  }
});

export default router;
