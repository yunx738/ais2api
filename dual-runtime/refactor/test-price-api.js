'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('http');
const {createServer}=require('./coordinator-http');
async function fixture(t){
 let revision=0,calls=0;
 const server=createServer({
  keys:['isolated-price-test'],models:()=>[],status:()=>({}),
  scheduler:{submit(){throw Error('Generation forbidden');}},
  actions:{
   prices:()=>({revision,prices:{},models:['gemini-test']}),
   savePrice:body=>{
    calls++;
    if(!body||body.model!=='gemini-test')throw Object.assign(Error('invalid'),{statusCode:400});
    if(body.revision!==revision)throw Object.assign(Error('conflict'),{statusCode:409});
    revision++;return {revision};
   }
  }
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=({method='GET',body='',auth=true,type='application/json'}={})=>new Promise((resolve,reject)=>{
  const headers={'Content-Type':type,'Content-Length':Buffer.byteLength(body)};
  if(auth)headers.Authorization='Bearer isolated-price-test';
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/internal/prices',
   method,headers,agent:false},res=>{
    let raw='';res.on('data',c=>raw+=c);
    res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));
   });
  req.on('error',reject);req.end(body);
 });
 return {request,calls:()=>calls};
}
test('price reads and writes require authentication',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request({auth:false})).status,401);
 assert.equal((await f.request({auth:false,method:'POST',body:'{}'})).status,401);
 assert.equal(f.calls(),0);
});
test('price writes reject non-JSON and malformed payload before mutation',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request({method:'POST',type:'text/plain',body:'{}'})).status,415);
 assert.equal((await f.request({method:'POST',type:'application/jsonx',body:'{}'})).status,415);
 assert.equal((await f.request({method:'POST',body:'{broken'})).status,400);
 assert.equal(f.calls(),0);
});
test('price endpoint returns conflict rather than repeating stale write',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request()).body.revision,0);
 const options={method:'POST',body:JSON.stringify({model:'gemini-test',revision:0})};
 assert.equal((await f.request(options)).status,200);
 assert.equal((await f.request(options)).status,409);
 assert.equal((await f.request()).body.revision,1);
});
test('invalid price target returns 400',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request({method:'POST',body:'{}'})).status,400);
 assert.equal((await f.request()).body.revision,0);
});
