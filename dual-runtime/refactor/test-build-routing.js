'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const B=require('./build-routing');
const {periodStart,WINDOW}=require('./model-quota-ledger');
assert.strictEqual(B.parseBuildModel('gemini-4-argon'),null);
assert.deepStrictEqual(B.parseBuildModel('build/gemini-4-argon'),{requested:'build/gemini-4-argon',prefix:'build/',model:'gemini-4-argon',thinking:3,level:'high'});
assert.strictEqual(B.parseBuildModel('build-st/gemini-3.8-flash-low').thinking,1);
assert.strictEqual(B.parseBuildModel('build/gemini-3.8-flash-medium').thinking,2);
assert.throws(()=>B.parseBuildModel('build/gemini-9'),e=>e.statusCode===404);
assert.strictEqual(B.listModels().length,16);
const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'btl-')),'build-tokens.json');
let now=Date.UTC(2026,9,31,8,0,0);
const tiers={31:'ultra',22:'standard',5:'pro'};
let L=new B.BuildTokenLedger(file,{clock:()=>now,tierOf:id=>tiers[id]||'standard'});
// Pro/Ultra: no daily cap, standard: not allowed
assert.strictEqual(L.view(31).limit,null);assert.strictEqual(L.view(31).unlimited,true);assert.strictEqual(L.view(31).allowed,true);
assert.strictEqual(L.view(5).limit,null);assert.strictEqual(L.view(5).allowed,true);
assert.strictEqual(L.view(22).limit,0);assert.strictEqual(L.view(22).allowed,false);
// usage breakdown + per model
L.charge(31,145067,{model:'build/gemini-3.8-flash',input:145000,output:67,cached:9000});
let v=L.view(31);assert.strictEqual(v.used,145067);assert.strictEqual(v.requests,1);assert.strictEqual(v.input,145000);assert.strictEqual(v.output,67);assert.strictEqual(v.cached,9000);
assert.deepStrictEqual(v.models['build/gemini-3.8-flash'],{requests:1,tokens:145067});
// huge usage never blocks an uncapped account
L.charge(31,500000000);assert.strictEqual(L.view(31).allowed,true);assert.strictEqual(L.view(31).remaining,null);
// old 2-arg charge still works
L.charge(5,10);assert.strictEqual(L.view(5).used,10);
// failures + recent log
L.fail(31);assert.strictEqual(L.view(31).failed,1);
for(let i=0;i<60;i++)L.log({at:i,account:31,model:'m',status:200});
assert.strictEqual(L.recent().length,50);assert.strictEqual(L.recent()[0].at,59);
// persisted
L=new B.BuildTokenLedger(file,{clock:()=>now,tierOf:id=>tiers[id]||'standard'});
assert.strictEqual(L.view(31).used,145067+500000000);assert.strictEqual(L.recent().length,50);
// reset at 15:00 Beijing
now=periodStart(now)+WINDOW+1000;v=L.view(31);assert.strictEqual(v.used,0);assert.strictEqual(v.input,0);assert.deepStrictEqual(v.models,{});
// cooldown still respected
L.defer(5,now+60000);assert.strictEqual(L.view(5).allowed,false);now+=61000;assert.strictEqual(L.view(5).allowed,true);
// an explicit cap can still be configured
L=new B.BuildTokenLedger(file,{clock:()=>now,tierOf:id=>tiers[id]||'standard',limits:{pro:1000}});
assert.strictEqual(L.view(5).limit,1000);L.charge(5,1000);assert.strictEqual(L.view(5).allowed,false);
console.log('build-routing: all tests passed');
