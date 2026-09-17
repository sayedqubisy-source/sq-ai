import test from 'node:test';
import assert from 'node:assert/strict';
import { videoInputs, readVideoEvents } from '../media/gradio-video.mjs';

test('current Space contract has four inputs and a resolution string', () => {
  assert.deepEqual(videoInputs(' ocean ', 'landscape', 2), [null, 'ocean', '832x480', 2]);
  assert.equal(videoInputs('ocean', 'instagram-square', 3)[2], '640x640');
  assert.equal(videoInputs('ocean', 'vertical', 3)[2], '480x832');
  assert.equal(videoInputs('ocean', '16:9', 3)[2], '832x480');
  assert.equal(videoInputs('ocean', '', 'invalid')[3], 3);
  assert.equal(videoInputs('ocean', '', 20)[3], 5);
});

test('complete VideoData output survives heartbeat and progress events', () => {
  const output = [{ video: { path: '/tmp/output.mp4', url: 'https://example.hf.space/output.mp4' }, subtitles: null }, 42];
  const stream = `event: heartbeat\r\ndata: null\r\n\r\nevent: generating\r\ndata: [null]\r\n\r\nevent: complete\r\ndata: ${JSON.stringify(output)}\r\n\r\n`;
  assert.deepEqual(readVideoEvents(stream), output);
});

test('provider errors are preserved instead of reported as missing video', () => {
  assert.throws(() => readVideoEvents('event: error\ndata: "GPU quota exceeded"\n\n'), /GPU quota exceeded/);
  assert.throws(() => readVideoEvents('event: error\ndata: {"error":"Space unavailable"}\n\n'), /Space unavailable/);
  assert.throws(() => readVideoEvents('event: error\ndata: null\n\n'), /without error details/);
});

test('truncated and malformed streams do not become successful results', () => {
  assert.throws(() => readVideoEvents('event: heartbeat\ndata: null\n\n'), /before a completion event/);
  assert.throws(() => readVideoEvents('event: complete\ndata: invalid\n\n'), /invalid event response/);
});
