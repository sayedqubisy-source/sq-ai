const originalFetch = globalThis.fetch;

// OpenRouter's current free text models. The router is first; the explicit
// models below are valid free variants used as deterministic fallbacks.
const TEXT_FALLBACKS = [
  'openrouter/free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b:free',
  'inclusionai/ling-3.0-flash-vl:free'
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isOpenRouter = url => String(url).startsWith('https://openrouter.ai/api/v1/');
const retryable = status => status === 408 || status === 409 || status === 429 || status >= 500;

function responseWithBody(response, body, status = response.status) {
  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json');
  return new Response(body, { status, statusText: response.statusText, headers });
}

function extractText(body) {
  const message = body?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content.map(part => typeof part === 'string' ? part : part?.text)
      .filter(text => typeof text === 'string' && text.trim()).join('\n').trim();
    if (text) return text;
  }
  const choiceText = body?.choices?.[0]?.text;
  if (typeof choiceText === 'string' && choiceText.trim()) return choiceText.trim();
  return '';
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
    let lastStatus = 502;
    let lastErrorMessage = '';

    for (let attempt = 0; attempt < models.length; attempt++) {
      const model = models[attempt];
      try {
        const response = await originalFetch(input, {
          ...init,
          body: JSON.stringify({
            ...payload,
            model,
            stream: false,
            temperature: payload.temperature ?? 0.7,
            max_tokens: payload.max_tokens ?? 1200
          })
        });
        const raw = await response.text();
        lastResponse = response;
        lastStatus = response.status;

        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        const text = extractText(parsed);

        if (response.ok && text) {
          if (parsed?.choices?.[0]?.message) parsed.choices[0].message.content = text;
          return responseWithBody(response, JSON.stringify(parsed), 200);
        }

        lastErrorMessage = parsed?.error?.message || parsed?.message || `OpenRouter returned HTTP ${response.status}`;
        if (!response.ok && !retryable(response.status)) {
          return responseWithBody(response, raw, response.status);
        }
      } catch (error) {
        lastErrorMessage = error?.message || String(error);
      }
      if (attempt < models.length - 1) await sleep(Math.min(1200, 250 * (attempt + 1)));
    }

    return responseWithBody(
      lastResponse || new Response('{}'),
      JSON.stringify({
        error: {
          code: 'openrouter_unavailable',
          message: `OpenRouter did not return usable text. ${lastErrorMessage || 'No usable response was returned.'}`
        }
      }),
      503
    );
  }

  if (isVideoSubmit && typeof init.body === 'string') {
    try {
      const payload = JSON.parse(init.body);
      const model = String(payload.model || '');
      if (model.endsWith(':free')) {
        return new Response(JSON.stringify({ error: { code: 'video_model_requires_configuration', message: 'The configured video model requires a supported video provider.' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
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
