'use strict';
// build-st/: plugin envelope only (no gateway splitting). bridge/ and build/: presets applied, files dropped.
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {BuildChannel}=require('./build-coordinator');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bps-'));
const appsFile=path.join(dir,'build-apps.json'),ledgerFile=path.join(dir,'build-tokens.json');
fs.writeFileSync(appsFile,JSON.stringify({31:'d5df4c44-02ed-4b2f-b71a-34fbc28e8861'}));
let applied=0;
const presets={apply(){applied++;return {content:'BUILD_ST_CONTEXT_V1\n{}'};},list(){return [];}};
const ch=new BuildChannel({appsFile,ledgerFile,tierOf:()=>'ultra',isPremium:()=>true,presets,log:{error(){},warn(){},info(){},log(){}}});
const body=o=>Buffer.from(JSON.stringify(o));
const msgs=[{role:'system',content:'preset text here'},{role:'user',content:'hi'}];
(async()=>{
 let sent;const fwd=ch.wrapForward(async(t,r,b)=>{sent=JSON.parse(b.toString());return {status:200};});
 // build-st/ without plugin envelope: rejected, nothing forwarded
 sent=null;const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(b){this.body=b;}};
 const r=await fwd({id:'a',account:31},'/v1/chat/completions',body({model:'build-st/gemini-4-argon-low',messages:msgs}),res,{});
 assert.strictEqual(r.status,400);assert.strictEqual(sent,null);assert.match(res.body,/build_st_plugin_required/);assert.strictEqual(applied,0);
 // build-st/ with plugin envelope: forwarded untouched, presets not applied
 const env=[{role:'user',content:'BUILD_ST_CONTEXT_V1\n{"version":1,"segments":[]}'}];
 await fwd({id:'a2',account:31},'/v1/chat/completions',body({model:'build-st/gemini-4-argon-low',messages:env}),{},{});
 assert.strictEqual(applied,0);assert.deepStrictEqual(sent.messages,env);
 for(const [i,m] of ['bridge/gemini-4-argon-low','build/gemini-4-argon-low'].entries()){
  await fwd({id:'b'+i,account:31},'/v1/chat/completions',body({model:m,messages:msgs}),{},{});
  assert.strictEqual(applied,i+1);assert.strictEqual(sent.__build.keepMedia,undefined);
  assert.ok(sent.messages[0].content.startsWith('BUILD_ST_CONTEXT_V1'));
 }
 console.log('ok build-prefix-swap');
})().catch(e=>{console.error(e);process.exit(1);});
