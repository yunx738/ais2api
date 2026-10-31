'use strict';
const fs=require('fs'),path=require('path');
const {restore}=require('./restore-dispatch');
const {WorkerClient}=require('./worker-client');
const {WorkerDriver}=require('./worker-driver');
const {RotationController}=require('./rotation-controller');
const {RequestScheduler}=require('./request-scheduler');
const {forwardWorker}=require('./forward-worker');
const {createServer,sanitizeStats}=require('./coordinator-http');
const {authFileInfo}=require('./auth-maintenance');
async function main(){
 const root=process.env.DUAL_ROOT||'/opt/ais2api/dual-runtime';
 const cfg=JSON.parse(fs.readFileSync(path.join(root,'coordinator.json'),'utf8'));
 const dispatch=restore(path.join(root,'state.json'));
 const client=new WorkerClient(Object.fromEntries(['A','B'].map(s=>[s,cfg.workers[s].control])));
 const driver=new WorkerDriver(root,cfg.image,client);
 const rotation=new RotationController(dispatch,driver);
 const {openHistory}=require('./history-startup');
 const {createRecordedForward}=require('./recorded-forward');
 const history=await openHistory(path.join(root,'request-history'));
 if(!history.status().ready)console.error('[Analytics] history unavailable; generation remains enabled');
 const {ModelPriceStore}=require('./model-price-store');
 const priceStore=new ModelPriceStore(path.join(root,'model-prices.json'));
 const sweepStale=()=>{if(history.status().ready&&typeof history.expireStale==='function')history.expireStale().then(n=>{if(n)console.warn('[Analytics] closed '+n+' stale pending request(s) as uncertain');}).catch(()=>{});};
 sweepStale();setInterval(sweepStale,300000).unref();
 const recordedForward=createRecordedForward({history,forward:(ticket,route,body,res,credentials,options={})=>forwardWorker(ticket,route,body,res,credentials,{...options,atPrompt:atPrompt.get(),atPromptCustom:atPrompt.header()}),priceFor:model=>priceStore.get(model),missLog:require('path').join(__dirname,'..','usage-missing.jsonl')});
 const scheduler=new RequestScheduler(dispatch,client,recordedForward,cfg.workers);
 const {QuarantineRecovery}=require('./quarantine-recovery');
 const recovery=new QuarantineRecovery(dispatch,scheduler,client,driver,rotation);
 // Logged-out accounts are logged in again in place (same account, same worker); never skipped.
 const relogin=require('./relogin-client').createRelogin({key:cfg.apiKeys[0]});
 rotation.relogin=relogin;recovery.relogin=relogin;
 const {CatalogController}=require('./catalog-controller');
 const {createCatalogWorkerClient}=require('./catalog-worker-client');
 const catalogs=new CatalogController({
  dispatch,scheduler,client,rotation,call:createCatalogWorkerClient(cfg.workers)
 });
 const {CatalogRouting}=require("./catalog-routing");
 const {ModelPolicyStore}=require("./model-policy-store");
 const policyStore=new ModelPolicyStore(path.join(root,"model-policies.json"),cfg.modelPolicies||{});
 const routing=new CatalogRouting(dispatch,catalogs,policyStore.policies);
 const {AccountTiers}=require('./account-tiers');
 let browserLeaseRef=null;
 const tiers=new AccountTiers({authDir:'/opt/ais2api/auth',file:path.join(root,'ultra-mode.json'),isSingle:()=>browserLeaseRef?.mode?.single===true});
 dispatch.slotAllows=(slot,id)=>tiers.allowed(slot,id);
 const concurrency=new (require('./slot-concurrency').SlotConcurrency)(path.join(root,'concurrency.json'));
 dispatch.slotLimit=slot=>concurrency.get(slot);
 const atPrompt=new (require('./at-prompt-store').AtPromptStore)(path.join(root,'at-prompt.json'));
 dispatch.slotRule=slot=>!tiers.active()?'':slot===tiers.mode.slot?'实例 '+slot+' 只用 Pro/Ultra 账号':'实例 '+slot+' 不使用 Pro/Ultra 账号';
 routing.isUltra=id=>tiers.isUltra(id);
 routing.isPremium=id=>tiers.isPremium(id);
 dispatch.quotas.tierOf=id=>tiers.tier(id);
 scheduler.resolveModel=(route,body,options)=>routing.resolve(route,body,options);
 // Build channel (build/*, build-st/*): own token ledger, per-account Build project from build-apps.json.
 const {BuildChannel}=require('./build-coordinator');
 const buildPresets=new (require('./build-presets').PresetStore)(path.join(root,'build-presets.json'));
 const build=new BuildChannel({appsFile:path.join(root,'build-apps.json'),ledgerFile:path.join(root,'build-tokens.json'),
  tierOf:id=>tiers.tier(id),isPremium:id=>tiers.isPremium(id),presets:buildPresets});
 scheduler.resolveModel=(route,body,options)=>build.resolve(route,body,options)||routing.resolve(route,body,options);
 scheduler.forward=build.wrapForward(scheduler.forward);
 // Nightly Build applet rotation (Beijing 03:00-06:00): fresh applet per Build account, old one deleted.
 const {BuildAppletRotation}=require('./build-applet-rotation');
 const appletRpc=(slot,method,request)=>new Promise((resolve,reject)=>{
  const payload=JSON.stringify({method,request});
  const req=require('http').request({hostname:'127.0.0.1',port:slot==='A'?8891:8892,path:'/internal/build/applet-rpc',method:'POST',agent:false,
   headers:{'X-Worker-Key':cfg.workers[slot].control,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{
   let body='';res.on('data',c=>{body+=c;if(body.length>1e6)req.destroy();});
   res.on('end',()=>{if(res.statusCode!==200)return reject(Error('worker '+res.statusCode+' '+body.slice(0,80)));try{resolve(JSON.parse(body));}catch{reject(Error('bad worker reply'));}});});
  req.setTimeout(90000,()=>req.destroy(Error('applet rpc deadline')));req.on('error',reject);req.end(payload);});
 const appletRotation=new BuildAppletRotation({appsFile:path.join(root,'build-apps.json'),stateFile:path.join(root,'build-applet-rotation.json'),rpc:appletRpc,
  slotOf:id=>['A','B'].find(slot=>dispatch.pool.slots.get(slot)?.current===id)||null});
 const appletTimer=setInterval(()=>{appletRotation.tick().then(r=>{if(r&&!r.skipped)console.log('[BuildRotation]',JSON.stringify(r));}).catch(e=>console.error('[BuildRotation]',e.message));},600000);appletTimer.unref();
 dispatch.quotaExhausted=(slot,plan)=>routing.exhausted(slot,plan);
 let stopping=false;
 const {RetiredResourceCleanup}=require('./retired-resource-cleanup');
 const cleanup=new RetiredResourceCleanup({dispatch,driver,root,options:cfg.retiredCleanup===undefined?{}:cfg.retiredCleanup,
  isStopping:()=>stopping,hasWaiting:()=>scheduler.queue.length>0});
 rotation.onRetired=(slot,marker)=>cleanup.record(slot,marker);
 const frontendGuard=new (require('./frontend-guard').FrontendGuard)({file:path.join(root,'frontend-verified.json')});
 dispatch.onWorkerStatus=(slot,status)=>frontendGuard.observe(slot,status);
 rotation.frontendHold=slot=>frontendGuard.hold(slot);
 const {CoordinatorMonitor}=require('./coordinator-monitor');
 const monitor=new CoordinatorMonitor({dispatch,client,catalogs,recovery,rotation,routing,scheduler});
 const {ConsoleAuth,StreamMode}=require('./console-auth');
 const consoleAuth=new ConsoleAuth({file:path.join(root,'console-auth.json'),internalKey:cfg.apiKeys[0]});
 // Persisted streaming mode (default fake). Re-applied whenever a slot reports a new worker epoch.
 const streamMode=new StreamMode(path.join(root,'stream-mode.json'));
 let lastMode=streamMode.mode;
 let applyingMode=false;
 const applyMode=async()=>{
  if(applyingMode)return;applyingMode=true;
  try{for(const slot of ['A','B']){
   const s=dispatch.slots.get(slot),epoch=s?.workerEpoch;
   if(!epoch||streamMode.applied.get(slot)===epoch+':'+streamMode.mode)continue;
   try{await client.setMode(slot,streamMode.mode);streamMode.applied.set(slot,epoch+':'+streamMode.mode);console.log('[StreamMode] slot',slot,'->',streamMode.mode);}
   catch{}
  }}finally{applyingMode=false;}
 };
 const accountOccupied=id=>dispatch.pool.owners.has(id)||[...dispatch.slots.values()].some(s=>
  [s.rotation?.account,s.rotation?.oldAccount,s.rotation?.predecessorAccount,s.recovery?.account,s.proxyApply?.account].includes(id)||
  Object.values(s.executions||{}).some(x=>x.account===id)||Object.values(s.retirements||{}).some(x=>x.account===id));
 const cookieStatus=(id,owner,flag)=>{
  const info=authFileInfo(path.join(driver.authSource,'auth-'+id+'.json'));
  const slot=owner?dispatch.pool.slots.get(owner):undefined,s=owner?dispatch.slots.get(owner):undefined;
  const login=flag&&['invalid','deleting','deleted'].includes(flag.status)?'invalid':
   slot?.current===id?((s?.ready||s?.active>0)&&!monitor.status(owner).error?'online':'unconfirmed'):
   'unverified';
  return {login,file:info.state,keyCookies:info.keyCookies||0,
   expiresAt:Number.isFinite(info.expiresAt)?info.expiresAt:null,session:info.session===true,
   expired:Number.isFinite(info.expiresAt)&&info.expiresAt<=Date.now(),
   modifiedAt:info.modifiedAt||null,save:dispatch.authSaves?.[id]||null};
 };
 const status=()=>({
  halted:dispatch.halted,queue:scheduler.queue.length,scheduling:scheduler.status(),
  streamingMode:lastMode,ultra:tiers.status(dispatch.pool.ids),rotationThrottle:{...dispatch.rotationThrottle,intervalMs:300000},browserLease:browserLease?browserLease.status():null,runMode:browserLease?browserLease.modeStatus():null,
  analytics:recordedForward.status(),
  gatewayRepair:{...sanitizeStats},
  retiredCleanup:cleanup.status(),
  frontendGuard:frontendGuard.status(),
  quotaMode:"per-account-per-model",quotaLimits:require('./model-quota-ledger').TIER_LIMITS,
  slots:Object.fromEntries([...dispatch.slots].map(([slot,s])=>[slot,{
   account:dispatch.pool.slots.get(slot)?.current,
   pending:dispatch.pool.slots.get(slot)?.pending?.id,
   active:s.active,ready:s.ready,unready:s.ready?null:(s.unready||null),frontendHold:frontendGuard.hold(slot),
   quota:Number.isSafeInteger(dispatch.pool.slots.get(slot)?.current)?dispatch.quotas.summary(dispatch.pool.slots.get(slot).current,policyStore.policies):undefined,
   healthCheck:monitor.status(slot),workerEpoch:s.workerEpoch,workerHealth:s.workerHealth,pendingRetirements:Object.keys(s.retirements||{}).length,
   pendingExecutions:Object.values(s.executions||{}).map(t=>({id:t.id,phase:t.phase,createdAt:t.createdAt})),
   legacyUnresolved:[...s.requests].filter(id=>!s.executions?.[id]).length,
   operation:dispatch.operations.status(slot),manualAction:rotation.manual.get(slot)||null,rotationBlocked:rotation.failures.has(slot),
   rotationFailure:rotation.failures.has(slot)?{
    reason:rotation.failures.get(slot).reason,retryable:rotation.failures.get(slot).retryable===true,
    retryAt:rotation.failures.get(slot).retryAt||null
   }:undefined
  }])),
  accounts:dispatch.pool.ids.filter(id=>dispatch.accountFlags[id]?.status!=='deleted').map(id=>{
   const names=tiers.names(id),name=names.alias||names.accountName||'N/A (未命名)';
   const owner=dispatch.pool.owners.get(id);
   const cooldownUntil=dispatch.pool.cooldowns.get(id)||0;
   const flag=dispatch.accountFlags[id];
   return {cookie:cookieStatus(id,owner,flag),authStatus:flag?.status||'unknown',invalidReason:flag?.reason,
    invalidAt:flag?.at,invalidSlot:flag?.slot,canDelete:flag?.status!=='deleted'&&!accountOccupied(id),
    id,name,alias:names.alias,accountName:names.accountName,tier:tiers.tier(id),owner:owner||null,cooldownUntil,quota:dispatch.quotas.summary(id,policyStore.policies)};
  })
 });
 const {ProxySettings}=require('./proxy-settings');
 const proxies=new ProxySettings({root,dispatch,driver,client,rotation,scheduler,isStopping:()=>stopping});
 const {SpareKeepalive}=require('./spare-keepalive');
 const verifyJobs=new Map();
 const keepalive=new SpareKeepalive({dispatch,driver,client,scheduler,rotation,occupied:accountOccupied,isStopping:()=>stopping});
 const {BrowserLease}=require('./browser-lease');
 const browserLease=new BrowserLease({dispatch,driver,client,rotation,scheduler,isStopping:()=>stopping,file:path.join(root,'run-mode.json')});
 browserLease.init();browserLeaseRef=browserLease;
 const {TargetApp}=require('./target-app');
 const targetApp=new TargetApp({root,
  isBusy:slot=>stopping||dispatch.operations.has(slot)||rotation.running.has(slot),
  rotate:async slot=>{const r=rotation.forceRotate(slot);await r.done;const m=rotation.manual.get(slot);if(m?.phase==='failed')throw Error(m.error);}});
 monitor.tick();
 const actions={
  buildStatus:()=>({...build.status(),appletRotation:appletRotation.status()}),
  buildPresets:()=>({presets:buildPresets.list()}),
  buildPresetAdd:body=>buildPresets.add(body?.name,body?.preset),
  buildPresetRemove:body=>buildPresets.remove(String(body?.id||'')),
  buildPresetEnable:body=>buildPresets.setEnabled(String(body?.id||''),body?.enabled),
  rotateBuildApplets:body=>appletRotation.tick({force:true,only:Number.isSafeInteger(body?.account)?body.account:null}),
  leaseStatus:()=>browserLease.status(),
  leaseAcquire:body=>browserLease.acquire(body?.owner,body?.slot),
  leaseRelease:()=>browserLease.release(false),
  runMode:()=>browserLease.modeStatus(),
  ultraMode:()=>tiers.status(dispatch.pool.ids),
  setUltraMode:body=>{const r=tiers.setMode(body);monitor.tick();return tiers.status(dispatch.pool.ids);},
  setAccountName:body=>{const id=Number(body?.id);if(!dispatch.pool.ids.includes(id))throw Object.assign(Error('账号 '+body?.id+' 不在账号池'),{statusCode:404});
   return tiers.setAlias(id,body?.name);},
  setAccountTier:body=>{const id=Number(body?.id);if(!dispatch.pool.ids.includes(id))throw Object.assign(Error('账号 '+body?.id+' 不在账号池'),{statusCode:404});
   const r=tiers.setTier(id,body?.tier);monitor.tick();return r;},
  setRunMode:body=>browserLease.setMode(body),
  concurrency:()=>concurrency.status(),
  atPrompt:()=>atPrompt.status(),
  setAtPrompt:body=>{const r=atPrompt.set(body);console.log('[Coordinator] anti-truncation prompt set to '+r.preset);return r;},
  importAtPrompt:body=>{const r=atPrompt.import(body);console.log('[Coordinator] anti-truncation prompt imported, preset '+r.preset);return r;},
  exportAtPrompt:()=>atPrompt.export(),
  setConcurrency:body=>{const r=concurrency.set(body);console.log('[Coordinator] per-slot concurrency set to A='+r.A+' B='+r.B);monitor.tick();return r;},
  targetApp:()=>targetApp.status(),
  saveTargetApp:body=>targetApp.save(body),
  applyTargetApp:()=>targetApp.apply(),
  async deleteAccount(body){
   const id=body?.id,flag=dispatch.accountFlags[id];
   const error=(statusCode,message)=>Object.assign(Error(message),{statusCode});
   if(!Number.isSafeInteger(id)||id<1||body.confirm!=='DELETE '+id)throw error(400,'删除确认不匹配');
   if(!dispatch.pool.ids.includes(id))throw error(404,'账号 '+id+' 不在账号池');
   if(flag?.status==='deleted')return {deleted:true,id};
   // Any account can be deleted (healthy or not), as long as no instance is using it right now.
   if(stopping||dispatch.halted||accountOccupied(id))throw error(409,'账号正被实例使用，请先换号再删除');
   const f=dispatch.accountFlags[id]||(dispatch.accountFlags[id]={status:'deleting',reason:'login_required',at:Date.now()});
   f.status='deleting';dispatch.checkpoint();
   const q=await driver.run('docker',['ps','--filter','label=operit.project=ais2api-dual','--filter','label=operit.account='+id,'--format','{{.ID}}'],{timeout:15000,maxBuffer:16384});
   if(q.stdout.trim()||accountOccupied(id))throw error(409,'账号仍被运行容器占用');
   const file=path.join(driver.authSource,'auth-'+id+'.json');
   try{
    const st=fs.lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink())throw error(409,'认证文件类型异常，拒绝删除');
    fs.unlinkSync(file);driver.syncDirectory(driver.authSource);
   }catch(e){if(e.code!=='ENOENT')throw e;}
   f.status='deleted';f.deletedAt=Date.now();dispatch.checkpoint();
   // Drop the saved password too, so a reused ID never auto-logs in with the old account.
   try{require('../login/login-credentials').remove(id);}catch{}
   return {deleted:true,id,historyPreserved:true,retiredCopiesPreserved:true};
  },
  verifyAccount(body){
   const id=Number(body?.id);
   if(!Number.isSafeInteger(id)||!dispatch.pool.ids.includes(id))throw Object.assign(Error('账号无效'),{statusCode:400});
   const cur=verifyJobs.get(id);
   if(cur&&cur.state==='running')return cur;
   const job={id,state:'running',startedAt:Date.now(),attempts:0};verifyJobs.set(id,job);
   const tryOnce=async()=>{
    job.attempts++;
    const r=await keepalive.verify(id).catch(()=>({result:'failed'}));
    if(['busy','low_memory'].includes(r.result)&&job.attempts<20&&!stopping){job.waiting=r.result;setTimeout(tryOnce,15000);return;}
    Object.assign(job,{state:'done',result:r.result,finishedAt:Date.now()});delete job.waiting;
    console.log('[Verify] account',id,r.result);
   };
   tryOnce();
   return job;
  },
  verifyStatus(id){const j=verifyJobs.get(Number(id));const f=dispatch.accountFlags[Number(id)];return {job:j||null,flag:f?f.status:null};},
  revalidateAccount(body){
   const id=body?.id,flag=dispatch.accountFlags[id];
   const error=(statusCode,message)=>Object.assign(Error(message),{statusCode});
   if(!Number.isSafeInteger(id)||!dispatch.pool.ids.includes(id))throw error(400,'账号无效');
   if(!flag)return {revalidated:false,id};
   if(flag.status!=='invalid')throw error(409,'账号状态不允许恢复');
   if(stopping||dispatch.halted||accountOccupied(id))throw error(409,'账号仍被占用');
   try{driver.validateAccount(id);}catch{throw error(409,'登录文件不可用');}
   delete dispatch.accountFlags[id];dispatch.pool.cooldowns.delete(id);
   if(dispatch.authSaves?.[id])dispatch.authSaves[id]={...dispatch.authSaves[id],keepaliveResult:'ok',keepaliveAt:Date.now()};
   dispatch.checkpoint();
   return {revalidated:true,id};
  },
  proxies:()=>proxies.snapshot(),
  saveProxy:body=>proxies.save(body),
  applyProxy:body=>proxies.start(body),
  prices(){return {...priceStore.snapshot(),models:[...routing.policies.keys()].sort()};},
  savePrice(body){
   if(!body || !routing.policies.has(body.model))throw Object.assign(Error('Configured canonical model required'),{statusCode:400});
   const saved=priceStore.set(body);
   return {...saved,models:[...routing.policies.keys()].sort()};
  },
  historyList(options){return {...history.list(options),recording:recordedForward.status()};},
  usageCounts(){const r=history.counts();for(const i of r.items)i.tier=Number.isSafeInteger(i.account)?tiers.tier(i.account):null;return r;},
  historySummary(options){return {...history.summary(options),recording:recordedForward.status()};},
  async models(){
   const errors={};
   await Promise.all(['A','B'].map(async slot=>{
    try{await catalogs.read(slot);}catch{errors[slot]='catalog_status_unavailable';}
   }));
   return {slots:catalogs.status(),errors,generationRoutingIntegrated:true,configuredPolicies:routing.policies.size,policyState:policyStore.snapshot()};
  },
  async saveModelPolicy(body){
   if(stopping||dispatch.halted||scheduler.queue.length||scheduler.executing.size||
      [...dispatch.slots].some(([slot,s])=>s.active>0||dispatch.operations.has(slot)))
    return {saved:false,reason:"requests_or_operations_busy"};
   const known=[...dispatch.pool.slots].some(([slot,owner])=>
    routing.eligible(slot,owner.current,body.model));
   if(!known)return {saved:false,reason:"model_not_in_fresh_catalog"};
   const result=policyStore.set(body);
   routing.policies=new Map(Object.entries(result.policies).map(([id,p])=>[id,Object.freeze({...p})]));
   return {saved:true,...result};
  },
  async syncModels(slot){
   if(stopping)return {accepted:false,reason:'coordinator_stopping'};
   return catalogs.start(slot);
  },
  async setMode(mode){
   const results={};streamMode.set(mode);
   for(const slot of ['A','B']){
    try{await client.setMode(slot,mode);results[slot]='ok';const e=dispatch.slots.get(slot)?.workerEpoch;if(e)streamMode.applied.set(slot,e+':'+mode);}
    catch(error){results[slot]=String(error.message||error);}
   }
   lastMode=mode;
   return {mode,results};
  },
  async rotate(slot,targetAccount){
   if(stopping)return {started:[],skipped:[{slot,reason:'协调器正在停止'}]};
   const started=[],skipped=[],details={};
   for(const target of slot===undefined?['A','B']:[slot]){
    try{const r=rotation.forceRotate(target,targetAccount??undefined);
     r.done?.then(()=>scheduler.pump());started.push(target);details[target]={account:r.account,activeRequests:r.activeRequests||0,resumed:!!r.resumed};}
    catch(e){skipped.push({slot:target,reason:String(e.message||e)});}
   }
   return {started,skipped,details};
  },
  async restart(slot){
   if(stopping)return {started:[],skipped:[{slot,reason:'协调器正在停止'}]};
   try{const r=rotation.forceRestart(slot);r.done?.then(()=>scheduler.pump());
    return {started:[slot],skipped:[],details:{[slot]:{account:r.account,activeRequests:r.activeRequests||0,resumed:!!r.resumed}}};}
   catch(e){return {started:[],skipped:[{slot,reason:String(e.message||e)}]};}
  },
  async syncAccounts(){
   if(stopping)return {added:[],reason:'coordinator_stopping'};
   const files=fs.readdirSync('/opt/ais2api/auth').filter(n=>/^auth-[1-9]\d*\.json$/.test(n)).map(n=>Number(n.match(/\d+/)[0])).filter(Number.isSafeInteger).sort((a,b)=>a-b);
   const added=[];
   for(const id of files){
    // Importers number new files max+1, so a deleted ID can come back as a different account.
    // A file written after the deletion is a new account: drop the old account's flag and history.
    const flag=dispatch.accountFlags[id];
    if(flag?.status==='deleted'&&!accountOccupied(id)){
     let mtime=0;try{mtime=fs.statSync(path.join('/opt/ais2api/auth','auth-'+id+'.json')).mtimeMs;}catch{}
     if(mtime>(flag.deletedAt||flag.at||0)){
      delete dispatch.accountFlags[id];dispatch.pool.cooldowns.delete(id);
      if(dispatch.authSaves)delete dispatch.authSaves[id];
      added.push(id);console.log('[Accounts] reused ID',id,'treated as a new account');
     }
    }
    if(dispatch.pool.ids.includes(id))continue;
    dispatch.quotas.account(id,true);
    dispatch.pool.ids.push(id);
    dispatch.pool.ids.sort((a,b)=>a-b);
    added.push(id);
   }
   // Auth file removed outside the admin page: retire it like a normal delete (history kept).
   const removed=[];
   for(const id of dispatch.pool.ids){
    if(files.includes(id)||dispatch.accountFlags[id]?.status==='deleted'||accountOccupied(id))continue;
    dispatch.accountFlags[id]={status:'deleted',reason:'login_required',at:Date.now(),deletedAt:Date.now()};removed.push(id);
   }
   if(removed.length)console.log('[Accounts] auth file missing, marked deleted',removed.join(','));
   if(added.length||removed.length)dispatch.checkpoint();
   return {added,removed,pool:dispatch.pool.ids};
  }
 };
 const server=createServer({keys:cfg.apiKeys,models:()=>[...routing.list(),...build.models()],scheduler,status,actions,auth:consoleAuth});
 await new Promise((resolve,reject)=>{
  server.once('error',reject);server.listen(8890,'127.0.0.1',resolve);
 });
 const authTimer=setInterval(()=>{actions.syncAccounts().then(r=>{if(r.added?.length)console.log('[Accounts] synced',r.added.join(','));}).catch(()=>{});},60000);authTimer.unref();
 const haltTimer=setInterval(()=>{if(!stopping&&dispatch.halted&&dispatch.tryResume())console.warn('[Coordinator] state checkpoint succeeded again; dispatch resumed');},30000);haltTimer.unref();
 const timer=setInterval(()=>{monitor.tick();applyMode().catch(()=>{});},2000);
 const modeTimer=setInterval(()=>browserLease.tick(),5000);modeTimer.unref();
 const cleanupTimer=setInterval(()=>cleanup.tick(),60000);cleanupTimer.unref();
 console.log('[Coordinator] loopback 8890; protocol v2; per-slot concurrency A='+concurrency.get('A')+' B='+concurrency.get('B')+'; explicit model quotas');
 async function shutdown(){
  if(stopping)return;stopping=true;clearInterval(timer);clearInterval(haltTimer);clearInterval(authTimer);clearInterval(cleanupTimer);cleanup.close();monitor.close();scheduler.close();
  server.close();
  const deadline=Date.now()+620000;
  while(Date.now()<deadline && ([...dispatch.slots.values()].some(s=>s.active>0||Object.keys(s.retirements||{}).length>0)||[...rotation.running].some(slot=>!dispatch.slots.get(slot).proxyApply)||catalogs.jobs.size||proxies.jobs.size)){
   await scheduler.reconcile();
   await Promise.all(["A","B"].map(slot=>catalogs.reconcile(slot)));
   await new Promise(r=>setTimeout(r,500));
  }
  try{dispatch.checkpoint();}catch{}
  process.exit(0);
 }
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
main().catch(()=>{console.error('[Coordinator] startup failed; details suppressed');process.exitCode=1;});
