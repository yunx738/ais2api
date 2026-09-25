'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {buildSpec}=require('./worker-container-spec');
const fail=(code,message)=>Object.assign(Error(message),{statusCode:code});
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
class ProxySettings {
 constructor({root,dispatch,driver,client,rotation,scheduler,isStopping}){
  Object.assign(this,{root,dispatch,driver,client,rotation,scheduler,isStopping});
  this.jobs=new Map();this.leases=new Map();this.secret=crypto.randomBytes(32);
  for(const [slot,s] of dispatch.slots)if(s.proxyApply){
   if(dispatch.pool.slots.get(slot)?.current!==s.proxyApply.account)throw Error('Proxy ownership mismatch');
   this.lock(slot);
  }
 }
 lock(slot){
  if(this.leases.has(slot))return;
  const lease=this.dispatch.operations.acquire(slot,'proxy');
  if(!lease)throw fail(409,'实例正在执行其他操作');
  this.leases.set(slot,lease);this.rotation.running.add(slot);
 }
 unlock(slot){
  const lease=this.leases.get(slot);
  if(lease)this.dispatch.operations.release(lease);
  this.leases.delete(slot);this.rotation.running.delete(slot);
 }
 read(slot){
  if(!['A','B'].includes(slot))throw fail(400,'实例必须为 A 或 B');
  const file=path.join(this.root,'slots',slot,'worker.env');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  let text,stat;
  try{stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>65536)throw fail(503,'配置文件不可用');text=fs.readFileSync(fd,'utf8');}
  finally{fs.closeSync(fd);}
  const lines=text.split(/\r?\n/),matches=lines.filter(l=>/^SOCKS_UPSTREAM_URL=/.test(l));
  if(matches.length!==1)throw fail(503,'代理配置项缺失或重复');
  let url;
  try{url=new URL(matches[0].slice('SOCKS_UPSTREAM_URL='.length));}catch{throw fail(503,'代理配置格式不可用');}
  if(url.protocol!=='socks5:'||!url.hostname||!url.port||!url.username||!url.password)throw fail(503,'代理配置格式不可用');
  return {file,text,lines,url,stat,revision:crypto.createHmac('sha256',this.secret).update(text).digest('hex')};
 }
 async view(slot){
  const c=this.read(slot),s=this.dispatch.slots.get(slot);let applied=null;
  try{
   const d=await this.driver.describe(slot);
   const raw=(d.Config.Env||[]).find(x=>x.startsWith('SOCKS_UPSTREAM_URL='))?.slice(19);
   applied=raw===c.url.href||raw===c.lines.find(l=>l.startsWith('SOCKS_UPSTREAM_URL=')).slice(19);
  }catch{}
  return {slot,protocol:'socks5',host:c.url.hostname,port:Number(c.url.port),
   hasUsername:!!c.url.username,hasPassword:!!c.url.password,revision:c.revision,applied,
   applying:this.jobs.has(slot),blocked:!!s.proxyApply,phase:s.proxyApply?.phase || null,
   error:s.proxyApply?.error || null};
 }
 async snapshot(){return {slots:await Promise.all(['A','B'].map(s=>this.view(s)))};}
 save(body){
  const {slot,revision,host,port,username='',password=''}=body;
  const c=this.read(slot),s=this.dispatch.slots.get(slot);
  if(this.isStopping()||this.dispatch.halted||s.proxyApply||this.dispatch.operations.has(slot))
   throw fail(409,'实例正在操作中，暂不能保存');
  if(revision!==c.revision)throw fail(409,'配置版本已变化，请重新读取');
  if(typeof host!=='string'||host.length>253||!host||/[\s/@?#\\%]/.test(host)||
     !Number.isInteger(port)||port<1||port>65535||
     typeof username!=='string'||typeof password!=='string'||username.length>512||password.length>512||
     /[\x00-\x1f\x7f]/.test(username+password))throw fail(400,'代理主机、端口或认证字段无效');
  let u;
  try{u=new URL('socks5://'+host+':'+port);if(u.hostname!==host.toLowerCase()||u.pathname||u.search||u.hash||u.username||u.password)throw Error();}
  catch{throw fail(400,'主机仅填写域名或 IP；IPv6 使用方括号');}
  u.username=username?encodeURIComponent(username):c.url.username;
  u.password=password?encodeURIComponent(password):c.url.password;
  if(!u.username||!u.password)throw fail(400,'当前 worker 需要代理用户名和密码');
  const text=c.lines.map(l=>l.startsWith('SOCKS_UPSTREAM_URL=')?'SOCKS_UPSTREAM_URL='+u.href:l).join('\n');
  const tmp=c.file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';let fd;
  try{
   fd=fs.openSync(tmp,'wx',0o600);fs.fchownSync(fd,c.stat.uid,c.stat.gid);
   fs.writeFileSync(fd,text);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
   if(this.read(slot).revision!==revision)throw fail(409,'配置版本已变化，请重新读取');
   fs.renameSync(tmp,c.file);
   const dir=fs.openSync(path.dirname(c.file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  return {saved:true};
 }
 idle(slot){
  const s=this.dispatch.slots.get(slot),o=this.dispatch.pool.slots.get(slot);
  return o&&!o.pending&&!s.rotation&&!s.recovery&&!s.catalogTask&&s.active===0&&!s.requests.size&&
   !Object.keys(s.executions||{}).length&&!Object.keys(s.retirements||{}).length&&
   ![...this.scheduler.executing].some(t=>t.slot===slot);
 }
 start(body){
  const {slot,revision,action='apply'}=body,c=this.read(slot),s=this.dispatch.slots.get(slot);
  if(!['apply','rollback'].includes(action))throw fail(400,'操作无效');
  if(this.jobs.has(slot))throw fail(409,'该实例正在应用配置，请等待');
  if(this.isStopping()||this.dispatch.halted||this.scheduler.closed||!this.idle(slot))throw fail(409,'实例繁忙或存在未结算请求');
  if(revision!==c.revision)throw fail(409,'配置版本已变化，请重新读取');
  if(action==='rollback'&&!s.proxyApply)throw fail(409,'没有待恢复的代理操作');
  if(!s.proxyApply&&(this.rotation.running.has(slot)||this.rotation.failures.has(slot)))throw fail(409,'实例正在轮换或处于故障保护');
  this.lock(slot);
  try{
   if(!s.proxyApply){
    s.proxyApply={account:this.dispatch.pool.slots.get(slot).current,phase:'inspect',envHash:digest(c.text)};
    s.ready=false;this.dispatch.checkpoint();
   }
   if(action==='rollback'){
    if(!s.proxyApply.oldId)throw fail(409,'尚未记录原容器，不能恢复');
    s.proxyApply.rollback=true;this.dispatch.checkpoint();
   }
   const task=this.run(slot).catch(()=>{
    s.ready=false;
    if(s.proxyApply){s.proxyApply.error='操作未完成；可重试，或恢复原容器';try{this.dispatch.checkpoint();}catch{}}
   }).finally(()=>this.jobs.delete(slot));
   this.jobs.set(slot,task);
   return {accepted:true,slot};
  }catch(e){if(!s.proxyApply)this.unlock(slot);throw e;}
 }
 async command(args){return this.driver.run('docker',args,{timeout:60000,maxBuffer:1048576});}
 async stopId(slot,id,account){
  let d=await this.driver.describeId(slot,id,account);
  if(d.State.Running)await this.command(['stop','--time','30',id]);
  d=await this.driver.describeId(slot,id,account);
  if(d.State.Running||d.State.Pid!==0||!['created','exited'].includes(d.State.Status))throw Error('Closure unconfirmed');
  return d;
 }
 async named(slot){return this.driver.find(slot);}
 async run(slot){
  const s=this.dispatch.slots.get(slot),m=s.proxyApply,account=m.account,name=this.driver.name(slot);
  if(!this.idle(slot)||this.dispatch.pool.slots.get(slot).current!==account)throw Error('Ownership changed');
  delete m.error;
  const phase=p=>{m.phase=p;s.ready=false;this.dispatch.checkpoint();};
  if(m.rollback){
   phase('rollback');
   let d=await this.named(slot);
   if(d&&d.Id!==m.oldId){
    if(m.newId&&d.Id!==m.newId)throw Error('Replacement changed');
    if(!m.newId){m.newId=d.Id;this.dispatch.checkpoint();}
    await this.stopId(slot,d.Id,account);
    await this.command(['rename',d.Id,name+'-proxy-failed-'+d.Id.slice(0,12)]);
   }
   const old=await this.driver.describeId(slot,m.oldId,account);
   if(old.Name!=='/'+name)await this.command(['rename',old.Id,name]);
   if(!old.State.Running)await this.command(['start',old.Id]);
  }else{
   if(digest(this.read(slot).text)!==m.envHash)throw Error('Configuration changed');
   if(!m.oldId){
    const probe=await this.client.status(slot,account);
    if(probe.account!==account||probe.busy!==false||probe.activeRequests!==0||
       probe.pendingCompletions!==0||probe.browserOperations!==0)throw Error('Worker not idle');
    const old=await this.driver.describe(slot);
    if(old.Config.Labels['operit.account']!==String(account))throw Error('Ownership mismatch');
    m.oldId=old.Id;phase('stopping');
   }
   const old=await this.stopId(slot,m.oldId,account);
   const retired=name+'-proxy-old-'+m.oldId.slice(0,12);
   if(old.Name==='/'+name)await this.command(['rename',old.Id,retired]);
   else if(old.Name!=='/'+retired)throw Error('Old container renamed externally');
   phase('creating');
   let d=await this.named(slot);
   if(!d){
    const out=await this.command(buildSpec(slot,account,this.root,this.driver.image));
    const id=out.stdout.trim();if(!/^[a-f0-9]{64}$/.test(id))throw Error('Create unconfirmed');
    m.newId=id;this.dispatch.checkpoint();d=await this.driver.describe(slot);
   }
   if(d.Id===m.oldId||d.Config.Labels['operit.account']!==String(account)||(m.newId&&d.Id!==m.newId))throw Error('Replacement mismatch');
   const raw=(d.Config.Env||[]).find(x=>x.startsWith('SOCKS_UPSTREAM_URL='));
   if(raw!==this.read(slot).lines.find(x=>x.startsWith('SOCKS_UPSTREAM_URL=')))throw Error('Proxy mismatch');
   m.newId=d.Id;phase('starting');
   if(!d.State.Running)await this.driver.restartStopped(slot,account,d.Id);
  }
  phase(m.rollback?'rollback_waiting':'waiting');
  const fresh=await this.client.waitReady(slot,account,180000);
  if(!this.rotation.ready(fresh,account)||!this.idle(slot))throw Error('Readiness unconfirmed');
  delete s.proxyApply;
  try{this.dispatch.checkpoint();}catch(e){s.proxyApply=m;throw e;}
  this.unlock(slot);this.dispatch.update(slot,fresh);this.dispatch.checkpoint();
 }
}
module.exports={ProxySettings};
