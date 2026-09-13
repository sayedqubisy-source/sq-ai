import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const previousFetch = globalThis.fetch;

function platformDimensions(platform) {
  const p = String(platform || '').toLowerCase();
  if (/youtube|facebook|linkedin|website|landscape/.test(p)) return { width: 832, height: 480 };
  return { width: 480, height: 832 };
}

function generatedVideoDir() {
  const dbPath = process.env.DB_PATH || '/app/data/adflow.sqlite';
  const dir = path.join(path.dirname(path.resolve(dbPath)), 'generated-videos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function findFile(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    if (/\.(mp4|webm|mov)(\?|$)/i.test(value) || /gradio_api\/file|\.hf\.space/i.test(value)) return value;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = findFile(item); if (found) return found; }
  }
  if (typeof value === 'object') {
    for (const key of ['video_url', 'url', 'path', 'name']) {
      const found = findFile(value[key]);
      if (found) return found;
    }
  }
  return null;
}

async function freeVideo(payload) {
  const space = process.env.FREE_VIDEO_SPACE || 'alexcheng0072/wan27-free-video-generator';
  const base = `https://${space.replace(/\/$/, '')}.hf.space`;
  const { width, height } = platformDimensions(payload.platform);
  const aspect = `${width}x${height}`;
  const prompt = String(payload.prompt || '').slice(0, 600);
  const duration = Math.min(5, Math.max(2, Number(process.env.FREE_VIDEO_DURATION_SECONDS || 3)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240000);
  try {
    // Current public Space API has exactly four inputs:
    // input_image, prompt, aspect_ratio, duration_seconds.
    const inputData = [null, prompt, aspect, duration];
    const submit = await previousFetch(`${base}/gradio_api/call/generate_video`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ data: inputData }), signal: controller.signal
    });
    const raw = await submit.text();
    let data = {}; try { data = JSON.parse(raw); } catch {}
    if (!submit.ok) throw new Error(data?.error || `Free video service rejected the request (${submit.status}).`);
    if (!data.event_id) throw new Error('Free video service did not return an event id.');

    const result = await previousFetch(`${base}/gradio_api/call/generate_video/${encodeURIComponent(data.event_id)}`, {
      headers: { Accept: 'text/event-stream' }, signal: controller.signal
    });
    if (!result.ok) throw new Error(`Free video service status failed (${result.status}).`);
    const stream = await result.text();
    let finalData = null;
    let streamError = '';
    for (const line of stream.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5).trim();
      if (!value || value === '[DONE]') continue;
      try {
        const parsed = JSON.parse(value);
        if (parsed?.error) streamError = String(parsed.error);
        if (Array.isArray(parsed)) finalData = parsed;
        else if (Array.isArray(parsed?.data)) finalData = parsed.data;
      } catch {}
    }
    if (streamError) throw new Error(streamError);
    const file = findFile(finalData);
    if (!file) throw new Error('Free video service finished without a video file.');

    let fileUrl = file;
    if (!/^https?:\/\//i.test(fileUrl)) {
      fileUrl = `${base}/gradio_api/file=${encodeURIComponent(fileUrl)}`;
    }
    const video = await previousFetch(fileUrl, { signal: controller.signal });
    if (!video.ok) throw new Error(`Generated video download failed (${video.status}).`);
    const bytes = Buffer.from(await video.arrayBuffer());
    const contentType = video.headers.get('content-type') || '';
    if (!bytes.length || (!contentType.includes('video') && bytes.slice(0, 32).toString().includes('<!DOCTYPE'))) {
      throw new Error('Generated video download did not return a valid video.');
    }
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.mp4`;
    fs.writeFileSync(path.join(generatedVideoDir(), filename), bytes);
    return new Response(JSON.stringify({ provider: 'huggingface-zero-gpu', model: 'FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers', video_url: `/generated-videos/${filename}`, status: 'completed', free: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    const status = error?.name === 'AbortError' ? 504 : 503;
    return new Response(JSON.stringify({ error: { code: status === 504 ? 'free_video_timeout' : 'free_video_unavailable', message: error?.message || 'Free video service is temporarily unavailable.' } }), { status, headers: { 'Content-Type': 'application/json' } });
  } finally { clearTimeout(timer); }
}

globalThis.fetch = async function videoSafeFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input?.url || '';
  const method = String(init.method || 'GET').toUpperCase();
  if (url.endsWith('/api/v1/videos') && method === 'POST' && typeof init.body === 'string') {
    let payload; try { payload = JSON.parse(init.body); } catch { return previousFetch(input, init); }
    if (process.env.PAID_VIDEO_ENABLED !== 'true') return freeVideo(payload);
  }
  return previousFetch(input, init);
};

process.env.FREE_VIDEO_DURATION_SECONDS = process.env.FREE_VIDEO_DURATION_SECONDS || '3';
process.env.PAID_VIDEO_ENABLED = process.env.PAID_VIDEO_ENABLED || 'false';
