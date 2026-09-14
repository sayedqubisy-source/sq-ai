import fs from 'node:fs';
import path from 'node:path';

const state = globalThis.__sqAiRecoveryState || { startedAt: Date.now(), unhandledRejections: 0, uncaughtExceptions: 0 };
globalThis.__sqAiRecoveryState = state;

function log(type, error) {
  const message = String(error?.stack || error?.message || error || 'unknown_error').slice(0, 4000);
  console.error(`[SQ AI AUTO-RECOVERY] ${type}: ${message}`);
}

globalThis.sqAiAutoRecover = async function sqAiAutoRecover(operation, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 3));
  const baseDelay = Math.max(100, Number(options.baseDelay || 1000));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await operation(attempt); }
    catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(15000, baseDelay * 2 ** (attempt - 1))));
    }
  }
  throw lastError || new Error('auto_recovery_failed');
};

process.on('unhandledRejection', (error) => {
  state.unhandledRejections += 1;
  log('unhandledRejection', error);
});

process.on('uncaughtException', (error) => {
  state.uncaughtExceptions += 1;
  log('uncaughtException', error);
  setTimeout(() => process.exit(1), 250).unref();
});

function cleanupDir(dir, cutoff) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {}
  }
}

setInterval(() => {
  try {
    const dbPath = process.env.DB_PATH || '/app/data/sq-ai.sqlite';
    const root = path.dirname(path.resolve(dbPath));
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    cleanupDir(path.join(root, 'generated-videos'), cutoff);
    cleanupDir(path.join(root, 'generated-media'), cutoff);
  } catch (error) { log('cleanup', error); }
}, 6 * 60 * 60 * 1000).unref();

console.log('[SQ AI AUTO-RECOVERY] enabled');
