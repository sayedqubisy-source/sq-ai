import express from 'express';

/** Route production video tools into the agent pipeline. */
if (!express.application.__sqaiAgentToolsBridge) {
  express.application.__sqaiAgentToolsBridge = true;

  const previousPost = express.application.post;
  const productionVideoTools = new Set([
    'video', 'ai-video', 'video-generator', 'reels', 'shorts',
    'long-shorts', 'text-video', 'image-video', 'ad-video',
    'product-video', 'video-ad', 'ai-video-generator'
  ]);

  function isProductionVideoTool(tool) {
    const normalized = String(tool || '').toLowerCase().trim();
    const isScriptTool =
      normalized.includes('script') ||
      normalized === 'video-hooks' ||
      normalized === 'hooks';

    return !isScriptTool && productionVideoTools.has(normalized);
  }

  async function forwardToAgent(req, res, next, original) {
    const tool = String(req.body?.tool || '').toLowerCase().trim();

    // Script generation stays on the text-first path. Only real production
    // tools are forwarded to the agent pipeline.
    if (!isProductionVideoTool(tool)) {
      return original(req, res, next);
    }

    try {
      const port = Number(process.env.PORT || 3000);
      const headers = { 'Content-Type': 'application/json' };

      if (req.headers.cookie) headers.Cookie = req.headers.cookie;
      if (req.headers['x-api-key']) headers['x-api-key'] = req.headers['x-api-key'];

      const body = {
        prompt: req.body?.prompt || req.body?.input,
        mode: 'video',
        aspectRatio:
          req.body?.aspectRatio ||
          (req.body?.format === '9:16' ? '9:16' : '16:9'),
        resolution: req.body?.resolution || '720p',
        voice: req.body?.voice === true,
        voiceId: req.body?.voiceId
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6 * 60_000);

      let response;
      try {
        response = await fetch(
          `http://127.0.0.1:${port}/api/agent/generate`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal
          }
        );
      } finally {
        clearTimeout(timer);
      }

      const data = await response
        .json()
        .catch(() => ({ error: 'agent_invalid_response' }));

      return res.status(response.status).json(data);
    } catch (error) {
      if (error?.name === 'AbortError') {
        return res.status(504).json({
          error: 'agent_timeout',
          message: 'إنتاج الفيديو استغرق وقتًا أطول من الحد المسموح.'
        });
      }
      return next(error);
    }
  }

  express.application.post = function patchedPost(route, ...handlers) {
    if (route === '/api/tools/generate' && handlers.length) {
      const last = handlers.length - 1;
      const original = handlers[last];

      handlers[last] = (req, res, next) =>
        forwardToAgent(req, res, next, original);
    }

    return previousPost.call(this, route, ...handlers);
  };

  console.log(
    'SQ AI Agent Tools Bridge loaded: production video tools -> agent pipeline; scripts stay text-first'
  );
}
