(() => {
  'use strict';
  const state = { busy: false };
  const $ = (s, root=document) => root.querySelector(s);
  const text = (v) => String(v ?? '').trim();
  const esc = (v) => text(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function findPrompt() {
    return document.querySelector('textarea[name="prompt"], textarea#prompt, textarea');
  }

  function installPanel() {
    if (document.getElementById('sqai-smart-panel')) return;
    const host = document.querySelector('#app .main, .main, main') || document.body;
    const panel = document.createElement('section');
    panel.id = 'sqai-smart-panel';
    panel.dir = 'rtl';
    panel.innerHTML = `
      <div class="sqai-smart-head">
        <div><span class="sqai-kicker">SQ AI</span><h2>مساعد SQ AI الذكي</h2><p>اكتب المطلوب وسيختار النظام أفضل مزود AI متاح تلقائيًا.</p></div>
        <span id="sqai-runtime-status" class="sqai-status">جاري الفحص…</span>
      </div>
      <div class="sqai-smart-body">
        <textarea id="sqai-smart-prompt" placeholder="مثال: اكتب إعلانًا احترافيًا لمنتج ملابس يستهدف الشباب في مصر..."></textarea>
        <div class="sqai-smart-row"><select id="sqai-capability"><option value="text">كتابة ومحتوى</option><option value="reasoning">تحليل وتفكير</option><option value="coding">برمجة</option></select><button id="sqai-smart-run">تشغيل SQ AI ✦</button></div>
        <div id="sqai-smart-result" class="sqai-result hidden"></div>
      </div>`;
    host.prepend(panel);
    $('#sqai-smart-run').addEventListener('click', run);
    loadStatus();
  }

  async function loadStatus() {
    const el = $('#sqai-runtime-status');
    if (!el) return;
    try {
      const r = await fetch('/api/ai/runtime', { credentials: 'same-origin' });
      const d = await r.json();
      if (d.ok && d.count) { el.textContent = `${d.count} مزود متاح`; el.dataset.ok = '1'; }
      else { el.textContent = 'جاهز — أضف مفتاح مزود AI'; }
    } catch { el.textContent = 'جاهز'; }
  }

  async function run() {
    if (state.busy) return;
    const prompt = text($('#sqai-smart-prompt')?.value);
    const result = $('#sqai-smart-result');
    const button = $('#sqai-smart-run');
    if (!prompt) { result.classList.remove('hidden'); result.textContent = 'اكتب طلبك أولًا.'; return; }
    state.busy = true; button.disabled = true; button.textContent = 'جاري التنفيذ…'; result.classList.remove('hidden'); result.textContent = 'SQ AI يختار أفضل مزود متاح…';
    try {
      const r = await fetch('/api/ai/generate', { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prompt, capability:$('#sqai-capability')?.value || 'text'}) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || d.error || 'تعذر تنفيذ الطلب');
      result.innerHTML = `<div class="sqai-result-meta">${esc(d.provider)} · ${esc(d.model)} · تم استخدام 1 Credit</div><pre>${esc(d.result)}</pre>`;
    } catch (e) { result.textContent = e.message || 'حدث خطأ غير متوقع.'; }
    finally { state.busy = false; button.disabled = false; button.textContent = 'تشغيل SQ AI ✦'; }
  }

  function injectStyle() {
    if ($('#sqai-runtime-style')) return;
    const s = document.createElement('style'); s.id='sqai-runtime-style';
    s.textContent = `#sqai-smart-panel{margin:18px auto 24px;max-width:1100px;border:1px solid rgba(124,92,255,.25);border-radius:20px;background:linear-gradient(145deg,rgba(124,92,255,.10),rgba(17,21,29,.94));box-shadow:0 18px 50px rgba(0,0,0,.18);overflow:hidden}.sqai-smart-head{padding:20px 22px;display:flex;justify-content:space-between;gap:15px;align-items:flex-start}.sqai-kicker{font-size:11px;letter-spacing:1.5px;color:#a99aff}.sqai-smart-head h2{margin:3px 0;font-size:23px}.sqai-smart-head p{margin:0;color:#929aaa;font-size:13px}.sqai-status{white-space:nowrap;padding:7px 10px;border-radius:999px;background:rgba(50,213,131,.08);color:#8be6b7;font-size:11px}.sqai-smart-body{padding:0 22px 22px}.sqai-smart-body textarea{width:100%;min-height:125px;resize:vertical;padding:14px;border-radius:13px;border:1px solid rgba(255,255,255,.10);background:#0b0e14;color:#f5f7fb;outline:none}.sqai-smart-row{display:flex;gap:10px;margin-top:10px}.sqai-smart-row select{flex:0 0 190px;border:1px solid rgba(255,255,255,.10);border-radius:11px;background:#0b0e14;color:#f5f7fb;padding:10px}.sqai-smart-row button{flex:1;border:0;border-radius:11px;background:linear-gradient(135deg,#7c5cff,#5f8fff);color:white;font-weight:800;min-height:44px}.sqai-result{margin-top:13px;padding:15px;border-radius:13px;background:#0a0d13;border:1px solid rgba(255,255,255,.08);white-space:pre-wrap}.sqai-result pre{white-space:pre-wrap;font:inherit;color:#eef1f7;margin:7px 0 0}.sqai-result-meta{font-size:11px;color:#a99aff}@media(max-width:650px){.sqai-smart-head{flex-direction:column}.sqai-smart-row{flex-direction:column}.sqai-smart-row select{flex:auto}}`;
    document.head.appendChild(s);
  }

  function start() { injectStyle(); installPanel(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true}); else start();
})();
