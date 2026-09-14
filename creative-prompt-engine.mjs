import express from 'express';

const IMAGE_TOOLS = new Set(['text-image','product-image','ad-creative','background','enhance','thumbnail','social-image','variations']);
const VIDEO_TOOLS = new Set(['text-video','image-video','ad-video','product-video','reels','long-shorts','script-video','hooks-video']);
const MUSIC_TOOLS = new Set(['music','music-generation','audio','background-music','soundtrack','lyria']);
const VOICE_TOOLS = new Set(['voiceover']);
const CAPTION_TOOLS = new Set(['subtitles']);
const TRANSLATION_TOOLS = new Set(['translation']);
const EDIT_TOOLS = new Set(['resize','silence','noise']);
const MEDIA_TOOLS = new Set([...IMAGE_TOOLS,...VIDEO_TOOLS,...MUSIC_TOOLS,...VOICE_TOOLS,...CAPTION_TOOLS,...TRANSLATION_TOOLS,...EDIT_TOOLS]);

const TEXT_TOOL_HINTS = {
  text:'Create a polished, useful, ready-to-publish answer. Follow the requested language, audience and tone. Do not invent facts.',
  research:'Research/analysis mode: separate verified facts from assumptions, use structured reasoning, and never fabricate sources.',
  reasoning:'Reason step by step internally, but return a concise, actionable result with clear assumptions and conclusions.',
  coding:'Return production-ready code or implementation guidance, preserving the requested stack and avoiding invented APIs.'
};

function clean(v,max=12000){return String(v??'').trim().slice(0,max)}
function mediaPrompt(tool,idea,body){
  const platform=clean(body.platform,80)||'General';
  const language=clean(body.language,50)||'English';
  const ratio=clean(body.aspectRatio,20)||'';
  const base=`USER IDEA:\n${idea}\n\nTOOL: ${tool}\nPLATFORM: ${platform}\nLANGUAGE: ${language}${ratio?`\nASPECT RATIO: ${ratio}`:''}`;
  const common='Create the actual output, not an explanation. Preserve the user intent. Make the result production-ready, coherent, specific, and suitable for direct generation. Never add watermarks, logos, random text, or unrelated objects unless requested.';
  if(IMAGE_TOOLS.has(tool)) return `${common}\nIMAGE: define subject, composition, environment, action/pose, camera/framing, lens, lighting, materials, colors, depth, realism/style, background and exact aspect ratio. Keep products consistent and people anatomically natural.\n${base}`;
  if(VIDEO_TOOLS.has(tool)) return `${common}\nVIDEO: define the subject, continuous action, setting, shot type, camera movement, lens/framing, lighting, atmosphere, realistic physics, continuity, timing and transitions. Keep the main subject consistent from start to finish. Add natural dialogue, ambience and sound effects only when appropriate. Optimize composition for the requested platform.\n${base}`;
  if(MUSIC_TOOLS.has(tool)) return `${common}\nMUSIC/AUDIO: define genre, mood, tempo/BPM, instrumentation, rhythm, structure, dynamics, sound design, vocal/no-vocal direction and mix/master character. Keep the composition original and suitable for the use case.\n${base}`;
  if(VOICE_TOOLS.has(tool)) return `${common}\nVOICEOVER: define language, dialect, speaker character, age range, gender only if requested, emotion, pace, pronunciation, pauses, emphasis, clarity and recording style. Return a script/audio-ready direction, not visual instructions.\n${base}`;
  if(CAPTION_TOOLS.has(tool)) return `${common}\nSUBTITLES: preserve the spoken meaning exactly, use the requested language, concise readable lines, natural segmentation and correct timing cues. Do not invent dialogue.\n${base}`;
  if(TRANSLATION_TOOLS.has(tool)) return `${common}\nTRANSLATION: preserve meaning, context, names and intent; use natural target-language phrasing and the requested dialect. Do not add or remove information.\n${base}`;
  if(EDIT_TOOLS.has(tool)) return `${common}\nMEDIA EDIT: apply only the requested transformation. Preserve the source content and quality, avoid unintended changes, and return an actionable processing specification.\n${base}`;
  return `${common}\n${base}`;
}

const originalPost=express.application.post;
if(!express.application.__sqaiCreativePromptEngine){
  express.application.__sqaiCreativePromptEngine=true;
  express.application.post=function(route,...handlers){
    if(handlers.length && (route==='/api/tools/generate'||route==='/api/ai/generate')){
      const original=handlers[handlers.length-1];
      handlers[handlers.length-1]=function(req,res,next){
        try{
          req.body=req.body||{};
          if(route==='/api/tools/generate'){
            const tool=clean(req.body.tool,100);
            const idea=clean(req.body.prompt||req.body.input,12000);
            if(idea && MEDIA_TOOLS.has(tool)) req.body.prompt=mediaPrompt(tool,idea,req.body);
          } else {
            const capability=clean(req.body.capability,30).toLowerCase()||'text';
            const hint=TEXT_TOOL_HINTS[capability]||TEXT_TOOL_HINTS.text;
            const existing=clean(req.body.system,4000);
            req.body.system=`${hint}\n${existing||'You are SQ AI, a professional AI creation assistant.'}\nAlways produce the requested result directly. Respect the user's language and intended audience.`.slice(0,4000);
          }
        }catch(e){console.warn('SQ AI prompt engine skipped:',e?.message||e)}
        return original(req,res,next);
      };
    }
    return originalPost.call(this,route,...handlers);
  };
}
console.log('SQ AI Creative Prompt Engine loaded: universal generation prompts enabled');
