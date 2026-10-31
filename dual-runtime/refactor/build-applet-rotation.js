'use strict';
// Nightly Build project (applet) rotation.
// Google keeps every Build chat inside the applet and has no per-chat delete, so once a night each Build
// account gets a fresh minimal applet: CreateApplet -> switch build-apps.json -> DeleteApplet(old).
// Runs only through the account's live worker page (page auth), only when that worker is idle.
const fs=require('fs');
const APP=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME='GW Text Bridge',DESC='Minimal private project for text-chat context files.';
function createRequest(){
 const meta=[NAME,DESC];
 const md=Buffer.from(JSON.stringify({name:NAME,description:DESC,requestFramePermissions:[]},null,2));
 const html=Buffer.from('<!doctype html><html><body>Ready</body></html>\n');
 return [null,meta,null,[meta,[['metadata.json',md.toString('base64')],['index.html',html.toString('base64')]]]];
}
function parseCreated(out){
 if(!out||out.status!==200)return null;
 try{const d=JSON.parse(out.text);const id=Array.isArray(d)?String(d[0]||'').toLowerCase():'';return APP.test(id)?id:null;}catch{return null;}
}
const deleted=d=>!!d&&(d.status===200||d.status===404);
// Beijing (UTC+8) hour, independent of host timezone.
const bjHour=t=>new Date(t+8*3600000).getUTCHours();
class BuildAppletRotation{
 constructor({appsFile,stateFile,rpc,slotOf,now=Date.now,log=console,window=[3,6],minGapMs=20*3600000}){
  Object.assign(this,{appsFile,stateFile,rpc,slotOf,now,log,window,minGapMs});
  this.running=false;this.last=null;
 }
 readApps(){try{return JSON.parse(fs.readFileSync(this.appsFile,'utf8'));}catch{return null;}}
 writeApps(d){const t=this.appsFile+'.tmp';fs.writeFileSync(t,JSON.stringify(d));fs.renameSync(t,this.appsFile);}
 readState(){try{const s=JSON.parse(fs.readFileSync(this.stateFile,'utf8'));return s&&s.accounts&&typeof s.accounts==='object'?s:{accounts:{}};}catch{return {accounts:{}};}}
 writeState(s){const t=this.stateFile+'.tmp';fs.writeFileSync(t,JSON.stringify(s,null,1));fs.renameSync(t,this.stateFile);}
 inWindow(){const h=bjHour(this.now());return h>=this.window[0]&&h<this.window[1];}
 async tick({force=false,only=null}={}){
  if(this.running)return {skipped:'running'};
  if(!force&&!this.inWindow())return {skipped:'window'};
  const apps=this.readApps();if(!apps)return {skipped:'apps_unreadable'};
  this.running=true;
  try{
   const state=this.readState(),results={};
   for(const key of Object.keys(apps)){
    if(!/^\d+$/.test(key)||!APP.test(String(apps[key]).toLowerCase()))continue;
    if(only!==null&&Number(key)!==only)continue;
    const id=Number(key),slot=this.slotOf(id);
    const st=state.accounts[key]=state.accounts[key]||{lastAt:0,pendingDelete:[]};
    st.pendingDelete=Array.isArray(st.pendingDelete)?st.pendingDelete:[];
    if(!slot){results[key]='offline';continue;}
    try{
     const cur=String(apps[key]).toLowerCase();
     // Retry deletes that failed earlier (never the applet currently in use).
     for(const old of [...st.pendingDelete]){
      if(old===cur||deleted(await this.rpc(slot,'DeleteApplet',[old])))st.pendingDelete=st.pendingDelete.filter(x=>x!==old);
     }
     if(!force&&this.now()-(st.lastAt||0)<this.minGapMs){results[key]='recent';continue;}
     const created=parseCreated(await this.rpc(slot,'CreateApplet',createRequest()));
     if(!created){results[key]='create_failed';st.lastError='create_failed';continue;}
     const fresh=this.readApps();if(!fresh)throw Error('apps_unreadable');
     fresh[key]=created;this.writeApps(fresh);
     st.lastAt=this.now();st.app=created;delete st.lastError;
     let d;try{d=await this.rpc(slot,'DeleteApplet',[cur]);}catch{d=null;}
     if(deleted(d))results[key]='rotated';
     else{st.pendingDelete=[...new Set([...st.pendingDelete,cur])];results[key]='rotated_delete_pending';}
     this.log.log('[BuildRotation] #'+key+' '+cur.slice(0,8)+' -> '+created.slice(0,8)+' '+results[key]);
    }catch(e){results[key]='error';st.lastError=String(e.message||e).slice(0,120);}
   }
   this.writeState(state);
   this.last={at:this.now(),results};
   return results;
  }finally{this.running=false;}
 }
 status(){return {window:this.window,last:this.last,accounts:this.readState().accounts};}
}
module.exports={BuildAppletRotation,createRequest,parseCreated,bjHour};
