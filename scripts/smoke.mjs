import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 3187;
const dbPath = path.join(os.tmpdir(), `sq-ai-smoke-${process.pid}.sqlite`);
const child = spawn(process.execPath, [
  '--import','./security-fix.mjs','--import','./sqai-bridge.mjs','--import','./route-order-fix.mjs','--import','./auto-recovery.mjs',
  '--import','./billing-fix.mjs','--import','./ui-fix.mjs','--import','./video-fix.mjs',
  '--import','./video-jobs-fix.mjs','--import','./ai-runtime-loader.mjs','--import','./ai-status.mjs',
  '--import','./media-studio-runtime.mjs','--import','./media-assets-fix.mjs','server.js'
], {
  env: { ...process.env, NODE_ENV:'test', PORT:String(port), DB_PATH:dbPath, SQAI_BRIDGE_TOKEN:'',
    OPENROUTER_API_KEY:'', OPENAI_API_KEY:'', GEMINI_API_KEY:'', ANTHROPIC_API_KEY:'',
    DEEPSEEK_API_KEY:'', GROQ_API_KEY:'', MISTRAL_API_KEY:'', TOGETHER_API_KEY:'', FIREWORKS_API_KEY:'',
    MEDIA_PROMPT_ENHANCER:'false' },
  stdio:['ignore','pipe','pipe']
});

let output='';
child.stdout.on('data', b => { output += b.toString(); });
child.stderr.on('data', b => { output += b.toString(); });

const base=`http://127.0.0.1:${port}`;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function get(pathname, options={}) { return fetch(`${base}${pathname}`, options); }
async function waitForHealth(){
  for(let i=0;i<60;i++){
    try { const r=await get('/api/health'); if(r.ok)return; } catch {}
    await wait(250);
  }
  throw new Error(`server did not become healthy\n${output}`);
}
function assert(condition,message){if(!condition)throw new Error(message);}

try {
  await waitForHealth();
  const health=await get('/api/health');
  const healthJson=await health.json();
  assert(healthJson.ok===true,'health check failed');

  const plans=await get('/api/plans');
  assert(plans.ok,'plans endpoint failed');
  const planJson=await plans.json();
  assert(planJson.starter?.credits===100,'starter plan mismatch');

  const email=`smoke-${Date.now()}@example.com`;
  const signup=await get('/api/auth/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'SmokeTest123!',name:'Smoke'})});
  assert(signup.status===201,`signup failed: ${signup.status}`);
  const cookie=signup.headers.get('set-cookie');
  assert(cookie?.includes('sqai_session='),'session cookie missing');
  const sessionCookie=cookie.split(';')[0];

  const me=await get('/api/me',{headers:{cookie:sessionCookie}});
  assert(me.ok,'authenticated /api/me failed');
  const projects=await get('/api/projects',{headers:{cookie:sessionCookie}});
  assert(projects.ok,'authenticated projects failed');

  const runtime=await get('/api/ai/runtime');
  assert(runtime.ok,'AI runtime endpoint failed');

  // Route-order regression test: the runtime POST must see JSON body data.
  // With providers disabled, a parsed prompt should reach provider selection
  // and return 503 rather than prompt_required (400).
  const ai=await get('/api/ai/generate',{method:'POST',headers:{cookie:sessionCookie,'content-type':'application/json'},body:JSON.stringify({prompt:'smoke body parser test',capability:'text'})});
  assert(ai.status===503 || ai.status===502,`AI POST routing/body parsing failed: ${ai.status}`);

  const mediaConfig=await get('/api/media/config',{headers:{cookie:sessionCookie}});
  assert(mediaConfig.ok,'Media Studio config endpoint failed');
  const mediaJson=await mediaConfig.json();
  assert(mediaJson.queue==='sqlite-sequential','Media Studio queue missing');
  assert(mediaJson.veo_model==='veo-3.1-generate-preview','Veo model default mismatch');
  assert(mediaJson.lyria_model==='lyria-3.5','Lyria model default mismatch');

  const mediaUnauth=await get('/api/media/config');
  assert(mediaUnauth.status===401,'Media Studio auth guard failed');

  const checkout=await get('/api/billing/checkout',{method:'POST',headers:{cookie:sessionCookie,'content-type':'application/json'},body:JSON.stringify({plan:'starter'})});
  assert([501,502,503].includes(checkout.status),'billing configuration guard failed');

  for(const page of ['/terms.html','/privacy.html','/refund.html','/tools.html']){
    const r=await get(page);
    assert(r.ok,`${page} failed with ${r.status}`);
  }

  const missing=await get('/api/does-not-exist');
  assert(missing.status===404,'API 404 handling failed');

  console.log('SQ AI smoke test: PASS');
} catch(error) {
  console.error('SQ AI smoke test: FAIL');
  console.error(error?.stack||error);
  console.error(output);
  process.exitCode=1;
} finally {
  child.kill('SIGTERM');
  await wait(300);
  for(const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(dbPath+suffix,{force:true}); } catch {} }
}