import express from 'express';

if (!express.application.__sqaiAiErrorVisibility) {
  express.application.__sqaiAiErrorVisibility = true;
  const originalUse = express.application.use;
  express.application.use = function (...args) {
    const wrapped = args.map((fn) => {
      if (typeof fn !== 'function' || fn.length !== 4) return fn;
      return function sqaiAiErrorVisibility(err, req, res, next) {
        const code = String(err?.code || '');
        const aiError = code.startsWith('ai_') || code.includes('_request_failed') || code.includes('_not_configured') || code === 'no_ai_provider_configured' || code === 'all_ai_providers_failed';
        if (aiError && req?.path?.startsWith('/api/')) {
          const status = Number.isInteger(err?.status) ? err.status : 502;
          if (!res.headersSent) {
            return res.status(status).json({
              error: code || 'ai_generation_failed',
              message: String(err?.message || 'AI provider failed'),
              provider_error: true,
              credits_refunded: true
            });
          }
        }
        return fn(err, req, res, next);
      };
    });
    return originalUse.apply(this, wrapped);
  };
}
console.log('SQ AI provider error visibility loaded');
