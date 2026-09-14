'use strict';
const crypto=require('crypto');
const express=require('express');
function install(system,secret){
 if(typeof secret !== 'string'||secret.length<32)throw Error('Worker control key required');
 const original=system._createExpressApp.bind(system);
 system._createExpressApp=()=>{
  const outer=express();
  outer.disable('x-powered-by');
  outer.use((req,res,next)=>{
   res.setHeader('Cache-Control','no-store');
   const supplied=req.headers['x-worker-key'];
   const a=Buffer.from(typeof supplied==='string'?supplied:''),b=Buffer.from(secret);
   if(a.length !== b.length)return res.status(401).json({error:'Unauthorized worker access'});
   if(crypto.timingSafeEqual(a,b)===false)return res.status(401).json({error:'Unauthorized worker access'});
   if(req.method==='GET' && req.path==='/internal/status')return res.json(system.workerStatus());
   if(req.method==='POST' && req.path==='/internal/set-mode'){
    let size=0;const chunks=[];
    req.on('data',chunk=>{size+=chunk.length;if(size>1024){req.destroy();return;}chunks.push(chunk);});
    req.on('end',()=>{
     if(res.writableEnded)return;
     let mode=null;
     try{mode=JSON.parse(Buffer.concat(chunks).toString('utf8')).mode;}catch{}
     if(mode!=='fake'&&mode!=='real')return res.status(400).json({error:'Invalid mode'});
     system.streamingMode=mode;
     res.json({mode});
    });
    return;
   }
   const prefix='/v1beta/models/';
   const suffix=req.path.slice(prefix.length);
   const native=req.path.startsWith(prefix) && suffix.includes('/')===false && (suffix.endsWith(':generateContent')||suffix.endsWith(':streamGenerateContent'));
   const generation=req.method==='POST' && (req.path==='/v1/chat/completions'||native);
   if(generation===false)return res.status(404).json({error:'Worker endpoint unavailable'});
   next();
  });
  outer.use(original());
  return outer;
 };
}
module.exports={install};
