'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {shouldRefresh}=require('./catalog-refresh-policy');
const now=1800000000000;
const input=()=>({account:4,epoch:'epoch-a',now,state:{ready:true,active:0},
 cached:{account:4,workerEpoch:'epoch-a',observedAt:now,syncing:false}});
test('empty directory after worker change requests refresh only with current identity',()=>{
 const x=input();assert.equal(shouldRefresh(x),true);
 x.cached.workerEpoch='previous';assert.equal(shouldRefresh(x),false);
 delete x.cached;assert.equal(shouldRefresh(x),false);
});
test('fresh directory refreshes at 30 minutes before 60-minute expiry',()=>{
 const x=input();x.cached.snapshot={account:4,updatedAt:now-1799999,stale:false};
 assert.equal(shouldRefresh(x),false);x.cached.snapshot.updatedAt--;assert.equal(shouldRefresh(x),true);
});
test('busy, unresolved, rotating or syncing slots are never refreshed',()=>{
 for(const patch of [{operation:true},{jobs:1},{rotating:true},{state:{ready:false,active:0}},
  {state:{ready:true,active:1}},{state:{ready:true,active:0,retirements:{x:{}}}},
  {state:{ready:true,active:0,executions:{x:{}}}},{state:{ready:true,active:0,pending:6}}]){
  assert.equal(shouldRefresh({...input(),...patch}),false);
 }
 const x=input();x.cached.syncing=true;assert.equal(shouldRefresh(x),false);
});
test('failed sync uses one-minute backoff and does not tight-loop',()=>{
 const x=input();x.cached.error='failed';x.cached.attemptedAt=now-59999;
 assert.equal(shouldRefresh(x),false);x.cached.attemptedAt--;assert.equal(shouldRefresh(x),true);
 x.cached.retryAt=now+1;assert.equal(shouldRefresh(x),false);
});
test('stale or future observation cannot authorize a new task',()=>{
 const x=input();x.cached.observedAt=now-30001;assert.equal(shouldRefresh(x),false);
 x.cached.observedAt=now+1;assert.equal(shouldRefresh(x),false);
});
