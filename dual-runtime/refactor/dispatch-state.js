'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function save(dispatch,file){
 const pool=dispatch.pool;
 const slots=[...dispatch.slots].map(([slot,st])=>[slot,{...st,requests:[...(st.requests||[])]}]);
 const data={version:2,quotaLedger:dispatch.quotas.snapshot(),pool:{ids:pool.ids,cursor:pool.cursor,sequence:pool.sequence,slots:[...pool.slots],cooldowns:[...pool.cooldowns]},dispatch:{slots,cursor:dispatch.cursor,globalUntil:dispatch.globalUntil,halted:dispatch.halted}};
 const temp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
 let fd;
 try{
  fd=fs.openSync(temp,'wx',384);
  fs.writeFileSync(fd,JSON.stringify(data));
  fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  fs.renameSync(temp,file);
  const dir=fs.openSync(path.dirname(file),'r');
  try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
 }finally{
  if(fd!==undefined)fs.closeSync(fd);
  if(fs.existsSync(temp))fs.unlinkSync(temp);
 }
}
function read(file){
 const d=JSON.parse(fs.readFileSync(file,'utf8'));
 if(![1,2].includes(d.version)||typeof d.pool!=='object'||typeof d.dispatch!=='object')throw Error('Invalid checkpoint');
 if(d.version===2)d.quotaLedger=require('./model-quota-ledger').validate(d.quotaLedger);
 const s=d.dispatch;
 if(Array.isArray(s.slots)===false||s.slots.length!==2)throw Error('Invalid slots');
 const seen=new Set();
 for(const [slot,state] of s.slots){
  if(['A','B'].includes(slot)===false||seen.has(slot))throw Error('Invalid slot identity');
  seen.add(slot);
  if(state.requests===undefined&&typeof state.busy==='boolean')state.requests=state.busy&&state.request?[state.request]:[];
  if(state.active===undefined)state.active=state.requests.length;
  if(Number.isSafeInteger(state.active)===false||state.active<0||state.active>2)throw Error('Invalid active count');
  if(Array.isArray(state.requests)===false||state.requests.length!==state.active||state.requests.some(x=>typeof x!=='string'||!x))throw Error('Invalid requests');
  delete state.busy;delete state.request;
  if(state.usesFlash38===undefined){
    const legacy=state.usesFlash!==undefined?state.usesFlash:(Number.isSafeInteger(state.uses)?state.uses:0);
    state.usesFlash38=Number.isSafeInteger(legacy)?legacy:0;
  }
  if(state.usesFlash37===undefined)state.usesFlash37=0;
  if(Number.isSafeInteger(state.usesFlash38)===false||state.usesFlash38<0||state.usesFlash38>100)throw Error('Invalid flash38 uses');
  if(Number.isSafeInteger(state.usesFlash37)===false||state.usesFlash37<0||state.usesFlash37>100)throw Error('Invalid flash37 uses');
  if(state.usesPro===undefined)state.usesPro=0;
  if(Number.isSafeInteger(state.usesPro)===false||state.usesPro<0||state.usesPro>10)throw Error('Invalid pro uses');
  if(state.windowStart===undefined){state.usesFlash37=0;state.usesFlash38=0;state.usesPro=0;state.windowStart=0;}
  if(Number.isSafeInteger(state.windowStart)===false||state.windowStart<0)throw Error('Invalid quota window start');
  delete state.uses;
  if(state.busy && (typeof state.request!=='string'||state.request.length===0))throw Error('Missing active request identity');
  if(new Set(state.requests).size!==state.requests.length)throw Error("Duplicate requests");
  const records=state.executions??{};
  if(!records||typeof records!=="object"||Array.isArray(records))throw Error("Invalid executions");
  for(const [id,t] of Object.entries(records)){
   if(!t||t.id!==id||!state.requests.includes(id)||t.slot!==slot||
      !/^[a-f0-9-]{36}$/.test(id)||!/^[a-f0-9-]{36}$/.test(t.workerEpoch||"")||
      !Number.isSafeInteger(t.account)||t.account<1||
      !(d.version===1?["flash37","flash38","pro"]:["flash","pro"]).includes(t.kind)||
      (d.version===2 && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(t.model||""))||
      !["running","reconciling"].includes(t.phase)||
      !Number.isSafeInteger(t.createdAt)||t.createdAt<1)throw Error("Invalid persisted execution");
   if(t.admissionDeadline!==undefined && (!Number.isSafeInteger(t.admissionDeadline)||t.admissionDeadline!==t.createdAt+30000))throw Error("Invalid admission deadline"); t.phase="reconciling";
  }
  const retired=state.retirements??{};
  if(!retired||typeof retired!=="object"||Array.isArray(retired)||Object.keys(retired).length>1024)throw Error("Invalid retirements");
  for(const [id,t] of Object.entries(retired)){
   if(!t||t.id!==id||state.requests.includes(id)||t.slot!==slot||
      !/^[a-f0-9-]{36}$/.test(id)||!/^[a-f0-9-]{36}$/.test(t.workerEpoch||"")||
      !Number.isSafeInteger(t.account)||t.account<1||t.phase!=="settled"||
      !(d.version===1?["flash37","flash38","pro"]:["flash","pro"]).includes(t.kind)||
      (d.version===2 && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(t.model||""))||
      !Number.isSafeInteger(t.createdAt)||t.createdAt<1)throw Error("Invalid retirement");
  }
  for(const t of Object.values(retired))if(t.admissionDeadline!==undefined && (!Number.isSafeInteger(t.admissionDeadline)||t.admissionDeadline!==t.createdAt+30000))throw Error("Invalid retirement deadline"); state.retirements=retired;
  state.executions=records;
  state.ready=false;
 }
 if(Number.isSafeInteger(s.cursor)===false||s.cursor<0||s.cursor>1||Number.isFinite(s.globalUntil)===false||s.globalUntil<0||typeof s.halted!=='boolean')throw Error('Invalid dispatch metadata');
 return d;
}
module.exports={save,read};
