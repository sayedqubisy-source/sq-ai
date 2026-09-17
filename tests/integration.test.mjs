import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const provider of ['free', 'custom', 'fal']) test(`production routes (${provider} video): auth, billing, credits, projects and throttling`, { timeout: 30000 }, async t => {
  const paid = provider !== 'free';
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqai-integration-'));
  const dbPath = path.join(directory, 'test.sqlite');
  const startup = JSON.parse(fs.readFileSync('package.json')).scripts.start.split(' ').slice(1);
  const child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', ...startup], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DB_PATH: dbPath, TRUST_PROXY: 'false',
      GEMINI_API_KEY: '', OPENAI_API_KEY: '', GROQ_API_KEY: '', OPENROUTER_API_KEY: 'test-only',
      PADDLE_API_KEY: '', PADDLE_WEBHOOK_SECRET: 'test-webhook-secret', PADDLE_PRICE_GROWTH: 'pri_growth',
      PAID_VIDEO_ENABLED: provider === 'custom' ? 'true' : 'false', FREE_VIDEO_SPACE: 'alexcheng0072/wan27-free-video-generator', FREE_VIDEO_SPACE_URL: '',
      VIDEO_API_URL: provider === 'custom' ? 'https://video.test/generate' : '', VIDEO_API_KEY: provider === 'custom' ? 'test-only' : '',
      FAL_KEY: provider === 'fal' ? 'test-fal-key' : '', HF_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; let database;
  child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    database?.close(); fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = (url, options) => fetch(`http://127.0.0.1:${port}${url}`, options);
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await request('/api/health')).ok) { ready = true; break; } } catch {} await wait(50); }
  assert.ok(ready, logs);
  const healthResponse = await request('/api/health');
  assert.ok(healthResponse.headers.get('content-security-policy')?.includes("default-src 'self'"));
  assert.equal(healthResponse.headers.get('cache-control'), 'no-store');
  assert.equal(healthResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Number(healthResponse.headers.get('x-ratelimit-remaining')) >= 0);
  database = new Database(dbPath);
  const post = (url, body, cookie, headers = {}) => request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) });
  const account = { email: 'integration@example.com', password: 'IntegrationPassword123' };
  assert.equal((await post('/api/auth/signup', { email: 'long@example.com', password: 'x'.repeat(1025) })).status, 400);
  const signups = await Promise.all([post('/api/auth/signup', account), post('/api/auth/signup', account)]);
  assert.deepEqual(signups.map(r => r.status).sort(), [201, 409]);
  const signup = signups.find(r => r.status === 201);
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  const user = (await signup.json()).user;
  assert.equal((await post('/api/auth/login', { ...account, password: 'wrong' })).status, 401);
  assert.equal((await post('/api/auth/login', account)).status, 200);

  await t.test('signed webhook updates fresh schema and replay is idempotent', async () => {
    const event = { event_id: 'evt_test', event_type: 'transaction.completed', data: { id: 'txn_test', subscription_id: 'sub_test', custom_data: { sq_ai_user_id: String(user.id), sq_ai_plan: 'growth' }, items: [{ price: { id: 'pri_growth' } }] } };
    const raw = JSON.stringify(event); const ts = Math.floor(Date.now() / 1000);
    const signature = `ts=${ts};h1=${crypto.createHmac('sha256', 'test-webhook-secret').update(`${ts}:${raw}`).digest('hex')}`;
    assert.equal((await post('/api/webhooks/paddle', event)).status, 400);
    assert.equal((await post('/api/webhooks/paddle', event, null, { 'paddle-signature': signature })).status, 200);
    assert.equal(database.prepare('SELECT credits FROM users WHERE id=?').get(user.id).credits, 500);
    database.prepare('UPDATE users SET credits=499 WHERE id=?').run(user.id);
    assert.equal((await post('/api/webhooks/paddle', event, null, { 'paddle-signature': signature })).status, 200);
    assert.equal(database.prepare('SELECT credits FROM users WHERE id=?').get(user.id).credits, 499);

    const missingUserEvent = { ...event, event_id: 'evt_missing_user', data: { ...event.data, id: 'txn_missing_user', custom_data: { ...event.data.custom_data, sq_ai_user_id: '9999999' } } };
    const missingRaw = JSON.stringify(missingUserEvent); const missingTs = Math.floor(Date.now() / 1000);
    const missingSignature = `ts=${missingTs};h1=${crypto.createHmac('sha256', 'test-webhook-secret').update(`${missingTs}:${missingRaw}`).digest('hex')}`;
    assert.equal((await post('/api/webhooks/paddle', missingUserEvent, null, { 'paddle-signature': missingSignature })).status, 500);
    assert.equal(database.prepare('SELECT id FROM billing_events WHERE event_id=?').get('evt_missing_user'), undefined);
  });

  await t.test('concurrent generation cannot overspend and failures refund usage', async () => {
    database.prepare('UPDATE users SET credits=1 WHERE id=?').run(user.id);
    const results = await Promise.all([post('/api/ai/generate', { prompt: 'hello' }, cookie), post('/api/ai/generate', { prompt: 'hello' }, cookie)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 402]);
    database.prepare('UPDATE users SET credits=1 WHERE id=?').run(user.id);
    assert.equal((await post('/api/ai/generate', { prompt: 'FAIL_PROVIDER' }, cookie)).status, 400);
    const usage = await (await request('/api/usage', { headers: { cookie } })).json();
    assert.equal(usage.credits, 1); assert.equal(usage.total_units, 1);
  });

  await t.test('project ownership is enforced', async () => {
    const project = await (await post('/api/projects', { title: 'Owned', content: 'private' }, cookie)).json();
    const other = await post('/api/auth/signup', { email: 'other@example.com', password: 'OtherPassword123' });
    const otherCookie = other.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(`/api/projects/${project.project.id}`, { method: 'DELETE', headers: { cookie: otherCookie } })).status, 404);
    assert.equal((await request(`/api/projects/${project.project.id}`, { method: 'DELETE', headers: { cookie } })).status, 200);
  });

  await t.test('video returns a pollable job through the configured provider', async () => {
    const response = await post('/api/tools/generate', { tool: 'text-video', prompt: 'test scene' }, cookie);
    assert.equal(response.status, 202); const job = await response.json(); assert.equal(job.async, true);
    let result;
    for (let i = 0; i < 40; i++) { result = await (await request(`/api/tools/video-job/${job.job_id}`, { headers: { cookie } })).json(); if (result.status !== 'running') break; await wait(25); }
    assert.equal(result.status, 'completed', JSON.stringify(result));
    if (provider === 'custom') { assert.equal(result.provider, 'custom'); assert.equal(result.video_url, 'https://video.test/output.mp4'); return; }
    if (provider === 'fal') { assert.equal(result.provider, 'fal-wan-turbo'); assert.equal(result.video_url, 'https://video.test/fal-output.mp4'); return; }
    const media = await request(result.video_url, { headers: { cookie } });
    assert.equal(media.status, 200); assert.equal(media.headers.get('cache-control'), 'private, no-store');
    assert.equal((await request(result.video_url)).status, 401);
  });

  if (!paid) await t.test('provider error fails the video job and refunds its reserved credit', async () => {
    database.prepare('UPDATE users SET credits=1 WHERE id=?').run(user.id);
    const response = await post('/api/tools/generate', { tool: 'text-video', prompt: 'test provider failure', platform: 'square' }, cookie);
    assert.equal(response.status, 202);
    const job = await response.json();
    let result;
    for (let i = 0; i < 40; i++) {
      result = await (await request(`/api/tools/video-job/${job.job_id}`, { headers: { cookie } })).json();
      if (result.status !== 'running') break;
      await wait(25);
    }
    assert.equal(result.status, 'failed');
    assert.match(result.error, /GPU quota exceeded/);
    assert.equal(result.credits_remaining, 1);
    assert.equal(database.prepare('SELECT credits FROM users WHERE id=?').get(user.id).credits, 1);
  });

  await t.test('music generation returns protected audio and records one credit', async () => {
    database.prepare('UPDATE users SET credits=2 WHERE id=?').run(user.id);
    const response = await post('/api/tools/generate', { tool: 'music', prompt: 'cinematic piano' }, cookie);
    assert.equal(response.status, 200); const result = await response.json();
    assert.match(result.audio_url, /^\/generated-media\/music-.*\.wav$/);
    assert.equal(result.credits_remaining, 1);
    const audio = await request(result.audio_url, { headers: { cookie } });
    assert.equal(audio.status, 200); assert.match(audio.headers.get('content-type'), /^audio\/wav/);
    assert.equal((await request(result.audio_url)).status, 401);
  });

  await t.test('forged forwarded headers cannot bypass authentication rate limits', async () => {
    let limited = 0;
    for (let i = 0; i < 14; i++) {
      const result = await post('/api/auth/login', { email: 'missing@example.com', password: 'wrong' }, null, { 'x-forwarded-for': `203.0.113.${i}` });
      if (result.status === 429) { limited++; assert.ok(result.headers.get('retry-after')); }
    }
    assert.ok(limited > 0);
  });
});
