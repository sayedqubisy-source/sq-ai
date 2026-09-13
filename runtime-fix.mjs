import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const originalFetch = globalThis.fetch;

const TEXT_FALLBACKS = [
  'openrouter/free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'inclusionai/ling-3.0-flash-fin:free'
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isOpenRouter = url => String(url).startsWith('https://openrouter.ai/api/v1/');
const retryable = status => status === 408 || status === 409 || status === 429 || status >= 500;

function responseWithBody(response, body, status = response.status) {
  const headers = new Headers(response?.headers || {});
  headers.set('content-type', 'application/json');
  return new Response(body, { status, statusText: response?.statusText || '', headers });
}

function extractText(body) {
  const choice = body?.choices?.[0];
  const message = choice?.message;
  const content = message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content.map(part => typeof part === 'string' ? part : part?.text || part?.content || part?.value || '')
      .filter(Boolean).join('\n').trim();
    if (text) return text;
  }
  if (typeof choice?.text === 'string' && choice.text.trim()) return choice.text.trim();
  if (typeof body?.output_text === 'string' && body.output_text.trim()) return body.output_text.trim();
  return '';
}

function generatedVideoPath() {
  const dbPath = process.env.DB_PATH || '/app/data/adflow.sqlite';
  const dir = path.join(path.dirname(path.resolve(dbPath)), 'generated-videos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function platformAspect(platform) {
  const p = String(platform || '').toLowerCase();
  if (/tiktok|reel|short|instagram story|stories|snapchat/.test(p)) return '9:16';
  if (/youtube|facebook|linkedin|website|landscape/.test(p)) return '16:9';
  return process.env.VIDEO_ASPECT_RATIO || '9:16';
}

async function downloadOpenRouterVideo(jobId, key) {
  const response = await originalFetch(`https://openrouter.ai/api/v1/videos/${encodeURIComponent(jobId)}/content`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(new Error(text || `Video content download failed (${response.status})`), { status: response.status });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('OpenRouter returned an empty video.');
  if (bytes.length > 100 * 1024 * 1024) throw new Error('Generated video is too large.');
  const type = response.headers.get('content-type') || 'video/mp4';
  const ext = type.includes('webm') ? 'webm' : 'mp4';
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(generatedVideoPath(), filename), bytes);
  return `/generated-videos/${filename}`;
}

async function generateOpenRouterVideo(payload, headers) {
  const key = headers.get('authorization')?.replace(/^Bearer\s+/i, '') || process.env.OPENROUTER_API_KEY;
  if (!key) return new Response(JSON.stringify({ error: { code: 'openrouter_not_configured', message: 'OPENROUTER_API_KEY is not configured.' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });

  const model = payload.model || process.env.OPENROUTER_VIDEO_MODEL || 'bytedance/seedance-2.0-mini';
  const platform = payload.platform || '';
  const duration = Number(process.env.VIDEO_DURATION_SECONDS || 4);
  const resolution = process.env.VIDEO_RESOLUTION || '720p';
  const aspectRatio = platformAspect(platform);

  const submitBody = {
    model,
    prompt: String(payload.prompt || '').slice(0, 6000),
    duration: Math.min(15, Math.max(4, duration)),
    resolution,
    aspect_ratio: aspectRatio,
    generate_audio: process.env.VIDEO_GENERATE_AUDIO === 'true'
  };

  const submit = await originalFetch('https://openrouter.ai/api/v1/videos', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000', 'X-Title': 'SQ AI' },
    body: JSON.stringify(submitBody)
  });
  const submitRaw = await submit.text();
  let job;
  try { job = JSON.parse(submitRaw); } catch { job = {}; }
  if (!submit.ok) {
    return new Response(JSON.stringify({ error: { code: 'video_provider_request_failed', message: job?.error?.message || `OpenRouter video submission failed (${submit.status})` } }), { status: submit.status, headers: { 'Content-Type': 'application/json' } });
  }

  const jobId = job?.id || job?.video_id || job?.job_id;
  if (!jobId) return new Response(JSON.stringify({ error: { code: 'video_provider_invalid_output', message: 'OpenRouter did not return a video job id.' } }), { status: 502, headers: { 'Content-Type': 'application/json' } });

  const deadline = Date.now() + Number(process.env.VIDEO_MAX_WAIT_MS || 360000);
  let lastStatus = 'queued';
  while (Date.now() < deadline) {
    await sleep(Number(process.env.VIDEO_POLL_MS || 10000));
    const statusResponse = await originalFetch(`https://openrouter.ai/api/v1/videos/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` }
    });
    const raw = await statusResponse.text();
    let state;
    try { state = JSON.parse(raw); } catch { state = {}; }
    if (!statusResponse.ok) {
      if (retryable(statusResponse.status)) continue;
      return new Response(JSON.stringify({ error: { code: 'video_provider_status_failed', message: state?.error?.message || `Video status failed (${statusResponse.status})` } }), { status: statusResponse.status, headers: { 'Content-Type': 'application/json' } });
    }
    lastStatus = state?.status || lastStatus;
    if (lastStatus === 'completed') {
      const videoUrl = await downloadOpenRouterVideo(jobId, key);
      return new Response(JSON.stringify({ provider: 'openrouter', model, video_url: videoUrl, status: 'completed', job_id: jobId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (['failed', 'cancelled', 'expired'].includes(lastStatus)) {
      return new Response(JSON.stringify({ error: { code: 'video_generation_failed', message: state?.error?.message || `Video generation ${lastStatus}.` } }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }
  return new Response(JSON.stringify({ error: { code: 'video_provider_timeout', message: `Video generation timed out while status was ${lastStatus}.` } }), { status: 504, headers: { 'Content-Type': 'application/json' } });
}

async function safeFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!isOpenRouter(url)) return originalFetch(input, init);

  const method = String(init.method || 'GET').toUpperCase();
  const isChat = url.endsWith('/chat/completions') && method === 'POST';
  const isVideoSubmit = url.endsWith('/videos') && method === 'POST';

  if (isChat && typeof init.body === 'string') {
    let payload;
    try { payload = JSON.parse(init.body); } catch { return originalFetch(input, init); }
    const preferred = payload.model || process.env.OPENROUTER_MODEL || 'openrouter/free';
    const models = [...new Set([preferred, ...TEXT_FALLBACKS].filter(Boolean))];
    let lastResponse = null;
    let lastErrorMessage = '';
    for (let attempt = 0; attempt < models.length; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      const model = models[attempt];
      try {
        const response = await originalFetch(input, { ...init, signal: controller.signal, body: JSON.stringify({ ...payload, model, stream: false, temperature: payload.temperature ?? 0.7, max_tokens: payload.max_tokens ?? 1200, provider: { ...(payload.provider || {}), allow_fallbacks: true } }) });
        const raw = await response.text();
        lastResponse = response;
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        const text = extractText(parsed);
        if (response.ok && text) {
          if (parsed?.choices?.[0]?.message) parsed.choices[0].message.content = text;
          return responseWithBody(response, JSON.stringify(parsed), 200);
        }
        lastErrorMessage = parsed?.error?.message || parsed?.message || (response.ok ? 'OpenRouter returned an empty completion.' : `OpenRouter returned HTTP ${response.status}`);
        if (!response.ok && !retryable(response.status)) return responseWithBody(response, raw, response.status);
      } catch (error) {
        lastErrorMessage = error?.name === 'AbortError' ? 'OpenRouter request timed out.' : (error?.message || String(error));
      } finally { clearTimeout(timer); }
      if (attempt < models.length - 1) await sleep(Math.min(1200, 250 * (attempt + 1)));
    }
    return responseWithBody(lastResponse || new Response('{}'), JSON.stringify({ error: { code: 'openrouter_unavailable', message: `OpenRouter did not return usable text. ${lastErrorMessage || 'No usable response was returned.'}` } }), 503);
  }

  if (isVideoSubmit && typeof init.body === 'string') {
    let payload;
    try { payload = JSON.parse(init.body); } catch { return originalFetch(input, init); }
    return generateOpenRouterVideo(payload, new Headers(init.headers || {}));
  }

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await originalFetch(input, init);
      if (response.ok || !retryable(response.status) || attempt === 2) return response;
      await sleep(Math.min(1200, 350 * (attempt + 1)));
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
      await sleep(Math.min(1200, 350 * (attempt + 1)));
    }
  }
  throw lastError || new Error('OpenRouter request failed.');
}

globalThis.fetch = safeFetch;
process.env.AI_TEXT_PROVIDER = process.env.AI_TEXT_PROVIDER || 'openrouter';
process.env.AI_VIDEO_PROVIDER = process.env.AI_VIDEO_PROVIDER || 'openrouter';
process.env.OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
process.env.VIDEO_API_URL = process.env.VIDEO_API_URL || 'https://openrouter.ai/api/v1/videos';
process.env.VIDEO_API_KEY = process.env.VIDEO_API_KEY || process.env.OPENROUTER_API_KEY || '';
process.env.VIDEO_MODEL = process.env.VIDEO_MODEL || process.env.OPENROUTER_VIDEO_MODEL || 'bytedance/seedance-2.0-mini';
process.env.VIDEO_DURATION_SECONDS = process.env.VIDEO_DURATION_SECONDS || '4';
process.env.VIDEO_RESOLUTION = process.env.VIDEO_RESOLUTION || '720p';
process.env.VIDEO_MAX_WAIT_MS = process.env.VIDEO_MAX_WAIT_MS || '360000';
process.env.VIDEO_POLL_MS = process.env.VIDEO_POLL_MS || '10000';
