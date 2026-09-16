(() => {
  const boot = () => {
    if (document.getElementById('sqai-media-studio')) return;
    const host = document.querySelector('.hero') || document.querySelector('.wrap') || document.querySelector('.content');
    if (!host) return;

    const style = document.createElement('style');
    style.textContent = `
      #sqai-media-studio{margin:22px 0;padding:20px;border:1px solid rgba(124,92,255,.22);border-radius:18px;background:#11151d;color:#f5f7fb;direction:rtl}
      #sqai-media-studio textarea,#sqai-media-studio select{width:100%;box-sizing:border-box;background:#0b0e14;color:#fff;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px}
      #sqai-media-studio textarea{min-height:130px;resize:vertical}
      .sqai-ms-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:14px}.sqai-ms-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
      .sqai-ms-row>*{flex:1}.sqai-ms-btn{border:0;border-radius:11px;padding:11px 15px;background:#7c5cff;color:#fff;font-weight:800;cursor:pointer}.sqai-ms-status{margin-top:12px;padding:10px;border-radius:10px;background:#0b0e14;color:#c7cedb}.sqai-ms-result video,.sqai-ms-result audio{width:100%;margin-top:10px;border-radius:12px}
      @media(max-width:800px){.sqai-ms-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);

    const section = document.createElement('section');
    section.id = 'sqai-media-studio';
    section.innerHTML = `
      <h2>🎬 SQ AI Production Studio</h2>
      <p>Brief واحد → خطة إنتاج → صورة/صوت/فيديو → ملف MP4.</p>
      <div class="sqai-ms-grid">
        <div>
          <textarea id="sqaiMsPrompt" placeholder="مثال: اعمل إعلان احترافي لسويت شيرت أوفر سايز عليه باندا، 9:16، واقعي وسينمائي..."></textarea>
          <div class="sqai-ms-row">
            <select id="sqaiMsMode"><option value="video">فيديو</option><option value="all">فيديو + صورة + صوت</option><option value="image">صورة</option><option value="voice">صوت</option></select>
            <select id="sqaiMsRatio"><option value="9:16">9:16</option><option value="16:9">16:9</option></select>
            <select id="sqaiMsResolution"><option value="720p">720p</option><option value="1080p">1080p</option></select>
          </div>
          <div class="sqai-ms-row"><button class="sqai-ms-btn" id="sqaiMsCreate">🚀 إنتاج</button></div>
        </div>
        <div>
          <div class="sqai-ms-status" id="sqaiMsStatus">جاهز.</div>
          <div class="sqai-ms-result" id="sqaiMsResult"></div>
        </div>
      </div>`;
    host.insertAdjacentElement('afterend', section);

    const setStatus = value => { document.getElementById('sqaiMsStatus').textContent = value; };
    document.getElementById('sqaiMsCreate').onclick = async () => {
      const prompt = document.getElementById('sqaiMsPrompt').value.trim();
      if (!prompt) return setStatus('اكتب الفكرة أولاً.');
      const button = document.getElementById('sqaiMsCreate');
      button.disabled = true;
      setStatus('جاري بناء خطة الإنتاج وتشغيل الأدوات...');
      try {
        const response = await fetch('/api/agent/generate', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, mode: document.getElementById('sqaiMsMode').value, aspectRatio: document.getElementById('sqaiMsRatio').value, resolution: document.getElementById('sqaiMsResolution').value, voice: true })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'فشل الإنتاج');
        setStatus(`تم الإنتاج — المتبقي: ${data.credits_remaining ?? '—'} Credit`);
        const box = document.getElementById('sqaiMsResult');
        box.innerHTML = '';
        for (const item of data.outputs || []) {
          const url = item.final_url || item.url;
          if (!url) continue;
          const link = document.createElement('a');
          link.href = url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = `فتح ${item.type}`;
          box.appendChild(link);
          if (item.type === 'video') { const video = document.createElement('video'); video.controls = true; video.src = url; box.appendChild(video); }
          if (item.type === 'voice') { const audio = document.createElement('audio'); audio.controls = true; audio.src = url; box.appendChild(audio); }
        }
      } catch (error) { setStatus(`خطأ: ${error.message}`); }
      finally { button.disabled = false; }
    };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();
