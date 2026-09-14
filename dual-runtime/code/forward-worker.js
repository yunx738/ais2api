'use strict';
const http=require('http');
function forwardWorker(ticket,route,body,res,credentials){
 if(['A','B'].includes(ticket.slot)===false)throw Error('Invalid slot');
 if(Buffer.isBuffer(body)===false)throw Error('Body must be buffered before dispatch');
 const prefix='/v1beta/models/';
 const native=route.startsWith(prefix) && route.slice(prefix.length).includes('/')===false && (route.endsWith(':generateContent')||route.endsWith(':streamGenerateContent'));
 if(route!=='/v1/chat/completions' && native===false)throw Error('Unsupported generation route');
 return new Promise(resolve=>{
  let ended=false;
  const finish=(result)=>{
   if(ended)return;
   ended=true;clearTimeout(timer);res.removeListener('close',disconnect);
   resolve(result);
  };
  const upstream=http.request({
   hostname:'127.0.0.1',port:ticket.slot==='A'?8891:8892,
   path:route,method:'POST',agent:false,
   headers:{'Content-Type':'application/json','Content-Length':body.length,
    'X-Worker-Key':credentials.control,'Authorization':'Bearer '+credentials.api}
  },reply=>{
   if(res.destroyed){reply.destroy();upstream.destroy();finish({cancelled:true});return;}
   res.statusCode=reply.statusCode;
   for(const key of ['content-type','retry-after','cache-control']){
    if(reply.headers[key]!==undefined)res.setHeader(key,reply.headers[key]);
   }
   reply.on('error',()=>{if(res.destroyed===false)res.destroy();finish({uncertain:true});});
   reply.on('aborted',()=>{if(res.destroyed===false)res.destroy();finish({uncertain:true});});
   reply.on('end',()=>finish({status:reply.statusCode,retryAfter:reply.headers['retry-after']}));
   reply.pipe(res);
  });
  const disconnect=()=>{
   if(res.writableEnded===false){
    upstream.destroy();
    finish({cancelled:true});
   }
  };
  const timer=setTimeout(()=>{
   upstream.destroy();
   if(res.destroyed===false){
    if(res.headersSent===false){res.statusCode=504;res.end('Worker request timeout');}
    else res.destroy();
   }
   finish({uncertain:true});
  },600000);
  res.on('close',disconnect);
  upstream.on('error',()=>{
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
