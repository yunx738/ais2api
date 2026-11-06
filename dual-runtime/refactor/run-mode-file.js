'use strict';
// run-mode.json: {mode:'headless'|'dual'|'single', single, parked}. Missing mode = headless (the default).
// Browser modes keep the old {single, parked} fields for BrowserLease.
const fs=require('fs'),path=require('path');
const MODES=['headless','dual','single'];
function file(root){return path.join(root,'run-mode.json');}
function read(root){
 let m={};try{m=JSON.parse(fs.readFileSync(file(root),'utf8'))||{};}catch{}
 const mode=MODES.includes(m.mode)?m.mode:'headless';
 return {mode,single:m.single===true,parked:['A','B'].includes(m.parked)?m.parked:null};
}
function write(root,mode){
 if(!MODES.includes(mode))throw Object.assign(Error('运行模式只能是 headless、dual 或 single'),{statusCode:400});
 const cur=read(root);
 const next={mode,single:mode==='single',parked:mode==='single'?(cur.parked||'B'):null};
 const t=file(root)+'.tmp';fs.writeFileSync(t,JSON.stringify(next),{mode:0o600});fs.renameSync(t,file(root));
 return next;
}
// Restart the coordinator a moment later (the current process drains first via SIGTERM).
function scheduleRestart(){
 const {execFile}=require('child_process');
 execFile('systemd-run',['--on-active=2','--unit=ais2api-mode-switch-'+Date.now(),'/bin/systemctl','restart','ais2api-dual-coordinator.service'],{timeout:10000},()=>{});
}
module.exports={read,write,scheduleRestart,MODES};
