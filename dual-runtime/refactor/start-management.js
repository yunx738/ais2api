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
 const allowed=new Set(['GET /login','POST /login','GET /import','POST /api/import-account','GET /','GET /api/status','GET /api/models','POST /api/models/refresh','GET /favicon.ico','GET /console-assets/console.css','GET /console-assets/console.js','GET /console-assets/models.js','POST /api/set-mode','POST /api/rotate','POST /api/sync-accounts']);
 allowed.add("POST /api/models/policy");
 allowed.add('GET /api/requests');
 allowed.add('GET /api/usage');
 allowed.add('POST /api/login/start');
 for(const r of ['GET /api/client-script','GET /api/target-app','POST /api/target-app','GET /api/run-mode','POST /api/run-mode','GET /api/ws/config','POST /api/ws/config','POST /api/login-proxy','POST /api/ws/start','GET /api/ws/job','POST /api/ws/cancel'])allowed.add(r);
 for(const m of ['GET','POST'])allowed.add(m+' /api/login/job');
 allowed.add('POST /api/accounts/delete');
 allowed.add('GET /api/proxies');
 allowed.add('POST /api/proxies');
 allowed.add('POST /api/proxies/apply');
 allowed.add('GET /api/prices');
 allowed.add('POST /api/prices');
 for(const name of require('./console-routes').assets)allowed.add('GET /console-assets/'+name);
 const outer=express();
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
     !["flash","pro"].includes(quotaFamily)||typeof antiTruncation!=="boolean")
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
 // Password login: forwarded to the loopback login service; never logged or stored here.
 const loginCall=createControlCall(system.config.apiKeys[0],{port:8894,timeoutMs:15000});
 const loginGuard=(req,res)=>{
  if(!req.session.importToken||req.get('X-Import-Token')!==req.session.importToken){res.status(403).json({error:'请求校验失败，请刷新页面'});return false;}
  return true;
 };
 dashboard.post('/api/login/start',async(req,res)=>{
  if(!loginGuard(req,res))return;
  const email=typeof req.body?.email==='string'?req.body.email:'',password=typeof req.body?.password==='string'?req.body.password:'';
  const r=await loginCall('POST','/login/start',{email,password,remember:req.body?.remember===true});
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
 dashboard.get('/api/client-script',(req,res)=>{
  const up=http.request({host:'127.0.0.1',port:8890,path:'/internal/client-script',method:'GET',agent:false,headers:{Authorization:'Bearer '+system.config.apiKeys[0]}},r=>{
   res.status(r.statusCode===200?200:503).type('text/plain; charset=utf-8');r.pipe(res);});
  up.on('error',()=>{if(!res.headersSent)res.status(503).json({error:'脚本不可用'});});up.setTimeout(10000,()=>up.destroy());up.end();
 });
 dashboard.get('/api/target-app',async(req,res)=>{const r=await call('GET','/internal/target-app');res.status(r.status).json(r.body);});
 dashboard.post('/api/target-app',async(req,res)=>{if(!loginGuard(req,res))return;
  const b=req.body||{};const payload=b.action==='apply'?{action:'apply'}:{url:typeof b.url==='string'?b.url.slice(0,300):''};
  const r=await call('POST','/internal/target-app',payload);res.status(r.status).json(r.body);});
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
 const holder=express();holder.use(dashboard);
 router.stack.splice(index,0,holder._router.stack[holder._router.stack.length-1]);
 outer.use(app);
 const server=http.createServer(outer);
 server.requestTimeout=30000;server.headersTimeout=15000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8893,'127.0.0.1',resolve);});
 console.log('[Management] loopback 8893; no browser; account switching disabled');
 process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}
main().catch(()=>{console.error('[Management] startup failed; details suppressed');process.exitCode=1;});
