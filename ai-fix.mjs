// SQ AI AI-response compatibility layer.
// Normalizes OpenRouter chat responses and falls back to the free router
// when the configured model returns an empty completion.
const previousFetch = globalThis.fetch;

function extractText(message = {}) {
  const content = message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .map(part => typeof part === 'string' ? part : (part?.text || part?.content || ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return text;
  }
  if (typeof message?.text === 'string' && message.text.trim()) return message.text.trim();
  if (typeof message?.reasoning === 'string' && message.reasoning.trim()) return message.reasoning.trim();
  return '';
}

function hasText(data) {
  const choice = data?.choices?.[0];
  return !!extractText(choice?.message || {}) || !!String(choice?.text || '').trim();
}

function makeResponse(data, response) {
  return new Response(JSON.stringify(data), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

async function readJson(response) {
  try { return await response.clone().json(); } catch { return null; }
}

async function callFreeRouter(originalArgs) {
  const [input, init = {}] = originalArgs;
  let nextInit = { ...init };
  try {
    const body = JSON.parse(init.body || '{}');
    body.model = 'openrouter/free';
    nextInit.body = JSON.stringify(body);
  } catch {}
  return previousFetch(input, nextInit);
}

globalThis.fetch = async (...args) => {
  let url = '';
  try { url = typeof args[0] === 'string' ? args[0] : args[0]?.url || ''; } catch {}
  const isChat = url.includes('openrouter.ai/api/v1/chat/completions');
  if (!isChat) return previousFetch(...args);

  // If no model was supplied, use OpenRouter's free model router.
  try {
    const init = args[1] || {};
    if (init.body) {
      const body = JSON.parse(init.body);
      if (!body.model) {
        body.model = 'openrouter/free';
        args[1] = { ...init, body: JSON.stringify(body) };
      }
    }
  } catch {}

  let response = await previousFetch(...args);
  let data = await readJson(response);

  // Retry once through the current free-model router when the configured
  // model succeeds at HTTP level but produces no usable text.
  if (response.ok && data && !hasText(data)) {
    const retry = await callFreeRouter(args);
    const retryData = await readJson(retry);
    if (retry.ok && retryData) {
      response = retry;
      data = retryData;
    }
  }

  if (!response.ok) return response;
  if (!data) return response;

  const choice = data?.choices?.[0];
  if (choice?.message) {
    const text = extractText(choice.message);
    if (text && typeof choice.message.content !== 'string') choice.message.content = text;
    if (!text && typeof choice.text === 'string' && choice.text.trim()) choice.message.content = choice.text.trim();
  }

  if (!hasText(data)) {
    return makeResponse({
      error: {
        code: 'empty_ai_response',
        message: 'The AI provider returned an empty response. Please try again.'
      }
    }, new Response(null, { status: 502 }));
  }

  return makeResponse(data, response);
};
