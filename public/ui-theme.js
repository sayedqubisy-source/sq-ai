(() => {
  'use strict';
  if (window.__sqAiLightUiLoaded) return;
  window.__sqAiLightUiLoaded = true;

  const style = document.createElement('style');
  style.id = 'sqai-light-theme';
  style.textContent = `
    :root{--bg:#f6f8fc!important;--bg-soft:#f1f4f9!important;--panel:#fff!important;--panel-2:#f1f4f9!important;--panel-3:#e9edf4!important;--border:#e1e6ee!important;--border-strong:#cbd3df!important;--text:#172033!important;--muted:#687386!important;--muted-2:#8b95a6!important;--accent:#6d4aff!important;--accent-2:#8b72ff!important;--success:#159a5b!important;--danger:#d9435f!important;--warning:#b77900!important;--shadow:0 12px 35px rgba(25,35,55,.08)!important}
    body{background:var(--bg)!important;color:var(--text)!important}
    .sidebar{background:#fff!important;border-right-color:var(--border)!important;box-shadow:3px 0 18px rgba(25,35,55,.035)!important}
    .topbar{background:rgba(255,255,255,.92)!important;border-bottom-color:var(--border)!important}
    .card,.panel,.tool-card,.result-box,.modal,.auth-modal{background:#fff!important;border-color:var(--border)!important;color:var(--text)!important;box-shadow:0 5px 22px rgba(25,35,55,.045)!important}
    input,textarea,select{background:#fff!important;color:var(--text)!important;border-color:var(--border)!important}
    .nav-item:hover{background:#f4f6f9!important}.nav-item.active{background:#f0edff!important;color:#5538dc!important}
    .btn:not(.btn-primary){background:#fff!important;color:var(--text)!important;border-color:var(--border)!important}
    .btn-primary{color:#fff!important}
    .sqai-video-size{margin:14px 0;padding:14px;border:1px solid var(--border);border-radius:14px;background:#fff;box-shadow:0 4px 16px rgba(25,35,55,.04)}
    .sqai-video-size-title{font-size:13px;font-weight:800;margin-bottom:9px;color:var(--text)}
    .sqai-video-size-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}
    .sqai-video-size-btn{border:1px solid var(--border);background:#fff;color:var(--text);border-radius:11px;padding:10px 8px;text-align:center;transition:.16s;min-height:64px}
    .sqai-video-size-btn:hover{border-color:#b8aaff;background:#faf9ff}.sqai-video-size-btn.active{border-color:var(--accent);background:#f1eeff;color:#4f35c9;box-shadow:0 0 0 2px rgba(109,74,255,.08)}
    .sqai-video-size-btn strong{display:block;font-size:12px}.sqai-video-size-btn span{display:block;font-size:10px;color:var(--muted);margin-top:2px}
    .sqai-ratio{display:block;margin:0 auto 6px;border:2px solid currentColor;border-radius:3px}.sqai-ratio.v{width:11px;height:19px}.sqai-ratio.h{width:20px;height:12px}.sqai-ratio.s{width:15px;height:15px}
    @media(max-width:700px){.sqai-video-size-grid{grid-template-columns:1fr 1fr}.sqai-video-size-btn:last-child{grid-column:1/-1}}
  `;
  (document.head || document.documentElement).appendChild(style);

  const sizes = [
    {key:'vertical', label:'عمودي 9:16', desc:'TikTok • Reels • Shorts', platform:'tiktok', cls:'v'},
    {key:'landscape', label:'أفقي 16:9', desc:'YouTube • Facebook', platform:'youtube', cls:'h'},
    {key:'square', label:'مربع 1:1', desc:'Instagram • Facebook', platform:'square', cls:'s'}
  ];
  let selected = localStorage.getItem('sqai_video_size') || 'vertical';

  function isVideoToolValue(value) {
    return /video|reel|short|ad[-_ ]?video|product[-_ ]?video/i.test(String(value || ''));
  }

  function currentToolIsVideo() {
    const active = document.querySelector('[data-tool].active,[data-tool][aria-selected="true"],[data-tool][aria-pressed="true"]');
    if (active && isVideoToolValue(active.dataset.tool || active.textContent)) return true;
    const text = document.body?.innerText || '';
    return /generate video|video generator|ad video|product video|reels|shorts/i.test(text) && !!document.querySelector('textarea,input[type="text"]');
  }

  function findAnchor() {
    return document.querySelector('textarea') || document.querySelector('input[type="text"]') || document.querySelector('.result-box');
  }

  function renderSizePanel() {
    let panel = document.getElementById('sqai-video-size-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'sqai-video-size-panel';
      panel.className = 'sqai-video-size';
      panel.innerHTML = `<div class="sqai-video-size-title">مقاس الفيديو</div><div class="sqai-video-size-grid"></div>`;
    }
    const grid = panel.querySelector('.sqai-video-size-grid');
    grid.innerHTML = '';
    for (const item of sizes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sqai-video-size-btn' + (selected === item.key ? ' active' : '');
      button.dataset.videoSize = item.key;
      button.innerHTML = `<span class="sqai-ratio ${item.cls}"></span><strong>${item.label}</strong><span>${item.desc}</span>`;
      button.addEventListener('click', () => {
        selected = item.key;
        localStorage.setItem('sqai_video_size', selected);
        grid.querySelectorAll('.sqai-video-size-btn').forEach(x => x.classList.toggle('active', x === button));
      });
      grid.appendChild(button);
    }
    const anchor = findAnchor();
    if (anchor && !panel.contains(anchor) && !panel.isConnected) anchor.parentNode?.insertBefore(panel, anchor);
    return panel;
  }

  function refreshPanel() {
    const panel = document.getElementById('sqai-video-size-panel');
    const video = currentToolIsVideo();
    if (video) {
      const p = renderSizePanel();
      p.style.display = '';
    } else if (panel) {
      panel.style.display = 'none';
    }
  }

  function patchGenerateFetch() {
    if (window.__sqAiVideoSizeFetchPatched) return;
    const original = window.fetch.bind(window);
    window.fetch = async function(input, init = {}) {
      const url = typeof input === 'string' ? input : input?.url || '';
      const method = String(init?.method || (typeof input !== 'string' ? input?.method : 'GET') || 'GET').toUpperCase();
      if (!/\/api\/tools\/generate(?:\?|$)/.test(url) || method !== 'POST' || !init?.body) return original(input, init);
      try {
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
        if (body && isVideoToolValue(body.tool)) {
          const item = sizes.find(x => x.key === selected) || sizes[0];
          body.platform = item.platform;
          init = {...init, body:JSON.stringify(body)};
        }
      } catch {}
      return original(input, init);
    };
    window.__sqAiVideoSizeFetchPatched = true;
  }

  function init() {
    patchGenerateFetch();
    refreshPanel();
    const observer = new MutationObserver(() => refreshPanel());
    observer.observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['class','aria-selected','aria-pressed','data-tool']});
    document.addEventListener('click', () => setTimeout(refreshPanel, 30), true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();
