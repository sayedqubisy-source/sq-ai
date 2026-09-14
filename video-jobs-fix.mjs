import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

const dbPath = process.env.DB_PATH || './data/sq-ai.sqlite';
let db;
try {
  db = new Database(dbPath);
  db.pragma('journal_mode=WAL');
  db.pragma('busy_timeout=5000');
  db.pragma('synchronous=NORMAL');
  db.exec(`CREATE TABLE IF NOT EXISTS video_jobs (
    id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,tool TEXT NOT NULL,prompt TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT '',platform TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'running',
    provider TEXT NOT NULL DEFAULT 'huggingface-zero-gpu',video_url TEXT,error TEXT,
    credits_reserved INTEGER NOT NULL DEFAULT 0,credits_remaining INTEGER,attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1,next_attempt_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_video_jobs_user_created ON video_jobs(user_id,created_at DESC);`);
  for (const sql of [
    "ALTER TABLE video_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE video_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE video_jobs ADD COLUMN next_attempt_at TEXT"
  ]) { try { db.exec(sql); } catch {} }
} catch (error) { console.error('SQ AI video jobs DB init failed:', error?.message || error); }

const VIDEO_TOOLS = new Set(['text-video','image-video','ad-video','product-video','reels','long-shorts','script-video','voiceover','subtitles','translation','resize','silence','noise','hooks-video','video_script','shorts','long_to_shorts','hooks']);
const ALIASES = { video_script:'script-video',ad_video:'ad-video',product_video:'product-video',shorts:'reels',long_to_shorts:'long-shorts',hooks:'hooks-video' };
function parseCookies(req){const cookies={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i<0)continue;try{cookies[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());}catch{}}return cookies;}
function hashToken(token){return crypto.createHash('sha256').update(token).digest('hex');}
function authenticatedUser(req){if(!db)return null;const apiKey=req.get('x-api-key');if(apiKey&&apiKey.length<=200){const u=db.prepare('SELECT u.* FROM users u JOIN api_keys a ON a.user_id=u.id WHERE a.key=?').get(apiKey);if(u)return u;}const token=parseCookies(req).sqai_session;if(!token)return null;const s=db.prepare("SELECT * FROM sessions WHERE token_hash=? AND expires_at > datetime('now')").get(hashToken(token));return s?db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id):null;}
function normalizeTool(raw){const v=String(raw||'').trim();return ALIASES[v]||v;}
function isVideoRequest(req){const raw=String(req.body?.tool||'').trim();return VIDEO_TOOLS.has(raw)||VIDEO_TOOLS.has(normalizeTool(raw));}
function getJob(id){return db?.prepare('SELECT * FROM video_jobs WHERE id=?').get(id)||null;}
function reserveCreditAndCreateJob({userId,tool,prompt,language,platform}){const id=crypto.randomUUID();return db.transaction(()=>{const u=db.prepare('SELECT credits FROM users WHERE id=?').get(userId);if(!u||Number(u.credits)<1)return null;db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>0').run(userId);db.prepare(`INSERT INTO video_jobs (id,user_id,tool,prompt,language,platform,status,credits_reserved,attempts,max_attempts,started_at) VALUES(?,?,?,?,?,?, 'running',1,0,1,CURRENT_TIMESTAMP)`).run(id,userId,tool,prompt,language,platform);return id;})();}
function finalizeSuccess(id,url){return db.transaction(()=>{const j=getJob(id);if(!j||j.status!=='running'||!j.credits_reserved)return false;db.prepare('INSERT INTO usage(user_id,endpoint,units) VALUES(?,?,1)').run(j.user_id,`tool:${j.tool}`);const u=db.prepare('SELECT credits FROM users WHERE id=?').get(j.user_id);db.prepare("UPDATE video_jobs SET status='completed',video_url=?,error=NULL,credits_reserved=0,credits_remaining=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(url,u?.credits??null,id);return true;})();}
function finalizeFailure(id,errorMessage){db.transaction(()=>{const j=getJob(id);if(!j||j.status==='completed')return;if(j.credits_reserved)db.prepare('UPDATE users SET credits=credits+1 WHERE id=?').run(j.user_id);const u=db.prepare('SELECT credits FROM users WHERE id=?').get(j.user_id);db.prepare("UPDATE video_jobs SET status='failed',error=?,credits_reserved=0,credits_remaining=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(String(errorMessage||'video_generation_failed').slice(0,500),u?.credits??null,id);})();}

// Direct mode: the provider is called immediately. There is no internal SQ AI queue.
async function runJob(id){const job=getJob(id);if(!job)return null;try{const port=Number(process.env.PORT||3000);const response=await fetch(`http://127.0.0.1:${port}/api/v1/videos`,{method:'POST',headers:{Authorization:'Bearer free-local-video','Content-Type':'application/json','X-Title':'SQ AI'},body:JSON.stringify({tool:job.tool,prompt:job.prompt,language:job.language||'English',platform:job.platform||'General'})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data?.error?.message||data?.message||data?.error||`video_provider_request_failed_${response.status}`);const url=data?.video_url||data?.url||data?.output?.video_url||data?.output?.url||(Array.isArray(data?.output)?data.output.find(x=>typeof x==='string'&&/^(?:https?:\/\/|\/)/.test(x)):null);if(!url)throw new Error('video_provider_invalid_output');finalizeSuccess(id,url);return {ok:true,videoUrl:url};}catch(error){const message=error?.message||'video_generation_failed';console.error('SQ AI direct video generation failed',id,message);finalizeFailure(id,message);return {ok:false,error:message};}}

const originalPost=express.application.post;
express.application.post=function(path,...handlers){if(path==='/api/tools/generate'&&handlers.length){const originalHandler=handlers[handlers.length-1];handlers[handlers.length-1]=async function(req,res,next){if(process.env.PAID_VIDEO_ENABLED==='true'||!isVideoRequest(req))return originalHandler(req,res,next);const user=req.user?.id?req.user:authenticatedUser(req);if(!user)return originalHandler(req,res,next);const tool=normalizeTool(req.body?.tool),prompt=String(req.body?.prompt??req.body?.input??'').trim().slice(0,6000),language=String(req.body?.language||'').trim().slice(0,50),platform=String(req.body?.platform||'').trim().slice(0,50);if(!tool||!prompt)return res.status(400).json({error:'tool_and_prompt_required'});try{const id=reserveCreditAndCreateJob({userId:user.id,tool,prompt,language,platform});if(!id)return res.status(402).json({error:'credits_exhausted'});const result=await runJob(id);const job=getJob(id);if(result?.ok)return res.json({result:result.videoUrl,video_url:result.videoUrl,provider:job?.provider||'huggingface-zero-gpu',free:true,credits_remaining:job?.credits_remaining??null});return res.status(502).json({error:result?.error||'video_generation_failed',job_id:id,credits_remaining:job?.credits_remaining??null});}catch(error){console.error('SQ AI direct video route failed:',error?.message||error);return res.status(503).json({error:'video_generation_unavailable',message:'Video generation is temporarily unavailable. Your credit was refunded.'});}};}return originalPost.call(this,path,...handlers);};

const originalGet=express.application.get;
express.application.get=function(path,...handlers){const result=originalGet.call(this,path,...handlers);if(!this.__sqAiVideoJobsRouteInstalled){this.__sqAiVideoJobsRouteInstalled=true;originalGet.call(this,'/api/tools/video-job/:id',(req,res)=>{const user=authenticatedUser(req);if(!user)return res.status(401).json({error:'authentication_required'});const job=getJob(req.params.id);if(!job)return res.status(404).json({error:'video_job_not_found'});if(Number(user.id)!==Number(job.user_id))return res.status(403).json({error:'forbidden'});return res.json({job_id:job.id,status:job.status,result:job.video_url||null,video_url:job.video_url||null,provider:job.provider||'huggingface-zero-gpu',credits_remaining:job.credits_remaining??null,error:job.error||null,attempts:Number(job.attempts||0),max_attempts:Number(job.max_attempts||1),created_at:job.created_at,started_at:job.started_at||null,completed_at:job.completed_at||null});});}return result;};

// If a process restarts during generation, refund the reserved credit after 20 minutes.
setInterval(()=>{if(!db)return;try{for(const j of db.prepare("SELECT id FROM video_jobs WHERE status='running' AND started_at IS NOT NULL AND started_at < datetime('now','-20 minutes')").all())finalizeFailure(j.id,'video_job_timeout_after_restart');}catch(error){console.error('SQ AI video recovery failed:',error?.message||error);}},2*60*1000).unref();
setInterval(()=>{if(!db)return;try{db.prepare("DELETE FROM video_jobs WHERE completed_at IS NOT NULL AND completed_at < datetime('now','-24 hours')").run();}catch(error){console.error('SQ AI video job cleanup failed:',error?.message||error);}},60*60*1000).unref();
