'use strict';
// bridge/ skips server-side preset splitting; build-st/ still uses it.
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {BuildChannel}=require('./build-coordinator');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bnp-'));
const appsFile=path.join(dir,'build-apps.json'),ledgerFile=path.join(dir,'build-tokens.json');
fs.writeFileSync(appsFile,JSON.stringify({31:'d5df4c44-02ed-4b2f-b71a-34fbc28e8861'}));
let applied=0;
const presets={apply(){applied++;return {content:'BUILD_ST_CONTEXT_V1\n{}'};},list(){return [];}};
const ch=new BuildChannel({appsFile,ledgerFile,tierOf:()=>'ultra',isPremium:()=>true,presets,log:{error(){},warn(){},info(){},log(){}}});
const body=o=>Buffer.from(JSON.stringify(o));
const msgs=[{role:'system',content:'preset text here'},{role:'user',content:'hi'}];
(async()=>{
 let sent;const fwd=ch.wrapForward(async(t,r,b)=>{sent=JSON.parse(b.toString());return {status:200};});
 await fwd({id:'a',account:31},'/v1/chat/completions',body({model:'bridge/gemini-4-argon-low',messages:msgs}),{},{});
 assert.strictEqual(applied,0);assert.deepStrictEqual(sent.messages,msgs);assert.strictEqual(sent.__build.keepMedia,true);
 await fwd({id:'b',account:31},'/v1/chat/completions',body({model:'build-st/gemini-4-argon-low',messages:msgs}),{},{});
 assert.strictEqual(applied,1);assert.strictEqual(sent.messages.length,1);assert.ok(sent.messages[0].content.startsWith('BUILD_ST_CONTEXT_V1'));
 console.log('ok bridge-no-preset');
})().catch(e=>{console.error(e);process.exit(1);});
