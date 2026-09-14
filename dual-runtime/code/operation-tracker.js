'use strict';
const {AsyncLocalStorage}=require('async_hooks');
const requestScope=new AsyncLocalStorage();
class OperationTracker {
 constructor(){this.active=new Map();this.quarantined=false;}
 begin(id){
  if(this.quarantined || this.active.size>=2)throw Error('Worker unavailable');
  if(typeof id!=='string' || !id)throw Error('Invalid request ID');
  let done;
  const promise=new Promise(resolve=>{done=resolve;});
  this.active.set(id,{promise,done});
  const scope=requestScope.getStore();
  if(scope instanceof Set)scope.add(id);
 }
 acknowledge(id){
  const entry=this.active.get(id);
  if(!entry)return false;
  this.active.delete(id);
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
   if(!ended)this.quarantined=true;
   return ended;
  }catch(e){this.quarantined=true;throw e;}
  finally{clearTimeout(timer);}
 }
}
module.exports={OperationTracker,requestScope};
