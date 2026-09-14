// SQ AI runtime compatibility and lightweight abuse protection for Express 5.
const express = await import('express');
const currentListen = express.application.listen;
if (!currentListen.__sqAiRouteOrderFix) {
  const wrapped = function (...args) {
    const server = currentListen.apply(this, args);
    const router = this?.router || this?._router;
    if (!router?.stack) return server;
    const wanted = new Set([
      '/api/ai/providers','/api/ai/route','/api/ai/status','/api/ai/capabilities','/api/ai/generate','/api/ai/runtime',
      '/api/tools/discovery','/api/webhooks/paddle','/tools'
    ]);
    const selected=[];
    router.stack=router.stack.filter(layer=>{const path=layer?.route?.path;if(wanted.has(path)){selected.push(layer);return false}return true});
    if(selected.length)router.stack.unshift(...selected);
    const buckets=new Map(),WINDOW_MS=60000,MAX_API_REQUESTS=120;
    const limiter=(req,res,next)=>{if(!req.path?.startsWith('/api/'))return next();const now=Date.now();const forwarded=process.env.TRUST_PROXY==='true'?String(req.headers['x-forwarded-for']||'').split(',')[0].trim():'';const ip=String(forwarded||req.ip||req.socket?.remoteAddress||'unknown').slice(0,100);let b=buckets.get(ip);if(!b||now-b.started>=WINDOW_MS)b={started:now,count:0};b.count++;buckets.set(ip,b);res.setHeader('X-Request-Limit',String(MAX_API_REQUESTS));res.setHeader('X-Request-Remaining',String(Math.max(0,MAX_API_REQUESTS-b.count));if(b.count>MAX_API_REQUESTS){res.setHeader('Retry-After','60');return res.status(429).json({error:'rate_limit_exceeded',message:'Too many requests. Please try again shortly.'})}next()};
    this.use(limiter);const limitLayer=router.stack.pop();if(limitLayer)router.stack.unshift(limitLayer);
    const cleanup=setInterval(()=>{const cutoff=Date.now()-WINDOW_MS;for(const [ip,b] of buckets)if(b.started<cutoff)buckets.delete(ip)},WINDOW_MS).unref();server.on('close',()=>clearInterval(cleanup));return server;
  };
  wrapped.__sqAiRouteOrderFix=true;express.application.listen=wrapped;
}
