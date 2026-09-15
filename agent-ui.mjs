import express from 'express';
import path from 'node:path';
import fs from 'node:fs';

const dbRoot = path.resolve(process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : './data');
const mediaDir = path.join(dbRoot, 'generated-media');
fs.mkdirSync(mediaDir, { recursive: true });

if (!express.application.__sqaiAgentUI) {
  express.application.__sqaiAgentUI = true;
  const originalSend = express.response.send;
  const originalListen = express.application.listen;

  express.application.listen = function patchedListen(...args) {
    try { this.use('/generated-media', express.static(mediaDir, { maxAge: '1h' })); } catch {}
    return originalListen.apply(this, args);
  };

  express.response.send = function patchedSend(body) {
    if (typeof body === 'string' && body.includes('</body>') && body.includes('<html')) {
      body = body.replace('</body>', `
<style>
#sqai-agent-launcher{position:fixed;right:18px;bottom:18px;z-index:9999;border:1px solid rgba(124,92,255,.5);background:linear-gradient(135deg,#7c5cff,#4c8dff);color:#fff;border-radius:14px;padding:12px 16px;font-weight:800;box-shadow:0 12px 40px rgba(0,0,0,.35);cursor:pointer}
#sqai-agent-panel{position:fixed;right:18px;bottom:76px;width:min(520px,calc(100vw - 36px));max-height:80vh;overflow:auto;z-index:9998;background:#10141c;color:#f5f7fb;border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:18px;box-shadow:0 25px 80px rgba(0,0,0,.5);display:none;font-family:Inter,system-ui,sans-serif}
#sqai-agent-panel h3{margin:0 0 6px;font-size:18px}#sqai-agent-panel p{color:#929aaa;font-size:12px;margin:0 0 12px}
#sqai-agent-prompt{width:100%;min-height:120px;resize:vertical;background:#080b11;color:#fff;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px;outline:none}
#sqai-agent-panel .row{display:flex;gap:8px;margin-top:10px}#sqai-agent-panel select,#sqai-agent-panel button{flex:1;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px;background:#171d28;color:#fff}#sqai-agent-run{background:linear-gradient(135deg,#7c5cff,#4c8dff)!important;border:0!important;font-weight:800}
#sqai-agent-status{margin-top:12px;font-size:12px;color:#aeb6c6;white-space:pre-wrap}.sqai-agent-result{margin-top:14px}.sqai-agent-result video{width:100%;border-radius:12px;background:#000}.sqai-agent-download{display:inline-block;margin-top:9px;padding:9px 12px;border-radius:9px;background:#202737;color:#fff}.sqai-agent-plan{margin-top:12px;padding:10px;background:#0b0e14;border-radius:10px;font-size:11px;color:#bfc5d2;white-space:pre-wrap}
</style>
<button id="sqai-agent-launcher" type="button">✦ SQ AI Agent</button>
<div id="sqai-agent-panel">
<h3>اصنع فيديو من طلب واحد</h3><p>اكتب فكرتك بالعربي أو الإنجليزي، وSQ AI يحولها إلى خطة + صوت + فيديو MP4.</p>
<textarea id="sqai-agent-prompt" placeholder="مثال: اعمل فيديو احترافي للآية الأولى من سورة الفاتحة مع التفسير باللهجة المصرية، عمودي 9:16"></textarea>
<div class="row"><select id="sqai-agent-ratio"><option value="9:16">9:16 عمودي</option><option value="16:9">16:9 أفقي</option></select><select id="sqai-agent-resolution"><option value="720p">720p</option><option value="1080p">1080p</option></select></div>
<div class="row"><button id="sqai-agent-run" type="button">إنشاء الفيديو الآن ✦</button><button id="sqai-agent-close" type="button">إغلاق</button></div>
<div id="sqai-agent-status"></div><div id="sqai-agent-result" class="sqai-agent-result"></div>
</div>
<script>
(()=>{const q=id=>document.getElementById(id),panel=q('sqai-agent-panel'),status=q('sqai-agent-status'),result=q('sqai-agent-result');q('sqai-agent-launcher').onclick=()=>panel.style.display=panel.style.display==='block'?'none':'block';q('sqai-agent-close').onclick=()=>panel.style.display='none';q('sqai-agent-run').onclick=async()=>{const prompt=q('sqai-agent-prompt').value.trim();if(!prompt){status.textContent='اكتب وصف الفيديو الأول.';return}const btn=q('sqai-agent-run');btn.disabled=true;result.innerHTML='';status.textContent='جاري فهم الطلب وبناء السيناريو...';try{const r=await fetch('/api/agent/generate',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({prompt,mode:'all',aspectRatio:q('sqai-agent-ratio').value,resolution:q('sqai-agent-resolution').value,voice:true})});status.textContent='جاري توليد الصوت والفيديو MP4...';const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||d.error||('HTTP '+r.status));const url=d?.result?.video_url;if(!url)throw new Error('لم يرجع السيرفر ملف MP4');status.textContent='تم إنشاء الفيديو MP4 بنجاح.';result.innerHTML='<video controls playsinline src="'+url+'"></video><a class="sqai-agent-download" href="'+url+'" download>⬇ تحميل MP4</a>';if(d?.plan)result.innerHTML+='<div class="sqai-agent-plan">الخطة: '+JSON.stringify(d.plan,null,2).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))+'</div>'}catch(e){status.textContent='فشل الإنشاء: '+(e?.message||e)}finally{btn.disabled=false}}})();
</script>
</body>`);
    }
    return originalSend.call(this, body);
  };
}
console.log('SQ AI Agent UI loaded');
