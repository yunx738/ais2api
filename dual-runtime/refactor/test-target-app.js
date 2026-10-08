'use strict';
const test=require('node:test'),assert=require('node:assert'),fs=require('fs'),os=require('os'),path=require('path');
const {TargetApp,parse}=require('./target-app');
const {select,ORIGINAL}=require('./verified-client-route');
const ID='0f0e7b4c-1111-4222-8333-944455556666';
function root(){const r=fs.mkdtempSync(path.join(os.tmpdir(),'ta-'));
 for(const s of ['A','B']){fs.mkdirSync(path.join(r,'slots',s),{recursive:true});fs.writeFileSync(path.join(r,'slots',s,'worker.env'),'API_KEYS=k\nTARGET_URL=\nPORT=7860\n');}return r;}
test('parse accepts ai.studio links and bare ids only',()=>{
 assert.equal(parse('https://ai.studio/apps/'+ID),ID);
 assert.equal(parse('https://aistudio.google.com/apps/drive/'+ID+'?x=1'),ID);
 assert.equal(parse(ID.toUpperCase()),ID);
 for(const bad of ['http://ai.studio/apps/'+ID,'https://evil.com/apps/'+ID,'https://ai.studio/apps/'+ID+'/../x','x\nTARGET_URL=evil',''])assert.equal(parse(bad),null);
});
test('save writes both slots, keeps other keys, mode 600',()=>{
 const r=root(),t=new TargetApp({root:r,rotate:async()=>{},isBusy:()=>false});
 assert.equal(t.status().configured,false);
 assert.throws(()=>t.save({url:'nope'}),/格式/);
 const s=t.save({url:'https://ai.studio/apps/'+ID});
 assert.equal(s.appId,ID);assert.ok(s.consistent);
 for(const x of ['A','B']){const f=path.join(r,'slots',x,'worker.env'),c=fs.readFileSync(f,'utf8');
  assert.match(c,/^API_KEYS=k$/m);assert.match(c,/^PORT=7860$/m);assert.equal(c.match(/^TARGET_URL=/gm).length,1);
  assert.equal(fs.statSync(f).mode&0o777,0o600);}
});
test('apply rotates idle slots and skips busy ones',async()=>{
 const r=root(),calls=[],t=new TargetApp({root:r,rotate:async s=>{calls.push(s);},isBusy:s=>s==='B'});
 assert.throws(()=>t.apply(),/先保存/);
 t.save({url:ID});t.apply();
 for(let i=0;i<50&&t.applying;i++)await new Promise(x=>setTimeout(x,10));
 assert.deepEqual(calls,['A']);assert.deepEqual(t.lastApply.result,{A:'ok',B:'skipped'});
});
test('client route matches any app host by script hash',()=>{
 assert.equal(select(Buffer.from('not the script'),fs.readFileSync(path.join(__dirname,'black-browser.js'),'utf8'),ORIGINAL),null);
});
