'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('http');
const {createServer}=require('./coordinator-http');
async function fixture(t){
 const calls=[];
 const actions={async rotate(slot,target){calls.push({slot,target});return {started:[],skipped:[{slot,reason:'busy'}]};}};
 const server=createServer({keys:['test-key'],models:[],scheduler:{submit(){calls.push('generation');}},status:()=>({}),actions});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const post=(body,type='application/json',route='/internal/rotate')=>new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:server.address().port,path:route,method:'POST',agent:false,
   headers:{Authorization:'Bearer test-key','Content-Type':type}},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
  });req.on('error',reject);req.end(body);
 });
 return {post,calls,actions};
}
test('malformed rotation input must never silently rotate both accounts',async t=>{
 const f=await fixture(t);
 for(const body of ['{','null','[]','"A"',''])assert.equal((await f.post(body)).status,400);
 assert.equal(f.calls.length,0);
});
test('rotation requires exact JSON media type, positive account and explicit target slot',async t=>{
 const f=await fixture(t);
 assert.equal((await f.post('{}','application/jsonp')).status,415);
 for(const body of ['{"slot":"C"}','{"targetAccount":3}','{"slot":"A","targetAccount":0}','{"slot":"A","targetAccount":-1}'])
  assert.equal((await f.post(body)).status,400);
 assert.equal(f.calls.length,0);
});
test('an entirely rejected rotation returns conflict; accepted one returns 202',async t=>{
 const f=await fixture(t);
 assert.equal((await f.post('{"slot":"A"}')).status,409);
 f.actions.rotate=async()=>({started:['A'],skipped:[]});
 assert.equal((await f.post('{"slot":"A"}')).status,202);
});
test('invalid generation media type is rejected before scheduling',async t=>{
 const f=await fixture(t);
 assert.equal((await f.post('{}','application/jsonp','/v1/chat/completions')).status,415);
 assert.equal(f.calls.length,0);
});
