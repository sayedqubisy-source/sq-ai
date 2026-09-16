import express from 'express';
import { generateText, runtimeStatus } from '../ai/runtime.mjs';
import { requireAuth, consumeCredit, remainingCredits } from '../auth/service.mjs';

const router = express.Router();
const clean = (value, max) => String(value ?? '').trim().slice(0, max);
router.get('/runtime', (_req, res) => res.json(runtimeStatus()));
router.use(requireAuth);

router.post('/generate', async (req, res, next) => {
  const prompt = clean(req.body?.prompt || req.body?.input, 12000);
  if (!prompt) return res.status(400).json({ error: 'prompt_required' });
  if (remainingCredits(req.user.id) < 1) return res.status(402).json({ error: 'credits_exhausted' });
  try {
    const result = await generateText({ messages: [
      { role: 'system', content: `You are SQ AI. Produce the finished output for capability ${clean(req.body?.capability, 80) || 'text'}.` },
      { role: 'user', content: prompt },
    ], model: clean(req.body?.model, 150) || undefined });
    if (!consumeCredit(req.user.id, `ai:${clean(req.body?.capability, 80) || 'text'}`)) return res.status(402).json({ error: 'credits_exhausted' });
    res.json({ result: result.text, provider: result.provider, model: result.model, credits_remaining: remainingCredits(req.user.id) });
  } catch (error) { next(error); }
});

export default router;
