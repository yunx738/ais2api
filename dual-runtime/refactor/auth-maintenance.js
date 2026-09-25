'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),http=require('http');
const INTERVAL=21600000;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function readAuth(file){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const st=fs.fstatSync(fd);
  if(!st.isFile()||st.size>262144)throw Error('auth_file_invalid');
  const bytes=fs.readFileSync(fd),data=JSON.parse(bytes);
  if(!Array.isArray(data.cookies)||!Array.isArray(data.origins))throw Error('auth_file_invalid');
  return {data,hash:hash(bytes),version:[st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs].join(':'),mode:st.mode&511,uid:st.uid,gid:st.gid};
 }finally{fs.closeSync(fd);}
}
function writeAuth(file,original,state){
 const data={...original.data,cookies:state.cookies,origins:state.origins};
 const bytes=Buffer.from(JSON.stringify(data));
 if(bytes.length>262144)throw Error('snapshot_too_large');
 const tmp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
 let fd;
 try{
  fd=fs.openSync(tmp,'wx',384);fs.writeFileSync(fd,bytes);
  fs.fchownSync(fd,original.uid,original.gid);fs.fchmodSync(fd,original.mode&384);
  fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  const now=readAuth(file);
  if(now.hash!==original.hash||now.version!==original.version)throw Error('auth_file_changed');
  fs.renameSync(tmp,file);
  const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  return hash(bytes);
 }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
function snapshot(client,slot,account,epoch){
 return new Promise((resolve,reject)=>{
  let done=false,timer;
  const finish=(e,v)=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve(v);};
  const req=http.request({hostname:'127.0.0.1',port:slot==='A'?8891:8892,
   method:'POST',path:'/internal/auth/snapshot',agent:false,
   headers:{'X-Worker-Key':client.keys[slot],'X-Auth-Account':String(account),'X-Worker-Epoch':epoch}},res=>{
    let size=0;const chunks=[];
    res.on('data',b=>{size+=b.length;if(size>300000){finish(Error('snapshot_too_large'));res.destroy();req.destroy();return;}chunks.push(b);});
    res.on('error',()=>finish(Error('snapshot_unavailable')));
    res.on('aborted',()=>finish(Error('snapshot_unavailable')));
    res.on('end',()=>{try{
     if(res.statusCode!==200)throw Error('snapshot_unavailable');
     finish(null,JSON.parse(Buffer.concat(chunks)));
    }catch{finish(Error('snapshot_unavailable'));}});
   });
  req.on('error',()=>finish(Error('snapshot_unavailable')));
  timer=setTimeout(()=>{finish(Error('snapshot_timeout'));req.destroy();},10000);
  req.end();
 });
}
const KEY_COOKIES=new Set(['SID','__Secure-1PSID','__Secure-3PSID']);
function cookieExpiry(data){
 const keys=(Array.isArray(data?.cookies)?data.cookies:[]).filter(c=>c&&KEY_COOKIES.has(c.name)&&/(^|\.)google\.com$/.test(String(c.domain||'')));
 if(!keys.length)return {keyCookies:0,expiresAt:null,session:false};
 const finite=keys.filter(c=>Number.isFinite(c.expires)&&c.expires>0).map(c=>Math.round(c.expires*1000));
 return {keyCookies:keys.length,expiresAt:finite.length?Math.min(...finite):null,session:finite.length<keys.length};
}
const infoCache=new Map();
function authFileInfo(file){
 let st;
 try{st=fs.lstatSync(file);}catch(e){return {state:e.code==='ENOENT'?'missing':'unreadable'};}
 if(!st.isFile()||st.isSymbolicLink())return {state:'unreadable'};
 const tag=[st.ino,st.size,st.mtimeMs].join(':'),hit=infoCache.get(file);
 if(hit&&hit.tag===tag)return hit.info;
 let info;
 try{const {data}=readAuth(file);info={state:'ok',modifiedAt:Math.round(st.mtimeMs),...cookieExpiry(data)};}
 catch{info={state:'unreadable'};}
 infoCache.set(file,{tag,info});
 return info;
}
class AuthMaintenance{
 constructor({dispatch,driver,client,scheduler,isStopping}){
  Object.assign(this,{dispatch,driver,client,scheduler,isStopping});this.jobs=new Map();
  for(const s of dispatch.slots.values())if(!s.authMaintenance)s.authMaintenance={nextAt:Date.now()+INTERVAL,result:'scheduled'};
  dispatch.checkpoint();
 }
 status(slot){
  const m=this.dispatch.slots.get(slot)?.authMaintenance||{};
  return {intervalHours:6,activeNetwork:false,nextAt:m.nextAt,lastAttemptAt:m.lastAttemptAt,
   lastSavedAt:m.lastSavedAt,savedAccount:m.savedAccount,result:m.result,running:this.jobs.has(slot)};
 }
 idle(slot){
  const d=this.dispatch,s=d.slots.get(slot),o=d.pool.slots.get(slot);
  return !this.isStopping()&&!d.halted&&!this.scheduler.queue.length&&o&&!o.pending&&
   s.ready&&!s.active&&!s.requests.size&&!s.rotation&&!s.recovery&&!s.proxyApply&&!s.catalogTask&&
   !Object.keys(s.executions||{}).length&&!Object.keys(s.retirements||{}).length;
 }
 tick(){
  for(const [slot,s] of this.dispatch.slots){
   if(this.jobs.has(slot)||Date.now()<s.authMaintenance.nextAt||!this.idle(slot)||this.dispatch.operations.has(slot))continue;
   const lease=this.dispatch.operations.acquire(slot,'auth');if(!lease)continue;
   const task=this.run(slot).catch(()=>{}).finally(()=>{
    this.dispatch.operations.release(lease);this.jobs.delete(slot);this.scheduler.pump();
   });this.jobs.set(slot,task);
  }
 }
 async run(slot){
  const d=this.dispatch,s=d.slots.get(slot),o=d.pool.slots.get(slot),account=o.current,m=s.authMaintenance;
  m.lastAttemptAt=Date.now();m.nextAt=m.lastAttemptAt+INTERVAL;m.result='saving';
  let prevExp,nextExp,saved=false;
  try{
   d.checkpoint();
   const before=await this.driver.describe(slot);
   const identity=x=>/^[a-f0-9]{64}$/.test(x.Id||'')&&x.State?.Running===true&&
    x.Config?.Labels?.['operit.account']===String(account)&&x.Config?.Labels?.['operit.slot']===slot&&
    x.Config?.Labels?.['operit.project']==='ais2api-dual';
   if(!identity(before))throw Error('identity_changed');
   const probe=await this.client.status(slot,account);
   if(probe.authSnapshotProtocol!==1)throw Error('worker_upgrade_pending');
   if(!/^[a-f0-9-]{36}$/.test(probe.workerEpoch||''))throw Error('identity_changed');
   const file=path.join(this.driver.authSource,'auth-'+account+'.json'),original=readAuth(file);
   const data=await snapshot(this.client,slot,account,probe.workerEpoch);
   if(data.account!==account||data.slot!==slot||data.workerEpoch!==probe.workerEpoch||
     !/^[a-f0-9]{64}$/.test(data.authBaseHash||'')||!Array.isArray(data.state?.cookies)||
     !data.state.cookies.length||!Array.isArray(data.state?.origins))throw Error('snapshot_invalid');
   const previous=m.containerId===before.Id&&m.epoch===probe.workerEpoch&&m.baseHash===data.authBaseHash;
   if(original.hash!==(previous?m.savedHash:data.authBaseHash))throw Error('auth_file_changed');
   const after=await this.driver.describe(slot),fresh=await this.client.status(slot,account);
   if(!identity(after)||after.Id!==before.Id||after.State.StartedAt!==before.State.StartedAt||
     d.pool.slots.get(slot)!==o||o.current!==account||o.pending||s.active||s.requests.size||
     Object.keys(s.executions||{}).length||Object.keys(s.retirements||{}).length||
     this.isStopping()||d.halted||fresh.workerEpoch!==probe.workerEpoch||
     !fresh.ready||fresh.busy||fresh.quarantined||fresh.hardQuarantine||
     fresh.browserOperations!==0||fresh.activeRequests!==0||fresh.pendingCompletions!==0)
    throw Error('identity_changed');
   const nextInfo=cookieExpiry(data.state);
   if(!nextInfo.keyCookies)throw Error('snapshot_invalid');
   prevExp=cookieExpiry(original.data).expiresAt;nextExp=nextInfo.expiresAt;
   const savedHash=writeAuth(file,original,data.state);saved=true;
   Object.assign(m,{containerId:before.Id,epoch:probe.workerEpoch,baseHash:data.authBaseHash,
    savedHash,lastSavedAt:Date.now(),savedAccount:account,result:'saved'});
  }catch(e){
   m.result=['auth_file_changed','worker_upgrade_pending','snapshot_unavailable','snapshot_timeout','identity_changed','snapshot_invalid'].includes(e.message)?e.message:'save_failed';
  }finally{
   try{
    const rec={...((d.authSaves||{})[account]||{}),lastAttemptAt:m.lastAttemptAt,lastResult:m.result};
    if(saved)Object.assign(rec,{savedAt:m.lastSavedAt,slot,previousExpiresAt:prevExp??null,expiresAt:nextExp??null,
     extended:Number.isFinite(prevExp)&&Number.isFinite(nextExp)&&nextExp>prevExp});
    d.authSaves={...(d.authSaves||{}),[account]:rec};
   }catch{}
   try{d.checkpoint();}catch{d.halted=true;}
  }
 }
}
module.exports={AuthMaintenance,readAuth,writeAuth,INTERVAL,cookieExpiry,authFileInfo};
