// SQ AI runtime route-order compatibility for Express 5.
const express = await import('express');
const currentListen = express.application.listen;
if (!currentListen.__sqAiRouteOrderFix) {
  const wrapped = function (...args) {
    const server = currentListen.apply(this, args);
    const router = this?.router || this?._router;
    if (router?.stack) {
      const wanted = new Set(['/api/ai/providers','/api/ai/route','/api/tools/discovery','/tools']);
      const selected = [];
      router.stack = router.stack.filter(layer => {
        const path = layer?.route?.path;
        if (wanted.has(path)) { selected.push(layer); return false; }
        return true;
      });
      if (selected.length) router.stack.unshift(...selected);
    }
    return server;
  };
  wrapped.__sqAiRouteOrderFix = true;
  express.application.listen = wrapped;
}
