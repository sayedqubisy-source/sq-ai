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

async function fetchWithRetry(input, init = {}) {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!isOpenRouter(url)) return originalFetch(input, init);

  const isChat = url.endsWith('/chat/completions');
  const isVideoSubmit = url.endsWith('/videos') && (init.method || 'GET').toUpperCase() === 'POST';
  const maxAttempts = isChat ? TEXT_FALLBACKS.length : 2;
  let lastResponse = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const headers = new Headers(init.headers || {});
    let body = init.body;

    if (isChat && typeof body === 'string') {
      try {
        const payload = JSON.parse(body);
        payload.model = TEXT_FALLBACKS[attempt];
        body = JSON.stringify(payload);
      } catch {}
    }

    try {
      const response = await originalFetch(input, { ...init, headers, body });
      lastResponse = response;

      if (response.ok || (!isChat && !isVideoSubmit) || (response.status < 500 && response.status !== 429)) {
        return response;
      }

      if (attempt < maxAttempts - 1) {
        await sleep(350 * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= maxAttempts - 1) throw error;
      await sleep(350 * (attempt + 1));
    }
  }

  return lastResponse;
}

globalThis.fetch = fetchWithRetry;
process.env.AI_TEXT_PROVIDER = process.env.AI_TEXT_PROVIDER || 'openrouter';
process.env.AI_VIDEO_PROVIDER = process.env.AI_VIDEO_PROVIDER || 'openrouter';
process.env.OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
