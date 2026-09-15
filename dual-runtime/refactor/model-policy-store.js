"use strict";
const fs=require("fs"),path=require("path"),{randomUUID}=require("crypto");
function validate(policies){
 if(!policies||typeof policies!=="object"||Array.isArray(policies))throw Error("Invalid policies");
 const entries=Object.entries(policies);
 if(entries.length>10000)throw Error("Too many policies");
 return Object.fromEntries(entries.map(([id,p])=>{
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id)||!p||Array.isArray(p)||
     Object.keys(p).some(k=>!["quotaFamily","antiTruncation"].includes(k))||
     !["flash","pro"].includes(p.quotaFamily)||
     typeof p.antiTruncation!=="boolean")throw Error("Invalid model policy");
  return [id,{quotaFamily:p.quotaFamily,antiTruncation:p.antiTruncation}];
 }));
}
class ModelPolicyStore{
 constructor(file,initial={}){
  this.file=file;this.blocked=false;this.revision=0;this.policies=validate(initial);
  try{
   const stat=fs.lstatSync(file);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4194304)throw Error("Invalid policy file");
   const d=JSON.parse(fs.readFileSync(file,"utf8"));
   if(d.version!==2||!Number.isSafeInteger(d.revision)||d.revision<1)throw Error("Invalid policy revision");
   this.policies=validate(d.policies);this.revision=d.revision;
  }catch(e){if(e.code!=="ENOENT")throw e;}
 }
 snapshot(){return {revision:this.revision,policies:structuredClone(this.policies),blocked:this.blocked};}
 set({model,quotaFamily,antiTruncation,revision}){
  if(this.blocked)throw Error("Policy storage requires reconciliation");
  if(revision!==this.revision)throw Object.assign(Error("Policy revision changed; refresh first"),{statusCode:409});
  if(typeof model!=="string")throw Error("Model ID required");
  const entry=validate({[model]:{quotaFamily,antiTruncation}});
  const next=validate({...this.policies,...entry});
  const value={version:2,revision:this.revision+1,policies:next};
  const temp=this.file+"."+randomUUID()+".tmp";let fd,renamed=false;
  try{
   fd=fs.openSync(temp,"wx",384);
   fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
   fs.renameSync(temp,this.file);renamed=true;
   const directory=fs.openSync(path.dirname(this.file),"r");
   try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
   this.policies=next;this.revision=value.revision;
   return this.snapshot();
  }catch{
   if(renamed)this.blocked=true;
   throw Error("Policy save not confirmed; refresh before retry");
  }finally{
   if(fd!==undefined)fs.closeSync(fd);
   if(!renamed){try{fs.unlinkSync(temp);}catch{}}
  }
 }
}
module.exports={ModelPolicyStore,validate};
