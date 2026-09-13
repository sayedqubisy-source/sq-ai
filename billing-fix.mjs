import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const originalJson = express.json;
express.json = function patchedJson(options = {}) {
  const verify = options.verify;
  return originalJson({
    ...options,
    verify(req, res, buf, encoding) {
      req.rawBody = Buffer.from(buf);
      if (typeof verify === 'function') verify(req, res, buf, encoding);
    }
  });
};

const appPrototype = express.application;
const originalPost = appPrototype.post;
const originalListen = appPrototype.listen;

const dbPath = process.env.DB_PATH || './data/sq-ai.sqlite';
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const billingDb = new Database(dbPath);
billingDb.exec(`
  CREATE TABLE IF NOT EXISTS billing_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    transaction_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_billing_events_transaction ON billing_events(transaction_id);
`);
for (const statement of [
  "ALTER TABLE users ADD COLUMN paddle_subscription_id TEXT",
  "ALTER TABLE users ADD COLUMN billing_status TEXT DEFAULT 'inactive'"
]) { try { billingDb.exec(statement); } catch {} }

const normalizePlan = value => {
  const plan = String(value || '').trim().toLowerCase();
  if (plan === 'pro') return 'growth';
  if (plan === 'business') return 'scale';
  return plan;
};
const planForPrice = priceId => {
  if (!priceId) return null;
  const map = {
    [process.env.PADDLE_PRICE_STARTER || '']: 'starter',
    [process.env.PADDLE_PRICE_GROWTH || '']: 'growth',
    [process.env.PADDLE_PRICE_SCALE || '']: 'scale'
  };
  return map[priceId] || null;
};
const creditsForPlan = { starter: 100, growth: 500, scale: 2000 };

function paddleApiBase() {
  return String(process.env.PADDLE_ENVIRONMENT || 'production').toLowerCase() === 'sandbox'
    ? 'https://sandbox-api.paddle.com'
    : 'https://api.paddle.com';
}

function verifyPaddleSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const parts = Object.fromEntries(String(signature).split(';').map(part => {
    const i = part.indexOf('=');
    return i > 0 ? [part.slice(0, i), part.slice(i + 1)] : [part, ''];
  }));
  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;
  const age = Math.abs(Date.now() - Number(ts) * 1000);
  if (!Number.isFinite(age) || age > 5000) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(h1, 'hex')); }
  catch { return false; }
}

async function createCheckout(req, res) {
  const apiKey = process.env.PADDLE_API_KEY;
  const requestedPlan = normalizePlan(req.body?.plan);
  const priceId = requestedPlan === 'starter' ? process.env.PADDLE_PRICE_STARTER
    : requestedPlan === 'growth' ? process.env.PADDLE_PRICE_GROWTH
    : requestedPlan === 'scale' ? process.env.PADDLE_PRICE_SCALE : null;

  if (!apiKey) return res.status(503).json({ error: 'paddle_not_configured' });
  if (!priceId) return res.status(503).json({ error: 'paddle_price_not_configured', plan: requestedPlan });

  const body = {
    items: [{ price_id: priceId, quantity: 1 }],
    collection_mode: 'automatic',
    custom_data: { sq_ai_user_id: String(req.user.id), sq_ai_plan: requestedPlan }
  };
  const checkoutUrl = process.env.PADDLE_CHECKOUT_URL || process.env.APP_URL;
  if (checkoutUrl) body.checkout = { url: checkoutUrl };

  const response = await fetch(`${paddleApiBase()}/transactions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('paddle_transaction_failed', response.status, data?.error?.code || data?.error?.detail || 'unknown');
    return res.status(response.status >= 400 && response.status < 500 ? 502 : 503).json({ error: 'paddle_transaction_failed' });
  }
  return res.json({ ok: true, transaction_id: data?.data?.id || null, checkout_url: data?.data?.checkout?.url || null, plan: requestedPlan });
}

async function paddleWebhook(req, res) {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  const signature = req.get('paddle-signature') || '';
  const raw = req.rawBody?.toString('utf8') || '';
  if (!secret) return res.status(503).send('webhook_not_configured');
  if (!verifyPaddleSignature(raw, signature, secret)) return res.status(400).send('invalid_signature');

  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).send('invalid_json'); }
  const eventId = String(event.event_id || '');
  const eventType = String(event.event_type || '');
  if (!eventId) return res.status(400).send('missing_event_id');
  if (billingDb.prepare('SELECT id FROM billing_events WHERE event_id=?').get(eventId)) return res.status(200).send('ok');

  try {
    billingDb.prepare('INSERT INTO billing_events(event_id,event_type,transaction_id) VALUES(?,?,?)').run(eventId, eventType, event?.data?.id || null);
    if (eventType === 'transaction.completed') {
      const data = event.data || {};
      const custom = data.custom_data || {};
      const userId = Number(custom.sq_ai_user_id || 0);
      const priceId = data?.items?.[0]?.price?.id || data?.items?.[0]?.price_id || '';
      const plan = normalizePlan(custom.sq_ai_plan) || planForPrice(priceId);
      if (userId && plan && creditsForPlan[plan]) {
        billingDb.prepare(`UPDATE users SET plan=?, credits=?, paddle_subscription_id=COALESCE(?,paddle_subscription_id), billing_status='active' WHERE id=?`).run(plan, creditsForPlan[plan], data.subscription_id || null, userId);
      }
    }
    if (eventType === 'subscription.canceled' || eventType === 'subscription.past_due') {
      const userId = Number(event?.data?.custom_data?.sq_ai_user_id || 0);
      if (userId) billingDb.prepare('UPDATE users SET billing_status=? WHERE id=?').run(eventType === 'subscription.canceled' ? 'canceled' : 'past_due', userId);
    }
    return res.status(200).send('ok');
  } catch (error) {
    console.error('paddle_webhook_processing_failed', error?.message || error);
    return res.status(500).send('webhook_processing_failed');
  }
}

appPrototype.post = function patchedPost(route, ...handlers) {
  if (route === '/api/billing/checkout' && handlers.length) return originalPost.call(this, route, ...handlers.slice(0, -1), createCheckout);
  return originalPost.call(this, route, ...handlers);
};

appPrototype.listen = function patchedListen(...args) {
  const app = this;
  if (!app.__sqaiPaddleWebhookRegistered) {
    app.__sqaiPaddleWebhookRegistered = true;
    originalPost.call(app, '/api/webhooks/paddle', paddleWebhook);
  }
  return originalListen.apply(this, args);
};
