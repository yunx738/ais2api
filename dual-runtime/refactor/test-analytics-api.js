'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('http');
const {parseAnalyticsQuery:parse}=require('./analytics-query');
const {createServer}=require('./coordinator-http');
test('analytics filters preserve numeric values',()=>{
 assert.deepEqual(parse(new URLSearchParams('account=4&from=0&page=2&pageSize=10')),
 {account:4,from:0,page:2,pageSize:10});
});
test('filters reject duplicates and invalid values',()=>{
 for(const q of ['account=4&account=5','password=x','page=0','pageSize=101','account=-1','from=3&to=2','model=<script>','outcome=whatever'])
 assert.throws(()=>parse(new URLSearchParams(q)));
 assert.throws(()=>parse(new URLSearchParams('page=2'),{summary:true}));
});
async function fixture(t){
 let calls=0;
 const server=createServer({keys:['offline-test-key'],models:()=>[],scheduler:{submit(){throw Error('Generation forbidden');}},
 status:()=>({}),actions:{
 historyList:o=>{calls++;return {items:[],total:0,filter:o};},
 historySummary:o=>{calls++;return {requests:0,filter:o};}
 }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const get=(route,key)=>new Promise((resolve,reject)=>{
 const req=http.get({hostname:'127.0.0.1',port:server.address().port,path:route,agent:false,
 headers:key?{Authorization:'Bearer '+key}:{}},res=>{
 let text='';res.on('data',c=>text+=c);
 res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),headers:res.headers}));
 });req.on('error',reject);
 });
 return {get,calls:()=>calls};
}
test('analytics requires authentication',async t=>{
 const f=await fixture(t);
 for(const p of ['/internal/requests','/internal/usage'])assert.equal((await f.get(p)).status,401);
 assert.equal(f.calls(),0);
});
test('authenticated reads route without generation',async t=>{
 const f=await fixture(t);
 const a=await f.get('/internal/requests?account=4&pageSize=10','offline-test-key');
 assert.equal(a.status,200);assert.equal(a.body.filter.account,4);
 assert.equal(a.headers['cache-control'],'no-store');
 const b=await f.get('/internal/usage?from=0','offline-test-key');
 assert.equal(b.status,200);assert.equal(b.body.filter.from,0);assert.equal(f.calls(),2);
});
test('invalid query returns 400 before reading history',async t=>{
 const f=await fixture(t);
 assert.equal((await f.get('/internal/requests?pageSize=999','offline-test-key')).status,400);
 assert.equal(f.calls(),0);
});
