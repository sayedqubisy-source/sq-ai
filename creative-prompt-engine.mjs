import express from 'express';

const MEDIA_TOOLS = new Set([
  'text-image','product-image','ad-creative','background','enhance','thumbnail','social-image','variations',
  'text-video','image-video','ad-video','product-video','reels','long-shorts','script-video','voiceover','subtitles','translation','resize','silence','noise','hooks-video',
  'music','music-generation','audio','background-music','soundtrack','lyria'
]);

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
  const common='Create the actual output, not an explanation. Preserve the user intent. Make the result production-ready, coherent, specific, and visually/audio compelling. Never add watermarks, logos, random text, or unrelated objects unless requested.';
  if(tool.includes('image')) return `${common}\nFor image generation: specify subject, composition, environment, action/pose, camera/framing, lens, lighting, materials, colors, depth, realism/style, background and exact aspect ratio. If people are present, make anatomy, hands and facial features natural. If the user asks for product advertising, keep the product identity and proportions consistent.\n${base}`;
  if(tool.includes('video')||['reels','long-shorts','script-video','voiceover','subtitles','translation','resize','silence','noise','hooks-video'].includes(tool)) return `${common}\nFor video generation: define subject, continuous action, setting, shot type, camera movement, lens/framing, lighting, atmosphere, realistic physics, continuity, timing and transitions. Keep the main subject consistent from start to finish. Add natural dialogue, ambience and sound effects only when appropriate. Optimize composition for the requested platform.\n${base}`;
  if(['music','music-generation','audio','background-music','soundtrack','lyria'].includes(tool)) return `${common}\nFor music/audio generation: define genre, mood, tempo, instrumentation, rhythm, structure, dynamics, sound design, vocal/no-vocal direction and mix/master character. Keep it original and suitable for the stated use case.\n${base}`;
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
