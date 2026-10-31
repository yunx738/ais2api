'use strict';
const express=require('express'),http=require('http');
const {requireSession,rotationPayload,createControlCall}=require('./management-control');
const {ProxyServerSystem}=require('./unified-server');
async function main(){
 const system=new ProxyServerSystem();
 const denied=async()=>({success:false,reason:'Account assignment belongs to coordinator'});
 system.requestHandler._switchToNextAuth=denied;
 system.requestHandler._switchToSpecificAuth=denied;
 system.browserManager.launchOrSwitchContext=async()=>{throw Error('Management cannot launch browsers');};
 const app=system._createExpressApp();
 const allowed=new Set(['GET /login','POST /login','GET /import','POST /api/import-account','GET /','GET /api/status','GET /api/models','POST /api/models/refresh','GET /favicon.ico','GET /console-assets/console.css','GET /console-assets/console.js','GET /console-assets/models.js','POST /api/set-mode','POST /api/rotate','POST /api/restart','GET /api/ultra-mode','GET /api/usage-counts','POST /api/ultra-mode','POST /api/accounts/tier','POST /api/accounts/name','POST /api/sync-accounts']);
 allowed.add("POST /api/models/policy");
 allowed.add('GET /api/requests');
 allowed.add('GET /api/build-status');
 allowed.add('GET /api/build/presets');
 allowed.add('POST /api/build/presets');
 allowed.add('GET /api/usage');
 allowed.add('POST /api/login/start');
 for(const r of ['GET /api/client-script','GET /api/target-app','POST /api/target-app','GET /api/run-mode','POST /api/run-mode','GET /api/ws/config','POST /api/ws/config','POST /api/login-proxy','POST /api/ws/start','GET /api/ws/job','POST /api/ws/cancel'])allowed.add(r);
 for(const m of ['GET','POST'])allowed.add(m+' /api/login/job');
 allowed.add('POST /api/accounts/delete');
 allowed.add('GET /api/relogin');
 allowed.add('POST /api/relogin/retry');
 allowed.add('GET /api/proxies');
 allowed.add('POST /api/proxies');
 allowed.add('POST /api/proxies/apply');
 allowed.add('GET /api/prices');
 for(const r of ['GET /api/auth','POST /api/auth/password','POST /api/auth/keys','POST /api/auth/key','POST /api/auth/internal'])allowed.add(r);
 allowed.add('POST /api/prices');
 for(const name of require('./console-routes').assets)allowed.add('GET /console-assets/'+name);
 const outer=express();
 require('./console-routes').installPublic(outer);
 // Userscript cookie sync: bearer key derived from the API key (never the API key itself).
 // Mounted before the browser-session/origin middleware because it does not use cookies.
 const syncKey=require('crypto').createHmac('sha256',String(system.config.apiKeys[0]||'')).update('ais2api-cookie-sync-v1').digest('hex');
 const syncHits=[];
 const ctl=createControlCall(system.config.apiKeys[0]);
 outer.post('/api/cookie-sync',express.json({limit:'300kb'}),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const got=Buffer.from(String(req.get('authorization')||'').replace(/^Bearer\s+/i,''));
  const want=Buffer.from(syncKey);
  if(!system.config.apiKeys[0]||got.length!==want.length||!require('crypto').timingSafeEqual(got,want))return res.status(401).json({error:'同步密钥无效'});
  const now=Date.now();while(syncHits.length&&now-syncHits[0]>60000)syncHits.shift();
  if(syncHits.length>=20)return res.status(429).json({error:'请求太频繁，请稍后再试'});
  syncHits.push(now);
  const b=req.body||{};const mode=['new','upsert','update'].includes(b.mode)?b.mode:'upsert';
  // Report which Google login cookies arrived (names only). Without the rotating PSIDTS pair the
  // session is normally rejected by Google on another machine, so refuse unless the user forces it.
  const names=new Set((Array.isArray(b.state?.cookies)?b.state.cookies:[]).map(c=>c&&c.name).filter(n=>typeof n==='string'));
  const KEY=['SID','HSID','SSID','APISID','SAPISID','__Secure-1PSID','__Secure-3PSID','__Secure-1PSIDTS','__Secure-3PSIDTS','__Secure-1PSIDCC','__Secure-3PSIDCC'];
  const check={present:KEY.filter(n=>names.has(n)),missing:KEY.filter(n=>!names.has(n)),total:names.size};
  const noTs=!names.has('__Secure-1PSIDTS')&&!names.has('__Secure-3PSIDTS');
  // Which signed-in Google account this is (browser multi-login). The worker opens AI Studio without
  // authuser, i.e. as account 0, so any other index would run as the wrong account or hit a sign-in page.
  const authUser=Number.isSafeInteger(b.authUser)&&b.authUser>=0&&b.authUser<10?b.authUser:0;
  check.authUser=authUser;
  if(b.mode==='check')return res.json({check,ok:authUser===0});
  if(authUser!==0&&b.force!==true)return res.status(422).json({error:'这是浏览器里的第 '+(authUser+1)+' 个 Google 账号（authuser='+authUser+'）。服务器只会打开第 1 个账号，导入后会用错账号或跳到登录页，没有导入',check,needForce:true,reason:'authuser'});
  try{
   const r=require('./import-ui').saveImport(system,b.state,{tier:b.tier,alias:typeof b.alias==='string'?b.alias:'',mode});
   let note='';
   if(r.updated){
    const st=await ctl('GET','/internal/coordinator-status');
    const using=Object.entries(st.body?.slots||{}).filter(([,x])=>x&&x.account===r.index).map(([k])=>k);
    if(using.length)note=(note?note+'；':'')+'实例 '+using.join('/')+' 正在用这个账号，下次切换或重启实例后使用新 Cookie';
   }else await ctl('POST','/internal/sync-accounts',{});
   // Real check: open AI Studio with these cookies (isolated context). Result arrives via /api/cookie-sync/verify.
   let verifying=false;
   if(!note.includes('正在用')){const v=await ctl('POST','/internal/accounts/verify',{id:r.index});verifying=v.status===202;}
   if(noTs)note=(note?note+'；':'')+'没有 __Secure-1PSIDTS，大多数账号仍可用，若启动时跳登录页请改用账号密码登录';
   res.json({...r,note,check,verifying});
  }catch(e){
   if(e.status)return res.status(e.status).json(e.body);
   console.error('[CookieSync] failed');res.status(500).json({error:'保存失败'});
  }
 });
  outer.get('/api/cookie-sync/verify',async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const got=Buffer.from(String(req.get('authorization')||'').replace(/^Bearer\s+/i,'')),want=Buffer.from(syncKey);
  if(got.length!==want.length||!require('crypto').timingSafeEqual(got,want))return res.status(401).json({error:'同步密钥无效'});
  const id=Number(req.query.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'账号无效'});
  const r=await ctl('GET','/internal/accounts/verify?id='+id);res.status(r.status).json(r.body);
 });
