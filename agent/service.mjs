import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../config/env.mjs';
import { generateText } from '../ai/runtime.mjs';
import { saveBuffer, localPath, videoRoot } from '../media/store.mjs';

const execFileAsync = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = (value, max = 12000) => String(value ?? '').trim().slice(0, max);

async function request(url, options = {}, timeoutMs = env.agentTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('provider_timeout'), { status: 504 });
    throw error;
  } finally { clearTimeout(timer); }
}

async function json(response) {
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw Object.assign(new Error(data?.error?.message || data?.error || data?.message || `provider_http_${response.status}`), { status: response.status });
  return data;
}

function parsePlan(text, prompt, options) {
  const raw = String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const plan = JSON.parse(raw);
    if (Array.isArray(plan.scenes) && plan.scenes.length) return plan;
  } catch {}
  return {
    title: 'SQ AI Project',
    script: raw || prompt,
    voice: { language: 'auto', dialect: 'auto', tone: 'natural', pace: 'medium' },
    scenes: [{ narration: raw || prompt, visualPrompt: prompt, durationSeconds: options.durationSeconds || 5 }],
  };
}

export async function createPlan(prompt, options = {}) {
  const result = await generateText({
    messages: [
      { role: 'system', content: 'You are SQ AI Creative Producer. Return ONLY JSON. Create a production-ready video plan with title, script, voice, and scenes. Each scene needs narration, visualPrompt, durationSeconds. Preserve the user language and intent. Visual prompts must be realistic and contain no on-screen text unless requested.' },
      { role: 'user', content: `${prompt}\nOptions: ${JSON.stringify(options)}` },
    ],
  });
  return parsePlan(result.text, prompt, options);
}

export async function generateImage(prompt, aspectRatio = '16:9') {
  if (!env.geminiKey) throw Object.assign(new Error('image_provider_not_configured'), { status: 503 });
  const ratio = ['1:1', '9:16', '16:9'].includes(aspectRatio) ? aspectRatio : '16:9';
  const response = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.geminiImageModel)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.geminiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: clean(prompt) }] }], generationConfig: { responseModalities: ['IMAGE'], responseFormat: { image: { aspectRatio: ratio, imageSize: '1K' } } } }),
  }, 180000);
  const data = await json(response);
  const part = (data?.candidates?.[0]?.content?.parts || []).find(item => item?.inlineData?.data || item?.inline_data?.data);
  const base64 = part?.inlineData?.data || part?.inline_data?.data;
  if (!base64) throw Object.assign(new Error('image_data_missing'), { status: 502 });
  const mime = part?.inlineData?.mimeType || part?.inline_data?.mime_type || 'image/png';
  const ext = mime.includes('webp') ? 'webp' : mime.includes('jpeg') ? 'jpg' : 'png';
  return { url: saveBuffer('image', ext, Buffer.from(base64, 'base64')), provider: 'google-gemini', model: env.geminiImageModel };
}

export async function generateVoice(text, voiceId) {
  if (!env.elevenLabsKey) throw Object.assign(new Error('voice_provider_not_configured'), { status: 503 });
  const id = voiceId || env.elevenLabsVoiceId;
  if (!id) throw Object.assign(new Error('voice_id_not_configured'), { status: 503 });
  const response = await request(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'xi-api-key': env.elevenLabsKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: clean(text), model_id: env.elevenLabsModel, output_format: 'mp3_44100_128' }),
  }, 180000);
  if (!response.ok) throw Object.assign(new Error((await response.text()).slice(0, 500)), { status: response.status });
  return { url: saveBuffer('voice', 'mp3', await response.arrayBuffer()), provider: 'elevenlabs', model: env.elevenLabsModel, voiceId: id };
}

