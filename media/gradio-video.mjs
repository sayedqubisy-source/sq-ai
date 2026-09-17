// Contract verified against the Space's /gradio_api/info endpoint.
export function videoInputs(prompt, platform, durationSeconds) {
  const platformName = String(platform || '').toLowerCase();
  const aspectRatio = /square|1:1/.test(platformName) ? '640x640'
    : /youtube|facebook|linkedin|website|landscape|16:9/.test(platformName) ? '832x480'
    : '480x832';
  const parsedDuration = Number(durationSeconds);
  const duration = Number.isFinite(parsedDuration)
    ? Math.min(5, Math.max(2, Math.round(parsedDuration))) : 3;
  return [null, String(prompt || '').trim().slice(0, 600), aspectRatio, duration];
}

export function readVideoEvents(stream) {
  let completed = false;
  let output;
  for (const block of String(stream).replace(/\r\n?/g, '\n').split(/\n\n+/)) {
    let event = '';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!['complete', 'error'].includes(event)) continue;
    let value;
    try { value = JSON.parse(data.join('\n')); }
    catch { throw new Error('Free video service returned an invalid event response.'); }
    if (event === 'error') {
      const detail = typeof value === 'string' ? value : value?.error?.message || value?.error || value?.message;
      throw new Error(detail ? `Free video provider error: ${String(detail).slice(0, 500)}`
        : 'Free video provider rejected the job without error details. Check the Space availability and Hugging Face GPU quota.');
    }
    completed = true;
    output = value;
  }
  if (!completed) throw new Error('Free video connection ended before a completion event.');
  return output;
}
