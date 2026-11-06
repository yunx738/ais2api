'use strict';
// Keeps the no-browser service's account directories (/opt/as2a-nb/auth/<email>/) in step with the login files
// (/opt/ais2api/auth/auth-<id>.json). A login file newer than the last import replaces storage-state.json
// (fresh login wins); otherwise the service's own refreshed cookies are left alone. Returns whether a reload is needed.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {accountEmail}=require('./headless-forward');
function writeAtomic(file,data){
 const tmp=file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
 const fd=fs.openSync(tmp,'wx',0o600);
 try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(tmp,file);
}
class HeadlessImport{
 constructor({authDir='/opt/ais2api/auth',target='/opt/as2a-nb/auth',stateFile='/opt/as2a-nb/import-state.json',proxyFor=()=>'' ,log=console}={}){
  Object.assign(this,{authDir,target,stateFile,proxyFor,log});
 }
 state(){try{return JSON.parse(fs.readFileSync(this.stateFile,'utf8'));}catch{return {accounts:{}};}}
 save(s){writeAtomic(this.stateFile,JSON.stringify(s));}
 // ids: coordinator pool ids that are not deleted. Returns {changed:[ids], added:[ids], skipped:{id:reason}}.
 sync(ids){
  const st=this.state();st.accounts||={};
  const out={changed:[],added:[],skipped:{}};
  fs.mkdirSync(this.target,{recursive:true,mode:0o700});
  for(const id of ids){
   const file=path.join(this.authDir,'auth-'+id+'.json');
   let stat;try{stat=fs.statSync(file);}catch{out.skipped[id]='no_auth_file';continue;}
   const email=accountEmail(id,this.authDir);
   if(!email){out.skipped[id]='no_email';continue;}
   const dir=path.join(this.target,email),prev=st.accounts[id];
   const fresh=!fs.existsSync(path.join(dir,'storage-state.json'));
   if(!fresh&&prev&&prev.email===email&&prev.mtime>=stat.mtimeMs)continue;
   let data;try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch{out.skipped[id]='unreadable';continue;}
   if(!Array.isArray(data.cookies)||!data.cookies.length){out.skipped[id]='no_cookies';continue;}
   fs.mkdirSync(dir,{recursive:true,mode:0o700});
   const storage={cookies:data.cookies,origins:Array.isArray(data.origins)?data.origins:[],accountName:email};
   if(data.accountTier)storage.accountTier=data.accountTier;
   writeAtomic(path.join(dir,'storage-state.json'),JSON.stringify(storage));
   const cfgFile=path.join(dir,'account.json');
   let cfg={};try{cfg=JSON.parse(fs.readFileSync(cfgFile,'utf8'));}catch{}
   const next={label:email,enabled:true,proxy:cfg.proxy!==undefined?cfg.proxy:this.proxyFor(id,data),locale:'en-US',timezone:'Europe/Berlin'};
   if(JSON.stringify(next)!==JSON.stringify(cfg))writeAtomic(cfgFile,JSON.stringify(next,null,1));
   st.accounts[id]={email,mtime:stat.mtimeMs,at:Date.now()};
   (fresh?out.added:out.changed).push(id);
  }
  if(out.added.length||out.changed.length)this.save(st);
  return out;
 }
 // Cookies refreshed by the service (storage-state.json newer than our last import) are written back to
 // auth-<id>.json so browser mode and the login service see them. Other fields in the login file are kept.
 writeBack(ids){
  const st=this.state();st.accounts||={};const out={written:[],skipped:{}};
  for(const id of ids){
   const prev=st.accounts[id];if(!prev)continue;
   const file=path.join(this.authDir,'auth-'+id+'.json'),src=path.join(this.target,prev.email,'storage-state.json');
   let ss,as;try{ss=fs.statSync(src);as=fs.statSync(file);}catch{continue;}
   if(ss.mtimeMs<=(prev.at||0)+1000||as.mtimeMs>prev.mtime+1)continue; // not refreshed, or the login file changed meanwhile (import wins)
   let state,auth;try{state=JSON.parse(fs.readFileSync(src,'utf8'));auth=JSON.parse(fs.readFileSync(file,'utf8'));}catch{out.skipped[id]='unreadable';continue;}
   if(!Array.isArray(state.cookies)||!state.cookies.length){out.skipped[id]='no_cookies';continue;}
   if(JSON.stringify(state.cookies)===JSON.stringify(auth.cookies)){st.accounts[id]={...prev,at:Date.now()};continue;}
   const next={...auth,cookies:state.cookies};if(Array.isArray(state.origins)&&state.origins.length)next.origins=state.origins;
   writeAtomic(file,JSON.stringify(next));try{fs.chownSync(file,as.uid,as.gid);fs.chmodSync(file,0o600);}catch{}
   const m=fs.statSync(file).mtimeMs;st.accounts[id]={...prev,mtime:m,at:Date.now()};out.written.push(id);
  }
  this.save(st);return out;
 }
 has(id){const e=accountEmail(id,this.authDir);return !!e&&fs.existsSync(path.join(this.target,e,'storage-state.json'));}
}
module.exports={HeadlessImport};
