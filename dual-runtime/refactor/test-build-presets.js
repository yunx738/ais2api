'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {PresetStore,parsePreset,segment}=require('./build-presets');
const {prepare,pack,WIRE_PREFIX}=require('./build-context');
const preset={prompts:[
 {identifier:'main',name:'Main Prompt',content:'你是{{char}}，与{{user}}进行沉浸式角色扮演。保持角色，不要跳出。'},
 {identifier:'jailbreak',name:'Post-History',content:'[回复要求：使用中文，至少300字，描写{{char}}的动作与心理。]'},
 {identifier:'abc-custom',name:'文风',content:'文风：细腻、克制，避免重复用词。'},
 {identifier:'charDescription',marker:true},{identifier:'chatHistory',marker:true},
 {identifier:'worldInfoBefore',content:'should be ignored as background'},
 {identifier:'short',content:'{{char}}'}]};
const p=parsePreset(preset);
assert.deepStrictEqual(p.map(x=>x.id),['main','jailbreak','abc-custom']);
const msgs=[
 {role:'system',content:'你是艾莉丝，与旅人进行沉浸式角色扮演。保持角色，不要跳出。\n文风：细腻、克制，避免重复用词。'},
 {role:'system',content:'艾莉丝是一位精灵弓手，住在森林里。(角色卡)'},
 {role:'user',content:'你好'},{role:'assistant',content:'旅人，你好。'},
 {role:'user',content:'带我去森林'},
 {role:'system',content:'[回复要求：使用中文，至少300字，描写艾莉丝的动作与心理。]'}];
const r=segment(msgs,p);
const show=r.segments.map(s=>s.message+'.'+s.part+' '+s.placement+' '+s.source);
console.log(show.join('\n'));
assert.strictEqual(r.hits,3);
const by=(m,src)=>r.segments.find(s=>s.message===m&&s.source===src);
assert.strictEqual(by(0,'main').placement,'inline');assert.strictEqual(by(0,'abc-custom').placement,'inline');
assert.strictEqual(r.segments.find(s=>s.message===1).placement,'file');
assert.strictEqual(r.segments.find(s=>s.message===2).placement,'file');
assert.strictEqual(by(4,'currentUser').placement,'inline');
assert.strictEqual(by(5,'jailbreak').placement,'inline');
// round-trip through the existing envelope path and packer
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bp-'));
const store=new PresetStore(path.join(dir,'p.json'));
assert.strictEqual(store.apply(msgs),null);
const a=store.add('我的预设.json',preset);assert.strictEqual(a.prompts,3);assert.strictEqual(store.list()[0].name,'我的预设');
const out=store.apply(msgs);assert.ok(out.content.startsWith(WIRE_PREFIX));
const prep=prepare([{role:'user',content:out.content}]);
const packed=pack(prep,{nonce:'a'.repeat(24)});assert.strictEqual(packed.mode,'attachment');
assert.ok(packed.parts[1][1].includes('保持角色，不要跳出'));assert.ok(!packed.parts[1][1].includes('精灵弓手'));
assert.strictEqual(store.list()[0].requests,1);
// unrelated conversation -> null, falls back to default rules
assert.strictEqual(store.apply([{role:'user',content:'hello'}]),null);
// disabled -> null
store.setEnabled(a.id,false);assert.strictEqual(store.apply(msgs),null);
store.remove(a.id);assert.strictEqual(store.list().length,0);
assert.throws(()=>parsePreset({foo:1}),/prompts/);
fs.rmSync(dir,{recursive:true,force:true});
console.log('build-presets ok');
