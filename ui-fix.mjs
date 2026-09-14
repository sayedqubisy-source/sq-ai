import fs from 'node:fs';
import path from 'node:path';

process.env.OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
process.env.OPENROUTER_IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-3.1-flash-image';
process.env.FREE_VIDEO_SPACE = process.env.FREE_VIDEO_SPACE || 'alexcheng0072/wan27-free-video-generator';
process.env.FREE_VIDEO_DURATION_SECONDS = process.env.FREE_VIDEO_DURATION_SECONDS || '3';
process.env.PAID_VIDEO_ENABLED = process.env.PAID_VIDEO_ENABLED || 'false';
process.env.VEO_MODEL = process.env.VEO_MODEL || 'veo-3.1-generate-preview';
process.env.LYRIA_MODEL = process.env.LYRIA_MODEL || 'lyria-3.5';
process.env.MEDIA_PROMPT_ENHANCER = process.env.MEDIA_PROMPT_ENHANCER || 'true';

const indexFile=path.resolve('public/index.html');
const toolsFile=path.resolve('public/tools.html');
const runtimeMarkers={
  app:'<script defer src="/app-fixes.js?v=sqai-app-20260914"></script>',
  runtime:'<script defer src="/sq-ai-runtime.js?v=sqai-runtime-20260914"></script>',
  theme:'<script defer src="/ui-theme.js?v=sqai-light-20260914"></script>',
  tools:'<script defer src="/tools-runtime.js?v=sqai-tools-20260914"></script>',
  media:'<script defer src="/media-studio.js?v=sqai-media-20260914"></script>'
};
const legalMarker='sqai-legal-links';
const toolsLink=`<a id="sqai-tools-hub-link" href="/tools.html" style="display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(124,92,255,.28);background:rgba(124,92,255,.10);padding:8px 12px;border-radius:10px;color:#d8d1ff;font-size:12px;font-weight:700">✦ Tools Hub</a>`;
const legalLinks=`\n    <div class="sqai-legal-links" style="margin-top:18px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap;font-size:13px;opacity:.8">\n      <a href="/terms.html" rel="nofollow">Terms of Service</a>\n      <a href="/privacy.html" rel="nofollow">Privacy Notice</a>\n      <a href="/refund.html" rel="nofollow">Refund Policy</a>\n      ${toolsLink}\n    </div>`;

function clean(html){
  return html
    .replace(/\s*<!-- SQAI_LAZY_ENHANCEMENTS -->[\s\S]*?<\/script>/g,'')
    .replace(/\s*<script(?: defer)? src="\/app-fixes\.js(?:\?[^\"]*)?"><\/script>/g,'')
    .replace(/\s*<script(?: defer)? src="\/sq-ai-runtime\.js(?:\?[^\"]*)?"><\/script>/g,'')
    .replace(/\s*<script(?: defer)? src="\/ui-theme\.js(?:\?[^\"]*)?"><\/script>/g,'')
    .replace(/\s*<script(?: defer)? src="\/tools-runtime\.js(?:\?[^\"]*)?"><\/script>/g,'')
    .replace(/\s*<script(?: defer)? src="\/media-studio\.js(?:\?[^\"]*)?"><\/script>/g,'');
}

try{
  if(fs.existsSync(indexFile)){
    const original=fs.readFileSync(indexFile,'utf8');
    let html=clean(original);
    const scripts=`\n  ${runtimeMarkers.app}\n  ${runtimeMarkers.runtime}`;
    html=html.replace(/<\/head>/i,`${runtimeMarkers.theme}${scripts}\n</head>`);
    if(!html.includes(legalMarker))html=html.replace(/<\/footer>/i,`${legalLinks}\n  </footer>`);
    if(html!==original)fs.writeFileSync(indexFile,html,'utf8');
  }
}catch(error){console.error('SQ AI UI fix injection failed:',error?.message||error)}

try{
  if(fs.existsSync(toolsFile)){
    const original=fs.readFileSync(toolsFile,'utf8');
    let html=clean(original);
    html=html.replace(/<\/head>/i,`${runtimeMarkers.tools}\n${runtimeMarkers.media}\n</head>`);
    if(html!==original)fs.writeFileSync(toolsFile,html,'utf8');
  }
}catch(error){console.error('SQ AI Tools UI injection failed:',error?.message||error)}
