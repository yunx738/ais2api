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
// Build channel master switch (enabled): off = no Build requests, no Build models, no provisioning.
test('enabled defaults to true, also without a settings file',()=>{
 const {c,settings,dir}=setup();
 assert.equal(settings.enabled,true);
 assert.equal(c.settings.enabled,true);
 assert.equal(settings.status().enabled,true);
 const bare=new BuildChannel({appsFile:path.join(dir,'a.json'),ledgerFile:path.join(dir,'l2.json'),tierOf:id=>tiers[id]||'standard',isPremium:id=>(tiers[id]||'standard')!=='standard',log:{warn(){},error(){},info(){}}});
 assert.equal(bare.settings.enabled,true);assert.equal(bare.models().length>0,true);
 fs.rmSync(dir,{recursive:true,force:true});
});
test('enabled off is persisted next to premiumOnly and keeps the other value',()=>{
 const {c,settings,dir}=setup(false);
 const st=settings.set({enabled:false});
 assert.deepEqual(st,{premiumOnly:false,enabled:false});
 assert.deepEqual(c.status([]).settings,{premiumOnly:false,enabled:false});
 const raw=fs.readFileSync(path.join(dir,'s.json'),'utf8'),d=JSON.parse(raw);
 assert.deepEqual(d,{premiumOnly:false,enabled:false});
 assert.ok(raw.indexOf('"premiumOnly"')>=0&&raw.indexOf('"premiumOnly"')<raw.indexOf('"enabled"'));
 const again=new BuildSettings(path.join(dir,'s.json'));
 assert.equal(again.enabled,false);assert.equal(again.premiumOnly,false);
 fs.rmSync(dir,{recursive:true,force:true});
});
test('enabled must be a boolean',()=>{
 const {c,settings,dir}=setup();
 assert.throws(()=>settings.set({enabled:'x'}),e=>e.statusCode===400&&e.message==='enabled 必须是 true/false');
 assert.equal(settings.enabled,true);
 assert.throws(()=>c.settings.set({enabled:1}),e=>e.statusCode===400);
 fs.rmSync(dir,{recursive:true,force:true});
});
test('off: Build requests get 503, normal models still route',()=>{
 const {c,settings,dir}=setup();
 settings.set({enabled:false});
 assert.throws(()=>c.resolve('/v1/chat/completions',body('build/gemini-3.8-flash')),e=>e.statusCode===503&&e.message==='Build 通道已关闭，请在管理后台开启后再使用');
 assert.throws(()=>c.resolve('/v1/chat/completions',body('build-st/gemini-4-argon')),e=>e.statusCode===503);
 assert.equal(c.resolve('/v1/chat/completions',body('gemini-3.8-flash')),null);
 fs.rmSync(dir,{recursive:true,force:true});
});
test('off: no Build models listed; back on: listed again',()=>{
 const {c,settings,dir}=setup();
 assert.equal(c.models().length>0,true);
 settings.set({enabled:false});
 assert.deepEqual(c.models(),[]);
 settings.set({enabled:true});
 assert.equal(c.models().length>0,true);
 assert.equal(c.resolve('/v1/chat/completions',body('build/gemini-3.8-flash')).model.startsWith('build-'),true);
 fs.rmSync(dir,{recursive:true,force:true});
});
