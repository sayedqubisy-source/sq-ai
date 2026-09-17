import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqai-core-'));
process.env.DB_PATH = path.join(directory, 'legacy.sqlite');
const legacy = new Database(process.env.DB_PATH);
legacy.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, content TEXT, type TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
INSERT INTO projects VALUES (1,1,'Existing','Keep me','Project','2026-01-01 00:00:00');`);
legacy.close();
const { db, closeDatabase } = await import('../database/index.mjs');
const auth = await import('../auth/service.mjs');
const { localPath } = await import('../media/store.mjs');
after(() => { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }); });

test('populated legacy database migrates without losing projects', () => {
  const project = db.prepare('SELECT * FROM projects WHERE id=1').get();
  assert.equal(project.content, 'Keep me');
  assert.equal(project.updated_at, project.created_at);
  const columns = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  assert.ok(columns.includes('billing_status'));
  assert.ok(columns.includes('paddle_subscription_id'));
  db.prepare("INSERT INTO projects(user_id,title,content,type) VALUES(1,'New','hello','Project')").run();
  assert.ok(db.prepare('SELECT updated_at FROM projects WHERE id=2').get().updated_at);
});

test('password verification rejects corrupt hashes and wrong passwords', async () => {
  const stored = await auth.hashPassword('CorrectPassword123');
  assert.equal(await auth.verifyPassword('CorrectPassword123', stored), true);
  assert.equal(await auth.verifyPassword('WrongPassword123', stored), false);
  assert.equal(await auth.verifyPassword('anything', 'scrypt:aa:zz'), false);
  assert.equal(await auth.verifyPassword('anything', 'scrypt:aa:'), false);
});

test('media paths cannot escape the generated-media directories', () => {
  assert.equal(localPath('/generated-media/image.png'), path.join(directory, 'generated-media/image.png'));
  assert.equal(localPath('/generated-videos/video.mp4'), path.join(directory, 'generated-videos/video.mp4'));
  for (const value of ['/generated-media/../legacy.sqlite', '/generated-media/../../secret', '/generated-media/%2e%2e/legacy.sqlite', '/generated-other/file', 'https://example.com/file']) {
    assert.equal(localPath(value), null);
  }
});

test('credit reservation is atomic and refunded usage nets to zero', () => {
  const id = db.prepare("INSERT INTO users(email,credits) VALUES('credit@example.com',1)").run().lastInsertRowid;
  assert.equal(auth.consumeCredit(id, 'test'), true);
  assert.equal(auth.consumeCredit(id, 'test'), false);
  auth.refundCredit(id, 'test');
  assert.equal(auth.remainingCredits(id), 1);
  assert.equal(db.prepare("SELECT SUM(CASE WHEN endpoint LIKE '%:refunded' THEN -units ELSE units END) AS total FROM usage WHERE user_id=?").get(id).total, 0);
});
