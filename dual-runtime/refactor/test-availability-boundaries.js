'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const http=require('node:http'),{randomUUID}=require('node:crypto');
const {openHistory}=require('./history-startup');
const {createRecordedForward}=require('./recorded-forward');
const {rotationPayload,requireSession,createControlCall}=require('./management-control');

test('corrupt analytics cannot prevent generation or appear as empty successful statistics',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ais-history-broken-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,randomUUID()+'.json');await fs.writeFile(file,'{broken');
 const history=await openHistory(dir);
 assert.equal(history.status().degraded,true);assert.equal(history.status().ready,false);
 assert.throws(()=>history.summary(),e=>e.statusCode===503);
 assert.throws(()=>history.list(),e=>e.statusCode===503);
 let forwarded=0;const result={status:200};
 const forward=createRecordedForward({history,forward:async()=>{forwarded++;return result;}});
 assert.equal(await forward({model:'fixture-flash'},'/v1/chat/completions',Buffer.from('{}'),{},{}),result);
 assert.equal(forwarded,1);assert.equal(await fs.readFile(file,'utf8'),'{broken');
});
test('history startup deadline returns an isolated unavailable facade even if init later succeeds',async()=>{
 let release;const original={init:()=>new Promise(r=>{release=()=>r(original);}),status:()=>({ready:true})};
 const history=await openHistory('/unused',{timeoutMs:10,createHistory:()=>original});
 release();await new Promise(r=>setImmediate(r));assert.equal(history.status().ready,false);
});
test('stuck history writes neither block generation forever nor grow a new log queue on every request',async()=>{
 for(const phase of ['begin','finish']){
  let begins=0,forwards=0;
  const history={begin:async()=>{begins++;if(phase==='begin')return new Promise(()=>{});},
   finish:async()=>{if(phase==='finish')return new Promise(()=>{});},status:()=>({ready:true})};
  const forward=createRecordedForward({history,recordTimeoutMs:10,forward:async()=>{forwards++;return {status:200};}});
  const args=[{model:'fixture-flash'},'/v1/chat/completions',Buffer.from('{}'),{},{}];
  assert.equal((await forward(...args)).status,200);assert.equal(forward.status().recordingPaused,true);
  assert.equal((await forward(...args)).status,200);assert.equal(begins,1);assert.equal(forwards,2);
 }
});
test('management proxy never normalizes malformed rotation into rotate-all',()=>{
 for(const body of [undefined,null,[],1,'A',{slot:null},{slot:'C'},{targetAccount:3},
  {slot:'A',targetAccount:0},{slot:'A',targetAccount:-1}])assert.throws(()=>rotationPayload(body));
 assert.deepEqual(rotationPayload({slot:'A',targetAccount:3}),{slot:'A',targetAccount:3});
 assert.deepEqual(rotationPayload({}),{});
});
test('expired management session returns API 401 without a redirect loop',()=>{
 const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;},redirect(){assert.fail('API must not redirect');}};
 requireSession({path:'/api/status'},res,()=>assert.fail('Unauthenticated'));
 assert.equal(res.code,401);assert.match(res.body.error,/Session expired/);
 let next=false;requireSession({path:'/api/status',session:{isAuthenticated:true}},res,()=>{next=true;});assert.equal(next,true);
});
test('management transport has absolute deadline even while coordinator trickles bytes',async t=>{
 const sockets=new Set(),timers=new Set();
 const server=http.createServer((_req,res)=>{
  res.writeHead(200,{'Content-Type':'application/json'});res.write('{');
  const timer=setInterval(()=>res.write(' '),5);timers.add(timer);
  res.once('close',()=>{clearInterval(timer);timers.delete(timer);});
 });server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{for(const timer of timers)clearInterval(timer);for(const s of sockets)s.destroy();return new Promise(r=>server.close(r));});
 const call=createControlCall('fixture-key',{port:server.address().port,timeoutMs:30});
 const result=await call('GET','/internal/coordinator-status');assert.equal(result.status,503);
});
test('truncated or non-JSON coordinator reply is a bounded failure, not a successful operation',async t=>{
 const server=http.createServer((req,res)=>{
  if(req.url==='/bad'){res.end('not-json');return;}
  res.writeHead(200,{'Content-Length':100});res.write('{');setImmediate(()=>res.destroy());
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const call=createControlCall('fixture',{port:server.address().port,timeoutMs:100});
 for(const route of ['/bad','/truncated'])assert.equal((await call('GET',route)).status,503);
});
