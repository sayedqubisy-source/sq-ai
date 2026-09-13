import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const previousFetch = globalThis.fetch;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function aspectFromPlatform(platform) {
  const p = String(platform || '').toLowerCase();
  if (/tiktok|reel|short|story|stories|snapchat/.test(p)) return [832, 480];
  if (/youtube|facebook|linkedin|website|landscape/.test(p)) return [832, 480];
  return [480, 832];
}

function generatedVideoDir() {
  const dbPath = process.env.DB_PATH || '/app/data/adflow.sqlite';
  const dir = path.join(path.dirname(path.resolve(dbPath)), 'generated-videos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function findFile(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findFile(item); if (found) return found; }
  }
  if (typeof value === 'object') {
    for (const key of ['url', 'video_url', 'path', 'name']) {
      const found = findFile(value[key]);
      if (found) return found;
    }
  }
  return null;
}

async function generateFreeVideo(payload) {
  const space = process.env.FREE_VIDEO_SPACE || 'alexcheng0072/wan27-free-video-generator';
  const base = `https://${space.replace(/\/$/, '')}.hf.space`;
  const [width, height] = aspectFromPlatform(payload.platform);
  const duration = Math.min(5, Math.max(2, Number(process.env.FREE_VIDEO_DURATION_SECONDS || 3)));
  const prompt = String(payload.prompt || '').slice(0, 600);
  const negative = 'nsfw, nudity, explicit content, watermark, text, signature, subtitles, low quality, blurry, deformed, disfigured, static frame';
  const data = [null, prompt, height, width, negative, duration, 0, 4, 42, true];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240000);
  try {
    const submit = await previousFetch(`${base}/gradio_api/call/generate_video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ data }),
      signal: controller.signal
    });
    const rawSubmit = await submit.text();
    let submitted = {};
    try { submitted = JSON.parse(rawSubmit); } catch {}
    if (!submit.ok) throw new Error(submitted?.error || `Free video Space rejected request (${submit.status}).`);
    const eventId = submitted?.event_id;
    if (!eventId) throw new Error('Free video Space did not return an event id.');

    const stream = await previousFetch(`${base}/gradio_api/call/generate_video/${encodeURIComponent(eventId)}`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal
    });
    if (!stream.ok) throw new Error(`Free video Space status failed (${stream.status}).`);
    const text = await stream.text();
    let finalData = null;
    let streamError = '';
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.error) streamError = String(parsed.error);
        if (Array.isArray(parsed)) finalData = parsed;
        else if (Array.isArray(parsed?.data)) finalData = parsed.data;
      } catch {}
    }
    if (streamError) throw new Error(streamError);
    const file = findFile(finalData);
    if (!file) throw new Error('Free video Space completed without a video file.');

    let fileUrl = file;
    if (!/^https?:\/\//i.test(fileUrl)) {
      fileUrl = `${base}/gradio_api/file=${encodeURIComponent(fileUrl)}`;
    }
    const videoResponse = await previousFetch(fileUrl, { signal: controller.signal });
    if (!videoResponse.ok) throw new Error(`Generated video download failed (${videoResponse.status}).`);
    const bytes = Buffer.from(await videoResponse.arrayBuffer());
    if (!bytes.length) throw new Error('Generated video file was empty.');
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.mp4`;
    fs.writeFileSync(path.join(generatedVideoDir(), filename), bytes);
    return new Response(JSON.stringify({ provider: 'huggingface-zero-gpu', model: 'FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers', video_url: `/generated-videos/${filename}`, status: 'completed', free: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    if (error?.name === 'AbortError') return new Response(JSON.stringify({ error: { code: 'free_video_timeout', message: 'The free video GPU queue timed out. Try again.' } }), { status: 504, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ error: { code: 'free_video_unavailable', message: error?.message || 'The free video service is temporarily unavailable.' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  } finally { clearTimeout(timer); }
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const method = String(init.method || 'GET').toUpperCase();
  if (method === 'POST' && url.endsWith('/api/v1/videos') && process.env.PAID_VIDEO_ENABLED !== 'true') {
    let payload = {};
    try { payload = typeof init.body === 'string' ? JSON.parse(init.body) : {}; } catch {}
    return generateFreeVideo(payload);
  }
  return previousFetch(input, init);
};
