import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const previousFetch = globalThis.fetch;

function platformDimensions(platform) {
  const p = String(platform || '').toLowerCase();
  if (/youtube|facebook|linkedin|website|landscape/.test(p)) return { width:832, height:480 };
  if (/square|instagram-square/.test(p)) return { width:640, height:640 };
  return { width:480, height:832 };
}
function generatedVideoDir() {
  const dbPath=process.env.DB_PATH || '/app/data/sq-ai.sqlite';
  const dir=path.join(path.dirname(path.resolve(dbPath)),'generated-videos');
  fs.mkdirSync(dir,{recursive:true});
  return dir;
}
function findFile(value) {
  if(!value)return null;
  if(typeof value==='string'){
    if(/^https?:\/\//i.test(value))return value;
    if(/\.(mp4|webm|mov)(\?|$)/i.test(value) || /gradio_api\/file=/i.test(value) || value.startsWith('/tmp/') || value.startsWith('/gradio/'))return value;
    return null;
  }
  if(Array.isArray(value)){for(const item of value){const found=findFile(item);if(found)return found;}}
  if(typeof value==='object'){
    for(const key of ['video_url','video_path','video','url','path','name','value','data']){const found=findFile(value[key]);if(found)return found;}
  }
  return null;
}
function fileUrls(base,file){
  if(/^https?:\/\//i.test(file))return [file];
  if(/^\/gradio_api\/file=/i.test(file))return [`${base}${file}`];
  return [`${base}/gradio_api/file=${file}`,`${base}/gradio_api/file=${encodeURIComponent(file)}`];
}
function authHeaders(){const token=String(process.env.HF_TOKEN || '').trim();return token?{Authorization:`Bearer ${token}`}:{}};
function retryableStatus(status){return status===408||status===425||status===429||status===500||status===502||status===503||status===504;}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function requestWithRetry(url,options={},controller,maxAttempts=4){
  let lastResponse=null,lastError=null;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
      const response=await previousFetch(url,{...options,signal:controller.signal});
      lastResponse=response;
      if(response.ok || !retryableStatus(response.status) || attempt===maxAttempts)return response;
      const retryAfter=Number(response.headers.get('retry-after') || 0);
      const waitMs=retryAfter>0?Math.min(retryAfter*1000,30000):Math.min(2000*attempt,8000);
      await sleep(waitMs);
    }catch(error){
      lastError=error;
      if(error?.name==='AbortError' || attempt===maxAttempts)throw error;
      await sleep(Math.min(2000*attempt,8000));
    }
  }
  if(lastResponse)return lastResponse;
  throw lastError || new Error('Hugging Face request failed.');
}

async function freeVideo(payload){
  const space=process.env.FREE_VIDEO_SPACE || 'alexcheng0072/wan27-free-video-generator';
  const base=`https://${space.replace(/\/$/,'')}.hf.space`;
  const {width,height}=platformDimensions(payload.platform);
  const prompt=String(payload.prompt || '').trim().slice(0,600);
  const duration=Math.min(5,Math.max(2,Number(process.env.FREE_VIDEO_DURATION_SECONDS || 3)));
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),600000);
  const headers={'Content-Type':'application/json',Accept:'application/json',...authHeaders()};
  const aspectRatio=`${width}x${height}`;

  try{
    // Current Space API: optional image, prompt, aspect ratio, duration.
    const submit=await requestWithRetry(`${base}/gradio_api/call/generate_video`,{method:'POST',headers,body:JSON.stringify({data:[null,prompt,aspectRatio,duration]})},controller,4);
    const raw=await submit.text();
    let data={};try{data=JSON.parse(raw);}catch{}
    if(!submit.ok)throw Object.assign(new Error(data?.error || `Free video service rejected the request (${submit.status}).`),{upstreamStatus:submit.status});
    if(!data.event_id)throw new Error('Free video service did not return an event id.');

    const result=await requestWithRetry(`${base}/gradio_api/call/generate_video/${encodeURIComponent(data.event_id)}`,{headers:{Accept:'text/event-stream',...authHeaders()}},controller,4);
    if(!result.ok)throw Object.assign(new Error(`Free video result request failed (${result.status}).`),{upstreamStatus:result.status});

    const stream=await result.text();
    let finalData=null,streamError='';
    for(const line of stream.split(/\r?\n/)){
      if(!line.startsWith('data:'))continue;
      const value=line.slice(5).trim();
      if(!value || value==='[DONE]')continue;
      try{
        const parsed=JSON.parse(value);
        if(parsed?.error)streamError=String(parsed.error);
        if(Array.isArray(parsed))finalData=parsed;
        else if(parsed?.data!==undefined)finalData=parsed.data;
      }catch{}
    }
    if(streamError)throw new Error(streamError);
    const file=findFile(finalData);
    if(!file)throw new Error('Free video service finished without a video file.');

    let video=null,lastStatus=0;
    for(const fileUrl of fileUrls(base,file)){
      video=await requestWithRetry(fileUrl,{headers:authHeaders()},controller,4);
      lastStatus=video.status;
      if(video.ok)break;
    }
    if(!video?.ok)throw Object.assign(new Error(`Generated video download failed (${lastStatus}).`),{upstreamStatus:lastStatus});

    const bytes=Buffer.from(await video.arrayBuffer());
    if(!bytes.length)throw new Error('Generated video download returned an empty file.');
    const contentType=(video.headers.get('content-type') || '').toLowerCase();
    const head=bytes.slice(0,256).toString('utf8').toLowerCase();
    if(head.includes('<!doctype html') || head.includes('<html'))throw new Error('Generated video download returned an HTML error page.');
    if(contentType.includes('json') || contentType.includes('text/html'))throw new Error('Generated video download returned an invalid response.');

    const filename=`${Date.now()}-${crypto.randomBytes(8).toString('hex')}.mp4`;
    fs.writeFileSync(path.join(generatedVideoDir(),filename),bytes);
    return new Response(JSON.stringify({provider:'huggingface-zero-gpu',model:'FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers',video_url:`/generated-videos/${filename}`,status:'completed',free:true}),{status:200,headers:{'Content-Type':'application/json'}});
  }catch(error){
    if(error?.name==='AbortError')return new Response(JSON.stringify({error:{code:'free_video_timeout',message:'Video generation timed out after 10 minutes. The free GPU service may be busy or over quota.'}}),{status:504,headers:{'Content-Type':'application/json'}});
    const upstreamStatus=Number(error?.upstreamStatus || 0);
    const status=retryableStatus(upstreamStatus)?502:503;
    return new Response(JSON.stringify({error:{code:status===502?'free_video_bad_gateway':'free_video_unavailable',message:error?.message || 'Free video service is temporarily unavailable.'}}),{status,headers:{'Content-Type':'application/json'}});
  }finally{clearTimeout(timer);}
}

globalThis.fetch=async function videoSafeFetch(input,init={}){
  const url=typeof input==='string'?input:input?.url || '';
  const method=String(init.method || 'GET').toUpperCase();
  if(url.endsWith('/api/v1/videos') && method==='POST' && typeof init.body==='string'){
    let payload;try{payload=JSON.parse(init.body);}catch{return previousFetch(input,init);}
    if(process.env.PAID_VIDEO_ENABLED!=='true')return freeVideo(payload);
  }
  return previousFetch(input,init);
};

process.env.FREE_VIDEO_DURATION_SECONDS=process.env.FREE_VIDEO_DURATION_SECONDS || '3';
process.env.PAID_VIDEO_ENABLED=process.env.PAID_VIDEO_ENABLED || 'false';
