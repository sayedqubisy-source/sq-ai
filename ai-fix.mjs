// SQ AI AI-response compatibility layer.
// Normalizes OpenRouter chat responses so the app never loses valid text
// when a provider returns array content, text fields, or reasoning fields.
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

globalThis.fetch = async (...args) => {
  const response = await previousFetch(...args);
  let url = '';
  try { url = typeof args[0] === 'string' ? args[0] : args[0]?.url || ''; } catch {}
  if (!url.includes('openrouter.ai/api/v1/chat/completions')) return response;

  let data;
  try { data = await response.clone().json(); } catch { return response; }
  if (!response.ok) return response;

  const choice = data?.choices?.[0];
  if (choice?.message) {
    const text = extractText(choice.message);
    if (text && typeof choice.message.content !== 'string') choice.message.content = text;
    if (!text && typeof choice.text === 'string' && choice.text.trim()) choice.message.content = choice.text.trim();
  }

  const hasText = !!extractText(choice?.message || {}) || !!String(choice?.text || '').trim();
  if (!hasText) {
    const body = JSON.stringify({
      error: {
        code: 'empty_ai_response',
        message: 'The AI provider returned an empty response. Please try again.'
      }
    });
    return new Response(body, {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  return new Response(JSON.stringify(data), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
};
