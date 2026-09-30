'use strict';
// Host-side service: one throwaway browser container per login, then import.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {spawn}=require('child_process');
const ROOT='/opt/ais2api',AUTH=path.join(ROOT,'auth'),RT=path.join(ROOT,'dual-runtime');
const cfg=JSON.parse(fs.readFileSync(path.join(RT,'coordinator.json'),'utf8'));
const KEY=cfg.apiKeys[0],IMAGE=cfg.image,PORT=8894;
const UPFILE='/opt/ais2api-direct/login-upstream.env';
const RUNNER=path.join(RT,'login','login-runner.js');
const jobs=new Map();
const eq=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const send=(res,code,body)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
const EMAIL=/^[^\s@]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;
const DOMAIN=/^\.?([a-z0-9-]+\.)*google\.com$/i;
const ORIGINS=['https://aistudio.google.com','https://ai.studio','https://accounts.google.com'];
function upstream(){try{const l=fs.readFileSync(UPFILE,'utf8').split('\n').find(x=>x.startsWith('UPSTREAM='));return l?l.slice(9).trim():'';}catch{return '';}}
function memMb(){try{return Number(fs.readFileSync('/proc/meminfo','utf8').match(/MemAvailable:\s+(\d+)/)[1])/1024;}catch{return 0;}}
function view(j){return {id:j.id,status:j.status,step:j.step,need:j.need||null,message:j.message||'',account:j.account||null};}
function cleanStorage(storage){
 const cookies=(storage.cookies||[]).filter(c=>c&&typeof c.name==='string'&&c.name&&c.name.length<=256&&
  typeof c.value==='string'&&c.value.length<=16384&&typeof c.domain==='string'&&DOMAIN.test(c.domain)&&
  typeof c.path==='string'&&c.path.startsWith('/')&&Number.isFinite(c.expires)&&c.expires>=-1&&
  ['Lax','Strict','None'].includes(c.sameSite)).slice(0,200)
  .map(c=>({name:c.name,value:c.value,domain:c.domain,path:c.path,expires:c.expires,httpOnly:!!c.httpOnly,secure:!!c.secure,sameSite:c.sameSite}));
 const origins=(storage.origins||[]).filter(o=>o&&ORIGINS.includes(o.origin)).slice(0,20)
  .map(o=>({origin:o.origin,localStorage:(o.localStorage||[]).filter(v=>v&&typeof v.name==='string'&&typeof v.value==='string'&&v.name.length<=1024&&v.value.length<=65536).slice(0,200).map(v=>({name:v.name,value:v.value}))}));
 return {cookies,origins};
}
function writeAccount(storage,email){
 const {cookies,origins}=cleanStorage(storage);
 if(cookies.filter(c=>/^(SID|__Secure-1PSID|__Secure-3PSID|SAPISID|HSID|SSID)$/.test(c.name)).length<3)throw Error('登录状态不完整');
 const names=fs.readdirSync(AUTH).filter(n=>/^auth-\d+\.json$/.test(n));
 if(names.length>=50)throw Error('账号数量已达上限');
 const index=Math.max(0,...names.map(n=>Number(n.match(/\d+/)[0])))+1;
 const content=JSON.stringify({cookies,origins,accountName:email});
 if(Buffer.byteLength(content)>262144)throw Error('登录数据过大');
 const file=path.join(AUTH,'auth-'+index+'.json');
 const fd=fs.openSync(file,'wx',0o600);
 try{fs.writeFileSync(fd,content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.chownSync(file,1000,1000);
 return index;
}
function syncPool(){
 return new Promise(resolve=>{
  const req=http.request({host:'127.0.0.1',port:8890,path:'/internal/sync-accounts',method:'POST',
   headers:{Authorization:'Bearer '+KEY,'Content-Type':'application/json','Content-Length':2}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode===200));});
  req.on('error',()=>resolve(false));req.setTimeout(15000,()=>{req.destroy();resolve(false);});req.end('{}');
 });
}
function alreadyImported(email){
 const want=email.toLowerCase();
 for(const n of fs.readdirSync(AUTH)){if(!/^auth-\d+\.json$/.test(n))continue;
  try{if(String(JSON.parse(fs.readFileSync(path.join(AUTH,n),'utf8')).accountName||'').toLowerCase()===want)return Number(n.match(/\d+/)[0]);}catch{}}
 return 0;
}
function startJob(email,password){
 const id=crypto.randomUUID(),name='ais-login-'+id.slice(0,8);
 const job={id,name,email,status:'running',step:'starting',need:null,message:'',account:null,created:Date.now(),updated:Date.now()};
 jobs.set(id,job);
 const up=upstream();
 const child=spawn('docker',['run','--rm','-i','--name',name,'--user','1000:1000','--memory','1100m','--shm-size','256m',
  '--pids-limit','256','--cap-drop','ALL','--security-opt','no-new-privileges:true','--log-driver','none',
  '-v',RUNNER+':/app/login-runner.js:ro','-v','/opt/ais2api/proxy-relay:/relay:ro',
  '--entrypoint','node',IMAGE,'/app/login-runner.js'],{stdio:['pipe','pipe','ignore']});
 job.child=child;
 child.stdin.on('error',()=>{});
 child.stdin.write(JSON.stringify({email,password,upstream:up||undefined})+'\n');
 password=null;
 let buf='';
 child.stdout.on('data',async d=>{
  buf+=d.toString('utf8');if(buf.length>2097152){buf='';return;}
  let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);
   let m;try{m=JSON.parse(line);}catch{continue;}
   job.updated=Date.now();
   if(m.type==='status'){job.step=m.step;job.need=null;job.status='running';}
   else if(m.type==='need'){job.status='need';job.need={kind:m.kind,prompt:m.prompt};}
   else if(m.type==='result'){
    job.need=null;
    if(!m.ok){job.status='failed';job.message=m.message||'登录失败';continue;}
    try{job.account=writeAccount(m.storage,email);m.storage=null;
     const ok=await syncPool();job.status='done';job.message=ok?'':'账号已保存，同步账号池未确认';}
    catch(e){job.status='failed';job.message=e.message;}
   }
  }
 });
 child.on('close',()=>{job.child=null;if(job.status==='running'||job.status==='need'){job.status='failed';job.message=job.message||'登录进程已结束';}});
 return job;
}
function cancel(job){
 if(job.child){try{job.child.stdin.write('{"cancel":true}\n');}catch{}
  setTimeout(()=>spawn('docker',['rm','-f',job.name],{stdio:'ignore'}),3000);}
 job.need=null;if(job.status==='running'||job.status==='need'){job.status='failed';job.message='已取消';}
}
setInterval(()=>{const now=Date.now();for(const [id,j] of jobs){
 if(j.child&&now-j.created>16*60000)cancel(j);
 if(!j.child&&now-j.updated>30*60000)jobs.delete(id);}},60000).unref();
