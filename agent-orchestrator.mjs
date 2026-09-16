import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { generateText } from './ai-runtime.mjs';

const execFileAsync = promisify(execFile);
const dbPath = process.env.DB_PATH || './data/sq-ai.sqlite';
const root = path.dirname(path.resolve(dbPath));
fs.mkdirSync(root, { recursive: true });
const db = new Database(dbPath);
db.pragma('busy_timeout=5000');
const mediaDir = path.join(root, 'generated-media');
const videoDir = path.join(root, 'generated-videos');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(videoDir, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = (v, max = 12000) => String(v ?? '').trim().slice(0, max);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1)); } catch {}
  }
  return out;
}

function currentUser(req) {
  const session = cookies(req).sqai_session;
  if (session) {
    const row = db.prepare("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>datetime('now')").get(hash(session));
    if (row) return db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id);
  }
  const key = req.get('x-api-key');
  return key ? db.prepare('SELECT u.* FROM users u JOIN api_keys a ON a.user_id=u.id WHERE a.key=?').get(key) || null : null;
}

function charge(userId, endpoint) {
  return db.transaction(() => {
    const result = db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>0').run(userId);
    if (!result.changes) return false;
    db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(userId, endpoint);
    return true;
  })();
}

function refund(userId, endpoint) {
  try {
    db.transaction(() => {
      db.prepare('UPDATE users SET credits=credits+1 WHERE id=?').run(userId);
      db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(userId, `${endpoint}:refunded`);
    })();
  } catch (error) { console.warn('agent_credit_refund_failed', error?.message || error); }
}

async function request(url, options = {}, timeout = 300000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('provider_timeout'), { status: 504 });
    throw error;
  } finally { clearTimeout(timer); }
}

async function json(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data?.error?.message || data?.error || data?.message || `provider_http_${response.status}`), { status: response.status });
  return data;
}

function saveBytes(prefix, ext, bytes) {
  const name = `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(mediaDir, name), Buffer.from(bytes));
  return `/generated-media/${name}`;
}

async function buildPlan(prompt, options) {
  const result = await generateText({
    capability: 'text',
    messages: [
      { role: 'system', content: `You are SQ AI's Creative Producer. Return ONLY valid JSON with keys title, script, scenes, voice. scenes must contain 1-3 objects with narration, visualPrompt, durationSeconds. voice contains language, dialect, tone, pace. Preserve the user's language and intent. Default Arabic to Egyptian Arabic. Visual prompts must be directly usable for generation and contain no on-screen text unless requested. Options: ${JSON.stringify(options || {})}` },
      { role: 'user', content: prompt }
    ]
  });
  const raw = String(result.text || '').replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('agent_plan_invalid_json'), { status: 502 }); }
}

async function geminiImage(prompt, aspectRatio = '1:1') {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Object.assign(new Error('image_provider_not_configured'), { status: 503 });
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
  const ratio = ['1:1', '9:16', '16:9'].includes(aspectRatio) ? aspectRatio : '1:1';
  const response = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], responseFormat: { image: { aspectRatio: ratio, imageSize: '1K' } } }
    })
  }, 180000);
  const data = await json(response);
  const part = (data?.candidates?.[0]?.content?.parts || []).find(p => p?.inlineData?.data || p?.inline_data?.data);
  const base64 = part?.inlineData?.data || part?.inline_data?.data;
  if (!base64) throw Object.assign(new Error('image_data_missing'), { status: 502 });
  const mime = part?.inlineData?.mimeType || part?.inline_data?.mime_type || 'image/png';
  const ext = mime.includes('webp') ? 'webp' : mime.includes('jpeg') ? 'jpg' : 'png';
  return { url: saveBytes('image', ext, Buffer.from(base64, 'base64')), provider: 'google-gemini', model };
}

async function elevenLabsVoice(text, voiceId) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw Object.assign(new Error('voice_provider_not_configured'), { status: 503 });
  const id = voiceId || process.env.ELEVENLABS_VOICE_ID;
  if (!id) throw Object.assign(new Error('voice_id_not_configured'), { status: 503 });
  const model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
  const response = await request(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: model, output_format: 'mp3_44100_128', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true } })
  }, 180000);
  if (!response.ok) throw Object.assign(new Error((await response.text().catch(() => 'voice_generation_failed')).slice(0, 500)), { status: response.status });
  return { url: saveBytes('voice', 'mp3', await response.arrayBuffer()), provider: 'elevenlabs', model, voiceId: id };
}

async function veo(prompt, options = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Object.assign(new Error('video_provider_not_configured'), { status: 503 });
  const model = options.model || process.env.VEO_MODEL || 'veo-3.1-generate-preview';
  const body = {
    instances: [{ prompt }],
    parameters: {
      aspectRatio: options.aspectRatio === '9:16' ? '9:16' : '16:9',
      resolution: ['720p', '1080p', '4k'].includes(options.resolution) ? options.resolution : '720p'
    }
  };
  const start = await json(await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:predictLongRunning`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body)
  }, 120000));
  if (!start.name) throw Object.assign(new Error('veo_operation_missing'), { status: 502 });
  let state = start;
  for (let i = 0; i < 90 && !state.done; i++) {
    await sleep(10000);
    state = await json(await request(`https://generativelanguage.googleapis.com/v1beta/${state.name}`, { headers: { 'x-goog-api-key': key } }, 60000));
  }
  if (!state.done) throw Object.assign(new Error('veo_generation_timeout'), { status: 504 });
  if (state.error) throw Object.assign(new Error(state.error.message || 'veo_generation_failed'), { status: 502 });
  const uri = state?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (!uri) throw Object.assign(new Error('veo_video_uri_missing'), { status: 502 });
  const video = await request(uri, { headers: { 'x-goog-api-key': key } }, 180000);
  if (!video.ok) throw Object.assign(new Error(`veo_download_failed_${video.status}`), { status: 502 });
  return { url: saveBytes('video', 'mp4', await video.arrayBuffer()), provider: 'google-veo', model };
}

