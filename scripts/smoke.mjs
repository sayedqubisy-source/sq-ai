import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 3187;
const dbPath = path.join(os.tmpdir(), `sq-ai-smoke-${process.pid}.sqlite`);
const child = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DB_PATH: dbPath,
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
    OPENROUTER_API_KEY: '',
    GROQ_API_KEY: '',
    ELEVENLABS_API_KEY: '',
    ELEVENLABS_VOICE_ID: '',
    VIDEO_API_URL: '',
    VIDEO_API_KEY: '',
    PADDLE_API_KEY: '',
    PADDLE_WEBHOOK_SECRET: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', chunk => { output += chunk.toString(); });
child.stderr.on('data', chunk => { output += chunk.toString(); });

const base = `http://127.0.0.1:${port}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const get = (pathname, options = {}) => fetch(`${base}${pathname}`, options);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await get('/api/health')).ok) return; } catch {}
    await wait(250);
  }
  throw new Error(`server did not become healthy\n${output}`);
}

try {
  await waitForHealth();
  const healthResponse = await get('/api/health');
  const health = await healthResponse.json();
  assert(health.ok === true && health.version === '5.2.0' && health.database === 'ok', 'health endpoint failed');
  assert(healthResponse.headers.get('x-request-id'), 'production request ID hardening missing');
  assert(healthResponse.headers.get('permissions-policy') === 'camera=(), microphone=(), geolocation=()', 'production security headers missing');

  const plansResponse = await get('/api/plans');
  assert(plansResponse.ok, `plans endpoint failed: ${plansResponse.status}`);
  const plans = await plansResponse.json();
  assert(plans.starter?.credits === 100 && plans.growth?.credits === 500 && plans.scale?.credits === 2000, 'plans endpoint failed');

  const bridgeAttempt = await get('/api/v1/videos', { method: 'POST', headers: { authorization: 'Bearer free-local-video', 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'smoke' }) });
  assert(bridgeAttempt.status === 404, 'legacy public video bridge route is still exposed');

  const email = `smoke-${Date.now()}@example.com`;
  const signup = await get('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'SmokeTest123!', name: 'Smoke' }) });
  assert(signup.status === 201, `signup failed: ${signup.status}`);
  const cookieHeader = signup.headers.get('set-cookie');
  assert(cookieHeader?.includes('sqai_session='), 'session cookie missing');
  const cookie = cookieHeader.split(';')[0];

  const me = await get('/api/me', { headers: { cookie } });
  assert(me.ok, 'authenticated /api/me failed');
  const projects = await get('/api/projects', { headers: { cookie } });
  assert(projects.ok, 'projects route failed');

  const project = await get('/api/projects', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Smoke', content: 'hello', type: 'Test' }) });
  assert(project.status === 201, 'project creation failed');

  const runtime = await get('/api/ai/runtime');
  assert(runtime.ok, 'AI runtime status failed');
  const ai = await get('/api/ai/generate', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'smoke', capability: 'text' }) });
  assert([402, 502, 503].includes(ai.status), `AI provider guard failed: ${ai.status}`);

  const unauthAgent = await get('/api/agent/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'smoke', mode: 'video' }) });
  assert(unauthAgent.status === 401, 'agent authentication failed');

  const agent = await get('/api/agent/generate', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'smoke', mode: 'video' }) });
  assert([402, 502, 503].includes(agent.status), `agent provider guard failed: ${agent.status}`);

  const tool = await get('/api/tools/generate', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'AI Video Script', prompt: 'smoke' }) });
  assert([402, 502, 503].includes(tool.status), `tool runtime guard failed: ${tool.status}`);

  const publicMedia = await get('/generated-media/nonexistent.png');
  const publicVideo = await get('/generated-videos/nonexistent.mp4');
  assert(publicMedia.status === 401 && publicVideo.status === 401, 'generated media is not protected');

  const checkout = await get('/api/billing/checkout', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'starter' }) });
  assert([400, 503].includes(checkout.status), `billing configuration guard failed: ${checkout.status}`);
  assert(checkout.status !== 501, 'billing route is still the unpatched placeholder');

  const webhook = await get('/api/webhooks/paddle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert(webhook.status === 503, `Paddle webhook guard failed: ${webhook.status}`);

  const unauthVideoJob = await get('/api/tools/video-job/smoke-missing');
  assert(unauthVideoJob.status === 401, 'video job authentication failed');

  for (const page of ['/terms.html', '/privacy.html', '/refund.html', '/tools.html']) {
    const response = await get(page);
    assert(response.ok, `${page} failed with ${response.status}`);
  }

  const missing = await get('/api/does-not-exist');
  assert(missing.status === 404, 'API 404 failed');
  console.log('SQ AI production smoke test: PASS');
} catch (error) {
  console.error('SQ AI production smoke test: FAIL');
  console.error(error?.stack || error);
  console.error(output);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await wait(300);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}
