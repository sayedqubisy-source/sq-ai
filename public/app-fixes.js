(() => {
  'use strict';

  const VIDEO_RE = /(?:\/generated-videos\/|\.(?:mp4|webm|mov)(?:[?#].*)?$)/i;
  const IMAGE_RE = /^(?:data:image\/(?:png|jpe?g|webp|gif);base64,|https?:\/\/.*\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$|\/generated-images\/)/i;

  function normalizeUrl(value) {
    if (!value) return '';
    if (/^https?:\/\//i.test(value) || /^data:/i.test(value)) return value;
    if (value.startsWith('/')) return value;
    return `/${value}`;
  }

  function isVideoUrl(value) {
    if (!value || typeof value !== 'string') return false;
    const v = value.trim();
    return (/^https?:\/\//i.test(v) && VIDEO_RE.test(v)) || /^\/generated-videos\//i.test(v);
  }

  function isImageUrl(value) {
    if (!value || typeof value !== 'string') return false;
    return IMAGE_RE.test(value.trim());
  }

  function actionRow(src, filename, label) {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.flexWrap = 'wrap';

    const open = document.createElement('a');
    open.className = 'btn';
    open.href = src;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = `Open ${label}`;

    const download = document.createElement('a');
    download.className = 'btn';
    download.href = src;
    download.download = filename;
    download.textContent = `Download ${label}`;

    row.append(open, download);
    return row;
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

    wrap.append(video, actionRow(src, 'sq-ai-video.mp4', 'video'));
    box.append(wrap);
    return true;
  }

  function renderImageResult(box, url) {
    if (!box || !isImageUrl(url)) return false;
    const src = normalizeUrl(url.trim());
    box.dataset.imageUrl = src;
    box.style.whiteSpace = 'normal';
    box.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.style.display = 'grid';
    wrap.style.gap = '10px';

    const image = document.createElement('img');
    image.src = src;
    image.alt = 'SQ AI generated image';
    image.loading = 'lazy';
    image.style.width = '100%';
    image.style.maxHeight = '620px';
    image.style.objectFit = 'contain';
    image.style.borderRadius = '12px';
    image.style.background = '#000';

    wrap.append(image, actionRow(src, 'sq-ai-image.png', 'image'));
    box.append(wrap);
    return true;
  }

  function scanResultBoxes(root = document) {
    root.querySelectorAll('.result-box').forEach(box => {
      if (box.dataset.mediaRendered === '1') return;
      const value = box.dataset.videoUrl || box.dataset.imageUrl || box.textContent.trim();
      if (renderVideoResult(box, value) || renderImageResult(box, value)) {
        box.dataset.mediaRendered = '1';
      }
    });
  }

  function patchOutputExtractor() {
    if (typeof window.extractOutput !== 'function' || window.__sqAiOutputPatched) return;
    const original = window.extractOutput;
    window.extractOutput = function(data) {
      const candidates = [
        data?.video_url,
        data?.image_url,
        data?.result?.video_url,
        data?.result?.image_url,
        data?.result,
        data?.output?.video_url,
        data?.output?.image_url,
        data?.output,
        data?.text,
        data?.content,
        data?.message
      ];
      const media = candidates.find(value => typeof value === 'string' && (isVideoUrl(value) || isImageUrl(value)));
      if (media) return media;
      return original(data);
    };
    window.__sqAiOutputPatched = true;
  }

  function patchResultReader() {
    if (typeof window.getCurrentToolResult !== 'function' || window.__sqAiResultReaderPatched) return;
    const original = window.getCurrentToolResult;
    window.getCurrentToolResult = function(category) {
      const box = document.getElementById(`${category}Result`);
      if (box?.dataset?.videoUrl) return box.dataset.videoUrl;
      if (box?.dataset?.imageUrl) return box.dataset.imageUrl;
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
        window.showToast?.('Enter your name first.');
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
          window.updateUserUI?.();
        }
        window.showToast?.('Account saved.');
      } catch (err) {
        window.showToast?.(err?.message || 'Could not save account.');
      } finally {
        button?.classList.remove('loading');
      }
    };
  }

  function patchPasswordMinimum() {
    const input = document.getElementById('authPassword');
    if (input) {
      input.minLength = 8;
      input.setAttribute('minlength', '8');
      input.placeholder = 'At least 8 characters';
    }
  }

  function patchBillingAliases() {
    if (typeof window.startCheckout !== 'function' || window.__sqAiBillingPatched) return;
    const original = window.startCheckout;
    window.startCheckout = function(plan) {
      const aliases = { pro: 'growth', business: 'scale' };
      return original(aliases[plan] || plan);
    };
    window.__sqAiBillingPatched = true;
  }

  let scanQueued = false;
  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      patchOutputExtractor();
      patchResultReader();
      patchAccountSave();
      patchPasswordMinimum();
      patchBillingAliases();
      scanResultBoxes();
    });
  }

  function init() {
    scheduleScan();

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { subtree: true, childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
