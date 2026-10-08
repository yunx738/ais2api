'use strict';
const fs=require('fs'),path=require('path');
// AI Studio app opened by every worker. Stored as TARGET_URL in each slot's
// worker.env; containers read it when created, so it applies on next rotation.
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parse(input){
 const s=String(input||'').trim();
 if(ID.test(s))return s.toLowerCase();
 let u;try{u=new URL(s);}catch{return null;}
 if(u.protocol!=='https:'||!['ai.studio','aistudio.google.com'].includes(u.hostname))return null;
 const m=u.pathname.match(/^\/apps\/(?:drive\/)?([0-9a-f-]{36})\/?$/i);
 return m&&ID.test(m[1])?m[1].toLowerCase():null;
}
class TargetApp{
 constructor({root,rotate,isBusy}){Object.assign(this,{root,rotate,isBusy});this.applying=null;this.lastApply=null;}
 files(){return ['A','B'].map(s=>path.join(this.root,'slots',s,'worker.env'));}
 read(file){const m=fs.readFileSync(file,'utf8').match(/^TARGET_URL=(.*)$/m);return m?parse(m[1].trim()):null;}
 status(){
  let ids=[];try{ids=this.files().map(f=>this.read(f));}catch{}
  const id=ids[0]&&ids.every(x=>x===ids[0])?ids[0]:null;
  return {configured:!!id,appId:id,url:id?'https://ai.studio/apps/'+id:null,consistent:ids.length===2&&ids[0]===ids[1],
   applying:this.applying,lastApply:this.lastApply};
 }
 save(body){
  const id=parse(body?.url);
  if(!id)throw Object.assign(Error('链接格式不正确'),{statusCode:400});
  for(const file of this.files()){
   const old=fs.readFileSync(file,'utf8'),line='TARGET_URL=https://ai.studio/apps/'+id;
   const next=/^TARGET_URL=.*$/m.test(old)?old.replace(/^TARGET_URL=.*$/m,line):old.replace(/\n?$/,'\n')+line+'\n';
   const tmp=file+'.tmp';fs.writeFileSync(tmp,next,{mode:0o600});fs.renameSync(tmp,file);
  }
  return this.status();
 }
 apply(){
  if(this.applying)throw Object.assign(Error('正在应用'),{statusCode:409});
  if(!this.status().configured)throw Object.assign(Error('请先保存应用链接'),{statusCode:409});
  this.applying={slot:null,startedAt:Date.now()};
  (async()=>{
   const result={};
   for(const slot of ['A','B']){
    this.applying.slot=slot;
    if(this.isBusy(slot)){result[slot]='skipped';continue;}
    try{await this.rotate(slot);result[slot]='ok';}catch{result[slot]='failed';}
   }
   this.lastApply={at:Date.now(),result};
  })().finally(()=>{this.applying=null;});
  return this.status();
 }
}
module.exports={TargetApp,parse};
