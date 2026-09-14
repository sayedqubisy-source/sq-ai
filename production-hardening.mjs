import express from 'express';
import crypto from 'node:crypto';

// Lightweight process-local protection. It is intentionally fail-open for static assets,
// but strict for API/auth/generation endpoints. Secrets are never logged.
const originalUse = express.application.use;
if (!express.application.__sqaiProductionHardening) {
  express.application.__sqaiProductionHardening = true;
  const buckets = new Map();
  const now = () => Date.now();
  const clientKey = req => {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || req.socket?.remoteAddress || 'unknown';
  };
  const limits = (req) => {
    const p = req.path || '';
    if (p.startsWith('/api/auth/')) return {window: 15 * 60_000, max: 12};
    if (p === '/api/tools/generate' || p === '/api/v1/videos') return {window: 60_000, max: 12};
    if (p.startsWith('/api/')) return {window: 60_000, max: 120};
    return null;
  };
  const guard = (req, res, next) => {
    const rule = limits(req);
    if (!rule) return next();
    const key = `${clientKey(req)}:${req.path}`;
    const t = now();
    let b = buckets.get(key);
    if (!b || b.reset <= t) b = {count: 0, reset: t + rule.window};
    b.count++;
    buckets.set(key, b);
    res.setHeader('X-RateLimit-Limit', String(rule.max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, rule.max - b.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(b.reset / 1000)));
    if (b.count > rule.max) return res.status(429).json({error:'rate_limit_exceeded',message:'Too many requests. Please try again shortly.'});
    next();
  };
  const headers = (req, res, next) => {
    res.setHeader('X-Request-Id', crypto.randomUUID());
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
  const cleanup = setInterval(() => {
    const t = now();
    for (const [k, b] of buckets) if (b.reset <= t) buckets.delete(k);
  }, 60_000);
  cleanup.unref?.();
  express.application.use = function patchedUse(first, ...handlers) {
    if (typeof first === 'function') {
      return originalUse.call(this, headers, guard, first, ...handlers);
    }
    return originalUse.call(this, first, ...handlers);
  };
  console.log('SQ AI Production Hardening loaded: rate limits + security headers + abuse protection');
}
