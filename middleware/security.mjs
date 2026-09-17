import crypto from 'node:crypto';
import { env } from '../config/env.mjs';

const buckets = new Map();
const rules = [
  { prefix: '/api/auth/', windowMs: 15 * 60_000, max: 12 },
  { prefix: '/api/tools/generate', windowMs: 60_000, max: 15 },
  { prefix: '/api/agent/generate', windowMs: 60_000, max: 6 },
  { prefix: '/api/', windowMs: 60_000, max: 120 },
];

export function securityMiddleware(req, res, next) {
  const suppliedRequestId = req.get('x-request-id') || '';
  const requestId = /^[A-Za-z0-9._:-]{1,100}$/.test(suppliedRequestId) ? suppliedRequestId : crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' blob: https:; connect-src 'self'");
  if (env.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (!req.path.startsWith('/api/')) return next();
  res.setHeader('Cache-Control', 'no-store');

  const rule = rules.find(item => req.path === item.prefix || req.path.startsWith(item.prefix));
  if (!rule) return next();
  const key = `${rule.prefix}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.startedAt >= rule.windowMs) bucket = { startedAt: now, count: 0 };
  bucket.count += 1;
  buckets.set(key, bucket);
  const remaining = Math.max(0, rule.max - bucket.count);
  res.setHeader('X-RateLimit-Limit', String(rule.max));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  if (bucket.count <= rule.max) return next();
  const retryAfter = Math.max(1, Math.ceil((bucket.startedAt + rule.windowMs - now) / 1000));
  res.setHeader('Retry-After', String(retryAfter));
  return res.status(429).json({ error: 'rate_limited', retry_after_seconds: retryAfter });
}

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [key, bucket] of buckets) if (bucket.startedAt < cutoff) buckets.delete(key);
}, 60_000);
cleanupTimer.unref();

export function stopSecurityCleanup() {
  clearInterval(cleanupTimer);
}
