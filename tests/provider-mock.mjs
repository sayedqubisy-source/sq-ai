// Loaded only by integration tests; never calls a real AI/payment service.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input);
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
  if (url === 'https://video.test/generate') return Response.json({ video_url: 'https://video.test/output.mp4', provider: 'custom' });
  if (url === 'https://openrouter.ai/api/v1/chat/completions') {
    const body = JSON.parse(init.body);
    await new Promise(resolve => setTimeout(resolve, 100));
    if (body.messages.some(message => message.content.includes('FAIL_PROVIDER'))) {
      return Response.json({ error: { message: 'mock_provider_failed' } }, { status: 400 });
    }
    return Response.json({ choices: [{ message: { content: 'Generated content' } }] });
  }
  const base = 'https://alexcheng0072-wan27-free-video-generator.hf.space';
  if (url === `${base}/gradio_api/call/generate_video`) return Response.json({ event_id: 'test-event' });
  if (url === `${base}/gradio_api/call/generate_video/test-event`) return new Response('event: complete\ndata: [{"url":"' + base + '/test.mp4"}]\n\n');
  if (url === `${base}/test.mp4`) return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { 'content-type': 'video/mp4' } });
  throw new Error(`Unexpected external request in test: ${new URL(url).origin}`);
};
