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
assert.deepStrictEqual(p.map(x=>x.id.replace(/#\d+$/,'')),['main','jailbreak','abc-custom']);
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
const by=(m,src)=>r.segments.find(s=>s.message===m&&s.source.replace(/#\d+$/,'')===src);
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
assert.throws(()=>parsePreset({foo:1}),/content/);
fs.rmSync(dir,{recursive:true,force:true});
{
 const card='角色卡正文'.repeat(400);
 const plot=[{name:'东方文花帖',extractTags:'act,scene,recall',
  prompts:[{id:'mainPrompt',name:'主系统提示词',role:'system',content:''},
   {id:'finalSystemDirective',name:'最终注入指令',role:'system',content:'$8\n\n以上是用户的本轮输入，以下act是各角色们的行动和台词：\n{{act}}\n\n以下是时间戳和场景信息等：\n{{scene}}'}],
  promptGroup:[
   {role:'SYSTEM',content:'{{random::软萌信号测试喵: {{random::a::b}}{{random::c::d}}}}'},
   {role:'SYSTEM',content:'[RESET, RECEIVE NEW TASK]\n你是香风智乃，是兔子屋的DM，要分清玩家和故事里的<%- userName %>哦。'},
   {role:'SYSTEM',content:'玩家：下面是模组资料卡：\n[player]\n$U\n[/player]\n[卡片简述]\n$C\n[卡片简述已结束]'}],
  plotTasks:[{id:'t1',name:'任务',promptGroup:[{role:'SYSTEM',content:'[RESET, RECEIVE NEW TASK]\n你是香风智乃，是兔子屋的DM，要分清玩家和故事里的<%- userName %>哦。'}]}]}];
 const pp=parsePreset(plot);
 assert.deepStrictEqual(pp.map(x=>x.name),['最终注入指令','主系统提示词'].slice(0,1).concat(pp.slice(1).map(x=>x.name)));
 assert.strictEqual(pp.length,3,'finalDirective + DM task + card frame; random-only and empty skipped, duplicate merged');
 const ms=[
  {role:'system',content:'[RESET, RECEIVE NEW TASK]\n你是香风智乃，是兔子屋的DM，要分清玩家和故事里的阿文哦。'},
  {role:'system',content:'玩家：下面是模组资料卡：\n[player]\n阿文，记者\n[/player]\n[卡片简述]\n'+card+'\n[卡片简述已结束]'},
  {role:'user',content:'去神社\n\n以上是用户的本轮输入，以下act是各角色们的行动和台词：\n文：出发！\n\n以下是时间戳和场景信息等：\n上午'}];
 const rr=segment(ms,pp);
 const lines=rr.segments.map(x=>x.message+'.'+x.part+' '+x.placement+' '+x.source+' '+x.text.length);console.log(lines.join('\n'));
 assert.ok(rr.segments.some(x=>x.message===0&&x.placement==='inline'));
 const cardSeg=rr.segments.find(x=>x.text.includes('角色卡正文'));assert.strictEqual(cardSeg.placement,'file','long expanded card goes to the attachment');
 assert.ok(rr.segments.some(x=>x.message===1&&x.placement==='inline'&&x.text.includes('[卡片简述已结束]')));
 assert.ok(rr.segments.filter(x=>x.message===2).every(x=>x.placement==='inline'));
}
console.log('build-presets ok');
