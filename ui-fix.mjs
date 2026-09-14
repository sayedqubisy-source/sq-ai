import fs from 'node:fs';
import path from 'node:path';

// Runtime defaults only. No provider request is made during startup.
process.env.OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
process.env.OPENROUTER_IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-3.1-flash-image';
process.env.FREE_VIDEO_SPACE = process.env.FREE_VIDEO_SPACE || 'alexcheng0072/wan27-free-video-generator';
process.env.FREE_VIDEO_DURATION_SECONDS = process.env.FREE_VIDEO_DURATION_SECONDS || '3';
process.env.PAID_VIDEO_ENABLED = process.env.PAID_VIDEO_ENABLED || 'false';

const file = path.resolve('public/index.html');
const marker = '<script src="/app-fixes.js?v=sqai-20260914b"></script>';
const legalMarker = 'sqai-legal-links';
const legalLinks = `\n    <div class="sqai-legal-links" style="margin-top:18px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap;font-size:13px;opacity:.8">\n      <a href="/terms.html" rel="nofollow">Terms of Service</a>\n      <a href="/privacy.html" rel="nofollow">Privacy Notice</a>\n      <a href="/refund.html" rel="nofollow">Refund Policy</a>\n    </div>`;
try {
  if (fs.existsSync(file)) {
    let html = fs.readFileSync(file, 'utf8');
    const withoutOldMarker = html.replace(/\s*<script src="\/app-fixes\.js(?:\?[^\"]*)?"><\/script>/g, '');
    if (!withoutOldMarker.includes(marker)) {
      html = withoutOldMarker.replace(/<\/head>/i, `  ${marker}\n</head>`);
    } else {
      html = withoutOldMarker;
    }
    if (!html.includes(legalMarker)) {
      html = html.replace(/<\/footer>/i, `${legalLinks}\n  </footer>`);
    }
    if (html !== fs.readFileSync(file, 'utf8')) fs.writeFileSync(file, html, 'utf8');
  }
} catch (error) {
  console.error('SQ AI UI fix injection failed:', error?.message || error);
}
