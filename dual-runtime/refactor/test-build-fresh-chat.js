'use strict';
const test=require('node:test'),assert=require('node:assert');
const {expression}=require('./build-page-call');
test('Build call starts a fresh chat: no trajectory in field 21, new-chat flag field 23',()=>{
 const code=expression({parts:[[null,'hi']],model:'gemini-3.8-flash',thinking:1,hx:{},app:'dacb8258-f919-45b7-892b-ff4d300d45bc',opts:{}});
 const m=code.match(/var b=(\[.*?crypto\.randomUUID\(\)\.toUpperCase\(\)\]);/s);
 assert.ok(m,'body literal found');
 let k=0;const app='APP',parts='P',sig='S',model='m',think=1,crypto={randomUUID:()=>'id'+(++k)};
 const b=eval(m[1]);
 assert.strictEqual(b[11],'APP');      // field 12 applet
 assert.strictEqual(b[20],null);       // field 21 trajectory id: unset
  assert.strictEqual(b[22],true);       // field 23 new chat
 assert.strictEqual(b.length,29);      // field 29 run id stays last
 assert.strictEqual(b[28],'ID1');
});