export async function generateVideo(prompt, options = {}) {
  if (env.videoApiUrl && env.videoApiKey) {
    const response = await request(env.videoApiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.videoApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: clean(prompt), aspectRatio: options.aspectRatio, resolution: options.resolution }),
    });
    const data = await json(response);
    const url = data.video_url || data.url || data.output?.video_url || data.output?.url;
    if (!url) throw Object.assign(new Error('video_provider_invalid_output'), { status: 502 });
    return { url, provider: data.provider || 'custom', model: data.model || null };
  }

  if (!env.geminiKey) throw Object.assign(new Error('video_provider_not_configured'), { status: 503 });
  const model = env.veoModel;
  const start = await json(await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:predictLongRunning`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.geminiKey },
    body: JSON.stringify({ instances: [{ prompt: clean(prompt) }], parameters: { aspectRatio: options.aspectRatio === '9:16' ? '9:16' : '16:9', resolution: ['720p', '1080p', '4k'].includes(options.resolution) ? options.resolution : '720p' } }),
  }, 120000));
  if (!start.name) throw Object.assign(new Error('video_operation_missing'), { status: 502 });
  let state = start;
  for (let attempt = 0; attempt < 90 && !state.done; attempt += 1) {
    await sleep(10000);
    state = await json(await request(`https://generativelanguage.googleapis.com/v1beta/${state.name}`, { headers: { 'x-goog-api-key': env.geminiKey } }, 60000));
  }
  if (!state.done) throw Object.assign(new Error('video_generation_timeout'), { status: 504 });
  if (state.error) throw Object.assign(new Error(state.error.message || 'video_generation_failed'), { status: 502 });
  const uri = state?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (!uri) throw Object.assign(new Error('video_uri_missing'), { status: 502 });
  const file = await request(uri, { headers: { 'x-goog-api-key': env.geminiKey } }, 180000);
  if (!file.ok) throw Object.assign(new Error(`video_download_failed_${file.status}`), { status: 502 });
  return { url: saveBuffer('video', 'mp4', await file.arrayBuffer(), videoRoot), provider: 'google-veo', model };
}

export async function muxVideo(videoUrl, audioUrl) {
  const videoPath = localPath(videoUrl);
  const audioPath = localPath(audioUrl);
  if (!videoPath || !audioPath) return videoUrl;
  const output = `${videoRoot}/final-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.mp4`;
  await execFileAsync('ffmpeg', ['-y', '-i', videoPath, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', output], { timeout: 180000 });
  return `/generated-videos/${output.split('/').pop()}`;
}

export async function runAgent(prompt, options = {}) {
  const plan = await createPlan(prompt, options);
  const scenes = plan.scenes.slice(0, 8);
  const outputs = [];
  const warnings = [];

  if (options.mode === 'image' || options.mode === 'all') {
    for (const [index, scene] of scenes.slice(0, options.maxImages || 3).entries()) {
      try { outputs.push({ type: 'image', scene: index + 1, ...(await generateImage(scene.visualPrompt || prompt, options.aspectRatio)) }); }
      catch (error) { warnings.push({ stage: `image:${index + 1}`, error: error?.message || 'image_generation_failed' }); }
    }
  }

  let voice = null;
  if (options.mode === 'voice' || options.mode === 'all' || options.voice === true) {
    try { voice = await generateVoice(scenes.map(scene => scene.narration).filter(Boolean).join('\n\n') || plan.script || prompt, options.voiceId); outputs.push({ type: 'voice', ...voice }); }
    catch (error) { warnings.push({ stage: 'voice', error: error?.message || 'voice_generation_failed' }); }
  }

  if (options.mode === 'video' || options.mode === 'all') {
    const videoPrompt = scenes.map((scene, index) => `Scene ${index + 1}: ${scene.visualPrompt || prompt}`).join('\n');
    try {
      const video = await generateVideo(`${videoPrompt}\nRealistic cinematic motion. Keep visual continuity. No on-screen text unless requested.`, options);
      const finalUrl = voice ? await muxVideo(video.url, voice.url) : video.url;
      outputs.push({ type: 'video', ...video, final_url: finalUrl });
    } catch (error) {
      warnings.push({ stage: 'video', error: error?.message || 'video_generation_failed' });
    }
  }

  return { plan, outputs, warnings };
}
