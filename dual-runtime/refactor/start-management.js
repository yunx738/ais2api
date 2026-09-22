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
