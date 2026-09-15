'use strict';
const {AsyncLocalStorage}=require('async_hooks');
const requestScope=new AsyncLocalStorage();
class OperationTracker {
 constructor(){this.active=new Map();this.hardQuarantine=false;this.unconfirmed=new Set();}
 get quarantined(){return this.hardQuarantine||this.unconfirmed.size>0;}
 set quarantined(value){if(value)this.hardQuarantine=true;}
 disconnected(id){
  const entry=this.active.get(id);
  if(entry){this.unconfirmed.add(id);entry.done(false);}
 }
 begin(id){
  if(this.quarantined || this.active.size>=2)throw Error('Worker unavailable');
  if(typeof id!=='string' || !id)throw Error('Invalid request ID');
  if(this.active.has(id))throw Error("Duplicate operation");
  let done;
  const promise=new Promise(resolve=>{done=resolve;});
  this.active.set(id,{promise,done});
  const scope=requestScope.getStore();
  if(scope instanceof Set)scope.add(id);
 }
 acknowledge(id){
  const entry=this.active.get(id);
  if(!entry)return false;
  this.active.delete(id);this.unconfirmed.delete(id);
  entry.done(true);
  return true;
 }
 async finishOrCancel(id,sendCancel,graceMs=250,timeoutMs=10000){
  if(graceMs<=0)return this.cancelAndWait(id,sendCancel,timeoutMs);
  const entry=this.active.get(id);if(!entry)return true;
  let timer;
  try{
   const ended=await Promise.race([entry.promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),graceMs);})]);
   if(ended)return true;
  }finally{clearTimeout(timer);}
  return this.cancelAndWait(id,sendCancel,timeoutMs);
 }
 async cancelAndWait(id,sendCancel,timeoutMs=10000){
  const entry=this.active.get(id);
  if(!entry)return true;
  let timer;
  try{
   sendCancel(id);
   const ended=await Promise.race([entry.promise,new Promise(resolve=>{
    timer=setTimeout(()=>resolve(false),timeoutMs);
   })]);
   if(!ended && this.active.has(id))this.unconfirmed.add(id);
   return ended;
  }catch(e){if(this.active.has(id))this.unconfirmed.add(id);throw e;}
  finally{clearTimeout(timer);}
 }
}
module.exports={OperationTracker,requestScope};
