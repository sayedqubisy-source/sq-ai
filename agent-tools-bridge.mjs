import express from 'express';

if (!express.application.__sqaiAgentToolsBridge) {
  const previousPost = express.application.post;
  express.application.__sqaiAgentToolsBridge = true;
  express.application.post = function(route, ...handlers) {
    if (route === '/api/tools/generate' && handlers.length) {
      const original = handlers[handlers.length - 1];
      handlers[handlers.length - 1] = async (req, res, next) => {
        const tool = String(req.body?.tool || '').toLowerCase();
        const isVideo = tool.includes('video') || ['reels', 'shorts', 'long-shorts', 'text-video', 'image-video'].includes(tool);
        if (!isVideo) return original(req, res, next);
        try {
          const port = Number(process.env.PORT || 3000);
          const base = `http://127.0.0.1:${port}`;
          const headers = { 'Content-Type': 'application/json' };
          if (req.headers.cookie) headers.Cookie = req.headers.cookie;
          if (req.headers['x-api-key']) headers['x-api-key'] = req.headers['x-api-key'];
          const body = {
            prompt: req.body?.prompt || req.body?.input,
            mode: 'video',
            aspectRatio: req.body?.aspectRatio || (req.body?.format === '9:16' ? '9:16' : '16:9'),
            resolution: req.body?.resolution || '720p',
            voice: req.body?.voice === true,
            voiceId: req.body?.voiceId
          };
          const r = await fetch(`${base}/api/agent/generate`, { method: 'POST', headers, body: JSON.stringify(body) });
          const data = await r.json().catch(() => ({ error: 'agent_invalid_response' }));
          return res.status(r.status).json(data);
        } catch (e) {
          return next(e);
        }
      };
    }
    return previousPost.call(this, route, ...handlers);
  };
}

console.log('SQ AI Agent Tools Bridge loaded: video tools -> agent pipeline');
