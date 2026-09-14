'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function save(dispatch,file){
 const pool=dispatch.pool;
 const slots=[...dispatch.slots].map(([slot,st])=>[slot,{...st,requests:[...(st.requests||[])]}]);
 const data={version:1,pool:{ids:pool.ids,cursor:pool.cursor,sequence:pool.sequence,slots:[...pool.slots],cooldowns:[...pool.cooldowns]},dispatch:{slots,cursor:dispatch.cursor,globalUntil:dispatch.globalUntil,halted:dispatch.halted}};
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
 if(d.version!==1||typeof d.pool!=='object'||typeof d.dispatch!=='object')throw Error('Invalid checkpoint');
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
  delete state.uses;
  if(state.busy && (typeof state.request!=='string'||state.request.length===0))throw Error('Missing active request identity');
  state.ready=false;
 }
 if(Number.isSafeInteger(s.cursor)===false||s.cursor<0||s.cursor>1||Number.isFinite(s.globalUntil)===false||s.globalUntil<0||typeof s.halted!=='boolean')throw Error('Invalid dispatch metadata');
 return d;
}
module.exports={save,read};
