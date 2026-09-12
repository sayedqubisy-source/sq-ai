const originalFetch = globalThis.fetch;

const TEXT_FALLBACKS = [
  'openrouter/free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-3-27b-it:free'
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isOpenRouter(url) {
  return String(url).startsWith('https://openrouter.ai/api/v1/');
}

function shouldRetry(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function fetchWithRetry(input, init = {}) {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!isOpenRouter(url)) return originalFetch(input, init);

  const method = String(init.method || 'GET').toUpperCase();
  const isChat = url.endsWith('/chat/completions') && method === 'POST';
  const isVideoSubmit = url.endsWith('/videos') && method === 'POST';
  const maxAttempts = isChat ? TEXT_FALLBACKS.length : (isVideoSubmit ? 2 : 3);
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const headers = new Headers(init.headers || {});
    let body = init.body;

    if (isChat && typeof body === 'string') {
      try {
        const payload = JSON.parse(body);
        payload.model = TEXT_FALLBACKS[attempt];
        body = JSON.stringify(payload);
      } catch (error) {
        console.error('runtime_fix_invalid_json_body', error);
        return originalFetch(input, init);
      }
    }

    try {
      const response = await originalFetch(input, { ...init, headers, body });
      if (response.ok || !shouldRetry(response.status) || attempt >= maxAttempts - 1) return response;
      await sleep(Math.min(1200, 400 * (attempt + 1)));
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts - 1) throw error;
      await sleep(Math.min(1200, 400 * (attempt + 1)));
    }
  }

  throw lastError || new Error('OpenRouter request failed after retries.');
}

globalThis.fetch = fetchWithRetry;
process.env.AI_TEXT_PROVIDER = process.env.AI_TEXT_PROVIDER || 'openrouter';
process.env.AI_VIDEO_PROVIDER = process.env.AI_VIDEO_PROVIDER || 'openrouter';
process.env.OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
