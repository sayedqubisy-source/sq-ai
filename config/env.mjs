import path from 'node:path';

const bool = (value, fallback = false) => {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const dbPath = process.env.DB_PATH || './data/sq-ai.sqlite';

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: number(process.env.PORT, 3000),
  dbPath,
  dbDirectory: path.dirname(path.resolve(dbPath)),
  isProduction: (process.env.NODE_ENV || 'development') === 'production',
  sessionDays: number(process.env.SESSION_DAYS, 30),
  requestTimeoutMs: number(process.env.REQUEST_TIMEOUT_MS, 180000),
  agentTimeoutMs: number(process.env.AGENT_TIMEOUT_MS, 600000),
  paidVideoEnabled: bool(process.env.PAID_VIDEO_ENABLED),
  freeVideoModel: process.env.FREE_VIDEO_SPACE || 'alexcheng0072/wan27-free-video-generator',
  freeVideoDuration: number(process.env.FREE_VIDEO_DURATION_SECONDS, 3),
  mediaPromptEnhancer: bool(process.env.MEDIA_PROMPT_ENHANCER, true),
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiTextModel: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash',
  geminiImageModel: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
  veoModel: process.env.VEO_MODEL || 'veo-3.1-generate-preview',
  elevenLabsKey: process.env.ELEVENLABS_API_KEY || '',
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || '',
  elevenLabsModel: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
  videoApiUrl: process.env.VIDEO_API_URL || '',
  videoApiKey: process.env.VIDEO_API_KEY || '',
});
