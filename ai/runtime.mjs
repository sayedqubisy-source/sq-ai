import { env } from '../config/env.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(url, options = {}, timeoutMs = env.requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('provider_timeout'), { status: 504 });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) {
    throw Object.assign(new Error(data?.error?.message || data?.error || data?.message || `provider_http_${response.status}`), { status: response.status });
  }
  return data;
}

function messagesToGemini(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }] }));
  if (system && contents[0]) contents[0].parts.unshift({ text: `SYSTEM INSTRUCTIONS:\n${system}\n\nUSER REQUEST:\n` });
  return { system, contents };
}

async function gemini(messages, model = env.geminiTextModel) {
  if (!env.geminiKey) throw Object.assign(new Error('text_provider_not_configured'), { status: 503 });
  const { system, contents } = messagesToGemini(messages);
  const body = { contents, generationConfig: { temperature: 0.7 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const response = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.geminiKey },
    body: JSON.stringify(body),
  });
  const data = await readJson(response);
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('').trim();
  if (!text) throw Object.assign(new Error('ai_empty_result'), { status: 502 });
  return { text, provider: 'google-gemini', model };
}

async function openAiCompatible(baseUrl, key, model, messages, provider) {
  const response = await request(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.7 }),
  });
  const data = await readJson(response);
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw Object.assign(new Error('ai_empty_result'), { status: 502 });
  return { text, provider, model };
}

export async function generateText({ messages, model } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw Object.assign(new Error('messages_required'), { status: 400 });

  const providers = [];
  if (env.geminiKey) providers.push(() => gemini(messages, model || env.geminiTextModel));
  if (process.env.OPENAI_API_KEY) providers.push(() => openAiCompatible('https://api.openai.com/v1', process.env.OPENAI_API_KEY, model || process.env.OPENAI_MODEL || 'gpt-4.1-mini', messages, 'openai'));
  if (process.env.OPENROUTER_API_KEY) providers.push(() => openAiCompatible('https://openrouter.ai/api/v1', process.env.OPENROUTER_API_KEY, model || process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini', messages, 'openrouter'));
  if (process.env.GROQ_API_KEY) providers.push(() => openAiCompatible('https://api.groq.com/openai/v1', process.env.GROQ_API_KEY, model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', messages, 'groq'));

  if (!providers.length) throw Object.assign(new Error('text_provider_not_configured'), { status: 503 });

  let lastError;
  for (const provider of providers) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { return await provider(); } catch (error) {
        lastError = error;
        if (![429, 500, 502, 503, 504].includes(Number(error?.status))) break;
        await sleep(500 * (attempt + 1));
      }
    }
  }
  throw lastError || Object.assign(new Error('ai_generation_failed'), { status: 502 });
}

export function runtimeStatus() {
  return {
    providers: {
      gemini: Boolean(env.geminiKey),
      openai: Boolean(process.env.OPENAI_API_KEY),
      openrouter: Boolean(process.env.OPENROUTER_API_KEY),
      groq: Boolean(process.env.GROQ_API_KEY),
    },
    default_provider: env.geminiKey ? 'google-gemini' : process.env.OPENAI_API_KEY ? 'openai' : null,
  };
}
