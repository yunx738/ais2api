'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {AccountTiers}=require('./account-tiers'),{ModelQuotaLedger}=require('./model-quota-ledger');
const {DispatchCore}=require('./dispatch-core'),{AccountPool}=require('../code/account-pool');
const {RequestHistory}=require('./request-history');
function setup(single=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tier-'));
 for(const id of [1,2,3,4])fs.writeFileSync(path.join(dir,'auth-'+id+'.json'),JSON.stringify({cookies:[{}],origins:[],accountName:'a'+id}),{mode:0o600});
 const tiers=new AccountTiers({authDir:dir,file:path.join(dir,'mode.json'),isSingle:()=>single});
 return {dir,tiers};
}
test('tier is stored in the auth file and survives the switch and a cookie refresh',()=>{
 const {dir,tiers}=setup();tiers.setTier(3,'ultra');
 a.equal(JSON.parse(fs.readFileSync(path.join(dir,'auth-3.json'))).accountTier,'ultra');
 tiers.setMode({enabled:true,slot:'B'});tiers.setMode({enabled:false});a.equal(tiers.isUltra(3),true);
 const f=path.join(dir,'auth-3.json'),d=JSON.parse(fs.readFileSync(f));fs.writeFileSync(f,JSON.stringify({...d,cookies:[{x:1}]}));
 a.equal(new AccountTiers({authDir:dir,file:path.join(dir,'mode.json')}).isUltra(3),true);
 tiers.setTier(3,'standard');a.equal(tiers.isUltra(3),false);a.equal('accountTier' in JSON.parse(fs.readFileSync(f)),false);
});
test('switch only changes allocation; off and single mode allow any slot',()=>{
 const {dir,tiers}=setup();tiers.setTier(3,'ultra');
 a.equal(tiers.allowed('A',3),true);a.equal(tiers.allowed('B',1),true);
 tiers.setMode({enabled:true,slot:'B'});
 a.equal(tiers.allowed('B',3),true);a.equal(tiers.allowed('B',1),false);a.equal(tiers.allowed('A',3),false);a.equal(tiers.allowed('A',1),true);
 a.equal(new AccountTiers({authDir:dir,file:path.join(dir,'mode.json')}).mode.enabled,true);
 const single=new AccountTiers({authDir:dir,file:path.join(dir,'mode.json'),isSingle:()=>true});a.equal(single.allowed('A',3),true);
});
test('rotation candidates follow the slot rule',()=>{
 const {tiers}=setup();tiers.setTier(3,'ultra');tiers.setMode({enabled:true,slot:'B'});
 const pool=new AccountPool([1,2,3,4]);pool.slots.set('A',{current:1,pending:null});pool.owners.set(1,'A');pool.slots.set('B',{current:2,pending:null});pool.owners.set(2,'B');
 const d=new DispatchCore(pool,()=>{});for(const id of pool.ids)d.quotas.account(id,true);d.slotAllows=(s,id)=>tiers.allowed(s,id);
 a.equal(d.rotationCandidate(undefined,undefined,'B'),3);a.equal(d.rotationCandidate(undefined,undefined,'A'),4);
});
test('every account class has the same caps (flash 100, pro 10, premium 10) and keeps 429 cooldown',()=>{
 const q=new ModelQuotaLedger();
 for(let i=0;i<10;i++)a.equal(q.charge(3,'gemini-4-argon','ultra'),true);
 a.equal(q.charge(3,'gemini-4-argon','ultra'),false);
 const v=q.view(3,'gemini-4-argon','ultra');a.equal(v.limit,10);a.equal(v.used,10);a.equal(v.allowed,false);
 for(let i=0;i<10;i++)q.charge(3,'gemini-3.1-pro-preview','pro');a.equal(q.charge(3,'gemini-3.1-pro-preview','pro'),false);
 for(let i=0;i<100;i++)q.charge(1,'gemini-3.7-flash','flash');a.equal(q.view(1,'gemini-3.7-flash','flash').allowed,false);
 q.defer(4,'gemini-4-argon','ultra',Date.now()+60000);a.equal(q.view(4,'gemini-4-argon','ultra').allowed,false);
});
test('request counts per Beijing day, 7 and 30 days with 429',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hist-'));
 const now=Date.UTC(2026,9,15,4,0,0);let t=now;const h=await new RequestHistory(dir,{clock:()=>t}).init();
 const add=async(at,outcome,status)=>{t=at;const id=require('crypto').randomUUID();await h.begin({id,model:'gemini-4-argon',account:3});await h.finish(id,{outcome,httpStatus:status});};
 await add(now-3600000,'success',200);await add(now-3600000,'http_error',429);
 await add(now-13*3600000,'success',200);await add(now-3*86400000,'success',200);await add(now-20*86400000,'success',200);await add(now-40*86400000,'success',200);
 t=now;const c=h.counts().items[0];
 a.deepEqual([c.today.requests,c.week.requests,c.month.requests],[2,4,5]);
 a.equal(c.today.rateLimited,1);a.equal(c.today.success,1);a.ok(c.last429At>0);
});
test('account alias is stored separately from login email and can be cleared',()=>{
 const {dir,tiers}=setup();
 a.deepEqual(tiers.setAlias(2,'  Ultra 主号 '),{id:2,alias:'Ultra 主号'});
 const d=JSON.parse(fs.readFileSync(path.join(dir,'auth-2.json')));a.equal(d.displayName,'Ultra 主号');a.equal(d.accountName,'a2');a.equal(d.cookies.length,1);
 a.deepEqual(tiers.names(2),{alias:'Ultra 主号',accountName:'a2'});
 tiers.setTier(2,'ultra');a.equal(tiers.names(2).alias,'Ultra 主号');
 a.throws(()=>tiers.setAlias(2,'x'.repeat(41)),/40/);
 tiers.setAlias(2,'');a.equal('displayName' in JSON.parse(fs.readFileSync(path.join(dir,'auth-2.json'))),false);
 a.equal((fs.statSync(path.join(dir,'auth-2.json')).mode&0o777),0o600);
});
test('pro and ultra share the premium group; caps differ by class',()=>{
 const {dir,tiers}=setup();tiers.setTier(2,'pro');tiers.setTier(3,'ultra');tiers.setTier(4,'ultra20');
 a.equal(JSON.parse(fs.readFileSync(path.join(dir,'auth-2.json'))).accountTier,'pro');
 a.equal(tiers.isPremium(2),true);a.equal(tiers.isPremium(3),true);a.equal(tiers.isPremium(1),false);a.equal(tiers.isUltra(2),false);
 tiers.setMode({enabled:true,slot:'B'});
 a.equal(tiers.allowed('B',2),true);a.equal(tiers.allowed('B',3),true);a.equal(tiers.allowed('B',1),false);a.equal(tiers.allowed('A',2),false);
 const st=tiers.status([1,2,3,4]);a.deepEqual(st.ultraAccounts,[3,4]);a.deepEqual(st.proAccounts,[2]);a.deepEqual(st.premiumAccounts,[2,3,4]);
 a.throws(()=>tiers.setTier(1,'max'),/standard、pro、ultra 或 ultra20/);
 const q=new ModelQuotaLedger();q.tierOf=id=>tiers.tier(id);
 const cap=(id,m,f)=>q.view(id,m,f).limit;
 for(const [id,argon,flash,pro] of [[1,10,100,10],[2,50,100,50],[3,100,220,100],[4,200,220,200]]){
  a.equal(cap(id,'gemini-4-argon','ultra'),argon);a.equal(cap(id,'gemini-3.8-flash','flash'),flash);a.equal(cap(id,'gemini-3.1-pro-preview','pro'),pro);}
});
test('premium model routing accepts pro and ultra accounts only',()=>{
 const {CatalogRouting}=require('./catalog-routing');
 const {tiers}=setup();tiers.setTier(2,'pro');
 const pool=new AccountPool([1,2,3,4]);pool.slots.set('A',{current:1,pending:null});pool.owners.set(1,'A');pool.slots.set('B',{current:2,pending:null});pool.owners.set(2,'B');
 const d=new DispatchCore(pool,()=>{});for(const id of pool.ids)d.quotas.account(id,true);
 const r=new CatalogRouting(d,{cache:new Map()},{'gemini-4-argon':{quotaFamily:'ultra',antiTruncation:false}});
 r.isUltra=id=>tiers.isUltra(id);r.isPremium=id=>tiers.isPremium(id);r.eligible=()=>true;
 const plan=r.resolve('/v1beta/models/gemini-4-argon:generateContent',{});
 a.equal(plan.eligible('B',2),true);a.equal(plan.eligible('A',1),false);
 tiers.setTier(2,'standard');
 a.throws(()=>r.resolve('/v1beta/models/gemini-4-argon:generateContent',{}),/Pro or Ultra/);
});
test('a queued premium request makes a standard slot rotate to a free pro/ultra account',()=>{
 const {CatalogRouting}=require('./catalog-routing');
 const {tiers}=setup();tiers.setTier(4,'ultra');
 const pool=new AccountPool([1,2,3,4]);pool.slots.set('A',{current:1,pending:null});pool.owners.set(1,'A');pool.slots.set('B',{current:2,pending:null});pool.owners.set(2,'B');
 const d=new DispatchCore(pool,()=>{});for(const id of pool.ids)d.quotas.account(id,true);
 const r=new CatalogRouting(d,{cache:new Map()},{'gemini-4-argon':{quotaFamily:'ultra',antiTruncation:false}});
 r.isUltra=id=>tiers.isUltra(id);r.isPremium=id=>tiers.isPremium(id);
 const plan={model:'gemini-4-argon',quotaFamily:'ultra'};
 a.equal(r.exhausted('B',plan),true);
 d.slots.set('B',{active:0,ready:true});
 const rp=r.rotationPlan('B',[plan]);a.equal(rp?.target,4);
 pool.slots.set('B',{current:4,pending:null});a.equal(r.exhausted('B',plan),false);
});
