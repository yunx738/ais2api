'use strict';
// Coordinator in no-browser mode: same public API (8890), same account pool / quotas / history / Build channel,
// but every request runs on the local AIStudio2API service. No worker containers are started.
const fs=require('fs'),path=require('path');
const {restore}=require('./restore-dispatch');
const {RequestScheduler}=require('./request-scheduler');
const {createServer,sanitizeStats}=require('./coordinator-http');
const {authFileInfo}=require('./auth-maintenance');
const {HeadlessService}=require('./headless-service');
const {createHeadlessForward,accountEmail}=require('./headless-forward');
const {HeadlessDispatch,HeadlessClient,settling,SLOT}=require('./headless-dispatch');
const {HeadlessRouting}=require('./headless-routing');
const {HeadlessImport}=require('./headless-import');
const RunMode=require('./run-mode-file');
async function main(){
 const root=process.env.DUAL_ROOT||'/opt/ais2api/dual-runtime';
 const cfg=JSON.parse(fs.readFileSync(path.join(root,'coordinator.json'),'utf8'));
 const core=restore(path.join(root,'state.json'),{repairMissingQuota:true});if(core.repairedQuota)core.checkpoint();
 const service=HeadlessService.fromFiles();
 const importer=new HeadlessImport();
 const {AccountTiers}=require('./account-tiers');
 const tiers=new AccountTiers({authDir:'/opt/ais2api/auth',file:path.join(root,'ultra-mode.json'),isSingle:()=>true});
 core.quotas.tierOf=id=>tiers.tier(id);
 // Per-account concurrency (1-10), persisted in headless-concurrency.json; env HEADLESS_PER_ACCOUNT is the fallback.
 const ccFile=path.join(root,'headless-concurrency.json');
 let perAccount=Number(process.env.HEADLESS_PER_ACCOUNT)||2;
 try{const n=JSON.parse(fs.readFileSync(ccFile,'utf8')).perAccount;if(Number.isSafeInteger(n)&&n>=1&&n<=10)perAccount=n;}catch{}
 const dispatch=new HeadlessDispatch({core,usable:id=>importer.has(id),isPremium:id=>tiers.isPremium(id),perAccount:()=>perAccount});
 const disFile=path.join(root,'headless-disabled.json');
 try{for(const id of JSON.parse(fs.readFileSync(disFile,'utf8')))if(Number.isSafeInteger(id))dispatch.disabled.add(id);}catch{}
 const live=()=>core.pool.ids.filter(id=>core.accountFlags[id]?.status!=='deleted');
 const syncImport=()=>{try{const r=importer.sync(live());if(r.added.length||r.changed.length)console.log('[Headless] imported',JSON.stringify(r));return r;}catch(e){console.error('[Headless] import failed',e.message);return null;}};
 syncImport();
 const {openHistory}=require('./history-startup');
 const {createRecordedForward}=require('./recorded-forward');
 const history=await openHistory(path.join(root,'request-history'));
 const {ModelPriceStore}=require('./model-price-store');
 const priceStore=new ModelPriceStore(path.join(root,'model-prices.json'));
 const sweepStale=()=>{if(history.status().ready&&typeof history.expireStale==='function')history.expireStale().catch(()=>{});};
 sweepStale();setInterval(sweepStale,300000).unref();
 const atPrompt=new (require('./at-prompt-store').AtPromptStore)(path.join(root,'at-prompt.json'));
 const hforward=createHeadlessForward({service});
 const recordedForward=createRecordedForward({history,forward:(ticket,route,body,res,credentials,options={})=>hforward(ticket,route,body,res,credentials,{...options,atPrompt:atPrompt.get(),atPromptCustom:atPrompt.header()}),
  priceFor:model=>priceStore.get(model),missLog:path.join(__dirname,'..','usage-missing.jsonl')});
 const client=new HeadlessClient(dispatch);
 const scheduler=new RequestScheduler(dispatch,client,recordedForward,{[SLOT]:{}});
 const {ModelPolicyStore}=require('./model-policy-store');
 const policyStore=new ModelPolicyStore(path.join(root,'model-policies.json'),cfg.modelPolicies||{});
 const policyMap=()=>new Map(Object.entries(policyStore.policies).map(([id,p])=>[id,Object.freeze({...p})]));
 const routing=new HeadlessRouting({service,policies:policyMap(),dispatch,isPremium:id=>tiers.isPremium(id)});
 routing.start();
 // Build channel: identical ledger/apps/settings files as browser mode.
 const {BuildChannel,BuildSettings}=require('./build-coordinator');
 const buildPresets=new (require('./build-presets').PresetStore)(path.join(root,'build-presets.json'));
 const buildDocument=new (require('./build-document').DocumentSwitch)(path.join(root,'build-document.json'));
 const buildSettings=new BuildSettings(path.join(root,'build-settings.json'));
 const build=new BuildChannel({appsFile:path.join(root,'build-apps.json'),ledgerFile:path.join(root,'build-tokens.json'),
  tierOf:id=>tiers.tier(id),isPremium:id=>tiers.isPremium(id),presets:buildPresets,document:buildDocument,settings:buildSettings});
 scheduler.resolveModel=(route,body,options)=>build.resolve(route,body,options)||routing.resolve(route,body,options);
 scheduler.forward=settling(dispatch,build.wrapForward(scheduler.forward));
 const H=require('./build-headless');
 const {BuildAppletRotation}=require('./build-applet-rotation');
 // 'slot' here is the account e-mail: applet RPCs go straight to the account through the headless service.
 const appletRpc=(email,method,request)=>H.appletRpc(service.raw,email,method,request).then(r=>{if(r.status===0)throw Error('headless rpc failed');return r;});
 const appletRotation=new BuildAppletRotation({appsFile:path.join(root,'build-apps.json'),stateFile:path.join(root,'build-applet-rotation.json'),rpc:appletRpc,
  slotOf:id=>importer.has(id)?accountEmail(id):null});
 setInterval(()=>{appletRotation.tick().then(r=>{if(r&&!r.skipped)console.log('[BuildRotation]',JSON.stringify(r));}).catch(e=>console.error('[BuildRotation]',e.message));},600000).unref();
 const renewing=new Map();
 const scheduleRenew=(acct,attempt=0)=>{
  if(cfg.buildRenewPerRequest===false||renewing.has(acct))return;
  const t=setTimeout(async()=>{
   renewing.delete(acct);
   if(build.busy(acct)>0){if(attempt<60)scheduleRenew(acct,attempt+1);return;}
   let r;try{r=await appletRotation.renew(acct,accountEmail(acct));}catch(e){r='error:'+e.message;}
   if(!/^renewed/.test(r)&&r!=='no_project'&&r!=='changed'){if(attempt<60)scheduleRenew(acct,attempt+1);else console.warn('[BuildRenew] #'+acct+' gave up: '+r);}
  },attempt===0?2000:10000);t.unref?.();renewing.set(acct,t);
 };
 build.onFinished=acct=>scheduleRenew(acct);
 // Every imported Pro/Ultra (or any, when premiumOnly is off) account gets a Build project.
 const provision=()=>{if(cfg.buildAutoProvision===false)return;
  for(const id of live()){if(core.accountFlags[id]||!importer.has(id)||build.appFor(id))continue;
   if(buildSettings.premiumOnly&&!tiers.isPremium(id))continue;
   appletRotation.ensure(id,accountEmail(id)).then(r=>{if(!['present','busy','backoff'].includes(r))console.log('[BuildProvision] #'+id+' '+r);}).catch(()=>{});}};
 setTimeout(provision,15000).unref();setInterval(provision,300000).unref();
 const {ConsoleAuth}=require('./console-auth');
 const consoleAuth=new ConsoleAuth({file:path.join(root,'console-auth.json'),internalKey:cfg.apiKeys[0]});
 let stopping=false;
 const cookieStatus=id=>{
  const info=authFileInfo(path.join('/opt/ais2api/auth','auth-'+id+'.json'));
  const flag=core.accountFlags[id];
  return {login:flag&&['invalid','deleting','deleted'].includes(flag.status)?'invalid':importer.has(id)?'online':'unverified',
   file:info.state,keyCookies:info.keyCookies||0,expiresAt:Number.isFinite(info.expiresAt)?info.expiresAt:null,session:info.session===true,
   expired:Number.isFinite(info.expiresAt)&&info.expiresAt<=Date.now(),modifiedAt:info.modifiedAt||null,save:core.authSaves?.[id]||null};
 };
 const runModeStatus=()=>({mode:'headless',single:false,parked:null,serving:null,phase:'headless',error:null,leaseActive:false,modes:RunMode.MODES});
 const status=()=>({
  halted:core.halted,paused:dispatch.paused,queue:scheduler.queue.length,scheduling:scheduler.status(),runMode:runModeStatus(),
  headless:{...dispatch.status(),models:routing.models.size,modelsAt:routing.at},
  streamingMode:'real',ultra:tiers.status(core.pool.ids),analytics:recordedForward.status(),gatewayRepair:{...sanitizeStats},
  quotaMode:'per-account-per-model',quotaLimits:require('./model-quota-ledger').TIER_LIMITS,
  slots:{[SLOT]:{account:null,active:dispatch.state.active,ready:true,headless:true,pendingRetirements:Object.keys(dispatch.state.retirements).length,
   pendingExecutions:Object.values(dispatch.state.executions).map(t=>({id:t.id,phase:t.phase,createdAt:t.createdAt,account:t.account}))}},
  accounts:core.pool.ids.filter(id=>core.accountFlags[id]?.status!=='deleted').map(id=>{
   const names=tiers.names(id),flag=core.accountFlags[id];
   return {cookie:cookieStatus(id),authStatus:flag?.status||'unknown',invalidReason:flag?.reason,invalidAt:flag?.at,
    canDelete:flag?.status!=='deleted'&&!dispatch.busy(id),id,name:names.alias||names.accountName||'N/A (未命名)',alias:names.alias,accountName:names.accountName,
    tier:tiers.tier(id),owner:dispatch.busy(id)?SLOT:null,busy:dispatch.busy(id),headless:importer.has(id),disabled:dispatch.disabled.has(id),cooldownUntil:core.pool.cooldowns.get(id)||0,quota:core.quotas.summary(id,policyStore.policies)};
  })
 });
 const nope=()=>{throw Object.assign(Error('无浏览器模式下没有实例，此操作不可用'),{statusCode:409});};
 const actions={
  buildStatus:()=>({...build.status(),appletRotation:appletRotation.status()}),
  buildPresets:()=>({presets:buildPresets.list()}),
  buildDocument:()=>buildDocument.status(),setBuildDocument:b=>buildDocument.set(b),
  buildSettings:()=>buildSettings.status(),setBuildSettings:b=>buildSettings.set(b),
  buildPresetAdd:b=>buildPresets.add(b?.name,b?.preset),buildPresetRemove:b=>buildPresets.remove(String(b?.id||'')),buildPresetEnable:b=>buildPresets.setEnabled(String(b?.id||''),b?.enabled),
  rotateBuildApplets:b=>appletRotation.tick({force:true,only:Number.isSafeInteger(b?.account)?b.account:null}),
  // Login browsers never pause anything in this mode: no workers to stop.
  leaseStatus:()=>null,leaseAcquire:async()=>({slot:null,account:null,single:false,headless:true}),leaseRelease:async()=>({released:true}),
  runMode:runModeStatus,
  setRunMode:b=>{const mode=b?.mode??(b?.single===true?'single':b?.single===false?'dual':undefined);
   const next=RunMode.write(root,mode);if(next.mode!=='headless'){console.log('[Coordinator] run mode -> '+next.mode+'; restarting');RunMode.scheduleRestart();}
   return {...runModeStatus(),mode:next.mode,phase:next.mode==='headless'?'headless':'restarting'};},
  ultraMode:()=>tiers.status(core.pool.ids),setUltraMode:b=>{tiers.setMode(b);return tiers.status(core.pool.ids);},
  setAccountName:b=>{const id=Number(b?.id);if(!core.pool.ids.includes(id))throw Object.assign(Error('账号 '+b?.id+' 不在账号池'),{statusCode:404});return tiers.setAlias(id,b?.name);},
  setAccountTier:b=>{const id=Number(b?.id);if(!core.pool.ids.includes(id))throw Object.assign(Error('账号 '+b?.id+' 不在账号池'),{statusCode:404});return tiers.setTier(id,b?.tier);},
  concurrency:()=>({A:perAccount,B:perAccount,perAccount,headless:true}),setConcurrency:nope,
  setHeadlessConcurrency(b){const n=Number(b?.perAccount);if(!Number.isSafeInteger(n)||n<1||n>10)throw Object.assign(Error('并发数只能是 1 到 10 的整数'),{statusCode:400});
   const t=ccFile+'.tmp';fs.writeFileSync(t,JSON.stringify({perAccount:n}),{mode:0o600});fs.renameSync(t,ccFile);perAccount=n;console.log('[Headless] per-account concurrency -> '+n);return {perAccount:n};},
  opsStatus:()=>({mode:'headless',perAccount,active:dispatch.state.active,queue:scheduler.queue.length,halted:core.halted,paused:dispatch.paused,
   running:Object.values(dispatch.state.executions).map(t=>({id:t.id,account:t.account,model:t.model,kind:t.kind,phase:t.phase,createdAt:t.createdAt,cancellable:dispatch.live.has(t.id)})),
   accounts:live().map(id=>({id,email:accountEmail(id),imported:importer.has(id),busy:dispatch.busy(id),limit:perAccount,disabled:dispatch.disabled.has(id),cooldownUntil:core.pool.cooldowns.get(id)||0,flag:core.accountFlags[id]?.status||null,
    modelCooldowns:Object.entries(core.quotas.account(id)?.models||{}).filter(([,q])=>q.cooldownUntil>Date.now()).map(([m,q])=>({model:m,until:q.cooldownUntil}))}))}),
  clearCooldown(b){const id=Number(b?.id);if(!core.pool.ids.includes(id))throw Object.assign(Error('账号 '+b?.id+' 不在账号池'),{statusCode:404});
   core.pool.cooldowns.delete(id);let models=0;for(const q of Object.values(core.quotas.account(id)?.models||{}))if(q.cooldownUntil){q.cooldownUntil=0;models++;}
   core.checkpoint();console.log('[Ops] cooldown cleared #'+id);return {id,cleared:true,models};},
  resetQuota(b){const id=Number(b?.id);if(!core.pool.ids.includes(id))throw Object.assign(Error('账号 '+b?.id+' 不在账号池'),{statusCode:404});
   if(b?.confirm!=='RESET '+id)throw Object.assign(Error('确认文字不匹配'),{statusCode:400});
   let n=0;for(const q of Object.values(core.quotas.account(id)?.models||{})){if(q.used){q.used=0;n++;}}
   core.checkpoint();console.log('[Ops] quota counters reset #'+id);return {id,reset:n};},
  setPaused(b){if(typeof b?.paused!=='boolean')throw Object.assign(Error('参数无效'),{statusCode:400});
   dispatch.paused=b.paused;console.log('[Ops] dispatch '+(b.paused?'paused':'resumed'));if(!b.paused)scheduler.pump();return {paused:dispatch.paused};},
  setAccountEnabled(b){const id=Number(b?.id);if(!core.pool.ids.includes(id))throw Object.assign(Error('账号 '+b?.id+' 不在账号池'),{statusCode:404});
   if(typeof b?.enabled!=='boolean')throw Object.assign(Error('参数无效'),{statusCode:400});
   if(b.enabled)dispatch.disabled.delete(id);else dispatch.disabled.add(id);
   const t=disFile+'.tmp';fs.writeFileSync(t,JSON.stringify([...dispatch.disabled].sort((x,y)=>x-y)),{mode:0o600});fs.renameSync(t,disFile);
   console.log('[Ops] account #'+id+' '+(b.enabled?'enabled':'disabled'));if(b.enabled)scheduler.pump();return {id,enabled:!dispatch.disabled.has(id)};},
  // One tiny request pinned to the account; bypasses the quota ledger (it is a health check, not client traffic).
  async testAccount(b){const id=Number(b?.id);if(!core.pool.ids.includes(id))throw Object.assign(Error('账号 '+b?.id+' 不在账号池'),{statusCode:404});
   const email=accountEmail(id);if(!email||!importer.has(id))throw Object.assign(Error('账号未导入无浏览器服务'),{statusCode:409});
   const pick=['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-3.6-flash','gemini-3.8-flash'].find(m=>routing.models.has(m))||[...routing.models].find(m=>/flash/.test(m)&&!/(image|tts|search|live|audio)/.test(m));
   if(!pick)throw Object.assign(Error('模型列表为空，请先刷新模型'),{statusCode:409});
   const c=new AbortController(),timer=setTimeout(()=>c.abort(),30000),t0=Date.now();
   try{const r=await service.call(email,'POST','/v1/chat/completions',{model:pick,messages:[{role:'user',content:'Reply with the single word OK.'}],stream:false},{signal:c.signal});
    const text=String(r.json?.choices?.[0]?.message?.content||'').trim().slice(0,80),ms=Date.now()-t0;
    console.log('[Ops] test #'+id+' '+pick+' status='+r.status+' ms='+ms);
    return {id,model:pick,ok:r.status===200&&!!text,status:r.status,ms,text,error:r.status===200?(text?null:'返回为空'):String(r.json?.error?.message||r.text||'').slice(0,200)};}
   catch(e){return {id,model:pick,ok:false,status:c.signal.aborted?504:502,ms:Date.now()-t0,error:c.signal.aborted?'30 秒未响应':String(e.message||e).slice(0,200)};}
   finally{clearTimeout(timer);}},
  cancelRequest(b){const id=String(b?.id||''),x=dispatch.live.get(id);if(!x)throw Object.assign(Error('请求已结束或不存在'),{statusCode:404});
   try{x.res?.destroy?.();}catch{}console.log('[Ops] request cancelled '+id.slice(0,8)+' #'+x.ticket.account);return {id,cancelled:true};},
  writeBack:()=>importer.writeBack(live()),
  atPrompt:()=>atPrompt.status(),setAtPrompt:b=>atPrompt.set(b),importAtPrompt:b=>atPrompt.import(b),exportAtPrompt:()=>atPrompt.export(),
  targetApp:()=>({headless:true}),saveTargetApp:nope,applyTargetApp:nope,
  proxies:()=>({slots:[],headless:true}),saveProxy:nope,applyProxy:nope,
  prices(){return {...priceStore.snapshot(),models:[...routing.policies.keys()].sort()};},
  savePrice(b){if(!b||!routing.policies.has(b.model))throw Object.assign(Error('Configured canonical model required'),{statusCode:400});return {...priceStore.set(b),models:[...routing.policies.keys()].sort()};},
  historyList:o=>({...history.list(o),recording:recordedForward.status()}),
  usageCounts(){const r=history.counts();for(const i of r.items)i.tier=Number.isSafeInteger(i.account)?tiers.tier(i.account):null;return r;},
  historySummary:o=>({...history.summary(o),recording:recordedForward.status()}),
  async models(){await routing.refresh();return {slots:{[SLOT]:{account:null,catalog:{snapshot:{models:[...routing.models].map(id=>({id,methods:['generateContent']}))}}}},errors:{},generationRoutingIntegrated:true,configuredPolicies:routing.policies.size,policyState:policyStore.snapshot()};},
  async saveModelPolicy(b){if(scheduler.queue.length||scheduler.executing.size)return {saved:false,reason:'requests_or_operations_busy'};
   const r=policyStore.set(b);routing.policies=policyMap();return {saved:true,...r};},
  syncModels:async()=>{await routing.refresh();return {accepted:true,models:routing.models.size};},
  setMode:async m=>({mode:m,results:{}}),
  rotate:async()=>({started:[],skipped:[{slot:SLOT,reason:'无浏览器模式下所有账号同时可用，无需切换'}]}),
  restart:async()=>{try{await require('util').promisify(require('child_process').execFile)('systemctl',['restart','ais2api-headless'],{timeout:30000});return {started:[SLOT],skipped:[]};}catch(e){return {started:[],skipped:[{slot:SLOT,reason:e.message}]};}},
  verifyAccount:b=>{const id=Number(b?.id);return {id,state:'done',result:importer.has(id)?'ok':'not_imported'};},
  verifyStatus:id=>({job:null,flag:core.accountFlags[Number(id)]?.status||null}),
  revalidateAccount(b){const id=b?.id,flag=core.accountFlags[id];if(!Number.isSafeInteger(id)||!core.pool.ids.includes(id))throw Object.assign(Error('账号无效'),{statusCode:400});
   if(!flag)return {revalidated:false,id};if(flag.status!=='invalid')throw Object.assign(Error('账号状态不允许恢复'),{statusCode:409});
   delete core.accountFlags[id];core.pool.cooldowns.delete(id);core.checkpoint();reloadSoon();return {revalidated:true,id};},
  async deleteAccount(body){
   const id=body?.id,flag=core.accountFlags[id];
   const error=(statusCode,message)=>Object.assign(Error(message),{statusCode});
   if(!Number.isSafeInteger(id)||id<1||body.confirm!=='DELETE '+id)throw error(400,'删除确认不匹配');
   if(!core.pool.ids.includes(id))throw error(404,'账号 '+id+' 不在账号池');
   if(flag?.status==='deleted')return {deleted:true,id};
   if(stopping||core.halted||dispatch.busy(id)||build.busy(id)>0)throw error(409,'账号正在处理请求，请稍后再删除');
   const email=accountEmail(id);
   const f=core.accountFlags[id]||(core.accountFlags[id]={status:'deleting',reason:'login_required',at:Date.now()});
   f.status='deleting';core.checkpoint();
   try{fs.unlinkSync(path.join('/opt/ais2api/auth','auth-'+id+'.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
   if(email&&/^[^\/]+@[^\/]+$/.test(email)){try{fs.rmSync(path.join(importer.target,email),{recursive:true,force:true});}catch{}}
   f.status='deleted';f.deletedAt=Date.now();core.checkpoint();
   try{require('../login/login-credentials').remove(id);}catch{}
   try{build.forget(id);appletRotation.forget(id);}catch(e){console.error('[Build] forget #'+id,e.message);}
   reloadSoon();
   return {deleted:true,id,historyPreserved:true};
  },
  async syncAccounts(){
   if(stopping)return {added:[],reason:'coordinator_stopping'};
   const files=fs.readdirSync('/opt/ais2api/auth').filter(n=>/^auth-[1-9]\d*\.json$/.test(n)).map(n=>Number(n.match(/\d+/)[0])).filter(Number.isSafeInteger).sort((a,b)=>a-b);
   const added=[];
   for(const id of files){
    const flag=core.accountFlags[id];
    if(flag?.status==='deleted'&&!dispatch.busy(id)){
     let mtime=0;try{mtime=fs.statSync(path.join('/opt/ais2api/auth','auth-'+id+'.json')).mtimeMs;}catch{}
     if(mtime>(flag.deletedAt||flag.at||0)){delete core.accountFlags[id];core.pool.cooldowns.delete(id);if(core.authSaves)delete core.authSaves[id];added.push(id);}
    }
    if(core.pool.ids.includes(id))continue;
    core.quotas.account(id,true);core.pool.ids.push(id);core.pool.ids.sort((a,b)=>a-b);added.push(id);
   }
   const removed=[];
   for(const id of core.pool.ids){
    if(files.includes(id)||core.accountFlags[id]?.status==='deleted'||dispatch.busy(id))continue;
    core.accountFlags[id]={status:'deleted',reason:'login_required',at:Date.now(),deletedAt:Date.now()};removed.push(id);
   }
   if(added.length||removed.length)core.checkpoint();
   for(const k of Object.keys(build.apps())){const id=Number(k);
    if(core.pool.ids.includes(id)&&core.accountFlags[id]?.status!=='deleted')continue;
    try{build.forget(id);appletRotation.forget(id);console.log('[Build] #'+id+' removed from the Build channel (account deleted)');}catch{}}
   const imp=syncImport();
   if(removed.length||imp&&(imp.added.length||imp.changed.length))reloadSoon();
   return {added,removed,pool:core.pool.ids,imported:imp};
  }
 };
 // The service reads account directories at start-up: restart it once nothing is running on it.
 let reloadTimer=null,reloadWaits=0;
 function reloadSoon(){
  if(reloadTimer)return;
  reloadTimer=setTimeout(async()=>{reloadTimer=null;
   if(dispatch.state.active>0||build.busy&&live().some(id=>build.busy(id)>0)){if(++reloadWaits<120)return reloadSoon();}
   reloadWaits=0;
   try{await actions.restart();console.log('[Headless] service reloaded for account changes');}catch(e){console.error('[Headless] reload failed',e.message);}
  },5000);reloadTimer.unref?.();
 }
 const server=createServer({keys:cfg.apiKeys,models:()=>[...routing.list(),...build.models()],scheduler,status,actions,auth:consoleAuth});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8890,'127.0.0.1',resolve);});
 // Browser workers left running by a previous browser-mode coordinator are not used here: stop them (data volumes kept).
 {const {execFile}=require('child_process');
  execFile('docker',['ps','-q','--filter','label=operit.project=ais2api-dual','--filter','name=^ais2api-dual-[ab]$'],{timeout:15000},(e,out)=>{
   const ids=String(out||'').split(/\s+/).filter(Boolean);if(e||!ids.length)return;
   execFile('docker',['stop','-t','20',...ids],{timeout:90000},err=>console.log('[Coordinator] browser workers '+(err?'stop failed: '+err.message:'stopped ('+ids.length+')')));
  });}
 const writeBack=()=>{try{const r=importer.writeBack(live());if(r.written.length)console.log('[Headless] cookies written back',r.written.join(','));}catch(e){console.error('[Headless] write-back failed',e.message);}};
 setInterval(writeBack,600000).unref();setTimeout(writeBack,30000).unref();
 const authTimer=setInterval(()=>{actions.syncAccounts().then(r=>{if(r.added?.length||r.removed?.length)console.log('[Accounts] synced',JSON.stringify({added:r.added,removed:r.removed}));}).catch(()=>{});},60000);authTimer.unref();
 const haltTimer=setInterval(()=>{if(!stopping&&core.halted&&core.tryResume?.())console.warn('[Coordinator] state checkpoint succeeded again; dispatch resumed');},30000);haltTimer.unref();
 console.log('[Coordinator] loopback 8890; mode=headless; per-account concurrency '+perAccount+'; accounts '+live().filter(id=>importer.has(id)).length);
 async function shutdown(){
  if(stopping)return;stopping=true;clearInterval(authTimer);clearInterval(haltTimer);routing.stop?.();scheduler.close();server.close();
  const deadline=Date.now()+620000;
  while(Date.now()<deadline&&dispatch.state.active>0)await new Promise(r=>setTimeout(r,500));
  try{core.checkpoint();}catch{}
  process.exit(0);
 }
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
module.exports={main};
if(require.main===module)main().catch(e=>{console.error('[Coordinator] headless startup failed:',e&&e.message);process.exitCode=1;});
