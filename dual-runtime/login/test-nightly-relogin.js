'use strict';
const a=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {NightlyRelogin,registered}=require('./nightly-relogin');
const reg=registered(),emails=Object.keys(reg);
a.ok(emails.length===10,'10 registered accounts');
a.ok(emails.every(e=>reg[e].password&&reg[e].totp),'every account has password and TOTP');
function setup(){
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'nr-')),'s.json');
 let t=new Date(2026,9,25,0,0,30).getTime();
 const accts=[{id:22,authStatus:'invalid',invalidReason:'login_required',owner:null,invalidSlot:'A'},
  {id:23,authStatus:'invalid',invalidReason:'login_required',owner:null},
  {id:27,authStatus:'unknown',owner:'A'},{id:31,authStatus:'invalid',invalidReason:'login_required',owner:null}];
 const map={22:emails[2],23:emails[3],27:emails[7],31:'导入账号 31'};
 const started=[],logs=[];let outcome='done';
 fs.writeFileSync(file,JSON.stringify({scanDay:'2026-10-24',scanAt:t-3600000}));
 const n=new NightlyRelogin({file,coord:async()=>({status:200,body:{accounts:accts}}),busy:()=>false,memOk:()=>true,
  emailOf:id=>map[id],failedSlot:async()=>'B',now:()=>t,log:m=>logs.push(m),cancel:j=>{j.status='failed';},
  startJob:(email,pw,o)=>{const j={target:o.target,status:'running'};started.push({email,o});
   setTimeout(()=>{if(outcome==='need'){j.status='need';j.need={kind:'phone'};}else{j.status=outcome;j.message=outcome==='failed'?'密码错误':'已重新登录';
    if(outcome==='done')Object.assign(accts.find(x=>x.id===o.target),{authStatus:'unknown',invalidReason:undefined});}},10);return j;}});
 return {n,accts,started,logs,set:o=>{outcome=o;},adv:ms=>{t+=ms;},file};
}
(async()=>{
 // midnight scan queues only invalid auto-registered accounts; one login, then 20-minute gap
 {const s=setup();await s.n.tick();
  a.deepStrictEqual(s.started.map(x=>x.o.target),[22]);
  a.strictEqual(s.started[0].o.slot,'A');a.ok(s.started[0].o.totp,'TOTP passed');
  a.deepStrictEqual(s.n.status().queue,[23]);
  a.ok(s.started[0].o.noLease,'never pauses a worker');
  s.adv(30000);await s.n.tick();a.strictEqual(s.started.length,2,'no pacing: next account right away');
  a.strictEqual(s.started[1].o.slot,'B','falls back to the worker of the last retired container');
  console.log('ok scan + no pacing + same worker network + no lease');}
 // failure: held, never retried automatically, not even at next midnight; operator retry runs once
 {const s=setup();s.set('failed');await s.n.tick();
  a.ok(s.n.status().held[22]&&s.n.status().held[22].message==='密码错误');
  s.adv(20*60000);await s.n.tick();s.adv(20*60000);await s.n.tick();
  a.deepStrictEqual(s.started.map(x=>x.o.target),[22,23],'22 not retried');
  s.adv(24*3600000);await s.n.tick();s.adv(20*60000);await s.n.tick();
  a.strictEqual(s.started.length,2,'held accounts skipped at next midnight too');
  s.set('done');s.n.retry(22);await s.n.tick();
  a.strictEqual(s.started.length,3);a.strictEqual(s.started[2].o.target,22);
  a.ok(!s.n.status().held[22]);
  console.log('ok failure holds until operator retry');}
 // verification request: cancelled and held as needs_verification
 {const s=setup();s.set('need');await s.n.tick();
  a.strictEqual(s.n.status().held[22].result,'needs_verification');console.log('ok verification is not answered automatically');}
 // deleted account: held entry removed
 {const s=setup();s.set('failed');await s.n.tick();s.accts.splice(0,1);s.adv(60000);await s.n.tick();
  a.ok(!s.n.status().held[22],'deleted account forgotten');console.log('ok deleted account cleared');}
 // first start mid-day: existing failures wait for midnight; a fresh failure during switching is queued now
 {const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'nr-')),'s.json');let t=new Date(2026,9,24,22,10).getTime();const st=[];
  const accts=[{id:22,authStatus:'invalid',invalidReason:'login_required',owner:null,invalidAt:t-3*3600000}];
  const n=new NightlyRelogin({file,coord:async()=>({status:200,body:{accounts:accts}}),busy:()=>false,memOk:()=>true,emailOf:id=>({22:emails[2],23:emails[3]})[id],now:()=>t,log:()=>{},cancel:()=>{},
   startJob:(e,p,o)=>{st.push(o.target);return {status:'done'};}});
  await n.tick();a.deepStrictEqual(st,[22],'existing failure relogged right away');
  t+=30000;await n.tick();a.deepStrictEqual(st,[22],'just-relogged account still flagged is not looped');
  t+=30000;accts.push({id:23,authStatus:'invalid',invalidReason:'login_required',owner:null,invalidAt:t,invalidSlot:'A'});
  await n.tick();a.deepStrictEqual(st,[22,23],'fresh failure relogged');
  t+=31*60000;await n.tick();a.deepStrictEqual(st,[22,23,22],'retried after the recent-ok window');
  console.log('ok immediate relogin, no loop on recent ok');}
 // old held entries caused by worker pausing are dropped on load and relogged
 {const s=setup();fs.writeFileSync(s.file,JSON.stringify({scanDay:'2026-10-25',scanAt:0,held:{22:{at:1,result:'failed',message:'等待请求结束超时'}}}));
  const m=new NightlyRelogin({file:s.file,coord:async()=>({status:200,body:{accounts:s.accts}}),busy:()=>false,memOk:()=>true,emailOf:()=>'',log:()=>{}});
  a.ok(!m.status().held[22]);console.log('ok lease-timeout hold cleared');}
// state survives restart
 {const s=setup();s.set('failed');await s.n.tick();
  const m=new NightlyRelogin({file:s.file,coord:async()=>({status:200,body:{accounts:s.accts}}),busy:()=>false,memOk:()=>true,emailOf:()=>'',log:()=>{}});
  a.ok(m.status().held[22]);console.log('ok persisted');}
})().catch(e=>{console.error(e);process.exit(1);});
