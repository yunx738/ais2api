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
// Unsupported content is dropped, not rejected
{
 const p=C.prepare([{role:'system',content:'sys'},{role:'user',content:[{type:'text',text:'看图'},{type:'image_url',image_url:{url:'data:x'}}]}]);
 assert.strictEqual(p.segments.length,2);assert.strictEqual(p.segments[1].text,'看图');assert.strictEqual(p.dropped.parts,1);
 assert.strictEqual(p.segments[1].source,'currentUser');
}
{
 const p=C.prepare([{role:'user',content:'查天气'},{role:'assistant',content:null,tool_calls:[{id:'1',type:'function',function:{name:'w',arguments:'{}'}}]},{role:'tool',tool_call_id:'1',content:'晴'},{role:'user',content:'谢谢'}]);
 assert.deepStrictEqual(p.segments.map(x=>x.text),['查天气','谢谢']);
 assert.strictEqual(p.dropped.toolCalls,1);assert.strictEqual(p.dropped.messages,2);
 assert.strictEqual(p.generationType,'normal');assert.strictEqual(p.segments[1].placement,'inline');
}
{
 // assistant with text and tool_calls keeps its text; a trailing assistant still means continue
 const p=C.prepare([{role:'user',content:'a'},{role:'assistant',content:'部分',tool_calls:[{id:'1'}]},{role:'function',content:'x'}]);
 assert.strictEqual(p.generationType,'continue');assert.strictEqual(p.segments.length,2);
}
{
 const p=C.prepare([{role:'user',content:[{type:'input_audio',input_audio:{}},{type:'text',text:'hi'},'raw']}]);
 assert.strictEqual(p.segments[0].text,'hi\nraw');assert.strictEqual(p.dropped.parts,1);
}
assert.strictEqual(C.prepare([{role:'user',content:'x'}]).dropped.parts,0);
// nothing left after filtering -> clear 400
assert.throws(()=>C.prepare([{role:'user',content:[{type:'image_url',image_url:{url:'x'}}]}]),e=>e.statusCode===400&&/文字内容/.test(e.message));
assert.throws(()=>C.prepare([{role:'tool',content:'x'}]),e=>e.statusCode===400);
// plugin refused locally: clear message, no forwarding
assert.throws(()=>C.prepare([{role:'user',content:C.WIRE_PREFIX+JSON.stringify({version:1,error:'text_only'})}]),e=>e.statusCode===400&&e.code==='build_plugin_refused'&&/图片/.test(e.message));
// plugin envelope: placements are used exactly as sent
{
 const env=C.WIRE_PREFIX+JSON.stringify({version:1,generationType:'swipe',segments:[{role:'system',placement:'inline',source:'main',text:'S'},{role:'user',placement:'file',source:'chatHistory',text:'H'},{role:'user',placement:'inline',source:'current',text:'Q'}]});
 const p=C.prepare([{role:'user',content:env}]);
 assert.deepStrictEqual(p.segments.map(x=>[x.role,x.placement,x.source,x.text]),[['system','inline','main','S'],['user','file','chatHistory','H'],['user','inline','current','Q']]);
 assert.strictEqual(p.generationType,'swipe');
}
// envelope: bad segments skipped
{
 const env=C.WIRE_PREFIX+JSON.stringify({version:1,segments:[{role:'tool',placement:'file',text:'x'},{role:'user',placement:'inline',text:'ok'}]});
 const p=C.prepare([{role:'user',content:env}]);
 assert.strictEqual(p.segments.length,1);assert.strictEqual(p.dropped.segments,1);
}
console.log('build-context: all tests passed');

// bridge/: files kept as inline-data parts, default prefixes still drop them
{const img='data:image/png;base64,iVBORw0KGgo=';
 const msgs=[{role:'user',content:[{type:'text',text:'see'},{type:'image_url',image_url:{url:img}},{type:'file',file:{filename:'a.pdf',file_data:'data:application/pdf;base64,JVBERi0='}}]}];
 const d=C.pack(C.prepare(msgs));assert.strictEqual(d.parts.length,1);assert.strictEqual(C.prepare(msgs).dropped.parts,2);
 const k=C.pack(C.prepare(msgs,{keepMedia:true}));
 assert.deepStrictEqual(k.parts.slice(0,2),[{__upload:['image/png','iVBORw0KGgo=','attachment-1']},{__upload:['application/pdf','JVBERi0=','a.pdf']}]);
 assert.ok(/attached file #2 a.pdf/.test(k.parts[2][1]));assert.ok(!/text-only/.test(k.parts[2][1]));
 assert.strictEqual(k.mode,'inline+media2');
 console.log('build-context: bridge keeps media ok');}
