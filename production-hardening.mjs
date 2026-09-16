import crypto from 'node:crypto';
import express from 'express';

if (!express.application.__sqaiProductionHardening) {
  express.application.__sqaiProductionHardening = true;
  const buckets = new Map();
  const limits = [
    { prefix: '/api/auth/', windowMs: 15 * 60 * 1000, max: 12 },
    { prefix: '/api/tools/generate', windowMs: 60 * 1000, max: 12 },
    { prefix: '/api/v1/videos', windowMs: 60 * 1000, max: 6 },
    { prefix: '/api/', windowMs: 60 * 1000, max: 120 },
  ];

  express.application.use.call(express.application, (req, res, next) => {
    const id = crypto.randomUUID();
    res.setHeader('X-Request-Id', id);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');

    if (!req.path.startsWith('/api/')) return next();
    const rule = limits.find(item => req.path === item.prefix || req.path.startsWith(item.prefix));
    if (!rule) return next();
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const key = `${rule.prefix}:${forwarded || req.socket.remoteAddress || 'unknown'}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= rule.windowMs) {
      buckets.set(key, { startedAt: now, count: 1 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > rule.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.startedAt + rule.windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'rate_limited', retry_after_seconds: retryAfter });
    }
    next();
  });

  setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [key, bucket] of buckets) if (bucket.startedAt < cutoff) buckets.delete(key);
  }, 60 * 1000).unref();
}
