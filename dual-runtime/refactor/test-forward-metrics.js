'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const vm=require('vm'),fs=require('fs'),path=require('path');
const {PassThrough,Writable}=require('stream'),{EventEmitter}=require('events');
const {randomUUID}=require('crypto');
const {ResponseMetrics}=require('./response-metrics');
async function run({chunks,status=200,type='application/json',abort=false}){
 let outbound,options,rawBody;
 const collected=[];
 const res=new Writable({write(chunk,encoding,done){collected.push(Buffer.from(chunk));done();}});
 res.headers={};res.setHeader=(k,v)=>{res.headers[k]=v;};
 res.on('error',()=>{});
 const http={request(opts,callback){
  options=opts;outbound=new EventEmitter();
  outbound.destroy=()=>{};
  outbound.end=body=>{
   rawBody=body;
   setImmediate(()=>{
    const reply=new PassThrough();
    reply.statusCode=status;reply.headers={'content-type':type,'retry-after':'60'};
    callback(reply);
    for(const c of chunks)reply.write(c);
    if(abort){reply.emit('aborted');reply.destroy();}
    else reply.end();
   });
  };
  return outbound;
 }};
 const sandbox={module:{exports:{}},Buffer,setTimeout,clearTimeout,
  require:name=>{if(name==='http')return http;if(name==='./response-metrics')return {ResponseMetrics};throw Error('Unexpected dependency');}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'forward-worker.js'),'utf8'),sandbox);
 const ticket={slot:'A',id:randomUUID(),workerEpoch:randomUUID(),admissionDeadline:Date.now()+30000};
 const input=Buffer.from('{"model":"offline-fixture","messages":[]}');
 const result=await sandbox.module.exports.forwardWorker(ticket,'/v1/chat/completions',input,res,{api:'fixture-api',control:'fixture-control'});
 if(!abort && !res.writableFinished)await new Promise(resolve=>res.once('finish',resolve));
 return {result,bytes:Buffer.concat(collected),res,options,rawBody,input,ticket};
}
test('passive observer preserves JSON bytes, headers and admission identity',async()=>{
 const bytes=Buffer.from('{"choices":[{"message":{"content":"中文"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}');
 const f=await run({chunks:[bytes.subarray(0,21),bytes.subarray(21)]});
 assert.deepEqual(f.bytes,bytes);assert.equal(f.rawBody,f.input);
 assert.equal(f.result.metrics.usage.total,7);
 assert.equal(f.result.metrics.transportComplete,true);
 assert.equal(f.options.headers['X-Execution-ID'],f.ticket.id);
 assert.equal(f.options.headers['X-Worker-Epoch'],f.ticket.workerEpoch);
 assert.equal(f.res.headers['content-type'],'application/json');
});
test('SSE observer preserves byte stream and does not sum cumulative usage',async()=>{
 const text=': heartbeat\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
 const f=await run({chunks:[Buffer.from(text.slice(0,45)),Buffer.from(text.slice(45))],type:'text/event-stream'});
 assert.equal(f.bytes.toString(),text);
 assert.equal(f.result.metrics.usage.output,2);
 assert.equal(f.result.metrics.streamDoneSeen,true);
});
test('rate limit status and retry-after survive metrics collection',async()=>{
 const f=await run({status:429,chunks:[Buffer.from('{"error":{"message":"fixture"}}')]});
 assert.equal(f.result.status,429);assert.equal(f.result.retryAfter,'60');
 assert.equal(f.res.statusCode,429);assert.equal(f.res.headers['retry-after'],'60');
 assert.equal(f.result.metrics.applicationError,true);
});
test('aborted response never claims complete transport or usage',async()=>{
 const f=await run({chunks:[Buffer.from('data: {"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n')],type:'text/event-stream',abort:true});
 assert.equal(f.result.metrics.transportComplete,false);
 assert.equal(f.result.metrics.usageComplete,false);
 assert.ok(f.result.uncertain||f.result.cancelled);
});
