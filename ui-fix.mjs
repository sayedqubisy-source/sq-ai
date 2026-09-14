import fs from 'node:fs';
import path from 'node:path';

// Runtime defaults only. No provider request is made during startup.
process.env.OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
process.env.OPENROUTER_IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-3.1-flash-image';
process.env.FREE_VIDEO_SPACE = process.env.FREE_VIDEO_SPACE || 'alexcheng0072/wan27-free-video-generator';
process.env.FREE_VIDEO_DURATION_SECONDS = process.env.FREE_VIDEO_DURATION_SECONDS || '3';
process.env.PAID_VIDEO_ENABLED = process.env.PAID_VIDEO_ENABLED || 'false';

const file = path.resolve('public/index.html');
const marker = '<script src="/app-fixes.js?v=sqai-20260913"></script>';
try {
  if (fs.existsSync(file)) {
    const html = fs.readFileSync(file, 'utf8');
    const withoutOldMarker = html.replace(/\s*<script src="\/app-fixes\.js(?:\?[^\"]*)?"><\/script>/g, '');
    if (!withoutOldMarker.includes(marker)) {
      const next = withoutOldMarker.replace(/<\/head>/i, `  ${marker}\n</head>`);
      if (next !== html) fs.writeFileSync(file, next, 'utf8');
    }
  }
} catch (error) {
  console.error('SQ AI UI fix injection failed:', error?.message || error);
}
