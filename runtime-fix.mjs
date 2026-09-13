const originalFetch = globalThis.fetch;

// Keep text generation working even when one OpenRouter free provider is
// temporarily unavailable. The server itself already supplies the prompt;
// this layer only makes the upstream request resilient.
const TEXT_FALLBACKS = [
  'openrouter/free',
  'nvidia/nemotron-3-ultra:free',
  'inclusionai/ling-3.0-flash-vl:free',
  'google/gemma-4-26b-a4b:free'
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isOpenRouter = url => String(url).startsWith('https://openrouter.ai/api/v1/');
const retryable = status => status === 408 || status === 409 || status === 429 || status >= 500;

function responseWithBody(response, body) {
  const headers = new Headers(response.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function hasUsableText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(part => typeof part?.text === 'string' && part.text.trim().length > 0);
  }
  return false;
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
    let lastError = null;

    for (let attempt = 0; attempt < models.length; attempt++) {
      const model = models[attempt];
      try {
        const response = await originalFetch(input, {
          ...init,
          body: JSON.stringify({
            ...payload,
            model,
            stream: false
          })
        });

        const raw = await response.text();
        lastResponse = responseWithBody(response, raw);

        if (response.ok) {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch {}

          // A 200 with no usable message is treated as a failed provider,
          // otherwise server.js turns it into the misleading empty-result UI.
          if (parsed && hasUsableText(parsed)) return responseWithBody(response, raw);
          if (!parsed && raw.trim()) return responseWithBody(response, raw);
        } else if (!retryable(response.status)) {
          return responseWithBody(response, raw);
        }
      } catch (error) {
        lastError = error;
      }

      if (attempt < models.length - 1) {
        await sleep(Math.min(1500, 300 * (attempt + 1)));
      }
    }

    if (lastResponse) return lastResponse;
    throw lastError || new Error('OpenRouter request failed.');
  }

  // Do not silently replace an invalid/free video slug with a paid model.
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
