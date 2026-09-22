'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('http');
const {EventEmitter}=require('events');
const {WorkerClient}=require('./worker-client');
function stub(t,send){
 t.mock.method(http,'get',(_options,callback)=>{
  const req=new EventEmitter();req.destroy=()=>{};
  queueMicrotask(()=>{
   const res=new EventEmitter();res.statusCode=200;res.complete=false;res.destroy=()=>{};
   callback(res);send(req,res);
  });return req;
 });
 return new WorkerClient({A:'a'.repeat(32)});
}
test('incomplete worker status settles immediately even when request closes first',async t=>{
 const client=stub(t,(req,res)=>{
  res.emit('data',Buffer.from('{"ready":'));req.emit('close');res.emit('close');
 });
 await assert.rejects(client.status('A',1),/incomplete/);
});
test('aborted worker status cannot leave health polling pending',async t=>{
 const client=stub(t,(_req,res)=>res.emit('aborted'));
 await assert.rejects(client.status('A',1),/aborted/);
});
test('valid bounded status accepts only expected account',async t=>{
 const client=stub(t,(_req,res)=>{
  res.emit('data',Buffer.from(JSON.stringify({account:2,ready:true,busy:false,
   quarantined:false,browserOperations:0,activeRequests:0,cooldownUntil:0})));
  res.complete=true;res.emit('end');res.emit('close');
 });
 await assert.rejects(client.status('A',1),/account mismatch/);
 assert.equal((await client.status('A',2)).ready,true);
});
