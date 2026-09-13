import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve('public/index.html');
const marker = '<script src="/app-fixes.js"></script>';

try {
  if (fs.existsSync(file)) {
    const html = fs.readFileSync(file, 'utf8');
    if (!html.includes(marker)) {
      const next = html.replace(/<\/head>/i, `  ${marker}\n</head>`);
      if (next !== html) fs.writeFileSync(file, next, 'utf8');
    }
  }
} catch (error) {
  console.error('SQ AI UI fix injection failed:', error?.message || error);
}
