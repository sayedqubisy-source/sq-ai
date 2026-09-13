import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { InferenceClient } from '@huggingface/inference';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static('public'));

// Use a writable relative data directory by default. Some managed Node hosts
// do not provide a writable /app directory when running without Docker.
const dbPath = process.env.DB_PATH || './data/sq-ai.sqlite';
const generatedVideoDir = path.join(path.dirname(path.resolve(dbPath)), 'generated-videos');
fs.mkdirSync(generatedVideoDir, { recursive: true });
app.use('/generated-videos', express.static(generatedVideoDir, { maxAge: '1h' }));
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(generatedVideoDir)) {
    const full = path.join(generatedVideoDir, file);
    try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch {}
  }
}, 6 * 60 * 60 * 1000).unref();
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode=WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    password_hash TEXT,
    plan TEXT NOT NULL DEFAULT 'starter',
    credits INTEGER NOT NULL DEFAULT 100,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS api_keys(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    key TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS usage(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    units INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS projects(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    type TEXT NOT NULL DEFAULT 'Project',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}
if (!columnExists('users', 'name')) db.exec('ALTER TABLE users ADD COLUMN name TEXT');
if (!columnExists('users', 'password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
if (!columnExists('usage', 'endpoint')) db.exec('ALTER TABLE usage ADD COLUMN endpoint TEXT');

const plans = {
  starter: { name: 'Starter', credits: 100, price_usd: 19 },
  growth: { name: 'Growth', credits: 500, price_usd: 49 },
  scale: { name: 'Scale', credits: 2000, price_usd: 149 }
};
