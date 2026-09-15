'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {validatePrice}=require('./usage-metrics');
const clone=v=>JSON.parse(JSON.stringify(v));
const fail=(message,statusCode)=>Object.assign(Error(message),{statusCode});
function cleanPrice(p,revision){
 const out={currency:p?.currency,revision:String(revision),reasoningMode:p?.reasoningMode};
 for(const key of ['inputPerMillion','outputPerMillion','cachedPerMillion','reasoningPerMillion']){
  out[key]=p?.[key];
  if(typeof out[key]==='number' && out[key]>1000000)throw fail('Price rate too large',400);
 }
 try{validatePrice(out);}catch{throw fail('Invalid model price',400);}
 return out;
}
class ModelPriceStore{
 constructor(file){
  this.file=file;this.revision=0;this.prices=Object.create(null);this.blocked=false;
  try{
   const stat=fs.lstatSync(file);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2097152)throw Error('Invalid price file');
   const data=JSON.parse(fs.readFileSync(file,'utf8'));
   if(data.version!==1||!Number.isSafeInteger(data.revision)||data.revision<0||
     !data.prices||typeof data.prices!=='object'||Array.isArray(data.prices))throw Error('Invalid price file');
   for(const [model,p] of Object.entries(data.prices)){
    this.validateModel(model);
    if(!/^\d+$/.test(p.revision)||!Number.isSafeInteger(Number(p.revision))||
      Number(p.revision)>data.revision)throw Error('Invalid price revision');
    this.prices[model]=cleanPrice(p,p.revision);
   }
   this.revision=data.revision;
  }catch(e){if(e.code!=='ENOENT')throw Error('Price configuration invalid; file preserved');}
 }
 validateModel(model){
  if(typeof model!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(model))throw fail('Canonical model ID required',400);
 }
 snapshot(){return {version:1,revision:this.revision,prices:clone(this.prices),blocked:this.blocked,currency:'USD',estimated:true};}
 get(model){if(this.blocked)return;const p=this.prices[model];return p?clone(p):undefined;}
 set(input){
  if(this.blocked)throw fail('Price storage blocked; reconcile before retry',503);
  this.validateModel(input?.model);
  if(!Number.isSafeInteger(input.revision)||input.revision<0)throw fail('Invalid price revision',400);
  if(input.revision!==this.revision)throw fail('Price revision changed; refresh first',409);
  if(this.revision===Number.MAX_SAFE_INTEGER)throw fail('Price revision capacity reached',503);
  const revision=this.revision+1,price=cleanPrice(input.price,revision);
  if(!Object.hasOwn(this.prices,input.model)&&Object.keys(this.prices).length>=1000)throw fail('Price catalog capacity reached',400);
  const prices=Object.assign(Object.create(null),this.prices,{[input.model]:price});
  const payload=JSON.stringify({version:1,revision,prices})+'\n';
  const dir=path.dirname(this.file),tmp=this.file+'.'+crypto.randomUUID()+'.tmp';
  let fd;
  try{
   fd=fs.openSync(tmp,'wx',0o600);
   fs.writeFileSync(fd,payload);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
   fs.renameSync(tmp,this.file);
   const d=fs.openSync(dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
   this.prices=prices;this.revision=revision;
   return this.snapshot();
  }catch{
   this.blocked=true;
   throw fail('Price save not confirmed; reconcile before retry',503);
  }finally{
   if(fd!==undefined)try{fs.closeSync(fd);}catch{}
   try{fs.unlinkSync(tmp);}catch{}
  }
 }
}
module.exports={ModelPriceStore};
