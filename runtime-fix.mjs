const originalFetch = globalThis.fetch;
const TEXT_FALLBACKS = [
  'openrouter/free',
  'nvidia/nemotron-3-ultra:free',
  'inclusionai/ling-3.0-flash-vl:free',
  'google/gemma-4-26b-a4b:free'
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isOpenRouter = url => String(url).startsWith('https://openrouter.ai/api/v1/');
const retryable = status => status === 408 || status === 409 || status === 429 || status >= 500;

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
    let lastResponse;
    for (let attempt = 0; attempt < models.length; attempt++) {
      try {
        const response = await originalFetch(input, { ...init, body: JSON.stringify({ ...payload, model: models[attempt] }) });
        if (response.ok) return response;
        lastResponse = response;
        if (!retryable(response.status)) return response;
        if (attempt < models.length - 1) await sleep(Math.min(1000, 250 * (attempt + 1)));
      } catch (error) {
        if (attempt >= models.length - 1) throw error;
        await sleep(Math.min(1000, 250 * (attempt + 1)));
      }
    }
    return lastResponse;
  }

  // Do not silently replace an invalid/free video slug with a paid model.
  // OpenRouter's current video catalogue is not a guaranteed free-video catalogue.
  if (isVideoSubmit && typeof init.body === 'string') {
    try {
      const payload = JSON.parse(init.body);
      const model = String(payload.model || '');
      if (model.endsWith(':free')) {
        return new Response(JSON.stringify({
          error: {
            code: 'video_model_requires_configuration',
            message: 'The configured video model is a free/retired slug. Set OPENROUTER_VIDEO_MODEL to a currently supported video model before generating videos.'
          }
        }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
    } catch {}
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
