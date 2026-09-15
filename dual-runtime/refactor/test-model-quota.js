 'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ModelQuotaLedger,WINDOW}=require('./model-quota-ledger');
const start=1800000000000;
test('Flash models and accounts have independent 100-request limits',()=>{
 const q=new ModelQuotaLedger(undefined,()=>start);
 for(let i=0;i<100;i++)assert.equal(q.charge(4,'gemini-3.7-flash','flash'),true);
 assert.equal(q.charge(4,'gemini-3.7-flash','flash'),false);
 assert.equal(q.charge(4,'gemini-3.8-flash','flash'),true);
 assert.equal(q.charge(5,'gemini-3.7-flash','flash'),true);
 assert.equal(q.view(4,'gemini-3.8-flash','flash').used,1);
});
test('Pro models have independent 10-request limits',()=>{
 const q=new ModelQuotaLedger(undefined,()=>start);
 for(let i=0;i<10;i++)assert(q.charge(4,'gemini-2.5-pro','pro'));
 assert.equal(q.charge(4,'gemini-2.5-pro','pro'),false);
 assert(q.charge(4,'gemini-3.1-pro-preview','pro'));
 assert(q.charge(4,'gemini-3.8-flash','flash'));
});
test('JSON restart and account switches preserve consumed quota',()=>{
 let q=new ModelQuotaLedger(undefined,()=>start);
 q.charge(4,'gemini-2.5-pro','pro');q.charge(5,'gemini-2.5-pro','pro');
 q=new ModelQuotaLedger(JSON.parse(JSON.stringify(q.snapshot())),()=>start+1000);
 assert.equal(q.view(4,'gemini-2.5-pro','pro').used,1);
 q.charge(6,'gemini-2.5-pro','pro');
 assert.equal(q.view(4,'gemini-2.5-pro','pro').used,1);
});
test('canonical IDs required; aliases cannot create another balance',()=>{
 const q=new ModelQuotaLedger(undefined,()=>start);
 assert.throws(()=>q.charge(4,'anti-truncation/gemini-3.8-flash','flash'));
 q.charge(4,'gemini-3.8-flash','flash');
 assert.equal(q.view(4,'gemini-3.8-flash','flash').used,1);
});
test('24h account window retained; expiry does not erase evidence on read',()=>{
 let now=start;const q=new ModelQuotaLedger(undefined,()=>now);
 q.charge(4,'gemini-3.7-flash','flash');now+=10000;q.charge(4,'gemini-3.8-flash','flash');
 assert.equal(q.view(4,'gemini-3.8-flash','flash').windowStart,start);
 now=start+WINDOW;assert.equal(q.view(4,'gemini-3.7-flash','flash').used,0);
 assert.equal(q.snapshot().accounts['4'].models['gemini-3.7-flash'].used,1);
 q.charge(4,'gemini-3.8-flash','flash');
 assert.equal(q.view(4,'gemini-3.8-flash','flash').used,1);
 assert.equal(q.view(4,'gemini-3.7-flash','flash').used,0);
});
test('ambiguous history preserved without invented per-model usage',()=>{
 let now=start;const q=new ModelQuotaLedger(undefined,()=>now);
 q.retainLegacy(4,{until:start+1000,windowStart:start-2000,evidence:{usesFlash37:23,usesFlash38:5,usesPro:0},blockedFamilies:['flash']});
 assert.equal(q.view(4,'gemini-3.7-flash','flash').legacyBlocked,true);
 assert.equal(q.charge(4,'gemini-3.8-flash','flash'),false);
 assert(q.charge(4,'gemini-2.5-pro','pro'));
 now+=1000;assert(q.charge(4,'gemini-3.8-flash','flash'));
 assert.equal(q.snapshot().accounts['4'].legacy.evidence.usesFlash38,5);
});
test('model cooldown affects neither other models nor other accounts',()=>{
 const q=new ModelQuotaLedger(undefined,()=>start);
 q.defer(4,'gemini-3.8-flash','flash',start+60000);
 assert.equal(q.charge(4,'gemini-3.8-flash','flash'),false);
 assert(q.charge(4,'gemini-3.7-flash','flash'));assert(q.charge(5,'gemini-3.8-flash','flash'));
});
test('policy change cannot reset consumed count',()=>{
 const q=new ModelQuotaLedger(undefined,()=>start);
 for(let i=0;i<11;i++)q.charge(4,'model-a','flash');
 assert.equal(q.view(4,'model-a','pro').allowed,false);
 assert.equal(q.view(4,'model-a','pro').used,11);
});
test('malformed and prototype-key input is rejected or safely isolated',()=>{
 const q=new ModelQuotaLedger(undefined,()=>start);
 assert.throws(()=>q.charge(0,'model-a','flash'));
 assert.throws(()=>q.charge(4,'model-a','constructor'));
 assert.throws(()=>new ModelQuotaLedger({version:1,accounts:{'4':{windowStart:0,models:{x:{family:'pro',used:1,cooldownUntil:0}},legacy:null}}}));
 q.charge(4,'constructor','flash');
 assert.equal(q.view(4,'constructor','flash').used,1);
 assert.throws(()=>q.charge(4,'__proto__','flash'));
});
