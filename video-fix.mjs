const previousFetch = globalThis.fetch;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function platformAspect(platform) {
  const p = String(platform || '').toLowerCase();
  if (/tiktok|reel|short|instagram story|stories|snapchat/.test(p)) return { width: 480, height: 832 };
  if (/youtube|facebook|linkedin|website|landscape/.test(p)) return { width: 832, height: 480 };
  return { width: 480, height: 832 };
}

function findVideoUrl(value) {
  if (!value) return null;
  if (typeof value === 'string') return /^https?:\/\//.test(value) ? value : null;
  if (Array.isArray(value)) for (const item of value) { const found = findVideoUrl(item); if (found) return found; }
  if (typeof value === 'object') for (const key of ['url', 'video_url', 'path', 'name']) { const found = findVideoUrl(value[key]); if (found) return found; }
  return null;
}

async function freeVideo(payload) {
  const space = process.env.FREE_VIDEO_SPACE || 'alexcheng0072/wan27-free-video-generator';
  const base = `https://${space.replace(/\/$/, '')}.hf.space`;
  const { width, height } = platformAspect(payload.platform);
  const prompt = String(payload.prompt || '').slice(0, 600);
  const duration = Math.min(5, Math.max(2, Number(process.env.FREE_VIDEO_DURATION_SECONDS || 3)));
  const negativePrompt = 'nsfw, nudity, explicit content, watermark, text, signature, subtitles, low quality, blurry, deformed, disfigured, static frame';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const submit = await previousFetch(`${base}/gradio_api/call/generate_video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [null, prompt, height, width, negativePrompt, duration, 0, 4, 42, true] }),
      signal: controller.signal
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
    for (const line of stream.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5).trim();
      if (value === '[DONE]') continue;
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) finalData = parsed;
        else if (parsed?.data) finalData = parsed.data;
      } catch {}
    }
    const videoUrl = findVideoUrl(finalData);
    if (!videoUrl) throw new Error('Free video service finished without a video URL.');
    return new Response(JSON.stringify({ provider: 'huggingface-zero-gpu', model: 'FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers', video_url: videoUrl, status: 'completed', free: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    const status = error?.name === 'AbortError' ? 504 : 503;
    return new Response(JSON.stringify({ error: { code: status === 504 ? 'free_video_timeout' : 'free_video_unavailable', message: error?.message || 'Free video service is temporarily unavailable.' } }), { status, headers: { 'Content-Type': 'application/json' } });
  } finally {
    clearTimeout(timer);
  }
}

globalThis.fetch = async function videoSafeFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input?.url || '';
  const method = String(init.method || 'GET').toUpperCase();
  if (url === 'https://openrouter.ai/api/v1/videos' && method === 'POST' && typeof init.body === 'string') {
    let payload; try { payload = JSON.parse(init.body); } catch { return previousFetch(input, init); }
    if (process.env.PAID_VIDEO_ENABLED !== 'true') return freeVideo(payload);
  }
  return previousFetch(input, init);
};

process.env.FREE_VIDEO_DURATION_SECONDS = process.env.FREE_VIDEO_DURATION_SECONDS || '3';
process.env.PAID_VIDEO_ENABLED = process.env.PAID_VIDEO_ENABLED || 'false';