function body(req){return new Promise((res,rej)=>{let s='';req.on('data',d=>{s+=d;if(s.length>8192){req.destroy();rej(Error('too large'));}});req.on('end',()=>{try{res(JSON.parse(s||'{}'));}catch{rej(Error('bad json'));}});req.on('error',rej);});}
http.createServer(async(req,res)=>{
 try{
  const auth=req.headers.authorization||'';
  if(!auth.startsWith('Bearer ')||!eq(auth.slice(7),KEY))return send(res,401,{error:'Unauthorized'});
  const url=new URL(req.url,'http://x');
  if(req.method==='POST'&&url.pathname==='/login/start'){
   const b=await body(req);const email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');
   if(!EMAIL.test(email)||!password||password.length>256)return send(res,400,{error:'邮箱或密码格式不正确'});
   const dup=alreadyImported(email);if(dup)return send(res,409,{error:'该邮箱已在账号池中（账号 '+dup+'）'});
   if([...jobs.values()].some(j=>j.child))return send(res,409,{error:'已有登录在进行，请稍候'});
   if(memMb()<900)return send(res,503,{error:'服务器内存不足，暂不能登录'});
   return send(res,202,view(startJob(email,password)));
  }
  const m=url.pathname.match(/^\/login\/([0-9a-f-]{36})(\/(input|cancel))?$/);
  if(!m)return send(res,404,{error:'Not found'});
  const job=jobs.get(m[1]);if(!job)return send(res,404,{error:'登录任务不存在或已过期'});
  if(req.method==='GET'&&!m[2])return send(res,200,view(job));
  if(req.method==='POST'&&m[3]==='input'){
   const b=await body(req);const v=String(b.value||'').trim();
   if(job.status!=='need'||!job.child)return send(res,409,{error:'当前不需要输入'});
   if(!v||v.length>64)return send(res,400,{error:'输入无效'});
   job.status='running';job.need=null;job.step='verifying';job.child.stdin.write(JSON.stringify({value:v})+'\n');
   return send(res,200,view(job));
  }
  if(req.method==='POST'&&m[3]==='cancel'){cancel(job);return send(res,200,view(job));}
  return send(res,405,{error:'Method not allowed'});
 }catch(e){send(res,400,{error:'请求无效'});}
}).listen(PORT,'127.0.0.1',()=>console.log('login service on 127.0.0.1:'+PORT));
