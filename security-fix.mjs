import express from 'express';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

// Keep generated media behind the same session/API-key boundary as the app.
// This is installed before server.js registers the /generated-videos static route.
const originalUse = express.application.use;
if (!originalUse.__sqAiPrivateMedia) {
  const dbPath = process.env.DB_PATH || './data/sq-ai.sqlite';
  const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
  const readCookie = req => {
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const key = part.slice(0, i).trim();
      if (key !== 'sqai_session') continue;
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
    return null;
  };
  const isAuthorized = req => {
    let db;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const cookie = readCookie(req);
      if (cookie) {
        const session = db.prepare("SELECT 1 FROM sessions WHERE token_hash=? AND expires_at > datetime('now') LIMIT 1").get(tokenHash(cookie));
        if (session) return true;
      }
      const apiKey = String(req.get('x-api-key') || '');
      if (apiKey && apiKey.length <= 200) {
        const key = db.prepare('SELECT 1 FROM api_keys WHERE key=? LIMIT 1').get(apiKey);
        if (key) return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      try { db?.close(); } catch {}
    }
  };
  const guard = (req, res, next) => {
    if (!isAuthorized(req)) return res.status(401).json({ error: 'authentication_required' });
    next();
  };
  const wrapped = function patchedUse(first, ...handlers) {
    if (first === '/generated-videos' && handlers.length) {
      return originalUse.call(this, first, guard, ...handlers);
    }
    return originalUse.call(this, first, ...handlers);
  };
  wrapped.__sqAiPrivateMedia = true;
  express.application.use = wrapped;
}
