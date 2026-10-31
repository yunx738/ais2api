'use strict';
// Nightly re-login for auto-registered accounts (email+password+TOTP from auto-register/data).
// 00:00 local: queue every account marked invalid/login_required. Then at most one login per 20 minutes.
// Accounts that fail while switching are queued as they appear, but follow the same 20-minute pacing.
// Each login runs on the worker network where the account failed, through that worker's egress.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const REG='/opt/ais2api/auto-register/data';
// No pacing: a failed account is logged in again as soon as no other login runs.
const GAP_MS=0,TICK_MS=30000,RECENT_OK_MS=30*60000;
// Errors from pausing/leasing a worker are not login failures; never hold an account on them.
const LEASE_ERR=/未就绪，暂不暂停|已有登录占用|实例正在执行其他操作|运行模式切换中|等待请求结束超时|暂停实例失败|暂停失败|单实例模式尚未就绪|调度不可用/;
function day(t){const d=new Date(t);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function registered(){
 const out={};
 let secrets={};try{secrets=JSON.parse(fs.readFileSync(path.join(REG,'secrets.json'),'utf8'));}catch{}
 let rows=[];try{rows=fs.readFileSync(path.join(REG,'output','accounts.tsv'),'utf8').split('\n');}catch{}
 for(const l of rows){if(!l.trim()||l.startsWith('#'))continue;const f=l.split('\t');const email=String(f[0]||'').trim().toLowerCase(),password=f[1]||'';
  if(!email.includes('@')||!password)continue;
  const s=secrets[email]||Object.values(secrets).find(v=>String(v.label||'').toLowerCase()===email);
  out[email]={password,totp:s&&s.secret&&(s.algo||'sha1')==='sha1'&&(s.digits||6)===6&&(s.period||30)===30?s.secret:null};}
 return out;
}
function mask(e){const i=e.indexOf('@');return i>0?e.slice(0,3)+'***'+e.slice(i):'***';}
class NightlyRelogin{
 constructor({file,coord,startJob,cancel,busy,memOk,emailOf,failedSlot,now=Date.now,log=console.log}){
  Object.assign(this,{file,coord,startJob,cancel,busy,memOk,emailOf,failedSlot,now,log});
  this.state={scanDay:null,queue:[],lastStartAt:0,triedDay:{},results:{},held:{},manual:[]};
  try{Object.assign(this.state,JSON.parse(fs.readFileSync(file,'utf8')));}catch{}
  this.state.held||={};this.state.manual||=[];
  for(const [id,h] of Object.entries(this.state.held))if(LEASE_ERR.test(h?.message||''))delete this.state.held[id];
  // First start: do not sweep existing failures now; wait for midnight.
  if(!this.state.scanDay){this.state.scanDay=day(this.now());this.state.scanAt=this.now();}
  this.job=null;this.ticking=false;
 }
 save(){const tmp=this.file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(this.state));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,this.file);}
 result(id,result,message){this.state.results[id]={at:this.now(),result,message:String(message||'').slice(0,160)};
  this.log('[NightlyRelogin] #'+id+' '+result+(message?' '+message:''));}
 eligible(a,reg){
  if(a.authStatus!=='invalid'||a.invalidReason!=='login_required'||a.owner)return null;
  if(this.state.held[a.id])return null;
  const email=String(this.emailOf(a.id)||'').toLowerCase();
  return reg[email]?email:null;
 }
 async accounts(){const r=await this.coord('GET','/internal/coordinator-status');
  if(r.status!==200||!Array.isArray(r.body?.accounts))throw Error('读取账号状态失败');return r.body.accounts;}
 // Midnight: rebuild the queue from all invalid accounts. Otherwise: append newly failed ones not tried today.
 async scan(full){
  const today=day(this.now()),reg=registered(),list=await this.accounts();
  if(full){this.state.scanDay=today;this.state.scanAt=this.now();this.state.triedDay={};}
  const q=new Set(this.state.queue);let added=0;
  for(const a of list){
   if(!this.eligible(a,reg))continue;
   // Just logged in but still flagged (revalidation unconfirmed): do not loop on it.
   {const r=this.state.results[a.id];if(!full&&r?.result==='ok'&&this.now()-r.at<RECENT_OK_MS)continue;}
   if(!q.has(a.id)){q.add(a.id);added++;}
  }
  // Drop queued accounts that recovered meanwhile.
  const byId=new Map(list.map(a=>[a.id,a]));
  this.state.queue=[...q].filter(id=>byId.has(id)&&this.eligible(byId.get(id),reg));
  // Forget held accounts that were deleted or recovered some other way.
  for(const id of Object.keys(this.state.held)){const a=byId.get(Number(id));if(!a||a.authStatus!=='invalid')delete this.state.held[id];}
  if(full)this.log('[NightlyRelogin] scan '+today+': '+this.state.queue.length+' invalid account(s) queued ['+this.state.queue.join(',')+']');
  else if(added)this.log('[NightlyRelogin] queued newly failed account(s): ['+this.state.queue.join(',')+']');
  this.save();
 }
 async tick(){
  if(this.ticking)return;this.ticking=true;
  try{
   const now=this.now(),today=day(now);
   if(this.state.scanDay!==today)await this.scan(true);
   else await this.scan(false);
   if(this.job||!this.state.queue.length)return;
   if(this.busy()){this.waiting='另一登录任务进行中';return;}
   if(!this.memOk()){this.waiting='服务器内存不足';return;}
   const list=await this.accounts(),reg=registered();
   const id=this.state.queue[0],a=list.find(x=>x.id===id),email=a&&this.eligible(a,reg);
   if(!email){this.state.queue.shift();this.save();return;}
   this.state.manual=this.state.manual.filter(x=>x!==id);
   const slot=a.invalidSlot==='A'||a.invalidSlot==='B'?a.invalidSlot:await this.failedSlot?.(id)||null;
   const c=reg[email];
   this.state.queue.shift();this.state.lastStartAt=now;this.state.triedDay[id]=today;this.waiting=null;this.save();
   this.log('[NightlyRelogin] #'+id+' '+mask(email)+' start on '+(slot?'worker '+slot+' network':'default login network')+(c.totp?'':' (no TOTP secret)'));
   const job=this.job=this.startJob(email,c.password,{target:id,auto:true,slot,totp:c.totp,noLease:true});
   job.nightly=true;
   await new Promise(res=>{const t=setInterval(()=>{
    if(job.status==='need'){job.verify=true;job.message='需要人工验证：'+(job.need?.prompt||job.need?.kind||'');this.cancel(job);}
    if(job.status==='done'||job.status==='failed'){clearInterval(t);res();}},3000);});
   // A paused worker that could not be leased is not an attempt: put it back for the next window.
   if(job.status==='failed'&&LEASE_ERR.test(job.message||'')){
    delete this.state.triedDay[id];this.state.queue.push(id);this.result(id,'deferred',job.message);}
   else if(job.status==='done')this.result(id,'ok',job.message);
   else{
    // One attempt only. Hold the account until the operator chooses: retry or delete.
    const r=job.verify?'needs_verification':'failed';
    this.result(id,r,job.message);
    this.state.held[id]={at:this.now(),result:r,message:String(job.message||'登录失败').slice(0,160)};
   }
   this.job=null;this.save();
  }catch(e){this.log('[NightlyRelogin] tick error: '+String(e.message||e).slice(0,160));}
  finally{this.ticking=false;}
 }
 retry(id){
  id=Number(id);
  if(!Number.isSafeInteger(id)||id<1)throw Error('账号编号无效');
  if(this.job&&this.job.target===id)throw Error('该账号正在登录');
  delete this.state.held[id];
  this.state.queue=[id,...this.state.queue.filter(x=>x!==id)];
  if(!this.state.manual.includes(id))this.state.manual.push(id);
  this.state.lastStartAt=0;this.save();
  this.log('[NightlyRelogin] #'+id+' retry requested by operator');
  setTimeout(()=>this.tick(),1000).unref?.();
  return this.status();
 }
 status(){return {queue:this.state.queue,scanDay:this.state.scanDay,lastStartAt:this.state.lastStartAt,
  nextAt:this.state.queue.length?Math.max(this.state.lastStartAt+GAP_MS,this.now()):null,waiting:this.waiting||null,
  running:this.job?{account:this.job.target,step:this.job.step,status:this.job.status}:null,results:this.state.results,held:this.state.held};}
 start(){setTimeout(()=>this.tick(),90000).unref();setInterval(()=>this.tick(),TICK_MS).unref();}
}
module.exports={NightlyRelogin,registered,day,GAP_MS};
