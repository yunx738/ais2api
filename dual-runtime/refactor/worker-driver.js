'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {DockerLifecycle}=require('../code/docker-lifecycle');
const {buildSpec}=require('./worker-container-spec');
const {prepareAuth}=require('../code/prepare-auth');
class WorkerDriver extends DockerLifecycle {
 constructor(root,image,client,run,options={}){
  super(run);this.root=root;this.image=image;this.client=client;
  this.prepared=new Map();this.authSource=options.authSource||'/opt/ais2api/auth';
 }
 validateAccount(account){
  if(!Number.isSafeInteger(account)||account<1)throw Error('Invalid account');
  const source=path.join(this.authSource,'auth-'+account+'.json');
  const fd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
   const stat=fs.fstatSync(fd);
   if(!stat.isFile()||stat.size>262144)throw Error('Invalid authentication source');
   const data=JSON.parse(fs.readFileSync(fd,'utf8'));
   if(!Array.isArray(data.cookies)||!data.cookies.length||!Array.isArray(data.origins))
    throw Error('Invalid authentication structure');
  }finally{fs.closeSync(fd);}
 }
 directory(dir){
  try{const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())throw Error('Invalid authentication directory');return true;}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
 }
 syncDirectory(dir){const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 validatePrepared(dir,account){
  if(!this.directory(dir))throw Error('Prepared credentials missing');
  const names=fs.readdirSync(dir);
  if(names.length!==1||names[0]!=='auth-'+account+'.json')throw Error('Prepared credentials mismatch');
  const source=path.join(dir,names[0]),fd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
   const stat=fs.fstatSync(fd);
   if(!stat.isFile()||stat.size>262144)throw Error('Invalid prepared credentials');
   const data=JSON.parse(fs.readFileSync(fd,'utf8'));
   if(!Array.isArray(data.cookies)||!data.cookies.length||!Array.isArray(data.origins))throw Error('Invalid prepared credentials');
  }finally{fs.closeSync(fd);}
 }
 async describeId(slot,id,account){
  if(!/^[a-f0-9]{64}$/.test(id||''))throw Error('Invalid container identity');
  const result=await this.run('docker',['inspect',id],{timeout:15000,maxBuffer:1048576});
  const items=JSON.parse(result.stdout),d=items[0],labels=d?.Config?.Labels||{};
  if(items.length!==1||d.Id!==id||labels['operit.project']!=='ais2api-dual'||
     labels['operit.slot']!==slot||labels['operit.account']!==String(account))throw Error('Container ownership mismatch');
  return d;
 }
 async find(slot){
  const result=await this.run('docker',['ps','--all','--no-trunc','--filter','name=^/'+this.name(slot)+'$','--format','{{.ID}}'],{timeout:15000,maxBuffer:16384});
  const ids=result.stdout.trim();
  if(!ids)return;
  if(!/^[a-f0-9]{64}$/.test(ids))throw Error('Ambiguous container identity');
  const description=await this.describe(slot);
  if(description.Id!==ids)throw Error('Container identity changed');
  return description;
 }
 async prepare(slot,account,transaction){
  const d=transaction?await this.describeId(slot,transaction.oldContainerId,transaction.predecessorAccount??transaction.oldAccount):await this.describe(slot);
  if(d.State.Running!==false||d.State.Pid!==0||!['exited','created'].includes(d.State.Status))
   throw Error('Old worker not safely stopped');
  const base=path.join(this.root,'slots',slot),auth=path.join(base,'auth');
  if(transaction&&(!Number.isSafeInteger(transaction.token)||transaction.token<1))throw Error('Invalid rotation transaction');
  // The checkpointed reservation token and pinned predecessor make each path
  // deterministic across coordinator restarts, including between two renames.
  const tag=transaction?transaction.token+'-'+d.Id.slice(0,12):Date.now()+'-'+crypto.randomBytes(6).toString('hex');
  const retiredName=this.name(slot)+'-retired-'+tag,retired=path.join(base,'auth-retired-'+tag),staged=path.join(base,'auth-next-'+tag);
  if(d.Name&&d.Name!=='/'+this.name(slot)&&d.Name!=='/'+retiredName)throw Error('Old container name changed');
  if(this.directory(retired)){
   if(d.Name!=='/'+retiredName)throw Error('Retired credentials ownership mismatch');
   if(!this.directory(auth)){
    this.validatePrepared(staged,account);fs.renameSync(staged,auth);this.syncDirectory(base);
   }else{
    this.validatePrepared(auth,account);
    if(this.directory(staged))throw Error('Ambiguous prepared credentials');
   }
  }else{
   if(!this.directory(auth))throw Error('Original credentials missing');
   // A partial staging write is safe to rebuild: this directory has never been
   // mounted by either the current or the reserved target container.
   if(this.directory(staged)){
    try{this.validatePrepared(staged,account);}catch{
     const names=fs.readdirSync(staged);
     if(names.some(name=>name!=='auth-'+account+'.json'))throw Error('Unexpected staging contents');
     fs.rmSync(staged,{recursive:true});
    }
   }
   if(!this.directory(staged)){
    fs.mkdirSync(staged,{mode:448});
    try{prepareAuth(this.authSource,staged,account,true);this.syncDirectory(staged);this.syncDirectory(base);}
    catch(error){fs.rmSync(staged,{recursive:true,force:true});throw error;}
   }
   if(d.Name!=='/'+retiredName){
    await this.run('docker',['rename',d.Id,retiredName],{timeout:15000,maxBuffer:16384});
   }
   fs.renameSync(auth,retired);this.syncDirectory(base);
   fs.renameSync(staged,auth);this.syncDirectory(base);
  }
  this.validatePrepared(auth,account);
  this.prepared.set(slot,{account,transaction});
 }
 async start(slot,account,transaction){
  if(this.prepared.get(slot)?.account!==account){
   if(!transaction)throw Error('Account not prepared by this driver');
   await this.prepare(slot,account,transaction);
  }
  let d=await this.find(slot);
  if(!d){
   const result=await this.run('docker',buildSpec(slot,account,this.root,this.image),{timeout:30000,maxBuffer:16384});
   const id=result.stdout.trim();
   if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid created container identity');
   d=await this.describe(slot);
   if(d.Id!==id)throw Error('Created worker mismatch');
  }
  if(d.Config?.Labels?.['operit.account']!==String(account)||d.Id===transaction?.oldContainerId)throw Error('Created worker mismatch');
  if(d.State?.Running!==true)await this.restartStopped(slot,account,d.Id);
  this.prepared.delete(slot);
 }
 async restartStopped(slot,account,id){
  const d=await this.describe(slot);
  if(!/^[a-f0-9]{64}$/.test(id||'')||d.Id!==id||
     d.Config?.Labels?.['operit.account']!==String(account)||
     d.State?.Running!==false||d.State?.Pid!==0||
     !['created','exited'].includes(d.State?.Status))
   throw Error('Worker restart identity or closure unconfirmed');
  await this.run('docker',['start',id],{timeout:30000,maxBuffer:16384});
 }
 async loginFailure(slot,account){
  const d=await this.describe(slot);
  if(d.Config?.Labels?.['operit.account']!==String(account)||
    d.State?.Running!==false||d.State?.Pid!==0||d.State?.Status!=='exited'||d.State?.ExitCode!==1||d.State?.OOMKilled)return null;
  const result=await this.run('docker',['logs','--since',d.State.StartedAt,'--tail','160',d.Id],{timeout:15000,maxBuffer:262144});
  const text=String(result.stdout||'')+'\n'+String(result.stderr||'');
  const exact='Cookie 已失效/过期！浏览器被重定向到了 Google 登录页面。请重新提取 storageState。';
  if(!text.split('\n').some(l=>l.includes('[System]')&&l.includes('使用账号 #'+account+' 启动失败。原因:')&&l.includes(exact)))return null;
  const after=await this.describeId(slot,d.Id,account);
  if(after.State.Running||after.State.Pid!==0||after.State.FinishedAt!==d.State.FinishedAt)throw Error('Failed target changed');
  return {id:d.Id,account};
 }
 waitReady(slot,account){return this.client.waitReady(slot,account,180000);}
 probeReady(slot,account){return this.client.status(slot,account);}
}
module.exports={WorkerDriver};
