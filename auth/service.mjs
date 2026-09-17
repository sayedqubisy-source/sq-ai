import crypto from 'node:crypto';
import { db } from '../database/index.mjs';
import { env } from '../config/env.mjs';

export const plans = Object.freeze({
  starter: { name: 'Starter', credits: 100, price_usd: 19 },
  growth: { name: 'Growth', credits: 500, price_usd: 49 },
  scale: { name: 'Scale', credits: 2000, price_usd: 149 },
});

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('hex');

export function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name || '', plan: user.plan, credits: user.credits, created_at: user.created_at };
}

export function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    try { result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1)); } catch {}
  }
  return result;
}

export function findUser(req) {
  const session = parseCookies(req).sqai_session;
  if (session) {
    const row = db.prepare("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')").get(hash(session));
    if (row) return db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  }
  const apiKey = String(req.get('x-api-key') || '');
  if (!apiKey || apiKey.length > 300) return null;
  const keyHash = hash(apiKey);
  return db.prepare('SELECT u.* FROM users u JOIN api_keys a ON a.user_id = u.id WHERE a.key_hash = ?').get(keyHash) || null;
}

export function requireAuth(req, res, next) {
  const user = findUser(req);
  if (!user) return res.status(401).json({ error: 'authentication_required' });
  req.user = user;
  next();
}

export async function hashPassword(value) {
  const salt = crypto.randomBytes(16);
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(String(value), salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => error ? reject(error) : resolve(key));
  });
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(value, stored) {
  if (typeof stored !== 'string' || !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/i.test(stored)) return false;
  const [, saltHex, expectedHex] = stored.split(':');
  if (!saltHex || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = await new Promise((resolve, reject) => {
    crypto.scrypt(String(value), Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 }, (error, key) => error ? reject(error) : resolve(key));
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function createSession(userId, res) {
  const value = randomToken();
  db.prepare("INSERT INTO sessions(user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', ?))").run(userId, hash(value), `+${env.sessionDays} days`);
  const secure = env.isProduction ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sqai_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${env.sessionDays * 86400}${secure}`);
}

export function clearSession(req, res) {
  const value = parseCookies(req).sqai_session;
  if (value) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(value));
  res.setHeader('Set-Cookie', 'sqai_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

export function consumeCredit(userId, endpoint) {
  return db.transaction(() => {
    const result = db.prepare('UPDATE users SET credits = credits - 1 WHERE id = ? AND credits > 0').run(userId);
    if (!result.changes) return false;
    db.prepare('INSERT INTO usage(user_id, endpoint, units) VALUES (?, ?, 1)').run(userId, endpoint);
    return true;
  })();
}

export function refundCredit(userId, endpoint) {
  db.transaction(() => {
    db.prepare('UPDATE users SET credits = credits + 1 WHERE id = ?').run(userId);
    db.prepare('INSERT INTO usage(user_id, endpoint, units) VALUES (?, ?, 1)').run(userId, `${endpoint}:refunded`);
  })();
}

export function remainingCredits(userId) {
  return db.prepare('SELECT credits FROM users WHERE id = ?').get(userId)?.credits ?? 0;
}
