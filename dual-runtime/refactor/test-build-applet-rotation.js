'use strict';
const test=require('node:test'),assert=require('node:assert');
const fs=require('fs'),os=require('os'),path=require('path');
const {BuildAppletRotation,createRequest,parseCreated,bjHour}=require('./build-applet-rotation');
const OLD='dacb8258-f919-45b7-892b-ff4d300d45bc',NEW='7f7571f1-071d-451f-b125-784b6d7fdcb0';
const at=h=>Date.UTC(2026,9,31,h-8<0?h+16:h-8,30)-(h-8<0?86400000:0);
function setup(rpc,{now=at(4),slot='B'}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rot-'));
 const appsFile=path.join(dir,'apps.json'),stateFile=path.join(dir,'state.json');
 fs.writeFileSync(appsFile,JSON.stringify({32:OLD}));
 const calls=[];
 const r=new BuildAppletRotation({appsFile,stateFile,now:()=>now,log:{log(){}},slotOf:id=>id===32?slot:null,
  rpc:async(s,m,req)=>{calls.push([s,m,req]);return rpc(m,req);}});
 return {r,calls,apps:()=>JSON.parse(fs.readFileSync(appsFile,'utf8')),state:()=>JSON.parse(fs.readFileSync(stateFile,'utf8'))};
}
const ok=m=>m==='CreateApplet'?{status:200,text:JSON.stringify([NEW,[NEW]])}:{status:200,text:'[]'};
test('Beijing hour helper',()=>{assert.strictEqual(bjHour(at(4)),4);assert.strictEqual(bjHour(at(23)),23);});
test('create request is a minimal private applet',()=>{
 const b=createRequest();assert.strictEqual(b[1][0],'GW Text Bridge');
 const names=b[3][1].map(f=>f[0]);assert.deepStrictEqual(names,['metadata.json','index.html']);
 assert.strictEqual(parseCreated({status:200,text:JSON.stringify([NEW])}),NEW);
 assert.strictEqual(parseCreated({status:200,text:'["x"]'}),null);assert.strictEqual(parseCreated({status:409}),null);
});
test('outside the night window nothing happens',async()=>{
 const t=setup(ok,{now:at(15)});assert.deepStrictEqual(await t.r.tick(),{skipped:'window'});assert.strictEqual(t.calls.length,0);
});
test('rotates: create, switch, delete old',async()=>{
 const t=setup(ok);const r=await t.r.tick();
 assert.strictEqual(r[32],'rotated');assert.strictEqual(t.apps()[32],NEW);
 assert.deepStrictEqual(t.calls.map(c=>c[1]),['CreateApplet','DeleteApplet']);
 assert.deepStrictEqual(t.calls[1][2],[OLD]);assert.strictEqual(t.calls[0][0],'B');
 assert.strictEqual((await t.r.tick())[32],'recent');
});
test('failed create keeps the current applet',async()=>{
 const t=setup(m=>m==='CreateApplet'?{status:409}:{status:200,text:'[]'});
 assert.strictEqual((await t.r.tick())[32],'create_failed');assert.strictEqual(t.apps()[32],OLD);
});
test('busy worker (409) leaves the old applet queued and retries the delete later',async()=>{
 let busy=true;
 const t=setup(async m=>{if(m==='CreateApplet')return ok(m);if(busy)throw Error('worker 409 busy');return {status:200,text:'[]'};});
 assert.strictEqual((await t.r.tick())[32],'rotated_delete_pending');
 assert.strictEqual(t.apps()[32],NEW);assert.deepStrictEqual(t.state().accounts[32].pendingDelete,[OLD]);
 busy=false;assert.strictEqual((await t.r.tick())[32],'recent');
 assert.deepStrictEqual(t.state().accounts[32].pendingDelete,[]);
 assert.deepStrictEqual(t.calls.at(-1).slice(1),['DeleteApplet',[OLD]]);
});
test('account not online is skipped',async()=>{
 const t=setup(ok,{slot:null});assert.strictEqual((await t.r.tick())[32],'offline');assert.strictEqual(t.calls.length,0);
});
