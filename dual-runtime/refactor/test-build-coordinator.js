'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {BuildChannel}=require('./build-coordinator');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bc-'));
const appsFile=path.join(dir,'build-apps.json'),ledgerFile=path.join(dir,'build-tokens.json');
const APP='d5df4c44-02ed-4b2f-b71a-34fbc28e8861';
const tiers={31:'ultra',22:'standard'};
const ch=new BuildChannel({appsFile,ledgerFile,tierOf:id=>tiers[id]||'standard',isPremium:id=>(tiers[id]||'standard')!=='standard'});
const body=o=>Buffer.from(JSON.stringify(o));
(async()=>{
 // non-Build model -> null (normal routing)
 assert.strictEqual(ch.resolve('/v1/chat/completions',body({model:'gemini-4-argon',messages:[]})),null);
 // no project configured -> 503
 assert.throws(()=>ch.resolve('/v1/chat/completions',body({model:'build/gemini-4-argon',messages:[{role:'user',content:'x'}]})),e=>e.statusCode===503);
 fs.writeFileSync(appsFile,JSON.stringify({31:APP,22:APP}));
 // native route rejected
 assert.throws(()=>ch.resolve('/v1beta/models/x:generateContent',body({model:'build/gemini-4-argon'})),e=>e.statusCode===400);
 const plan=ch.resolve('/v1/chat/completions',body({model:'build/gemini-4-argon-low',messages:[{role:'user',content:'hello world'}]}));
 assert.strictEqual(plan.quotaFamily,'ultra');assert.strictEqual(plan.build.thinking,1);
 assert.strictEqual(plan.eligible('A',31),true);assert.strictEqual(plan.eligible('A',22),false);   // free accounts: flash models only
 assert.strictEqual(ch.resolve('/v1/chat/completions',body({model:'build/gemini-3.8-flash',messages:[{role:'user',content:'x'}]})).eligible('A',22),true);
 // admission reserves; forward adds __build and charges usage
 const id='11111111-1111-1111-1111-111111111111';
 assert.strictEqual(plan.admit(31,id),true);assert.ok(ch.ledger.view(31).reserved>0);
 let sent;
 const fwd=ch.wrapForward(async(t,r,b)=>{sent=JSON.parse(b.toString());return {status:200,metrics:{usage:{input:145021,output:46,total:145067}}};});
 await fwd({id,account:31,slot:'B'},'/v1/chat/completions',body({model:'build/gemini-4-argon-low',messages:[{role:'user',content:'hello world'}]}),{},{});
 assert.deepStrictEqual(sent.__build,{app:APP,model:'gemini-4-argon',thinking:1});
 assert.strictEqual(ch.ledger.view(31).used,145067);assert.strictEqual(ch.ledger.view(31).reserved,0);
 // non-Build requests pass straight through, untouched
 let passed;const fwd2=ch.wrapForward(async(t,r,b)=>{passed=b;return {status:200};});
 const plain=body({model:'gemini-4-argon',messages:[]});await fwd2({id,account:31},'/v1/chat/completions',plain,{},{});assert.strictEqual(passed,plain);
 // 429 -> account cooled down for Build
 const id2='22222222-2222-2222-2222-222222222222';plan.admit(31,id2);
 await ch.wrapForward(async()=>({status:429}))({id:id2,account:31},'/v1/chat/completions',body({model:'build/gemini-4-argon',messages:[]}),{},{});
 assert.strictEqual(ch.ledger.view(31).allowed,false);assert.strictEqual(plan.eligible('A',31),false);
 // free account still serves while #31 cools down
 assert.ok(ch.resolve('/v1/chat/completions',body({model:'build/gemini-4-argon',messages:[{role:'user',content:'x'}]})));
 ch.ledger.defer(22,Date.now()+60000);
 // all exhausted -> 429 with reset hint at resolve time
 assert.throws(()=>ch.resolve('/v1/chat/completions',body({model:'build/gemini-4-argon',messages:[{role:'user',content:'x'}]})),e=>e.statusCode===429&&e.retryAfter>0);
 // queued requests are still admitted while unavailable (allowUnavailable)
 assert.ok(ch.resolve('/v1/chat/completions',body({model:'build/gemini-4-argon',messages:[{role:'user',content:'x'}]}),{allowUnavailable:true}));
 assert.strictEqual(ch.models().length,16);
 console.log('build-coordinator: all tests passed');
})().catch(e=>{console.error(e);process.exit(1);});
// 403 for a model -> that account skips that model only
;(async()=>{
 const fs2=require('fs'),os2=require('os'),p2=require('path'),{BuildChannel:BC}=require('./build-coordinator');
 const d=fs2.mkdtempSync(p2.join(os2.tmpdir(),'bc-'));fs2.writeFileSync(p2.join(d,'a.json'),JSON.stringify({23:'d5df4c44-02ed-4b2f-b71a-34fbc28e8861',32:'d5df4c44-02ed-4b2f-b71a-34fbc28e8862'}));
 const c=new BC({appsFile:p2.join(d,'a.json'),ledgerFile:p2.join(d,'t.json'),tierOf:()=>'ultra',isPremium:()=>true,log:{warn(){},error(){}}});
 const b=o=>Buffer.from(JSON.stringify(o)),m=[{role:'user',content:'x'}];
 const pa=c.resolve('/v1/chat/completions',b({model:'build/gemini-4-argon',messages:m}));
 await c.wrapForward(async()=>({status:403}))({id:'x',account:23},'/v1/chat/completions',b({model:'build/gemini-4-argon',messages:m}),{},{});
 require('assert').strictEqual(pa.eligible('A',23),false);require('assert').strictEqual(pa.eligible('B',32),true);
 const pf=c.resolve('/v1/chat/completions',b({model:'build/gemini-3.8-flash',messages:m}));require('assert').strictEqual(pf.eligible('A',23),true);
 require('assert').deepStrictEqual(c.status().accounts.find(a=>a.account===23).deniedModels,['gemini-4-argon']);
 fs2.rmSync(d,{recursive:true,force:true});console.log('build-coordinator: 403 per-model skip ok');
})();
// Free accounts: flash only; Pro/Ultra: everything
;(()=>{
 const fs3=require('fs'),os3=require('os'),p3=require('path'),A=require('assert'),{BuildChannel:BC}=require('./build-coordinator');
 const d=fs3.mkdtempSync(p3.join(os3.tmpdir(),'bc-'));fs3.writeFileSync(p3.join(d,'a.json'),JSON.stringify({23:'d5df4c44-02ed-4b2f-b71a-34fbc28e8861',32:'d5df4c44-02ed-4b2f-b71a-34fbc28e8862'}));
 const t={23:'standard',32:'ultra'};
 const c=new BC({appsFile:p3.join(d,'a.json'),ledgerFile:p3.join(d,'t.json'),tierOf:id=>t[id],isPremium:id=>t[id]!=='standard',log:{warn(){},error(){}}});
 const b=o=>Buffer.from(JSON.stringify(o)),m=[{role:'user',content:'x'}];
 const pa=c.resolve('/v1/chat/completions',b({model:'build/gemini-4-argon',messages:m}));A.strictEqual(pa.eligible('A',23),false);A.strictEqual(pa.eligible('B',32),true);
 const pf=c.resolve('/v1/chat/completions',b({model:'build/gemini-3.8-flash-low',messages:m}));A.strictEqual(pf.eligible('A',23),true);A.strictEqual(pf.eligible('B',32),true);
 fs3.writeFileSync(p3.join(d,'a.json'),JSON.stringify({23:'d5df4c44-02ed-4b2f-b71a-34fbc28e8861'}));
 A.throws(()=>c.resolve('/v1/chat/completions',b({model:'build/gemini-4-argon',messages:m})),e=>e.statusCode===403&&/flash/.test(e.message));
 A.ok(c.resolve('/v1/chat/completions',b({model:'build-st/gemini-3.8-flash',messages:m})));
 fs3.rmSync(d,{recursive:true,force:true});console.log('build-coordinator: free=flash only ok');
})();
