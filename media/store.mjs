import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.mjs';

export const mediaRoot = path.join(env.dbDirectory, 'generated-media');
export const videoRoot = path.join(env.dbDirectory, 'generated-videos');
fs.mkdirSync(mediaRoot, { recursive: true });
fs.mkdirSync(videoRoot, { recursive: true });

export function saveBuffer(prefix, extension, value, directory = mediaRoot) {
  const name = `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${extension}`;
  fs.writeFileSync(path.join(directory, name), Buffer.from(value));
  return `/${directory === videoRoot ? 'generated-videos' : 'generated-media'}/${name}`;
}

export function localPath(publicUrl) {
  const match = /^\/(generated-media|generated-videos)\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/.exec(String(publicUrl));
  if (!match) return null;
  const root = match[1] === 'generated-media' ? mediaRoot : videoRoot;
  const resolved = path.resolve(root, match[2]);
  return resolved;
}

export function removeFile(publicUrl) {
  const file = localPath(publicUrl);
  if (file) fs.rmSync(file, { force: true });
}
