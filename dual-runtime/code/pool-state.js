'use strict';
const fs=require('fs');
const {AccountPool}=require('./account-pool');
function save(pool,file){
 const data={version:1,ids:pool.ids,cursor:pool.cursor,sequence:pool.sequence,slots:[...pool.slots],cooldowns:[...pool.cooldowns]};
 const temp=file+'.tmp';
 const fd=fs.openSync(temp,'w',384);
 try{fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(temp,file);
 const dir=fs.openSync(require('path').dirname(file),'r');
 try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function load(file){
 const d=JSON.parse(fs.readFileSync(file,'utf8'));
 if(d.version!==1||!Array.isArray(d.ids)||!Array.isArray(d.slots)||!Array.isArray(d.cooldowns))throw Error('Invalid pool state');
 if(d.ids.some(x=>!Number.isSafeInteger(x)||x<1)||new Set(d.ids).size!==d.ids.length)throw Error('Invalid account IDs');
 if(!Number.isSafeInteger(d.cursor)||d.cursor<0||!Number.isSafeInteger(d.sequence)||d.sequence<0)throw Error('Invalid counters');
 const p=new AccountPool(d.ids);p.cursor=d.cursor;p.sequence=d.sequence;
 for(const [slot,s] of d.slots){
  if(!['A','B'].includes(slot)||p.slots.has(slot)||!s)throw Error('Invalid slot');
  for(const id of [s.current,s.pending?.id]){
   if(id===undefined||Object.is(id,JSON.parse(String.fromCharCode(110,117,108,108))))continue;
   if(!p.ids.includes(id)||p.owners.has(id))throw Error('Duplicate or unknown ownership');
   p.owners.set(id,slot);
  }
  if(s.pending&&(!Number.isSafeInteger(s.pending.token)||s.pending.token<1||s.pending.token>p.sequence))throw Error('Invalid reservation');
  p.slots.set(slot,s);
 }
 for(const [id,until] of d.cooldowns){
  if(!p.ids.includes(id)||!Number.isFinite(until))throw Error('Invalid cooldown');
  p.cooldowns.set(id,until);
 }
 return p;
}
module.exports={save,load};
