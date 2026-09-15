'use strict';
const http=require('http');
const {ResponseMetrics}=require('./response-metrics');
function forwardWorker(ticket,route,body,res,credentials){
 if(['A','B'].includes(ticket.slot)===false)throw Error('Invalid slot');
 if(!/^[a-f0-9-]{36}$/.test(ticket.id||'') ||
    !/^[a-f0-9-]{36}$/.test(ticket.workerEpoch||''))throw Error('Execution ticket identity missing');
 if(Buffer.isBuffer(body)===false)throw Error('Body must be buffered before dispatch');
 const prefix='/v1beta/models/';
 const native=route.startsWith(prefix) && route.slice(prefix.length).includes('/')===false && (route.endsWith(':generateContent')||route.endsWith(':streamGenerateContent'));
 if(route!=='/v1/chat/completions' && native===false)throw Error('Unsupported generation route');
 return new Promise(resolve=>{
  let ended=false,receivedStatus,receivedRetryAfter;
  const observer=new ResponseMetrics();
  const finish=(result)=>{
   if(ended)return;
   result={status:receivedStatus,retryAfter:receivedRetryAfter,...result};
   ended=true;clearTimeout(timer);res.removeListener('close',disconnect);
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
   receivedStatus=reply.statusCode;receivedRetryAfter=reply.headers['retry-after'];
   if(res.destroyed){finish({cancelled:true});reply.destroy();upstream.destroy();return;}
   observer.stream=String(reply.headers['content-type']||'').toLowerCase().includes('text/event-stream');
   res.statusCode=reply.statusCode;
   for(const key of ['content-type','retry-after','cache-control']){
    if(reply.headers[key]!==undefined)res.setHeader(key,reply.headers[key]);
   }
   reply.on('error',()=>{finish({uncertain:true});if(res.destroyed===false)res.destroy();});
   reply.on('aborted',()=>{finish({uncertain:true});if(res.destroyed===false)res.destroy();});
   reply.on('end',()=>finish({status:reply.statusCode,retryAfter:reply.headers['retry-after']}));
   reply.on('data',chunk=>observer.write(chunk));
   reply.pipe(res);
  });
  const disconnect=()=>{
   if(res.writableEnded===false){
    // A protocol terminator is evidence of model-stream completion, not HTTP drain.
    finish(observer.stream && observer.done ? {uncertain:true} : {cancelled:true});
    upstream.destroy();
   }
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
  upstream.on('error',()=>{
   finish({uncertain:true});
   if(res.destroyed===false){
    if(res.headersSent===false){res.statusCode=502;res.end('Worker connection failed');}
    else res.destroy();
   }
   finish({uncertain:true});
  });
  if(res.destroyed){upstream.destroy();finish({cancelled:true});return;}
  upstream.end(body);
 });
}
module.exports={forwardWorker};
