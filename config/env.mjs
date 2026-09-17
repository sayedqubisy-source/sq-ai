import path from 'node:path';

const bool = (value, fallback = false) => {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const number = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
};

const dbPath = process.env.DB_PATH || './data/sq-ai.sqlite';
const nodeEnv = process.env.NODE_ENV || 'production';
const falKey = process.env.FAL_KEY || '';

export const env = Object.freeze({
  nodeEnv,
  port: number(process.env.PORT, 3000, 65535),
  // Trust only the configured number of reverse-proxy hops; default to none.
  trustProxy: process.env.TRUST_PROXY === 'true' ? 1 : number(process.env.TRUST_PROXY, false, 16),
  dbPath,
  dbDirectory: path.dirname(path.resolve(dbPath)),
  isProduction: nodeEnv === 'production',
  sessionDays: number(process.env.SESSION_DAYS, 30, 365),
  requestTimeoutMs: number(process.env.REQUEST_TIMEOUT_MS, 180000, 600000),
  agentTimeoutMs: number(process.env.AGENT_TIMEOUT_MS, 600000, 900000),
  maxMediaBytes: number(process.env.MAX_MEDIA_BYTES, 250 * 1024 * 1024, 1024 * 1024 * 1024),
  paidVideoEnabled: Boolean(falKey) || bool(process.env.PAID_VIDEO_ENABLED),
  freeVideoModel: process.env.FREE_VIDEO_SPACE || 'alexcheng0072/wan27-free-video-generator',
  freeVideoDuration: number(process.env.FREE_VIDEO_DURATION_SECONDS, 3, 5),
  mediaPromptEnhancer: bool(process.env.MEDIA_PROMPT_ENHANCER, true),
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiTextModel: process.env.GEMINI_TEXT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  geminiImageModel: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
  veoModel: process.env.VEO_MODEL || 'veo-3.1-generate-preview',
  elevenLabsKey: process.env.ELEVENLABS_API_KEY || '',
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || '',
  elevenLabsModel: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
  falKey,
  falVideoModel: process.env.FAL_VIDEO_MODEL || 'fal-ai/wan/v2.2-a14b/text-to-video/turbo',
  falVideoResolution: ['480p', '580p', '720p'].includes(process.env.FAL_VIDEO_RESOLUTION) ? process.env.FAL_VIDEO_RESOLUTION : '720p',
  videoApiUrl: process.env.VIDEO_API_URL || '',
  videoApiKey: process.env.VIDEO_API_KEY || '',
});
