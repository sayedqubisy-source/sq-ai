(() => {
  'use strict';

  const VIDEO_RE = /(?:\/generated-videos\/|\.(?:mp4|webm|mov)(?:[?#].*)?$)/i;

  function isVideoUrl(value) {
    if (!value || typeof value !== 'string') return false;
    const v = value.trim();
    return (/^https?:\/\//i.test(v) && VIDEO_RE.test(v)) || /^\/generated-videos\//i.test(v);
  }

  function normalizeUrl(value) {
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/')) return value;
    return `/${value}`;
  }

  function renderVideoResult(box, url) {
    if (!box || !isVideoUrl(url)) return false;
    const src = normalizeUrl(url.trim());
    box.dataset.videoUrl = src;
    box.style.whiteSpace = 'normal';
    box.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.style.display = 'grid';
    wrap.style.gap = '10px';

    const video = document.createElement('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = src;
    video.style.width = '100%';
    video.style.maxHeight = '620px';
    video.style.borderRadius = '12px';
    video.style.background = '#000';

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.flexWrap = 'wrap';

    const open = document.createElement('a');
    open.className = 'btn';
    open.href = src;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open video';

    const download = document.createElement('a');
    download.className = 'btn';
    download.href = src;
    download.download = 'sq-ai-video.mp4';
    download.textContent = 'Download video';

    row.append(open, download);
    wrap.append(video, row);
    box.append(wrap);
    return true;
  }

  function scanVideoBoxes(root = document) {
    root.querySelectorAll('.result-box').forEach(box => {
      if (box.dataset.videoRendered === '1') return;
      const url = box.dataset.videoUrl || box.textContent.trim();
      if (isVideoUrl(url) && renderVideoResult(box, url)) {
        box.dataset.videoRendered = '1';
      }
    });
  }

  function patchResultReader() {
    if (typeof window.getCurrentToolResult !== 'function' || window.__sqAiResultReaderPatched) return;
    const original = window.getCurrentToolResult;
    window.getCurrentToolResult = function(category) {
      const box = document.getElementById(`${category}Result`);
      if (box?.dataset?.videoUrl) return box.dataset.videoUrl;
      return original(category);
    };
    window.__sqAiResultReaderPatched = true;
  }

  function patchAccountSave() {
    if (window.__sqAiAccountPatched || typeof API === 'undefined') return;
    window.__sqAiAccountPatched = true;
    window.saveAccount = async function() {
      const name = document.getElementById('settingsName')?.value.trim() || '';
      const button = document.querySelector('#settings-account .btn-primary');
      if (!name) {
        if (typeof showToast === 'function') showToast('Enter your name first.');
        return;
      }
      button?.classList.add('loading');
      try {
        const data = await API.request('/api/account', {
          method: 'PATCH',
          body: JSON.stringify({ name })
        });
        if (data?.user) {
          state.user = data.user;
          if (typeof updateUserUI === 'function') updateUserUI();
        }
        if (typeof showToast === 'function') showToast('Account saved.');
      } catch (err) {
        if (typeof showToast === 'function') showToast(err?.message || 'Could not save account.');
      } finally {
        button?.classList.remove('loading');
      }
    };
  }

  function init() {
    patchResultReader();
    patchAccountSave();
    scanVideoBoxes();
    const observer = new MutationObserver(() => {
      patchResultReader();
      patchAccountSave();
      scanVideoBoxes();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
