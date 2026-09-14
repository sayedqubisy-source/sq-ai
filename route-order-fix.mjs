// SQ AI runtime compatibility and lightweight abuse protection for Express 5.
const express = await import('express');
const currentListen = express.application.listen;

if (!currentListen.__sqAiRouteOrderFix) {
  const wrapped = function (...args) {
    const server = currentListen.apply(this, args);
    const router = this?.router || this?._router;
    if (!router?.stack) return server;

    // Runtime hooks register some routes at listen-time. Move only those routes
    // ahead of server.js's API 404 fallback without changing normal app order.
    const wanted = new Set([
      '/api/ai/providers',
      '/api/ai/route',
      '/api/ai/status',
      '/api/ai/capabilities',
      '/api/tools/discovery',
      '/api/webhooks/paddle',
      '/tools'
    ]);
    const selected = [];
    router.stack = router.stack.filter(layer => {
      const path = layer?.route?.path;
      if (wanted.has(path)) { selected.push(layer); return false; }
      return true;
    });
    if (selected.length) router.stack.unshift(...selected);

    // Global API rate guard. Conservative in-memory protection, no paid dependency.
    const buckets = new Map();
    const WINDOW_MS = 60_000;
    const MAX_API_REQUESTS = 120;
    const limiter = (req,res,next) => {
      if (!req.path?.startsWith('/api/')) return next();
      const now = Date.now();
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const ip = String(forwarded || req.ip || req.socket?.remoteAddress || 'unknown').slice(0,100);
      let bucket = buckets.get(ip);
      if (!bucket || now - bucket.started >= WINDOW_MS) bucket = { started: now, count: 0 };
      bucket.count += 1;
      buckets.set(ip,bucket);
      res.setHeader('X-Request-Limit',String(MAX_API_REQUESTS));
      res.setHeader('X-Request-Remaining',String(Math.max(0,MAX_API_REQUESTS-bucket.count)));
      if (bucket.count > MAX_API_REQUESTS) {
        res.setHeader('Retry-After','60');
        return res.status(429).json({error:'rate_limit_exceeded',message:'Too many requests. Please try again shortly.'});
      }
      next();
    };
    this.use(limiter);
    const limitLayer = router.stack.pop();
    if (limitLayer) router.stack.unshift(limitLayer);

    const cleanup = setInterval(() => {
      const cutoff = Date.now() - WINDOW_MS;
      for (const [ip,bucket] of buckets) if (bucket.started < cutoff) buckets.delete(ip);
    }, WINDOW_MS).unref();
    server.on('close', () => clearInterval(cleanup));
    return server;
  };
  wrapped.__sqAiRouteOrderFix = true;
  express.application.listen = wrapped;
}
