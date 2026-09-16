import express from 'express';
import crypto from 'node:crypto';

/** Process-local production safeguards loaded before application routes. */
if (!express.application.__sqaiProductionHardening) {
  express.application.__sqaiProductionHardening = true;

  const buckets = new Map();
  const originalUse = express.application.use;
  const originalRoutes = {};

  const now = () => Date.now();

  function clientKey(req) {
    if (process.env.TRUST_PROXY === 'true') {
      const forwarded = String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim();
      if (forwarded) return forwarded;
    }
    return req.socket?.remoteAddress || 'unknown';
  }

  function limitFor(req) {
    const route = req.path || '';
    const method = req.method || 'GET';

    if (route.startsWith('/api/auth/')) {
      return { window: 15 * 60_000, max: 12 };
    }

    if (
      method === 'POST' &&
      (route === '/api/tools/generate' || route === '/api/v1/videos')
    ) {
      return { window: 60_000, max: 12 };
    }

    if (route.startsWith('/api/')) {
      return { window: 60_000, max: 120 };
    }

    return null;
  }

  function rateLimit(req, res, next) {
    const rule = limitFor(req);
    if (!rule) return next();

    const key = `${clientKey(req)}:${req.method}:${req.path}`;
    const timestamp = now();
    let bucket = buckets.get(key);

    if (!bucket || bucket.reset <= timestamp) {
      bucket = { count: 0, reset: timestamp + rule.window };
    }

    bucket.count += 1;
    buckets.set(key, bucket);

    res.setHeader('X-RateLimit-Limit', String(rule.max));
    res.setHeader(
      'X-RateLimit-Remaining',
      String(Math.max(0, rule.max - bucket.count))
    );
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.reset / 1000)));

    if (bucket.count > rule.max) {
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        message: 'Too many requests. Please try again shortly.'
      });
    }

    return next();
  }

  function securityHeaders(req, res, next) {
    res.setHeader('X-Request-Id', crypto.randomUUID());
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    }

    return next();
  }

  // app.use() middleware gets the safeguards first.
  express.application.use = function patchedUse(first, ...handlers) {
    if (typeof first === 'function') {
      return originalUse.call(
        this,
        securityHeaders,
        rateLimit,
        first,
        ...handlers
      );
    }
    return originalUse.call(this, first, ...handlers);
  };

  // Route handlers do not automatically pass through app.use(). Protect API
  // routes at registration time, including routes registered by later modules.
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const original = express.application[method];
    originalRoutes[method] = original;

    express.application[method] = function patchedRoute(route, ...handlers) {
      if (
        typeof route === 'string' &&
        route.startsWith('/api/') &&
        handlers.length
      ) {
        return original.call(
          this,
          route,
          securityHeaders,
          rateLimit,
          ...handlers
        );
      }
      return original.call(this, route, ...handlers);
    };
  }

  const cleanup = setInterval(() => {
    const timestamp = now();
    for (const [key, bucket] of buckets) {
      if (bucket.reset <= timestamp) buckets.delete(key);
    }
  }, 60_000);

  cleanup.unref?.();

  console.log(
    'SQ AI Production Hardening loaded: route limits + security headers + abuse protection'
  );
}