async function mux(videoUrl, audioUrl) {
  if (!videoUrl || !audioUrl) return videoUrl;
  const videoPath = path.join(root, videoUrl.replace(/^\/(?:generated-media|generated-videos)\//, m => m.slice(1)));
  const audioPath = path.join(root, audioUrl.replace(/^\/generated-media\//, 'generated-media/'));
  if (!fs.existsSync(videoPath) || !fs.existsSync(audioPath)) return videoUrl;
  const output = path.join(videoDir, `final-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.mp4`);
  try {
    await execFileAsync('ffmpeg', ['-y', '-i', videoPath, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', output], { timeout: 180000 });
    return `/generated-videos/${path.basename(output)}`;
  } catch (error) {
    console.warn('agent_ffmpeg_mux_failed', error?.message || error);
    return videoUrl;
  }
}

async function generateAgent(req, res) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'authentication_required' });
  const prompt = clean(req.body?.prompt || req.body?.input, 12000);
  if (!prompt) return res.status(400).json({ error: 'prompt_required' });
  const mode = ['video', 'image', 'voice', 'all'].includes(req.body?.mode) ? req.body.mode : 'video';
  const endpoint = `/api/agent/generate:${mode}`;
  if (!charge(user.id, endpoint)) return res.status(402).json({ error: 'credits_exhausted' });
  try {
    const options = { aspectRatio: req.body?.aspectRatio === '9:16' ? '9:16' : '16:9', resolution: ['720p', '1080p', '4k'].includes(req.body?.resolution) ? req.body.resolution : '720p' };
    if (mode === 'image') return res.json({ ok: true, mode, result: await geminiImage(prompt, options.aspectRatio), credits_remaining: db.prepare('SELECT credits FROM users WHERE id=?').get(user.id)?.credits ?? 0 });
    if (mode === 'voice') return res.json({ ok: true, mode, result: await elevenLabsVoice(prompt, req.body?.voiceId), credits_remaining: db.prepare('SELECT credits FROM users WHERE id=?').get(user.id)?.credits ?? 0 });

    const plan = await buildPlan(prompt, options);
    const scenes = Array.isArray(plan.scenes) && plan.scenes.length ? plan.scenes.slice(0, 3) : [{ visualPrompt: prompt, narration: prompt, durationSeconds: 8 }];
    const outputs = [];
    const warnings = [];
    if (mode === 'all') {
      try { outputs.push({ type: 'image', ...(await geminiImage(scenes[0].visualPrompt || prompt, options.aspectRatio)) }); }
      catch (error) { warnings.push({ stage: 'image', error: error?.message || 'image_generation_failed' }); }
    }
    let voice = null;
    if (mode === 'all' || req.body?.voice === true) {
      const voiceText = clean(scenes.map(s => s.narration).filter(Boolean).join('\n\n'), 12000) || clean(plan.script || prompt, 12000);
      try { voice = await elevenLabsVoice(voiceText, req.body?.voiceId); outputs.push({ type: 'voice', ...voice }); }
      catch (error) { warnings.push({ stage: 'voice', error: error?.message || 'voice_generation_failed' }); }
    }
    const videoPrompt = clean(`${scenes.map((scene, i) => `Scene ${i + 1}: ${scene.visualPrompt || prompt}`).join('\n')}\nNo on-screen text. Cinematic, coherent, realistic motion.`, 12000);
    const video = await veo(videoPrompt, options);
    const finalVideo = voice ? await mux(video.url, voice.url) : video.url;
    outputs.push({ type: 'video', ...video, final_url: finalVideo });
    return res.json({ ok: true, mode, plan, result: { outputs, video_url: finalVideo, voice_url: voice?.url || null, warnings }, credits_remaining: db.prepare('SELECT credits FROM users WHERE id=?').get(user.id)?.credits ?? 0 });
  } catch (error) {
    refund(user.id, endpoint);
    return res.status(Number(error?.status || 502)).json({ error: error?.message || 'agent_generation_failed', message: 'فشل الإنتاج وتم إرجاع الـCredit.' });
  }
}

export function installAgentRoute(app) {
  if (!app || app.__sqaiAgentRouteInstalled) return;
  app.__sqaiAgentRouteInstalled = true;
  app.post('/api/agent/generate', generateAgent);
}

// Backward-compatible hook for any existing module that expects the route to
// be registered by startup imports. server.js explicitly calls installAgentRoute.
console.log('SQ AI Agent Orchestrator loaded: brief -> plan -> image/voice/video -> MP4');
