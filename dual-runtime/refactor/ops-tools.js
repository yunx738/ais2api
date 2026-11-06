'use strict';
// Operations data for the console "运维" page: host load, service units, containers, log tails and a few
// maintenance actions. Read-only helpers run fixed commands only (no user input reaches a shell).
const fs=require('fs'),os=require('os'),{execFile}=require('child_process');
const run=(cmd,args,timeout=15000)=>new Promise(r=>execFile(cmd,args,{timeout,maxBuffer:8*1024*1024},(e,out,err)=>r({ok:!e,out:String(out||''),err:String(err||e?.message||'')})));
const UNITS=Object.freeze({headless:'ais2api-headless',coordinator:'ais2api-dual-coordinator',login:'ais2api-login'});
const UNIT_NAMES=Object.freeze({headless:'无浏览器服务',coordinator:'调度器',login:'登录服务'});
const CONTAINERS=Object.freeze(['ais2api-dual-a','ais2api-dual-b','ais2api-dual-management']);
// Hide credentials that appear in log lines (proxy URLs, bearer tokens, long secrets).
function mask(s){
 return String(s)
  .replace(/(\w+:\/\/)[^\s:@\/]+:[^\s@\/]+@/g,'$1***@')
  .replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]{8,}/gi,'$1***')
  .replace(/\b(sk-|AIza)[A-Za-z0-9_-]{8,}/g,'$1***')
  .replace(/\b[a-f0-9]{40,}\b/gi,m=>m.slice(0,6)+'…');
}
function memInfo(){
 try{const t=fs.readFileSync('/proc/meminfo','utf8'),g=k=>Number((t.match(new RegExp('^'+k+':\\s+(\\d+)','m'))||[])[1]||0)*1024;
  return {total:g('MemTotal'),available:g('MemAvailable'),swapTotal:g('SwapTotal'),swapFree:g('SwapFree')};}
 catch{return {total:os.totalmem(),available:os.freemem(),swapTotal:0,swapFree:0};}
}
function disk(p='/'){try{const s=fs.statfsSync(p);return {total:s.blocks*s.bsize,free:s.bavail*s.bsize};}catch{return null;}}
async function unit(key){
 const r=await run('systemctl',['show',UNITS[key],'-p','ActiveState','-p','SubState','-p','MemoryCurrent','-p','ActiveEnterTimestamp','-p','NRestarts','-p','MemoryMax']);
 const kv=Object.fromEntries(r.out.split('\n').filter(Boolean).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));
 const num=v=>/^\d+$/.test(v||'')?Number(v):null;
 const since=kv.ActiveEnterTimestamp?Date.parse(kv.ActiveEnterTimestamp.replace(/ [A-Z]{2,5}$/,''))||null:null;
 return {key,unit:UNITS[key],name:UNIT_NAMES[key],state:kv.ActiveState||'unknown',sub:kv.SubState||'',memory:num(kv.MemoryCurrent),memoryMax:num(kv.MemoryMax),since,restarts:num(kv.NRestarts)};
}
async function containers(){
 const r=await run('docker',['ps','-a','--format','{{.Names}}\t{{.State}}\t{{.Status}}']);
 const rows=r.out.split('\n').filter(Boolean).map(l=>{const [name,state,status]=l.split('\t');return {name,state,status};});
 return CONTAINERS.map(n=>rows.find(x=>x.name===n)||{name:n,state:'missing',status:''});
}
async function version(cwd){
 const r=await run('git',['-C',cwd,'log','-1','--format=%h%x09%ct%x09%s']);
 const [hash,at,subject]=r.out.trim().split('\t');
 const d=await run('git',['-C',cwd,'status','--porcelain']);
 return {hash:hash||null,at:at?Number(at)*1000:null,subject:subject||'',dirty:d.out.split('\n').filter(l=>l&&!l.startsWith('??')).length};
}
async function overview({cwd}){
 const [units,ctr,ver]=await Promise.all([Promise.all(Object.keys(UNITS).map(unit)),containers(),version(cwd)]);
 return {at:Date.now(),host:{hostname:os.hostname(),uptime:os.uptime(),load:os.loadavg(),cpus:os.cpus().length,memory:memInfo(),disk:disk('/')},units,containers:ctr,version:ver};
}
const LEVELS=['debug','info','warn','error'];
// Last n lines of a log source as {t,level,source,msg}.
async function logs(source,n=200){
 n=Math.max(20,Math.min(1000,Number(n)||200));
 if(source==='headless'){
  let text='';
  try{const fd=fs.openSync('/opt/as2a-nb/run.log','r');const st=fs.fstatSync(fd);const len=Math.min(st.size,n*600);const buf=Buffer.alloc(len);fs.readSync(fd,buf,0,len,st.size-len);fs.closeSync(fd);text=buf.toString('utf8');}catch{}
  const lines=text.split('\n').filter(Boolean);if(text&&lines.length)lines.shift();
  return lines.slice(-n).map(l=>{try{const j=JSON.parse(l);const rq=j.request;
   const msg=rq?(rq.method+' '+rq.path+' '+(rq.status??rq.state??'')+(rq.duration_ms!==undefined?' '+Math.round(rq.duration_ms)+'ms':'')+(rq.error?' '+rq.error:'')):j.msg;
   return {t:Date.parse(j.time)||null,level:String(j.level||'info').toLowerCase(),source:j.source||'',msg:mask(msg||'')};}
   catch{return {t:null,level:'info',source:'',msg:mask(l)};}});
 }
 const u=UNITS[source];if(!u)throw Object.assign(Error('未知日志来源'),{statusCode:400});
 const r=await run('journalctl',['-u',u,'-n',String(n),'--no-pager','-o','json','--output-fields=MESSAGE,PRIORITY,__REALTIME_TIMESTAMP']);
 return r.out.split('\n').filter(Boolean).map(l=>{try{const j=JSON.parse(l);const p=Number(j.PRIORITY);
  const msg=Array.isArray(j.MESSAGE)?Buffer.from(j.MESSAGE).toString('utf8'):String(j.MESSAGE||'');
  const level=p<=3||/error|failed|失败/i.test(msg)?'error':p===4||/\bwarn|gave up|cooldown/i.test(msg)?'warn':'info';
  return {t:Math.round(Number(j.__REALTIME_TIMESTAMP)/1000)||null,level,source:'',msg:mask(msg)};}catch{return null;}}).filter(Boolean);
}
async function restartUnit(key){
 if(!UNITS[key])throw Object.assign(Error('未知服务'),{statusCode:400});
 // The coordinator restarts itself a moment later so this reply can still be delivered.
 if(key==='coordinator'){run('systemd-run',['--on-active=2','--unit=ais2api-ops-restart-'+Date.now(),'/bin/systemctl','restart',UNITS[key]]);return {scheduled:true};}
 const r=await run('systemctl',['restart',UNITS[key]],60000);
 if(!r.ok)throw Object.assign(Error('重启失败：'+r.err.slice(0,200)),{statusCode:409});
 return {restarted:true};
}
const BACKUP_DIR='/root/auth-backup';
function backups(){try{return fs.readdirSync(BACKUP_DIR).filter(n=>/^auth-\d{8}-\d{4,6}\.tgz$/.test(n)).sort().reverse().slice(0,20).map(n=>{const st=fs.statSync(BACKUP_DIR+'/'+n);return {name:n,size:st.size,at:st.mtimeMs};});}catch{return [];}}
async function backup(){
 fs.mkdirSync(BACKUP_DIR,{recursive:true,mode:0o700});
 const d=new Date(Date.now()+8*3600000).toISOString(),name='auth-'+d.slice(0,10).replace(/-/g,'')+'-'+d.slice(11,19).replace(/:/g,'')+'.tgz';
 const r=await run('tar',['czf',BACKUP_DIR+'/'+name,'-C','/opt/ais2api','auth','-C','/opt/as2a-nb','auth','import-state.json'],60000);
 if(!r.ok)throw Object.assign(Error('备份失败：'+r.err.slice(0,160)),{statusCode:409});
 fs.chmodSync(BACKUP_DIR+'/'+name,0o600);
 const all=fs.readdirSync(BACKUP_DIR).filter(n=>/^auth-\d{8}-\d{4,6}\.tgz$/.test(n)).sort();for(const n of all.slice(0,Math.max(0,all.length-20)))fs.unlinkSync(BACKUP_DIR+'/'+n);
 return {name,backups:backups()};
}
module.exports={backup,backups,overview,logs,restartUnit,mask,UNITS,LEVELS};