outer.use((req,res,next)=>{
  res.setHeader("X-Frame-Options","DENY");
  res.setHeader("X-Content-Type-Options","nosniff");
  if(req.method!=="POST")return next();
  if(req.headers["sec-fetch-site"]==="cross-site")return res.status(403).json({error:"Cross-site management request"});
  if(req.headers.origin){
   try{const origin=new URL(req.headers.origin);if(!["https:","http:"].includes(origin.protocol)||origin.host!==req.headers.host)throw Error();}
   catch{return res.status(403).json({error:"Cross-origin changes rejected"});}
  }
  if(req.path.startsWith("/api/") && !req.is("application/json"))return res.status(415).json({error:"JSON required"});
  next();
 });
 outer.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  if(!allowed.has(req.method+' '+req.path))return res.status(404).json({error:'Management endpoint unavailable'});
  next();
 });
 // Insert authenticated dashboard before legacy routes but after session middleware.
 const router=app._router;
 const index=router.stack.findIndex(layer=>layer.route?.path==='/');
 if(index<0)throw Error('Dashboard route missing');
 const dashboard=express.Router();
 dashboard.use(requireSession);
require('./console-routes').install(dashboard);
 const call=createControlCall(system.config.apiKeys[0]);
 dashboard.get('/api/status',async(req,res)=>{
  const result=await call('GET','/internal/coordinator-status');
  if(!res.destroyed)res.status(result.status).json(result.body);
 });
 for(const [publicPath,internalPath] of [['/api/requests','/internal/requests'],['/api/usage','/internal/usage']]){
  dashboard.get(publicPath,async(req,res)=>{
   const query=new URL(req.originalUrl,'http://localhost').searchParams.toString();
   if(query.length>2048)return res.status(400).json({error:'Query too long'});
   const result=await call('GET',internalPath+(query?'?'+query:''));
   res.status(result.status).json(result.body);
  });
 }
 dashboard.post('/api/accounts/delete',async(req,res)=>{
  try{const o=new URL(req.headers.origin);if(!['https:','http:'].includes(o.protocol)||o.host!==req.headers.host)throw Error();}
  catch{return res.status(403).json({error:'Same-origin browser request required'});}
  const {id,confirm}=req.body||{};
  if(!Number.isSafeInteger(id)||id<1||confirm!=='DELETE '+id)return res.status(400).json({error:'删除确认不匹配'});
  const r=await call('POST','/internal/accounts/delete',{id,confirm});res.status(r.status).json(r.body);
 });
 dashboard.get('/api/proxies',async(req,res)=>{
  const r=await call('GET','/internal/proxies');res.status(r.status).json(r.body);
 });
 for(const suffix of ['','/apply'])dashboard.post('/api/proxies'+suffix,async(req,res)=>{
  try{const o=new URL(req.headers.origin);if(!['http:','https:'].includes(o.protocol)||o.host!==req.headers.host)throw Error();}
  catch{return res.status(403).json({error:'Same-origin browser request required'});}
  const b=req.body;
  if(!b||typeof b!=='object'||Array.isArray(b)||!['A','B'].includes(b.slot))return res.status(400).json({error:'Invalid proxy configuration'});
  const payload=suffix?{slot:b.slot,revision:b.revision,action:b.action}:
   {slot:b.slot,revision:b.revision,host:b.host,port:b.port,username:b.username,password:b.password};
  const r=await call('POST','/internal/proxies'+suffix,payload);res.status(r.status).json(r.body);
 });
 dashboard.get('/api/prices',async(req,res)=>{
  const result=await call('GET','/internal/prices');
  res.status(result.status).json(result.body);
 });
 dashboard.post('/api/prices',async(req,res)=>{
  if(!req.is('application/json'))return res.status(415).json({error:'JSON required'});
  try{
   const origin=new URL(req.headers.origin);
   if(!['https:','http:'].includes(origin.protocol)||origin.host!==req.headers.host)throw Error();
  }catch{return res.status(403).json({error:'Same-origin browser request required'});}
  const result=await call('POST','/internal/prices',req.body);
  res.status(result.status).json(result.body);
 });
 dashboard.get('/api/models',async(req,res)=>{
  const r=await call('GET','/internal/models');
  res.status(r.status).json(r.body);
 });
 dashboard.post("/api/models/policy",async(req,res)=>{
  if(!req.is("application/json"))return res.status(415).json({error:"JSON required"});
  if(req.headers.origin){
   try{if(new URL(req.headers.origin).host!==req.headers.host)throw Error();}
   catch{return res.status(403).json({error:"Cross-origin changes rejected"});}
  }
  const {model,quotaFamily,antiTruncation,revision}=req.body||{};
  if(typeof model!=="string"||model.length>200||!Number.isSafeInteger(revision)||revision<0||
     !["flash","pro","ultra"].includes(quotaFamily)||typeof antiTruncation!=="boolean")
   return res.status(400).json({error:"Invalid model policy"});
  const result=await call("POST","/internal/models/policy",{model,quotaFamily,antiTruncation,revision});
  res.status(result.status).json(result.body);
 });
 dashboard.post('/api/models/refresh',async(req,res)=>{
  const slot=req.body?.slot;
  if(!['A','B'].includes(slot))return res.status(400).json({error:'Invalid slot'});
  const r=await call('POST','/internal/models/refresh',{slot});
  res.status(r.status).json(r.body);
 });
 dashboard.post('/api/set-mode',async(req,res)=>{
  const mode=req.body?.mode;
  if(mode!=='fake'&&mode!=='real')return res.status(400).json({error:'mode must be fake or real'});
  const r=await call('POST','/internal/set-mode',{mode});
  res.status(r.status).json(r.body);
 });
 dashboard.post('/api/rotate',async(req,res)=>{
  let payload;
  try{payload=rotationPayload(req.body);}
  catch(error){return res.status(400).json({error:error.message});}
  const r=await call('POST','/internal/rotate',payload);
  if(!res.destroyed)res.status(r.status).json(r.body);
 });
 dashboard.get('/api/build/presets',async(req,res)=>{const r=await call('GET','/internal/build/presets');res.status(r.status).json(r.body);});
 dashboard.post('/api/build/presets',async(req,res)=>{const b=req.body||{};const r=await call('POST','/internal/build/presets',{action:b.action,id:b.id,enabled:b.enabled,name:b.name,preset:b.preset});res.status(r.status).json(r.body);});
 dashboard.get('/api/build-status',async(req,res)=>{const r=await call('GET','/internal/build-status');res.status(r.status).json(r.body);});
 dashboard.get('/api/usage-counts',async(req,res)=>{const r=await call('GET','/internal/usage-counts');res.status(r.status).json(r.body);});
 dashboard.get('/api/ultra-mode',async(req,res)=>{const r=await call('GET','/internal/ultra-mode');res.status(r.status).json(r.body);});
 dashboard.post('/api/ultra-mode',async(req,res)=>{const r=await call('POST','/internal/ultra-mode',{enabled:req.body?.enabled,slot:req.body?.slot});res.status(r.status).json(r.body);});
 dashboard.post('/api/accounts/name',async(req,res)=>{const r=await call('POST','/internal/accounts/name',{id:req.body?.id,name:req.body?.name});res.status(r.status).json(r.body);});
 dashboard.post('/api/accounts/tier',async(req,res)=>{const r=await call('POST','/internal/accounts/tier',{id:req.body?.id,tier:req.body?.tier});res.status(r.status).json(r.body);});
 dashboard.post('/api/restart',async(req,res)=>{
  const slot=req.body?.slot;
  if(!['A','B'].includes(slot))return res.status(400).json({error:'slot must be A or B'});
  const r=await call('POST','/internal/restart',{slot});
  if(!res.destroyed)res.status(r.status).json(r.body);
 });
 // Password login: forwarded to the loopback login service; never logged or stored here.
 const loginCall=createControlCall(system.config.apiKeys[0],{port:8894,timeoutMs:15000});
 const loginGuard=(req,res)=>{
  if(!req.session.importToken||req.get('X-Import-Token')!==req.session.importToken){res.status(403).json({error:'请求校验失败，请刷新页面'});return false;}
  return true;
 };
 dashboard.post('/api/login/start',async(req,res)=>{
  if(!loginGuard(req,res))return;
  const email=typeof req.body?.email==='string'?req.body.email:'',password=typeof req.body?.password==='string'?req.body.password:'';
  const r=await loginCall('POST','/login/start',{email,password,remember:req.body?.remember===true,alias:typeof req.body?.alias==='string'?req.body.alias.slice(0,40):'',tier:['pro','ultra','ultra20'].includes(req.body?.tier)?req.body.tier:'standard'});
  res.status(r.status).json(r.body);
 });
 const jobPath=id=>/^[0-9a-f-]{36}$/.test(String(id||''))?'/login/'+id:null;
 dashboard.get('/api/login/job',async(req,res)=>{
  const p=jobPath(req.query.id);if(!p)return res.status(400).json({error:'任务编号无效'});
  const r=await loginCall('GET',p);res.status(r.status).json(r.body);
 });
 dashboard.post('/api/login/job',async(req,res)=>{
  if(!loginGuard(req,res))return;
  const p=jobPath(req.body?.id),action=req.body?.action;
  if(!p||!['input','cancel'].includes(action))return res.status(400).json({error:'请求无效'});
  const r=await loginCall('POST',p+'/'+action,action==='input'?{value:String(req.body.value||'')}:{});
  res.status(r.status).json(r.body);
 });
 dashboard.get('/api/relogin',async(req,res)=>{const r=await loginCall('GET','/login/nightly');res.status(r.status||503).json(r.body||{error:'登录服务不可用'});});
 dashboard.post('/api/relogin/retry',async(req,res)=>{
  try{const o=new URL(req.headers.origin);if(!['https:','http:'].includes(o.protocol)||o.host!==req.headers.host)throw Error();}
  catch{return res.status(403).json({error:'Same-origin browser request required'});}
  const id=req.body?.id;if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'账号编号无效'});
  const r=await loginCall('POST','/login/nightly/retry',{id});res.status(r.status||503).json(r.body||{error:'登录服务不可用'});
 });
 dashboard.get('/api/client-script',(req,res)=>{
  const up=http.request({host:'127.0.0.1',port:8890,path:'/internal/client-script',method:'GET',agent:false,headers:{Authorization:'Bearer '+system.config.apiKeys[0]}},r=>{
   res.status(r.statusCode===200?200:503).type('text/plain; charset=utf-8');r.pipe(res);});
  up.on('error',()=>{if(!res.headersSent)res.status(503).json({error:'脚本不可用'});});up.setTimeout(10000,()=>up.destroy());up.end();
 });
 dashboard.get('/api/target-app',async(req,res)=>{const r=await call('GET','/internal/target-app');res.status(r.status).json(r.body);});
 dashboard.post('/api/target-app',async(req,res)=>{if(!loginGuard(req,res))return;
  const b=req.body||{};const payload=b.action==='apply'?{action:'apply'}:{url:typeof b.url==='string'?b.url.slice(0,300):''};
  const r=await call('POST','/internal/target-app',payload);res.status(r.status).json(r.body);});
 allowed.add('GET /api/concurrency');allowed.add('POST /api/concurrency');
 allowed.add('GET /api/at-prompt');allowed.add('POST /api/at-prompt');
 dashboard.get('/api/at-prompt',async(req,res)=>{const r=await call('GET','/internal/at-prompt');res.status(r.status).json(r.body);});
 allowed.add('GET /api/at-prompt/export');allowed.add('POST /api/at-prompt/import');
 dashboard.post('/api/at-prompt',async(req,res)=>{if(!loginGuard(req,res))return;
  const p=req.body?.preset;if(typeof p!=='string'||!/^[a-z_]{1,24}$/.test(p))return res.status(400).json({error:'参数无效'});
  const c=req.body?.custom;const payload={preset:p};
  if(c!==undefined&&c!==null){if(typeof c!=='object'||Array.isArray(c))return res.status(400).json({error:'参数无效'});payload.custom={desc:c.desc,hint:c.hint,cont:c.cont};}
  const r=await call('POST','/internal/at-prompt',payload);res.status(r.status).json(r.body);});
 dashboard.get('/api/at-prompt/export',async(req,res)=>{const r=await call('GET','/internal/at-prompt/export');
  if(r.status!==200)return res.status(r.status).json(r.body);
  res.setHeader('Content-Disposition','attachment; filename="at-prompt-'+new Date().toISOString().slice(0,10)+'.json"');res.type('application/json').send(JSON.stringify(r.body,null,1));});
 dashboard.post('/api/at-prompt/import',async(req,res)=>{if(!loginGuard(req,res))return;
  const b=req.body;if(!b||typeof b!=='object'||Array.isArray(b))return res.status(400).json({error:'文件内容不是 JSON 对象'});
  const r=await call('POST','/internal/at-prompt/import',b);res.status(r.status).json(r.body);});
 dashboard.get('/api/concurrency',async(req,res)=>{const r=await call('GET','/internal/concurrency');res.status(r.status).json(r.body);});
 dashboard.post('/api/concurrency',async(req,res)=>{if(!loginGuard(req,res))return;
  const b=req.body||{},p={};for(const s of ['A','B'])if(b[s]!==undefined)p[s]=Number(b[s]);
  const r=await call('POST','/internal/concurrency',p);res.status(r.status).json(r.body);});
 dashboard.get('/api/run-mode',async(req,res)=>{const r=await call('GET','/internal/run-mode');res.status(r.status).json(r.body);});
 dashboard.post('/api/run-mode',async(req,res)=>{if(!loginGuard(req,res))return;
  if(typeof req.body?.single!=='boolean')return res.status(400).json({error:'参数无效'});
  const r=await call('POST','/internal/run-mode',{single:req.body.single});res.status(r.status).json(r.body);});
 dashboard.get('/api/ws/config',async(req,res)=>{const r=await loginCall('GET','/ws/config');res.status(r.status).json(r.body);});
 dashboard.post('/api/ws/config',async(req,res)=>{if(!loginGuard(req,res))return;const b=req.body||{};
  const r=await loginCall('POST','/ws/config',{domain:b.domain,mailbox:b.mailbox,graph_client_id:b.graph_client_id,recovery_email:b.recovery_email,mail_subject_keywords:b.mail_subject_keywords,mail_provider:b.mail_provider,tempmail_api:b.tempmail_api,tempmail_admin:b.tempmail_admin,tempmail_name:b.tempmail_name});res.status(r.status).json(r.body);});
 dashboard.post('/api/login-proxy',async(req,res)=>{if(!loginGuard(req,res))return;const b=req.body||{};
  const r=await loginCall('POST','/login-proxy',{type:b.type,host:b.host,port:b.port,username:b.username,password:b.password,enabled:b.enabled,clear:b.clear===true});res.status(r.status).json(r.body);});
 dashboard.post('/api/ws/start',async(req,res)=>{if(!loginGuard(req,res))return;
  const r=await loginCall('POST','/ws/start',{kind:req.body?.kind,mailId:req.body?.mailId});res.status(r.status).json(r.body);});
 dashboard.get('/api/ws/job',async(req,res)=>{const id=String(req.query.id||'');if(!/^[0-9a-f-]{36}$/.test(id))return res.status(400).json({error:'任务编号无效'});
  const r=await loginCall('GET','/ws/'+id);res.status(r.status).json(r.body);});
 dashboard.post('/api/ws/cancel',async(req,res)=>{if(!loginGuard(req,res))return;const id=String(req.body?.id||'');if(!/^[0-9a-f-]{36}$/.test(id))return res.status(400).json({error:'任务编号无效'});
  const r=await loginCall('POST','/ws/'+id+'/cancel',{});res.status(r.status).json(r.body);});
 dashboard.post('/api/sync-accounts',async(req,res)=>{
  const r=await call('POST','/internal/sync-accounts',{});
  res.status(r.status).json(r.body);
 });
 // Console password and client API keys (stored by the coordinator in console-auth.json).
 const authRelay=(method,p,body)=>call(method,'/internal/console-auth'+p,body);
 dashboard.get('/api/auth',async(req,res)=>{const r=await authRelay('GET','');res.status(r.status).json(r.body);});
 for(const p of ['/password','/keys','/key','/internal'])dashboard.post('/api/auth'+p,async(req,res)=>{
  const b=req.body&&typeof req.body==='object'?req.body:{};
  const body=p==='/password'?{current:String(b.current||''),next:String(b.next||'')}:p==='/keys'?{name:String(b.name||'')}:
   p==='/key'?{id:String(b.id||''),disabled:b.disabled===true,remove:b.remove===true}:{enabled:b.enabled===true};
  const r=await authRelay('POST',p,body);res.status(r.status).json(r.body);
 });
 // Login throttle: 8 failures per IP per 10 minutes.
 const failures=new Map();
 const clientIp=req=>String(req.headers['x-real-ip']||req.socket.remoteAddress||'');
 const throttled=ip=>{const f=failures.get(ip);if(!f)return false;if(Date.now()-f.at>600000){failures.delete(ip);return false;}return f.n>=8;};
 const postLogin=express();postLogin.use(express.urlencoded({extended:false,limit:'4kb'}));
 postLogin.post('/login',async(req,res)=>{
  const ip=clientIp(req);if(throttled(ip))return res.redirect('/login?error=2');
  const secret=String(req.body?.apiKey||'');
  const r=secret?await authRelay('POST','/login',{secret}):{status:200,body:{ok:false}};
  if(r.status===200&&r.body?.ok===true){failures.delete(ip);return req.session.regenerate(()=>{req.session.isAuthenticated=true;res.redirect('/');});}
  if(r.status!==200)return res.redirect('/login?error=3');
  const f=failures.get(ip)||{n:0,at:Date.now()};f.n++;f.at=Date.now();failures.set(ip,f);
  res.redirect('/login?error=1');
 });
 const postIndex=router.stack.findIndex(layer=>layer.route?.path==='/login'&&layer.route.methods?.post);
 if(postIndex<0)throw Error('Login route missing');
 router.stack.splice(postIndex,0,...postLogin._router.stack.slice(-2));
 // Themed login page (management only; workers keep the built-in page).
 const loginIndex=router.stack.findIndex(layer=>layer.route?.path==='/login'&&layer.route.methods?.get);
 if(loginIndex>=0){
  const loginPage=require('fs').readFileSync(require('path').join(__dirname,'ui','login.html'),'utf8');
  const lh=express();
  lh.get('/login',(req,res)=>{
   if(req.session?.isAuthenticated)return res.redirect('/');
   res.setHeader('Cache-Control','no-store');
   const msg={'1':'密码错误，请重新输入','2':'尝试次数过多，请 10 分钟后再试','3':'调度服务暂不可用，请稍后再试'}[String(req.query.error||'')];
   res.type('html').send(loginPage.replace('<!--ERROR-->',msg?'<p class="error" role="alert">'+msg+'</p>':''));
  });
  router.stack.splice(loginIndex,0,lh._router.stack[lh._router.stack.length-1]);
 }
 const holder=express();holder.use(dashboard);
 // Recompute: the themed login route above shifted the stack.
 const dashIndex=router.stack.findIndex(layer=>layer.route?.path==='/');
 if(dashIndex<0)throw Error('Dashboard route missing');
 router.stack.splice(dashIndex,0,holder._router.stack[holder._router.stack.length-1]);
 outer.use(app);
 const server=http.createServer(outer);
 server.requestTimeout=30000;server.headersTimeout=15000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8893,'127.0.0.1',resolve);});
 console.log('[Management] loopback 8893; no browser; account switching disabled');
 process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}
main().catch(()=>{console.error('[Management] startup failed; details suppressed');process.exitCode=1;});
