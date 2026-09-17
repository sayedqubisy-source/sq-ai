// Loaded only by integration tests; never calls a real AI/payment service.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input);
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
  if (url === 'https://video.test/generate') return Response.json({ video_url: 'https://video.test/output.mp4', provider: 'custom' });
  const falBase = 'https://queue.fal.run/fal-ai/wan/v2.2-a14b/text-to-video/turbo';
  const falImageBase = 'https://queue.fal.run/fal-ai/wan/v2.2-a14b/image-to-video/turbo';
  const falQueue = 'https://queue.fal.run/fal-ai/wan';
  if (url === falBase) {
    const body = JSON.parse(init.body);
    if (body.resolution !== '720p' || !['16:9', '9:16', '1:1'].includes(body.aspect_ratio) || body.enable_prompt_expansion !== true) throw new Error('Invalid fal Wan Turbo contract');
    return Response.json({ request_id: 'fal-event', status: 'IN_QUEUE' });
  }
  if (url === falImageBase) {
    const body = JSON.parse(init.body);
    if (!body.image_url?.startsWith('data:image/png;base64,') || body.aspect_ratio !== 'auto' || body.enable_prompt_expansion !== true) throw new Error('Invalid fal Wan image-to-video contract');
    return Response.json({ request_id: 'fal-image-event', status: 'IN_QUEUE' });
  }
  if (url.startsWith(`${falQueue}/requests/fal-event/status`)) return Response.json({ status: 'COMPLETED', logs: [] });
  if (url === `${falQueue}/requests/fal-event`) return Response.json({ video: { url: 'https://video.test/fal-output.mp4' }, seed: 1 });
  if (url.startsWith(`${falQueue}/requests/fal-image-event/status`)) return Response.json({ status: 'COMPLETED', logs: [] });
  if (url === `${falQueue}/requests/fal-image-event`) return Response.json({ video: { url: 'https://video.test/fal-image-output.mp4' }, seed: 2 });
  if (url === 'https://openrouter.ai/api/v1/chat/completions') {
    const body = JSON.parse(init.body);
    await new Promise(resolve => setTimeout(resolve, 100));
    if (body.messages.some(message => message.content.includes('FAIL_PROVIDER'))) {
      return Response.json({ error: { message: 'mock_provider_failed' } }, { status: 400 });
    }
    return Response.json({ choices: [{ message: { content: 'Generated content' } }] });
  }
  const musicBase = 'https://facebook-musicgen.hf.space';
  if (url === `${musicBase}/gradio_api/call/predict_batched`) {
    const { data } = JSON.parse(init.body);
    if (!Array.isArray(data) || !Array.isArray(data[0]) || typeof data[0][0] !== 'string') throw new Error('Invalid MusicGen contract');
    return Response.json({ event_id: 'music-event' });
  }
  if (url === `${musicBase}/gradio_api/call/predict_batched/music-event`) {
    return new Response('event: complete\ndata: [{"path":"/tmp/test.wav"}]\n\n');
  }
  if (url === `${musicBase}/gradio_api/file=/tmp/test.wav`) {
    return new Response(new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69]), { headers: { 'content-type': 'audio/wav' } });
  }
  const base = 'https://alexcheng0072-wan27-free-video-generator.hf.space';
  if (url === `${base}/gradio_api/call/generate_video`) {
    const { data } = JSON.parse(init.body);
    if (data.length !== 4 || data[0] !== null || typeof data[1] !== 'string'
      || !['832x480', '480x832', '640x640'].includes(data[2]) || ![2, 3, 4, 5].includes(data[3])) {
      throw new Error('Invalid current Gradio generate_video contract');
    }
    return Response.json({ event_id: data[2] === '640x640' ? 'failed-event' : 'test-event' });
  }
  if (url === `${base}/gradio_api/call/generate_video/failed-event`) return new Response('event: error\ndata: "GPU quota exceeded"\n\n');
  if (url === `${base}/gradio_api/call/generate_video/test-event`) return new Response('event: complete\ndata: [{"video":{"url":"' + base + '/test.mp4"},"subtitles":null},42]\n\n');
  if (url === `${base}/test.mp4`) return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { 'content-type': 'video/mp4' } });
  throw new Error(`Unexpected external request in test: ${url}`);
};
