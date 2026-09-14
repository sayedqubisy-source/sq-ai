import crypto from 'node:crypto';

const BRIDGE_PREFIX = '/api/bridge';
const TOKEN = String(process.env.SQAI_BRIDGE_TOKEN || '').trim();
const WEBHOOK_URL = String(process.env.SQAI_BRIDGE_WEBHOOK_URL || '').trim();
const MAX_EVENTS = 100;
const events = [];
let installed = false;

function safeEqual(a, b) {
  if (!a || !b) return false;
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function authorized(req) {
  if (!TOKEN) return false;
  const header = req.get('x-sqai-bridge-token') || '';
  const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return safeEqual(header, TOKEN) || safeEqual(bearer, TOKEN);
}

function guard(req, res, next) {
  if (!TOKEN) return res.status(503).json({ ok:false, error:'bridge_not_configured' });
  if (!authorized(req)) return res.status(401).json({ ok:false, error:'bridge_authentication_required' });
  next();
}

function pushEvent(type, payload = {}) {
  const event = {
    id: crypto.randomUUID(),
    type: String(type || 'event').slice(0, 80),
    payload,
    created_at: new Date().toISOString()
  };
  events.push(event);
  while (events.length > MAX_EVENTS) events.shift();
  if (WEBHOOK_URL) {
    fetch(WEBHOOK_URL, {
      method:'POST',
      headers:{'Content-Type':'application/json','X-SQAI-Bridge-Event':event.type},
      body:JSON.stringify(event)
    }).catch(() => {});
  }
  return event;
}

globalThis.sqAiBridgeEvent = pushEvent;

function install(app) {
  if (installed || !app?.get || !app?.post) return;
  installed = true;

  app.get(`${BRIDGE_PREFIX}/health`, guard, (req, res) => {
    res.json({
      ok:true,
      service:'SQ AI Bridge',
      version:'1.0.0',
      connected:true,
      pid:process.pid,
      uptime_seconds:Math.floor(process.uptime()),
      started_at:new Date(Date.now() - process.uptime()*1000).toISOString(),
      webhook_configured:Boolean(WEBHOOK_URL)
    });
  });

  app.get(`${BRIDGE_PREFIX}/events`, guard, (req, res) => {
    const since = String(req.query.since || '');
    const index = since ? events.findIndex(event => event.id === since) : -1;
    const result = index >= 0 ? events.slice(index + 1) : events.slice(-25);
    res.json({ok:true,events:result});
  });

  app.post(`${BRIDGE_PREFIX}/events`, guard, (req, res) => {
    const type = String(req.body?.type || 'event').slice(0,80);
    const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
    res.status(201).json({ok:true,event:pushEvent(type,payload)});
  });

  app.post(`${BRIDGE_PREFIX}/command`, guard, async (req, res) => {
    const action = String(req.body?.action || '').trim();
    const allowed = new Set(['health','status','usage','projects']);
    if (!allowed.has(action)) return res.status(400).json({ok:false,error:'unsupported_bridge_action',allowed:[...allowed]});

    const port = Number(process.env.PORT || 3000);
    const target = action === 'health' ? '/api/health'
      : action === 'usage' ? '/api/usage'
      : action === 'projects' ? '/api/projects'
      : '/api/me';

    try {
      const headers = {};
      const apiKey = String(req.body?.api_key || '').trim();
      if (apiKey) headers['x-api-key'] = apiKey;
      const response = await fetch(`http://127.0.0.1:${port}${target}`, {headers});
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = {raw:text.slice(0,8000)}; }
      const event = pushEvent('command.completed',{action,status:response.status});
      res.status(response.status).json({ok:response.ok,action,data,event_id:event.id});
    } catch (error) {
      const event = pushEvent('command.failed',{action,error:String(error?.message || error)});
      res.status(502).json({ok:false,error:'bridge_internal_request_failed',event_id:event.id});
    }
  });

  app.use((err, req, res, next) => {
    if (req.path?.startsWith(BRIDGE_PREFIX)) return res.status(500).json({ok:false,error:'bridge_error'});
    next(err);
  });

  console.log('[SQ AI BRIDGE] two-way bridge installed');
}

const originalListen = (await import('express')).application.listen;
if (!originalListen.__sqAiBridgePatched) {
  const patched = function (...args) {
    install(this);
    return originalListen.apply(this, args);
  };
  patched.__sqAiBridgePatched = true;
  (await import('express')).application.listen = patched;
}

console.log('[SQ AI BRIDGE] ready; token configured:', Boolean(TOKEN));
