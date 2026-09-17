import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.mjs';
import { mediaRoot } from './store.mjs';

async function request(url, options = {}, timeoutMs = env.agentTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('music_provider_timeout'), { status: 504 });
    throw error;
  } finally { clearTimeout(timer); }
}

function findFile(value) {
  if (!value) return null;
  if (typeof value === 'string') return /^(?:https?:\/\/|\/|\/tmp\/)/.test(value) ? value : null;
  if (Array.isArray(value)) return value.map(findFile).find(Boolean) || null;
  if (typeof value === 'object') return ['url', 'path', 'file', 'data', 'value'].map(key => findFile(value[key])).find(Boolean) || null;
  return null;
}

async function downloadAudio(url, headers, provider, model) {
  const response = await request(url, { headers }, 120_000);
  if (!response.ok) throw Object.assign(new Error(`music_download_failed_${response.status}`), { status: 502 });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > env.maxMediaBytes) throw Object.assign(new Error('music_output_invalid_size'), { status: 502 });
  const contentType = response.headers.get('content-type') || '';
  const extension = contentType.includes('mpeg') || contentType.includes('mp3') ? 'mp3' : 'wav';
  const name = `music-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${extension}`;
  fs.writeFileSync(path.join(mediaRoot, name), bytes);
  return { url: `/generated-media/${name}`, provider, model };
}

export async function generateMusic(prompt) {
  const host = String(process.env.HF_MUSIC_SPACE || 'https://facebook-musicgen.hf.space').replace(/\/$/, '');
  const auth = process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
  const submit = await request(`${host}/gradio_api/call/predict_batched`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ data: [[String(prompt).slice(0, 4000)], [null]] }),
  }, 60_000);
  const submitted = await submit.json().catch(() => ({}));
  if (!submit.ok || !submitted.event_id) throw Object.assign(new Error(submitted.error || 'music_provider_unavailable'), { status: 503 });
  const result = await request(`${host}/gradio_api/call/predict_batched/${encodeURIComponent(submitted.event_id)}`, { headers: { Accept: 'text/event-stream', ...auth } }, 300_000);
  if (!result.ok) throw Object.assign(new Error(`music_provider_result_${result.status}`), { status: 502 });
  let downloadError;
  for (const block of (await result.text()).replace(/\r\n?/g, '\n').split(/\n\n+/).reverse()) {
    const line = block.split('\n').find(value => value.startsWith('data:'));
    if (!line) continue;
    try {
      const file = findFile(JSON.parse(line.slice(5).trim()));
      if (!file) continue;
      const url = file.startsWith('http') ? file : `${host}/gradio_api/file=${file}`;
      return await downloadAudio(url, auth, 'huggingface-musicgen', 'facebook/MusicGen');
    } catch (error) { downloadError = error; }
  }
  if (downloadError) throw downloadError;
  throw Object.assign(new Error('music_provider_output_missing'), { status: 502 });
}
