import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { env } from './config/env.mjs';
import { videoInputs, readVideoEvents } from './media/gradio-video.mjs';

const previousFetch = globalThis.fetch;
function generatedVideoDir() {
  const dbPath=process.env.DB_PATH || './data/sq-ai.sqlite';
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
function fileUrls(base,file) {
  if(/^https?:\/\//i.test(file))return [file];
  if(/^\/gradio_api\/file=/i.test(file))return [`${base}${file}`];
  const encoded=encodeURIComponent(file);
  return [`${base}/gradio_api/file=${file}`,`${base}/gradio_api/file=${encoded}`];
}
function authHeaders(){
  const token=String(process.env.HF_TOKEN || '').trim();
  return token?{Authorization:`Bearer ${token}`}:{};
}
function retryableStatus(status){return [408,425,429,500,502,503,504,520,521,522,523,524].includes(Number(status));}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function errorDetails(error){
  const code=error?.cause?.code || error?.code || '';
  const message=String(error?.message || 'Hugging Face request failed.');
  return code ? `${message} (${code})` : message;
}
async function requestWithRetry(url,options={},controller,maxAttempts=5){
  let lastResponse=null,lastError=null;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
      const response=await previousFetch(url,{...options,signal:controller.signal});
      lastResponse=response;
      if(response.ok || !retryableStatus(response.status) || attempt===maxAttempts)return response;
      const retryAfter=Number(response.headers.get('retry-after') || 0);
      const waitMs=retryAfter>0?Math.min(retryAfter*1000,30000):Math.min(1500*Math.pow(2,attempt-1),12000);
      await sleep(waitMs);
    }catch(error){
      lastError=error;
      if(error?.name==='AbortError' || attempt===maxAttempts)throw error;
      await sleep(Math.min(1500*Math.pow(2,attempt-1),12000));
    }
  }
  if(lastResponse)return lastResponse;
  throw lastError || new Error('Hugging Face request failed.');
}

export async function freeVideo(payload){
  const space=process.env.FREE_VIDEO_SPACE || 'alexcheng0072/wan27-free-video-generator';
  const configuredBase=String(process.env.FREE_VIDEO_SPACE_URL || '').trim().replace(/\/$/,'');
  const base=configuredBase || `https://${space.replace(/\/$/,'').replace('/', '-').toLowerCase()}.hf.space`;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),env.agentTimeoutMs);
  const headers={'Content-Type':'application/json',Accept:'application/json',...authHeaders()};

  try{
    const dataPayload=videoInputs(payload.prompt, payload.platform, process.env.FREE_VIDEO_DURATION_SECONDS || 3);
    const submit=await requestWithRetry(`${base}/gradio_api/call/generate_video`,{
      method:'POST',headers,body:JSON.stringify({data:dataPayload})
    },controller,1);
    const raw=await submit.text();
    let data={};try{data=JSON.parse(raw);}catch{}
    if(!submit.ok){
      const detail=data?.error || data?.message || raw.slice(0,300) || `HTTP ${submit.status}`;
      throw Object.assign(new Error(`Free video service rejected the request (${submit.status}): ${detail}`),{upstreamStatus:submit.status});
    }
    if(!data.event_id)throw new Error('Free video service did not return an event id.');

    const resultUrl=`${base}/gradio_api/call/generate_video/${encodeURIComponent(data.event_id)}`;
    const result=await requestWithRetry(resultUrl,{headers:{Accept:'text/event-stream',...authHeaders()}},controller,5);
    if(!result.ok){
      const detail=await result.text().catch(()=>`HTTP ${result.status}`);
      throw Object.assign(new Error(`Free video result request failed (${result.status}): ${detail.slice(0,300)}`),{upstreamStatus:result.status});
    }

    const stream=await result.text();
    const finalData=readVideoEvents(stream);
    const file=findFile(finalData);
    if(!file)throw new Error('Free video service finished without a video file.');

    let video=null,lastStatus=0;
    for(const fileUrl of fileUrls(base,file)){
      video=await requestWithRetry(fileUrl,{headers:authHeaders()},controller,5);
      lastStatus=video.status;
      if(video.ok)break;
    }
    if(!video?.ok)throw Object.assign(new Error(`Generated video download failed (${lastStatus}).`),{upstreamStatus:lastStatus});

    const declaredSize=Number(video.headers.get('content-length') || 0);
    if(declaredSize > env.maxMediaBytes)throw new Error('Generated video exceeds the configured size limit.');
    const bytes=Buffer.from(await video.arrayBuffer());
    if(!bytes.length || bytes.length > env.maxMediaBytes)throw new Error('Generated video returned an invalid file size.');
    const contentType=(video.headers.get('content-type') || '').toLowerCase();
    const head=bytes.slice(0,256).toString('utf8').toLowerCase();
    if(head.includes('<!doctype html') || head.includes('<html'))throw new Error('Generated video download returned an HTML error page.');
    if(contentType.includes('json') || contentType.includes('text/html') || !bytes.slice(0,64).includes(Buffer.from('ftyp')))throw new Error('Generated video download returned an invalid response.');

    const filename=`${Date.now()}-${crypto.randomBytes(8).toString('hex')}.mp4`;
    fs.writeFileSync(path.join(generatedVideoDir(),filename),bytes);
    return new Response(JSON.stringify({provider:'huggingface-zero-gpu',model:'FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers',video_url:`/generated-videos/${filename}`,status:'completed',free:true}),{status:200,headers:{'Content-Type':'application/json'}});
  }catch(error){
    if(error?.name==='AbortError')return new Response(JSON.stringify({error:{code:'free_video_timeout',message:'Video generation timed out after 10 minutes. The free GPU service may be busy or over quota.'}}),{status:504,headers:{'Content-Type':'application/json'}});
    const detail=errorDetails(error);
    console.error('[SQ AI video upstream]',{space,base,error:detail,status:error?.upstreamStatus||null});
    const upstreamStatus=Number(error?.upstreamStatus || 0);
    const status=retryableStatus(upstreamStatus)?502:503;
    return new Response(JSON.stringify({error:{code:status===502?'free_video_bad_gateway':'free_video_unavailable',message:`Free video service is temporarily unavailable: ${detail}`}}),{status,headers:{'Content-Type':'application/json'}});
  }finally{clearTimeout(timer);}
}
