'use strict';
// Build "Pro/Ultra only" switch: on = no Build model (flash included) goes to Free accounts, no Free-first rank.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {BuildChannel,BuildSettings}=require('./build-coordinator');
const tiers={23:'standard',32:'ultra',40:'pro'};
function setup(premiumOnly){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bpo-'));
 fs.writeFileSync(path.join(dir,'a.json'),JSON.stringify({23:'d5df4c44-02ed-4b2f-b71a-34fbc28e8861',32:'d5df4c44-02ed-4b2f-b71a-34fbc28e8862',40:'d5df4c44-02ed-4b2f-b71a-34fbc28e8863'}));
 const settings=new BuildSettings(path.join(dir,'s.json'));if(premiumOnly!==undefined)settings.set({premiumOnly});
 const c=new BuildChannel({appsFile:path.join(dir,'a.json'),ledgerFile:path.join(dir,'l.json'),tierOf:id=>tiers[id]||'standard',isPremium:id=>(tiers[id]||'standard')!=='standard',settings,log:{warn(){},error(){},info(){}}});
 return {c,settings,dir};
}
const body=m=>JSON.stringify({model:m,messages:[{role:'user',content:'hi'}]});
test('default is on: flash skips Free accounts, no Free-first rank',()=>{
 const {c,dir}=setup();
 const p=c.resolve('/v1/chat/completions',body('build/gemini-3.8-flash-low'));
 assert.equal(p.eligible('A',23),false);assert.equal(p.eligible('B',32),true);assert.equal(p.eligible('B',40),true);
 assert.equal(p.rank,undefined);
 assert.equal(c.status([]).settings.premiumOnly,true);
 fs.rmSync(dir,{recursive:true,force:true});
});
test('off: old behaviour (flash on Free first, pro models Pro/Ultra only)',()=>{
 const {c,dir}=setup(false);
 const f=c.resolve('/v1/chat/completions',body('build/gemini-3.8-flash'));
 assert.equal(f.eligible('A',23),true);assert.equal(typeof f.rank,'function');assert.equal(f.rank('A',23),0);assert.equal(f.rank('B',32),1);
 const a=c.resolve('/v1/chat/completions',body('build/gemini-4-argon'));
 assert.equal(a.eligible('A',23),false);assert.equal(a.eligible('B',32),true);
 fs.rmSync(dir,{recursive:true,force:true});
});
test('switch applies to the next request without restart and is persisted',()=>{
 const {c,settings,dir}=setup(false);
 assert.equal(c.resolve('/v1/chat/completions',body('build/gemini-3.8-flash')).eligible('A',23),true);
 settings.set({premiumOnly:true});
 assert.equal(c.resolve('/v1/chat/completions',body('build/gemini-3.8-flash')).eligible('A',23),false);
 assert.equal(new BuildSettings(path.join(dir,'s.json')).premiumOnly,true);
 assert.throws(()=>settings.set({premiumOnly:'yes'}),e=>e.statusCode===400);
 fs.rmSync(dir,{recursive:true,force:true});
});
test('on with only Free accounts: clear 403 instead of queueing forever',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bpo-'));
 fs.writeFileSync(path.join(dir,'a.json'),JSON.stringify({23:'d5df4c44-02ed-4b2f-b71a-34fbc28e8861'}));
 const c=new BuildChannel({appsFile:path.join(dir,'a.json'),ledgerFile:path.join(dir,'l.json'),tierOf:()=>'standard',isPremium:()=>false,settings:new BuildSettings(path.join(dir,'s.json')),log:{warn(){},error(){},info(){}}});
 assert.throws(()=>c.resolve('/v1/chat/completions',body('build/gemini-3.8-flash')),e=>e.statusCode===403&&/只用 Pro\/Ultra/.test(e.message));
 fs.rmSync(dir,{recursive:true,force:true});
});
