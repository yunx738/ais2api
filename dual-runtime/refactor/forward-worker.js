'use strict';
const http=require('http');
const {ResponseMetrics}=require('./response-metrics');
function forwardWorker(ticket,route,body,res,credentials,options={}){
 if(['A','B'].includes(ticket.slot)===false)throw Error('Invalid slot');
 if(!/^[a-f0-9-]{36}$/.test(ticket.id||'') ||
    !/^[a-f0-9-]{36}$/.test(ticket.workerEpoch||''))throw Error('Execution ticket identity missing');
 if(Buffer.isBuffer(body)===false)throw Error('Body must be buffered before dispatch');
 const prefix='/v1beta/models/';
 const native=route.startsWith(prefix) && route.slice(prefix.length).includes('/')===false && (route.endsWith(':generateContent')||route.endsWith(':streamGenerateContent'));
 if(route!=='/v1/chat/completions' && native===false)throw Error('Unsupported generation route');
 if(options.signal?.aborted)return Promise.resolve({uncertain:true});
 return new Promise(resolve=>{
  let ended=false,receivedStatus,receivedRetryAfter,upstreamReply;
  const observer=new ResponseMetrics();
  const finish=(result)=>{
   if(ended)return;
   result={status:receivedStatus,retryAfter:receivedRetryAfter,...result};
   ended=true;clearTimeout(timer);res.removeListener('close',disconnect);
   options.signal?.removeEventListener('abort',cancel);
   const metrics=observer.finish({complete:Number.isInteger(result.status) && !result.uncertain && !result.cancelled});
   resolve({...result,metrics});
  };
  const upstream=http.request({
   hostname:'127.0.0.1',port:ticket.slot==='A'?8891:8892,
   path:route,method:'POST',agent:false,
   headers:{"X-Admission-Deadline":String(ticket.admissionDeadline),'Content-Type':'application/json','Content-Length':body.length,
    'X-Request-ID':ticket.id,'X-Execution-ID':ticket.id,'X-Worker-Epoch':ticket.workerEpoch,
    'X-Worker-Key':credentials.control,'Authorization':'Bearer '+credentials.api}
  },reply=>{
   upstreamReply=reply;
   receivedStatus=reply.statusCode;receivedRetryAfter=reply.headers['retry-after'];
   if(ended||res.destroyed||res.writableEnded||res.headersSent){finish({cancelled:true});reply.destroy();upstream.destroy();return;}
   observer.stream=String(reply.headers['content-type']||'').toLowerCase().includes('text/event-stream');
   let deferred=options.deferRejections===true && [401,403,429].includes(reply.statusCode);
   let buffered=0,chunks=[];
   const headers={};
   for(const key of ['content-type','retry-after','cache-control'])if(reply.headers[key]!==undefined)headers[key]=reply.headers[key];
   const publishHeaders=()=>{
    res.statusCode=reply.statusCode;
    for(const [key,value] of Object.entries(headers))res.setHeader(key,value);
   };
   reply.on('error',()=>{if(ended)return;finish({uncertain:true});if(res.destroyed===false)res.destroy();});
   reply.on('aborted',()=>{if(ended)return;finish({uncertain:true});if(res.destroyed===false)res.destroy();});
   reply.on('end',()=>finish({status:reply.statusCode,retryAfter:reply.headers['retry-after'],
    ...(deferred?{rejection:{status:reply.statusCode,headers,body:Buffer.concat(chunks)}}:{})}));
   reply.on('data',chunk=>{
    if(ended)return;
    observer.write(chunk);
    if(!deferred)return;
    buffered+=chunk.length;chunks.push(chunk);
    // Only bounded, completely received rejection bodies can be considered for
    // failover. A large response is passed through and cannot be replayed.
    if(buffered>65536){
     deferred=false;publishHeaders();
     let blocked=false;
     for(const held of chunks)if(!res.write(held))blocked=true;
     chunks=[];reply.pipe(res);
     if(blocked){reply.pause();res.once('drain',()=>reply.resume());}
    }
   });
   if(!deferred){publishHeaders();reply.pipe(res);}
  });
  const disconnect=()=>{
   if(res.writableEnded===false){
    // A protocol terminator is evidence of model-stream completion, not HTTP drain.
    finish(observer.stream && observer.done ? {uncertain:true} : {cancelled:true});
    upstream.destroy();
   }
  };
  const cancel=()=>{
   if(ended)return;
   finish({uncertain:true});upstreamReply?.destroy();upstream.destroy();
  };
  const timer=setTimeout(()=>{
   finish({uncertain:true});
   upstream.destroy();
   if(res.destroyed===false){
    if(res.headersSent===false){res.statusCode=504;res.end('Worker request timeout');}
    else res.destroy();
   }
   finish({uncertain:true});
  },600000);
  res.on('close',disconnect);
  options.signal?.addEventListener('abort',cancel,{once:true});
  upstream.on('error',()=>{
   if(ended)return;
   finish({uncertain:true});
   if(res.destroyed===false){
    if(res.headersSent===false){res.statusCode=502;res.end('Worker connection failed');}
    else res.destroy();
   }
   finish({uncertain:true});
  });
  if(options.signal?.aborted){cancel();return;}
  if(res.destroyed||res.writableEnded){upstream.destroy();finish({cancelled:true});return;}
  upstream.end(body);
 });
}
module.exports={forwardWorker};
