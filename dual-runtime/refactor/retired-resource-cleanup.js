'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {RetiredResourceStore}=require('./retired-resource-store');
const DAY=86400000;
const DEFAULTS=Object.freeze({enabled:true,retentionDays:7,keepPerSlot:2,intervalMinutes:60,maxPerSweep:10});
const idPattern=/^[a-f0-9]{64}$/;
function policy(options){
 if(!options||typeof options!=='object'||Array.isArray(options))throw Error('Invalid cleanup policy');
 if(Object.keys(options).some(key=>!Object.hasOwn(DEFAULTS,key)))throw Error('Unknown cleanup policy');
 const value={...DEFAULTS,...options};
 if(typeof value.enabled!=='boolean')throw Error('Invalid cleanup policy');
 for(const [key,min,max] of [['retentionDays',7,3650],['keepPerSlot',2,100],['intervalMinutes',5,1440],['maxPerSweep',1,10]])
  if(!Number.isSafeInteger(value[key])||value[key]<min||value[key]>max)throw Error('Invalid cleanup policy');
 return value;
}
// Check every component; accepting a real final directory is insufficient when
// an ancestor is a symlink into the primary credential or checkpoint directory.
function directory(dir){
 if(!path.isAbsolute(dir)||path.resolve(dir)!==dir)throw Error('Unsafe cleanup path');
 let current=path.parse(dir).root;
 for(const part of dir.slice(current.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);
  const stat=fs.lstatSync(current);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe cleanup directory');
 }
 return fs.lstatSync(dir);
}
function credentials(file){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1||stat.size>262144)throw Error('Unsafe credential file');
  const bytes=fs.readFileSync(fd),data=JSON.parse(bytes.toString('utf8'));
  if(!Array.isArray(data.cookies)||!data.cookies.length||!Array.isArray(data.origins))throw Error('Invalid credential file');
  return {stat,bytes,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
 }finally{fs.closeSync(fd);}
}
function overlaps(a,b){
 const prefix=value=>value.endsWith(path.sep)?value:value+path.sep;
 return a===b||a.startsWith(prefix(b))||b.startsWith(prefix(a));
}
class RetiredResourceCleanup {
 constructor({dispatch,driver,root=driver.root,options={},now=Date.now,store,isStopping=()=>false,hasWaiting=()=>false}){
  Object.assign(this,{dispatch,driver,root,now,isStopping,hasWaiting});
  this.store=store||new RetiredResourceStore(root);
  this.closed=false;this.running=new Map();this.nextRun=new Map();this.results=new Map();this.lastCandidate=new Map();this.slotCursor=0;this.recordError=null;
  try{this.policy=policy(options);}catch{this.policy={...DEFAULTS,enabled:false};this.configError='invalid_cleanup_policy';}
 }
 paths(receipt){
  if(!['A','B'].includes(receipt.slot)||!idPattern.test(receipt.containerId)||
     !Number.isSafeInteger(receipt.account)||receipt.account<1||!Number.isSafeInteger(receipt.token)||receipt.token<1)
   throw Error('Invalid retirement identity');
  const tag=receipt.token+'-'+receipt.containerId.slice(0,12),base=path.join(this.root,'slots',receipt.slot);
  return {base,auth:path.join(base,'auth-retired-'+tag),file:'auth-'+receipt.account+'.json',
   name:'/ais2api-dual-'+receipt.slot.toLowerCase()+'-retired-'+tag};
 }
 record(slot,marker){
  // Called only AFTER the new account and removal of its rotation marker are
  // checkpointed. Failure here leaks a backup; it never invalidates the commit.
  try{
   const receipt={version:1,slot,containerId:marker.oldContainerId,account:marker.oldAccount,token:marker.token,retiredAt:this.now()};
   const owner=this.dispatch.pool.slots.get(slot),state=this.dispatch.slots.get(slot);
   if(!owner||owner.pending||state?.rotation||owner.current!==marker.account||this.dispatch.halted)throw Error('Uncommitted rotation');
   const p=this.paths(receipt),stat=directory(p.auth);
   if(fs.readdirSync(p.auth).join('\0')!==p.file)throw Error('Unexpected retired credentials');
   const data=credentials(path.join(p.auth,p.file));
   receipt.auth={dev:stat.dev,ino:stat.ino,fileDev:data.stat.dev,fileIno:data.stat.ino,sha256:data.sha256};
   this.store.record(receipt);this.recordError=null;return true;
  }catch{this.recordError='retirement_receipt_unavailable';return false;}
 }
 status(){
  return {...this.policy,error:this.configError||this.recordError||null,recordError:this.recordError,
   slots:Object.fromEntries(['A','B'].map(slot=>[slot,{lastRun:null,removed:0,protected:0,error:null,
    ...this.results.get(slot),running:this.running.has(slot)}]))};
 }
 close(){this.closed=true;}
 tick(){
  if(this.closed||!this.policy.enabled||this.isStopping()||this.dispatch.halted)return;
  if(this.running.size)return;
  for(let i=0;i<2;i++){
   const index=(this.slotCursor+i)%2,slot=['A','B'][index];
   if(this.now()<(this.nextRun.get(slot)||0))continue;
   // Busy slots get another chance soon, without competing with queued work.
   this.slotCursor=(index+1)%2;this.sweep(slot).catch(()=>{});break;
  }
 }
 safe(slot,owner){
  const d=this.dispatch,state=d.slots.get(slot),current=d.pool.slots.get(slot);
  return !this.closed&&!this.isStopping()&&!this.hasWaiting()&&!d.halted&&state&&current&&(!owner||current===owner)&&
   !current.pending&&Number.isSafeInteger(current.current)&&current.current>0&&
   !state.active&&!state.requests.size&&!Object.keys(state.executions||{}).length&&!Object.keys(state.retirements||{}).length&&
   !state.rotation&&!state.recovery&&!state.catalogTask;
 }
 referenced(receipt){
  return [...this.dispatch.slots.values()].some(state=>
   state.rotation?.oldContainerId===receipt.containerId||state.recovery?.containerId===receipt.containerId||
   [...Object.values(state.executions||{}),...Object.values(state.retirements||{})].some(t=>t.account===receipt.account));
 }
 async inventory(){
  const deadline=Date.now()+30000;
  const result=await this.driver.run('docker',['ps','--all','--no-trunc','--quiet'],{timeout:10000,maxBuffer:1048576});
  const ids=result.stdout.trim()?result.stdout.trim().split(/\s+/):[];
  if(ids.length>10000||new Set(ids).size!==ids.length||ids.some(id=>!idPattern.test(id)))throw Error('Invalid Docker inventory');
  const containers=new Map();
  for(let offset=0;offset<ids.length;offset+=32){
   if(Date.now()>=deadline||this.closed||this.isStopping())throw Error('Cleanup inventory interrupted');
   const batch=ids.slice(offset,offset+32);
   const inspected=await this.driver.run('docker',['inspect',...batch],{timeout:Math.min(10000,Math.max(1,deadline-Date.now())),maxBuffer:4194304});
   const descriptions=JSON.parse(inspected.stdout);
   if(!Array.isArray(descriptions)||descriptions.length!==batch.length)throw Error('Incomplete Docker inventory');
   for(const d of descriptions){
    if(!batch.includes(d?.Id)||containers.has(d.Id)||!Array.isArray(d.Mounts))throw Error('Invalid Docker inventory');
    containers.set(d.Id,d);
   }
  }
  return containers;
 }
 ownedStopped(receipt,d){
  const labels=d?.Config?.Labels||{},p=this.paths(receipt);
  return d?.Id===receipt.containerId&&d.Name===p.name&&labels['operit.project']==='ais2api-dual'&&
   labels['operit.slot']===receipt.slot&&labels['operit.account']===String(receipt.account)&&
   d.State?.Running===false&&d.State.Pid===0&&['created','exited'].includes(d.State.Status)&&
   d.State.Paused!==true&&d.State.Restarting!==true&&d.HostConfig?.AutoRemove!==true;
 }
 mounted(dir,containers,exclude){
  for(const d of containers.values())if(d.Id!==exclude)for(const mount of d.Mounts){
   if(typeof mount.Source!=='string'||!path.isAbsolute(mount.Source)){
    if(mount.Type==='tmpfs')continue;
    throw Error('Unknown Docker mount');
   }
   const source=path.resolve(mount.Source);
   if(overlaps(dir,source))return true;
   try{if(overlaps(dir,fs.realpathSync(source)))return true;}
   catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return false;
 }
 copyState(receipt,allowAbsent){
  const p=this.paths(receipt);directory(p.base);
  if(overlaps(p.auth,this.driver.authSource))throw Error('Primary credential directory protected');
  let stat;
  try{stat=directory(p.auth);}catch(error){if(error.code==='ENOENT'&&allowAbsent)return {absent:true};throw error;}
  if(stat.dev!==receipt.auth.dev||stat.ino!==receipt.auth.ino)throw Error('Retired directory identity changed');
  const names=fs.readdirSync(p.auth);
  if(!names.length&&allowAbsent)return {empty:true,stat};
  if(names.length!==1||names[0]!==p.file)throw Error('Unexpected retired contents');
  const retired=credentials(path.join(p.auth,p.file));
  if(retired.stat.dev!==receipt.auth.fileDev||retired.stat.ino!==receipt.auth.fileIno||retired.sha256!==receipt.auth.sha256)
   throw Error('Retired credential identity changed');
  directory(this.driver.authSource);
  const original=credentials(path.join(this.driver.authSource,p.file));
  if(original.stat.dev===retired.stat.dev&&original.stat.ino===retired.stat.ino)throw Error('Primary credential file protected');
  if(!retired.bytes.equals(original.bytes))throw Error('Unique credential backup retained');
  return {stat,retired,original};
 }
 deleteCopy(receipt){
  // No awaits and no recursive deletion. Revalidate the recorded inode, exact
  // contents and still-valid primary copy immediately before the two mutations.
  const p=this.paths(receipt),copy=this.copyState(receipt,true);
  if(copy.absent)return;
  const fd=fs.openSync(p.auth,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try{
   const pinned=fs.fstatSync(fd);
   if(pinned.dev!==receipt.auth.dev||pinned.ino!==receipt.auth.ino)throw Error('Retired directory changed before unlink');
   // This service runs on Linux. Pin the directory, so replacing a parent
   // pathname cannot redirect unlink into primary credentials after validation.
   const pinnedPath='/proc/self/fd/'+fd;
   if(!copy.empty){
    const before=credentials(path.join(pinnedPath,p.file));
    if(before.stat.dev!==receipt.auth.fileDev||before.stat.ino!==receipt.auth.fileIno||before.sha256!==receipt.auth.sha256)
     throw Error('Retired credential changed before unlink');
    fs.unlinkSync(path.join(pinnedPath,p.file));fs.fsyncSync(fd);
   }
   // rmdir refuses extra files if an external process added anything meanwhile.
   const after=directory(p.auth);
   if(after.dev!==pinned.dev||after.ino!==pinned.ino)throw Error('Retired directory changed before removal');
   fs.rmdirSync(p.auth);
  }finally{fs.closeSync(fd);}
  const parent=fs.openSync(p.base,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
 }
 authorized(receipt){
  // An operator can revoke evidence or extend retention while Docker is slow.
  // Never authorize deletion from the stale list captured before an await.
  const receipts=this.store.list().filter(r=>r.slot===receipt.slot).sort((a,b)=>b.token-a.token||b.retiredAt-a.retiredAt);
  const index=receipts.findIndex(r=>r.containerId===receipt.containerId);
  if(index<this.policy.keepPerSlot||JSON.stringify(receipts[index])!==JSON.stringify(receipt)||
     this.now()-receipt.retiredAt<this.policy.retentionDays*DAY)throw Error('Retirement authorization changed');
 }
 sweep(slot){
  if(!['A','B'].includes(slot))return Promise.reject(Error('Invalid cleanup slot'));
  if(this.running.has(slot))return this.running.get(slot);
  // Never occupy both generation slots for housekeeping at the same time.
  if(this.running.size)return Promise.resolve({skipped:'other_slot_cleanup'});
  const task=Promise.resolve().then(()=>this.scan(slot)).finally(()=>this.running.delete(slot));
  this.running.set(slot,task);return task;
 }
 async scan(slot){
  const result={lastRun:this.now(),removed:0,protected:0,error:null,tracked:0};
  let lease;
  const check=owner=>{if(!this.safe(slot,owner))throw Error('Cleanup safety state changed');};
  try{
   if(!this.policy.enabled||!this.safe(slot)||!this.dispatch.slots.get(slot).ready||this.dispatch.operations.has(slot)){
    result.skipped='slot_unavailable';this.nextRun.set(slot,this.now()+60000);return result;
   }
   const owner=this.dispatch.pool.slots.get(slot),account=owner.current;
   const receipts=this.store.list().filter(r=>r.slot===slot).sort((a,b)=>b.token-a.token||b.retiredAt-a.retiredAt);
   result.tracked=receipts.length;
   const eligible=receipts.slice(this.policy.keepPerSlot).filter(r=>this.now()-r.retiredAt>=this.policy.retentionDays*DAY);
   result.protected=receipts.length-eligible.length;
   if(!eligible.length)return result;
   // Inventory is read outside the slot lease. A slow Docker daemon must not
   // stop request admission while merely considering a cleanup candidate.
   let containers=await this.inventory();check(owner);
   if(owner.current!==account||!this.dispatch.slots.get(slot).ready)throw Error('Worker changed during inventory');
   // A preserved unique backup must not starve unrelated removable backups.
   const start=(eligible.findIndex(r=>r.containerId===this.lastCandidate.get(slot))+1)%eligible.length;
   const batch=Array.from({length:Math.min(eligible.length,this.policy.maxPerSweep)},(_,i)=>eligible[(start+i)%eligible.length]);
   for(const receipt of batch){
    check(owner);
    this.lastCandidate.set(slot,receipt.containerId);
    if(owner.current!==account)throw Error('Worker changed during cleanup');
    if(this.referenced(receipt)){result.protected++;continue;}
    try{
     const current=await this.driver.describe(slot);check(owner);
     if(current.Id===receipt.containerId||!idPattern.test(current.Id||'')||current.State?.Running!==true||
        current.Config?.Labels?.['operit.account']!==String(account))throw Error('Current worker unconfirmed');
     const old=containers.get(receipt.containerId);
     if(old&&!this.ownedStopped(receipt,old))throw Error('Retired worker identity or closure changed');
     if(this.mounted(this.paths(receipt).auth,containers,old?.Id))throw Error('Retired credentials still mounted');
     this.copyState(receipt,!old);
     if(old){
      const inspected=JSON.parse((await this.driver.run('docker',['inspect',receipt.containerId],{timeout:10000,maxBuffer:1048576})).stdout);
      check(owner);
      if(inspected.length!==1||!this.ownedStopped(receipt,inspected[0])||this.referenced(receipt))throw Error('Retired worker changed before removal');
      lease=this.dispatch.operations.acquire(slot,'cleanup');
      if(!lease)throw Error('Slot operation started before removal');
      // Only the bounded rm owns the lease, never the full Docker inventory.
      // Never force a running container, remove volumes or use Docker prune.
      try{this.authorized(receipt);await this.driver.run('docker',['rm',receipt.containerId],{timeout:10000,maxBuffer:16384});}
      finally{this.dispatch.operations.release(lease);lease=undefined;}
      check(owner);
     }
     // A successful rm reply alone is not enough to delete credentials. A
     // complete subsequent inventory proves absence and checks other mounts.
     containers=await this.inventory();check(owner);
     if(containers.has(receipt.containerId)||this.referenced(receipt)||this.mounted(this.paths(receipt).auth,containers))
      throw Error('Retirement removal unconfirmed');
     lease=this.dispatch.operations.acquire(slot,'cleanup');
     if(!lease)throw Error('Slot operation started before credential cleanup');
     try{this.authorized(receipt);this.deleteCopy(receipt);this.store.remove(receipt);result.removed++;}
     finally{this.dispatch.operations.release(lease);lease=undefined;}
    }catch{result.protected++;result.error='cleanup_candidate_retained';}
   }
  }catch{result.error='cleanup_unavailable';}
  finally{
   if(lease)this.dispatch.operations.release(lease);
   this.results.set(slot,result);
   if(result.skipped!=='slot_unavailable')this.nextRun.set(slot,this.now()+this.policy.intervalMinutes*60000);
  }
  return result;
 }
}
module.exports={RetiredResourceCleanup,policy};
