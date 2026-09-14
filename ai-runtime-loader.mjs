import express from 'express';
import { installAiRuntime } from './ai-runtime.mjs';
const original=express.application.listen;
if(!original.__sqAiRuntimeLoader){
  const wrapped=function(...args){
    try{installAiRuntime(this)}catch(e){console.error('[SQ AI] runtime install failed',e?.message||e)}
    return original.apply(this,args)
  };
  wrapped.__sqAiRuntimeLoader=true;
  express.application.listen=wrapped;
}
