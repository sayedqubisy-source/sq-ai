import express from 'express';
import { db } from '../database/index.mjs';
import { plans, publicUser, requireAuth, hashPassword, verifyPassword, createSession, clearSession } from '../auth/service.mjs';

const router = express.Router();
const clean = (value, max) => String(value ?? '').trim().slice(0, max);

router.get('/plans', (_req, res) => res.json(plans));

router.post('/auth/signup', async (req, res) => {
  const email = clean(req.body?.email, 200).toLowerCase();
  const password = String(req.body?.password || '');
  const name = clean(req.body?.name, 100);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'valid_email_required' });
  if (password.length < 8) return res.status(400).json({ error: 'password_min_8_characters' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'email_already_registered' });

  const passwordHash = await hashPassword(password);
  const result = db.prepare("INSERT INTO users(email,name,password_hash,plan,credits) VALUES(?,?,?,?,?) ON CONFLICT(email) DO NOTHING").run(email, name, passwordHash, 'starter', plans.starter.credits);
  if (!result.changes) return res.status(409).json({ error: 'email_already_registered' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  createSession(user.id, res);
  res.status(201).json({ user: publicUser(user) });
});

router.post('/auth/login', async (req, res) => {
  const email = clean(req.body?.email, 200).toLowerCase();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) return res.status(401).json({ error: 'invalid_email_or_password' });
  createSession(user.id, res);
  res.json({ user: publicUser(user) });
});

router.post('/auth/logout', (req, res) => { clearSession(req, res); res.json({ ok: true }); });
router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

router.patch('/account', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(clean(req.body?.name, 100), req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

router.get('/usage', requireAuth, (req, res) => {
  const credits = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id)?.credits ?? 0;
  const total = db.prepare("SELECT MAX(0, COALESCE(SUM(CASE WHEN endpoint LIKE '%:refunded' THEN -units ELSE units END),0)) AS total FROM usage WHERE user_id = ?").get(req.user.id).total;
  res.json({ credits, total_units: total });
});

export default router;
