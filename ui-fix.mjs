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
const marker='<script src="/app-fixes.js?v=sqai-20260914"></script>';
const runtimeMarker='<script defer src="/sq-ai-runtime.js?v=sqai-runtime-20260914"></script>';
const toolsRuntimeMarker='<script defer src="/tools-runtime.js?v=sqai-tools-20260914"></script>';
const mediaStudioMarker='<script defer src="/media-studio.js?v=sqai-media-20260914"></script>';
const themeMarker='<script defer src="/ui-theme.js?v=sqai-light-20260914"></script>';
const legalMarker='sqai-legal-links';
const toolsLink=`<a id="sqai-tools-hub-link" href="/tools.html" style="display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(124,92,255,.28);background:rgba(124,92,255,.10);padding:8px 12px;border-radius:10px;color:#d8d1ff;font-size:12px;font-weight:700">✦ Tools Hub</a>`;
const legalLinks=`\n    <div class="sqai-legal-links" style="margin-top:18px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap;font-size:13px;opacity:.8">\n      <a href="/terms.html" rel="nofollow">Terms of Service</a>\n      <a href="/privacy.html" rel="nofollow">Privacy Notice</a>\n      <a href="/refund.html" rel="nofollow">Refund Policy</a>\n      ${toolsLink}\n    </div>`;

// Keep the landing page's critical path small. The enhancement scripts are loaded
// after the first paint (or immediately on first user interaction), so the initial
// HTML can become interactive without waiting for optional runtime patches.
const lazyEnhancements=`\n  <script>\n    (()=>{\n      const urls=['/app-fixes.js?v=sqai-20260914','/sq-ai-runtime.js?v=sqai-runtime-20260914'];\n      let loaded=false;\n      const load=()=>{\n        if(loaded)return; loaded=true;\n        urls.forEach(src=>{const s=document.createElement('script');s.src=src;s.defer=true;document.body.appendChild(s);});\n      };\n      const schedule=()=>{\n        if('requestIdleCallback' in window) requestIdleCallback(load,{timeout:1400});\n        else setTimeout(load,900);\n      };\n      ['pointerdown','keydown','touchstart'].forEach(e=>window.addEventListener(e,load,{once:true,passive:true}));\n      if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',schedule,{once:true}); else schedule();\n    })();\n  </script>`;

function clean(html){return html.replace(/\s*<script(?: defer)? src="\/app-fixes\.js(?:\?[^\"]*)?"><\/script>/g,'').replace(/\s*<script(?: defer)? src="\/sq-ai-runtime\.js(?:\?[^\"]*)?"><\/script>/g,'').replace(/\s*<script(?: defer)? src="\/ui-theme\.js(?:\?[^\"]*)?"><\/script>/g,'').replace(/\s*<script(?: defer)? src="\/tools-runtime\.js(?:\?[^\"]*)?"><\/script>/g,'').replace(/\s*<script(?: defer)? src="\/media-studio\.js(?:\?[^\"]*)?"><\/script>/g,'');}
try{if(fs.existsSync(indexFile)){const original=fs.readFileSync(indexFile,'utf8');let html=clean(original);html=html.replace(/<\/head>/i,`  ${themeMarker}\n</head>`);html=html.replace(/<\/body>/i,`${lazyEnhancements}\n</body>`);if(!html.includes(legalMarker))html=html.replace(/<\/footer>/i,`${legalLinks}\n  </footer>`);if(html!==original)fs.writeFileSync(indexFile,html,'utf8')}}catch(error){console.error('SQ AI UI fix injection failed:',error?.message||error)}
try{if(fs.existsSync(toolsFile)){const original=fs.readFileSync(toolsFile,'utf8');let html=clean(original);html=html.replace(/<\/body>/i,`  ${toolsRuntimeMarker}\n  ${mediaStudioMarker}\n</body>`);if(html!==original)fs.writeFileSync(toolsFile,html,'utf8')}}catch(error){console.error('SQ AI Tools UI injection failed:',error?.message||error)}
