'use strict';
const http=require('http');

function requireSession(req,res,next){
 if(req.session?.isAuthenticated)return next();
 if(req.path.startsWith('/api/'))return res.status(401).json({error:'Session expired; sign in again'});
 return res.redirect('/login');
}
function rotationPayload(body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw Error('JSON object required');
 const {slot,targetAccount:target}=body;
 if(slot!==undefined&&!['A','B'].includes(slot))throw Error('slot must be A or B');
 if(target!==undefined&&target!==null&&(!Number.isSafeInteger(target)||target<1))throw Error('targetAccount must be a positive integer');
 if(target!==undefined&&target!==null&&slot===undefined)throw Error('Target account requires a slot');
 return {...(slot===undefined?{}:{slot}),...(target===undefined||target===null?{}:{targetAccount:target})};
}
function createControlCall(key,{hostname='127.0.0.1',port=8890,timeoutMs=10000,maxBytes=8388608}={}){
 return (method,actionPath,body)=>new Promise(resolve=>{
  let settled=false,timer;
  const failed={status:503,body:{error:'Coordinator unavailable; operation result may require a status refresh'}};
  const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};
  let payload;try{payload=body===undefined?'':JSON.stringify(body);}catch{return finish(failed);}
  const upstream=http.request({hostname,port,path:actionPath,method,agent:false,
   headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},reply=>{
   let size=0;const chunks=[];
   reply.on('data',chunk=>{
    size+=chunk.length;
    if(size>maxBytes){finish(failed);reply.destroy();upstream.destroy();return;}
    chunks.push(chunk);
   });
   reply.on('aborted',()=>finish(failed));
   reply.on('error',()=>finish(failed));
   reply.on('close',()=>{if(!reply.complete)finish(failed);});
   reply.on('end',()=>{
    try{finish({status:reply.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}
    catch{finish(failed);}
   });
  });
  timer=setTimeout(()=>{finish(failed);upstream.destroy();},timeoutMs);
  upstream.on('error',()=>finish(failed));
  upstream.end(payload);
 });
}
module.exports={requireSession,rotationPayload,createControlCall};
