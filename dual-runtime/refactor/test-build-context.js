'use strict';
const assert=require('assert');
const C=require('./build-context');
const dec=p=>JSON.parse(Buffer.from(p[0][2][1],'base64').toString('utf8'));
// 1 classification of a typical SillyTavern request
let r=C.prepare([{role:'system',content:'主提示词'},{role:'system',content:'角色描述'.repeat(1500)},{role:'system',name:'example_user',content:'示例'},
 {role:'user',content:'第一句'},{role:'assistant',content:'回复一'},{role:'system',content:'[作者注释]'},{role:'user',content:'第二句'},{role:'system',content:'破限'}]);
assert.deepStrictEqual(r.segments.map(x=>x.placement),['inline','file','file','file','file','file','inline','inline']);
assert.strictEqual(r.generationType,'normal');
// 2 pack: attachment holds file text, composer holds inline text in order
let k=C.pack(r,{nonce:'a'.repeat(24),requestedMaxOutputTokens:800});
assert.strictEqual(k.mode,'attachment');assert.strictEqual(k.parts.length,2);
assert.strictEqual(k.parts[0][2][0],'text/plain');
const f=dec(k.parts);
assert.strictEqual(f.segments.length,8);
assert.strictEqual(f.segments[1].text,'角色描述'.repeat(1500));
assert.strictEqual(f.segments[0].text,undefined);
const prompt=k.parts[1][1];
assert.ok(prompt.indexOf('主提示词')<prompt.indexOf('[CONTEXT segments 2..6')&&prompt.indexOf('[CONTEXT segments 2..6')<prompt.indexOf('第二句')&&prompt.indexOf('第二句')<prompt.indexOf('破限'));
assert.ok(prompt.includes('Requested output limit: 800'));
assert.ok(!prompt.includes('角色描述'));
assert.strictEqual(k.hashText,k.parts[0][2][1]+' '+prompt);
// 3 single user message: no attachment
k=C.pack(C.prepare([{role:'user',content:'hi'}]));
assert.strictEqual(k.mode,'inline');assert.strictEqual(k.parts.length,1);assert.ok(k.parts[0][1].includes('hi'));
// 4 continue
r=C.prepare([{role:'user',content:'讲个故事'},{role:'assistant',content:'从前'}]);
assert.strictEqual(r.generationType,'continue');
assert.ok(C.pack(r).parts[1][1].includes('Continue the final assistant message'));
// 5 manual tags
r=C.prepare([{role:'system',content:'[[file]]短设定'},{role:'system',content:'[[inline]]'+'长指令'.repeat(3000)},{role:'user',content:'go'}]);
assert.deepStrictEqual(r.segments.map(x=>x.placement),['file','inline','inline']);
assert.strictEqual(r.segments[0].text,'短设定');
// 6 inline overflow moves earliest presets to file, never truncates
r=C.prepare([{role:'system',content:'[[inline]]'+'甲'.repeat(30000)},{role:'system',content:'[[inline]]'+'乙'.repeat(30000)},{role:'user',content:'go'}]);
assert.deepStrictEqual(r.segments.map(x=>x.placement),['file','inline','inline']);
assert.ok(r.segments[0].source.endsWith('+overflow'));
// 7 oversize -> 413 before any upstream call
assert.throws(()=>C.pack(C.prepare([{role:'system',content:'x'.repeat(260000)},{role:'user',content:'go'}])),e=>e.statusCode===413&&e.code==='context_too_large');
// 8 current user message alone too large
assert.throws(()=>C.prepare([{role:'user',content:'字'.repeat(50000)}]),e=>e.statusCode===413);
// 9 extension envelope honoured as-is
const env=C.WIRE_PREFIX+JSON.stringify({version:1,generationType:'swipe',segments:[{message:0,part:0,role:'system',source:'main',placement:'inline',text:'P'},{message:1,part:0,role:'user',source:'chatHistory',placement:'file',text:'H'}]});
r=C.prepare([{role:'user',content:env}]);
assert.strictEqual(r.generationType,'swipe');assert.deepStrictEqual(r.segments.map(x=>x.placement),['inline','file']);
assert.throws(()=>C.prepare([{role:'user',content:C.WIRE_PREFIX+'{bad'}]),e=>e.statusCode===400);
// 10 rejects tools / non-text
assert.throws(()=>C.prepare([{role:'user',content:[{type:'image_url',image_url:{url:'x'}}]}]),e=>e.statusCode===400);
assert.throws(()=>C.prepare([{role:'tool',content:'x'}]),e=>e.statusCode===400);
console.log('build-context: all tests passed');
