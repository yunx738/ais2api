'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const R=require('./build-response');
const fx=n=>fs.readFileSync(path.join(__dirname,'fixtures','build',n),'utf8');
let r=R.parse(fx('fx-flash-text.txt'));
assert.strictEqual(r.ok,true);assert.strictEqual(r.text,'PONG 42');assert.strictEqual(r.model,'gemini-3.8-flash');
assert.deepStrictEqual(r.usage,{uncached:127838,output:46,cached:17183});assert.strictEqual(r.complete,true);
r=R.parse(fx('fx-argon-high.txt'));assert.strictEqual(r.text,'391');assert.strictEqual(r.model,'gemini-4-argon');
r=R.parse(fx('fx-flash-attach.txt'));assert.strictEqual(r.text,'PELICAN');
assert.deepStrictEqual(R.openaiUsage({uncached:10,output:5,cached:3}),{prompt_tokens:13,completion_tokens:5,total_tokens:18,prompt_tokens_details:{cached_tokens:3}});
// thought parts (part[12]===1) are separated from the answer; last model turn wins
const turn=(parts,usage)=>[[[parts,'model']],null,null,null,null,null,null,null,null,null,null,1,1,'models/gemini-4-argon',null,usage,'t'];
const raw=JSON.stringify([[[null,null,[turn([[null,'thinking...',null,null,null,null,null,null,null,null,null,null,1]],null)],'app'],[null,null,[turn([[null,'plan',null,null,null,null,null,null,null,null,null,null,1],[null,'Hello'],[null,' world']],['1','2','3'])],'app']]]);
r=R.parse(raw);assert.strictEqual(r.text,'Hello world');assert.strictEqual(r.thought,'plan');assert.deepStrictEqual(r.usage,{uncached:1,output:2,cached:3});
// incomplete (no usage yet) is reported
r=R.parse(JSON.stringify([[[null,null,[turn([[null,'Hel']],null)],'app']]]));assert.strictEqual(r.complete,false);assert.strictEqual(r.text,'Hel');
// errors
assert.strictEqual(R.parse('not json').ok,false);
r=R.parse('[7,"The caller does not have permission"]');assert.strictEqual(r.ok,false);assert.match(r.error,/permission/);
console.log('build-response: all tests passed');
// regression: usage with only two fields (no cache hit) must still count as complete
{const r2=R.parse(fx('fx-usage-two-fields.txt'));assert.strictEqual(r2.complete,true);assert.deepStrictEqual(r2.usage,{uncached:34646,output:120,cached:0});assert.ok(r2.text.startsWith('它叫'));
 assert.deepStrictEqual(R.openaiUsage(r2.usage),{prompt_tokens:34646,completion_tokens:120,total_tokens:34766,prompt_tokens_details:{cached_tokens:0}});
 console.log('build-response: two-field usage regression passed');}
