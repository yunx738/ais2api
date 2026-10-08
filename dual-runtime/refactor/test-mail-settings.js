'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path'),os=require('os');
const html=fs.readFileSync(path.join(__dirname,'../code/import-ui.html'),'utf8');
const code=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function ui(){
 const nodes={};for(const [,id] of html.matchAll(/\bid="([^"]+)"/g))nodes[id]={value:'',textContent:'',hidden:false};
 const ctx=vm.createContext({URL,$:id=>nodes[id]});
 vm.runInContext(code.slice(code.indexOf('function wsettings()'),code.indexOf('$("wsave").onclick=')),ctx);
 vm.runInContext(code.slice(code.indexOf('function wproviderShow()'),code.indexOf('async function wload()')),ctx);
 Object.entries({wdom:'accounts.example.com',wmail:'inbox@mail.example.com',wprovider:'tempmail',wapi:'https://api.example.com/',wrec:'recovery@example.com',wkey:'Google, 新的 Google',wta:''}).forEach(([id,v])=>nodes[id].value=v);
 return {nodes,ctx,get:()=>JSON.parse(JSON.stringify(vm.runInContext('wsettings()',ctx)))};
}
test('all referenced elements exist and ids are unique',()=>{
 new vm.Script(code);const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);assert.equal(ids.length,new Set(ids).size);
 for(const [,id] of code.matchAll(/\$\("([^"]+)"\)/g))assert.ok(ids.includes(id),id);
});
test('API mode posts full mailbox and API origin, omits unrelated Graph and prefix',()=>{
 const f=ui(),b=f.get();assert.equal(b.mailbox,'inbox@mail.example.com');assert.equal(b.tempmail_api,'https://api.example.com');
 assert.equal(b.graph_client_id,undefined);assert.equal(b.tempmail_name,undefined);assert.equal(b.tempmail_admin,'');
 f.nodes.wmail.value='other@another.example';assert.equal(f.get().mailbox,'other@another.example');
 vm.runInContext('wproviderShow()',f.ctx);assert.equal(f.nodes.wtempfields.hidden,false);assert.equal(f.nodes.wgraphfields.hidden,true);assert.equal(f.nodes.wauth.hidden,true);
});
test('Graph mode omits API credentials and only requires Graph application ID',()=>{
 const f=ui();f.nodes.wprovider.value='graph';assert.throws(()=>f.get(),/Azure/);f.nodes.wcid.value='11111111-1111-4111-8111-111111111111';
 const b=f.get();assert.ok(b.graph_client_id);assert.equal(b.tempmail_admin,undefined);assert.equal(b.tempmail_api,undefined);
 vm.runInContext('wproviderShow()',f.ctx);assert.equal(f.nodes.wgraphfields.hidden,false);assert.equal(f.nodes.wauth.hidden,false);
});
test('rejects non-API urls including inbox JWT links',()=>{
 for(const url of ['', 'http://api.example.com', 'https://mail.example.com/?jwt=dummy', 'https://api.example.com/admin/mails','https://user:pass@api.example.com']){
 const f=ui();f.nodes.wapi.value=url;assert.throws(()=>f.get(),/API/);}
});
test('actual config module saves alternate addresses in isolated storage, preserves password without echo',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-settings-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),initial={domain:'accounts.example.com',mail_provider:'tempmail',mailbox:'old@example.com',recovery_email:'recovery@example.com',tempmail_api:'https://api.example.com',tempmail_admin:'fixture-password',tempmail_name:'old'};fs.writeFileSync(file,JSON.stringify(initial));
 const src=fs.readFileSync(path.join(__dirname,'../login/workspace.js'),'utf8').replace("path.join(DATA,'ws-config.json')",JSON.stringify(file));
 const fakeFs=Object.create(fs);fakeFs.chownSync=()=>{};const ctx={require:n=>n==='fs'?fakeFs:require(n),module:{exports:{}},Buffer,URL};vm.runInNewContext(src,ctx);
 const w=ctx.module.exports;let b=ui().get();b.mailbox='new@example.com';b.tempmail_api='https://new-api.example.com';b.tempmail_admin='new-fixture-password';w.saveConfig(b);
 b.tempmail_admin='';const result=w.saveConfig(b),saved=JSON.parse(fs.readFileSync(file));
 assert.equal(saved.mailbox,'new@example.com');assert.equal(saved.tempmail_api,'https://new-api.example.com');assert.equal(saved.recovery_email,initial.recovery_email);assert.equal(saved.domain,initial.domain);
 assert.equal(saved.tempmail_admin,'new-fixture-password');assert.equal(result.has_tempmail_admin,true);assert.equal(result.tempmail_admin,undefined);assert.equal(result.tempmail_jwt,undefined);assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.throws(()=>w.saveConfig({...b,mailbox:'bad'}),/邮箱/);assert.equal(JSON.parse(fs.readFileSync(file)).mailbox,'new@example.com');
});
