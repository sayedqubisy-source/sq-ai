const IMAGE_TOOLS = new Set(['text-image', 'product-image', 'ad-creative', 'background', 'enhance', 'thumbnail', 'social-image', 'variations']);
const VIDEO_TOOLS = new Set(['text-video', 'image-video', 'ad-video', 'product-video', 'reels', 'long-shorts', 'script-video', 'voiceover', 'subtitles', 'translation', 'resize', 'silence', 'noise', 'hooks-video']);
const MUSIC_TOOLS = new Set(['music', 'music-generation', 'audio', 'background-music', 'soundtrack', 'lyria']);

export const mediaToolGroups = Object.freeze({ IMAGE_TOOLS, VIDEO_TOOLS, MUSIC_TOOLS });

const clean = (value, max = 12000) => String(value ?? '').trim().slice(0, max);

export function enhanceMediaPrompt(tool, idea, body = {}) {
  const userIdea = clean(idea);
  const platform = clean(body.platform, 80) || 'General';
  const language = clean(body.language, 50) || 'auto';
  const ratio = clean(body.aspectRatio, 20);
  const context = `USER IDEA:\n${userIdea}\n\nTOOL: ${tool}\nPLATFORM: ${platform}\nLANGUAGE: ${language}${ratio ? `\nASPECT RATIO: ${ratio}` : ''}`;
  const common = 'Create the requested output directly. Treat USER IDEA as an exact visual checklist: preserve every requested subject, product, clothing item, color, motif, action, and setting. Never replace the main subject with a generic person or unrelated scene. Keep it coherent, specific, production-ready, and free of watermarks, random text, logos, or unrelated objects unless explicitly requested.';
  if (IMAGE_TOOLS.has(tool)) return `${context}\n\n${common}\nDefine subject, composition, environment, camera, lighting, materials, colors, depth, style, background, and aspect ratio. Keep products consistent and people anatomically natural.`;
  if (VIDEO_TOOLS.has(tool)) return `${context}\n\n${common}\nIf USER IDEA is not English, interpret it precisely and express the visual concepts in clear English for the video model without changing its meaning. Define continuous action, setting, shot, camera movement, lighting, atmosphere, realistic physics, continuity, timing, and transitions. Show the requested subject clearly in the opening frame and keep it consistent from start to finish.`;
  if (MUSIC_TOOLS.has(tool)) return `${context}\n\n${common}\nDefine genre, mood, tempo, instrumentation, rhythm, structure, dynamics, vocals, and mix character. Keep the composition original.`;
  return userIdea;
}

export function textSystemPrompt(capability, supplied = '') {
  const mode = clean(capability, 80).toLowerCase() || 'text';
  const hints = {
    text: 'Create a polished, useful, ready-to-publish answer. Do not invent facts.',
    research: 'Separate verified facts from assumptions and never fabricate sources.',
    reasoning: 'Return a concise, actionable result with explicit assumptions and conclusions.',
    coding: 'Return production-ready code or implementation guidance using only real APIs.',
  };
  return `${hints[mode] || hints.text}\n${clean(supplied, 3000) || 'You are SQ AI, a professional AI creation assistant.'}\nRespect the user language and intended audience. Return the requested result directly.`.slice(0, 4000);
}
