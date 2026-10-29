'use strict';
const crypto=require('crypto');
const express=require('express');
function install(system,secret){
 if(typeof secret !== 'string'||secret.length<32)throw Error('Worker control key required');
 const fs=require('fs'),path=require('path');
 const account=Number(process.env.WORKER_ACCOUNT),slot=process.env.WORKER_SLOT;
 const authBaseHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'auth','auth-'+account+'.json'))).digest('hex');
 const original=system._createExpressApp.bind(system);
 let exporting=false,lastExportAt=0,keeping=false,probing=false;
 // Runs inside the page. Returns status, headers, chunk timing and body; the signature itself is never returned.
 const rpcProbe=async function(method,body,ht,sigPath){var w=window,tb=w.__tb;if(!tb||!w.__gcS||!w.__gcH)return JSON.stringify({err:'signer_not_ready'});
  var md=tb.getMetadata()||{};var waa=md['X-Goog-Api-Key'];var key=null;for(var sk in tb){var mb;try{mb=tb[sk];}catch(e){continue;}if(!mb||typeof mb!=='object')continue;for(var k in mb){var v;try{v=mb[k];}catch(e){continue;}if(typeof v==='string'&&/^AIza[0-9A-Za-z_-]{30,}$/.test(v)&&v!==waa){key=v;break;}}if(key)break;}
  if(!key)return JSON.stringify({err:'page_key_not_found'});
  var sig=await w.__gcS(tb,await w.__gcH(ht));var o=body;for(var i=0;i<sigPath.length-1;i++)o=o[sigPath[i]];o[sigPath[sigPath.length-1]]=sig;
  var hd={'content-type':'application/json+protobuf','x-user-agent':'grpc-web-javascript/0.1','x-goog-api-key':key,'authorization':md.Authorization,'x-goog-authuser':md['X-Goog-AuthUser']!=null?String(md['X-Goog-AuthUser']):'0'};
  var url='https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/'+method;
  var t0=Date.now(),chunks=[],txt='',r;var ac=new AbortController();var wd=setTimeout(function(){ac.abort();},110000);
  try{r=await fetch(url,{method:'POST',credentials:'include',headers:hd,body:JSON.stringify(body),signal:ac.signal});var rh={};r.headers.forEach(function(v,k){if(!/cookie|auth/i.test(k))rh[k]=v;});
   var rd=r.body.getReader(),dec=new TextDecoder();for(;;){var x=await rd.read();if(x.done)break;var s=dec.decode(x.value,{stream:true});txt+=s;chunks.push([Date.now()-t0,s.length]);if(txt.length>200000)break;}
  }catch(e){return JSON.stringify({err:'fetch '+String(e&&e.message||e).slice(0,120),ms:Date.now()-t0});}finally{clearTimeout(wd);}
  return JSON.stringify({status:r.status,ms:Date.now()-t0,headers:rh,chunks:chunks,sigLen:sig.length,text:txt});};
 const idle=()=>{
  const s=system.workerStatus(),b=system.browserManager;
  let url;try{url=new URL(b.page.url());}catch{return false;}
  return s.account===account && s.ready===true && s.busy===false &&
   s.quarantined===false && !s.hardQuarantine && s.activeRequests===0 &&
   s.browserOperations===0 && s.pendingCompletions===0 &&
   b.currentAuthIndex===account && b.context && !b.page.isClosed() &&
   url.protocol==='https:' && url.hostname==='aistudio.google.com';
 };
 system.exportAuth=async(expectedAccount,expectedEpoch)=>{
  if(expectedAccount!==account||expectedEpoch!==system.executions?.epoch||exporting||keeping||
    Date.now()-lastExportAt<21600000||!idle())throw Error('Snapshot unavailable');
  exporting=true;lastExportAt=Date.now();
  const context=system.browserManager.context,page=system.browserManager.page;
  try{
   // Playwright reads existing state; no goto/reload, no network keepalive.
   const state=await context.storageState();
   if(context!==system.browserManager.context||page!==system.browserManager.page||!idle()||
     !Array.isArray(state.cookies)||!state.cookies.length||!Array.isArray(state.origins))
    throw Error('Snapshot unsafe');
   if(!state.cookies.some(c=>['SID','__Secure-1PSID','__Secure-3PSID'].includes(c.name)&&
     /(^|\.)google\.com$/.test(c.domain)&&(c.expires===-1||c.expires>Date.now()/1000)))
    throw Error('Login cookies unavailable');
   const data={account,slot,workerEpoch:system.executions.epoch,authBaseHash,state};
   if(Buffer.byteLength(JSON.stringify(data))>300000)throw Error('Snapshot too large');
   return data;
  }finally{exporting=false;}
 };

 const KEYS=['SID','__Secure-1PSID','__Secure-3PSID'];
 system.spareKeepalive=async(body)=>{
  const target=Number(body?.account),st=body?.state;
  if(!Number.isSafeInteger(target)||target<1||target===account||body.expectedEpoch!==system.executions?.epoch||
    !Array.isArray(st?.cookies)||!Array.isArray(st?.origins))throw Error('bad');
  if(keeping||exporting||!idle())return {result:'busy'};
  let free=0;
  try{const r=f=>fs.readFileSync('/sys/fs/cgroup/'+f,'utf8').trim();const max=r('memory.max');
   free=(max==='max'?1363148800:Number(max))-Number(r('memory.current'));}catch{}
  if(!(free>=400*1048576))return {result:'low_memory'};
  const b=system.browserManager,browser=b.browser;
  if(!browser||!browser.isConnected())return {result:'busy'};
  keeping=true;let ctx;
  const hard=setTimeout(()=>{if(ctx)ctx.close().catch(()=>{});},110000);
  try{
   // Separate context in A's browser: isolated cookies, same proxy, main page untouched.
   ctx=await browser.newContext({storageState:{cookies:st.cookies,origins:st.origins},viewport:{width:1280,height:800}});
   await ctx.route('**/*',r=>['image','media','font'].includes(r.request().resourceType())?r.abort().catch(()=>{}):r.continue().catch(()=>{}));
   const page=await ctx.newPage();
   const url0=(b.config&&b.config.targetUrl)||'https://aistudio.google.com/';
   try{await page.goto(url0,{timeout:60000,waitUntil:'domcontentloaded'});}
   catch(e){return {result:/timeout/i.test(String(e&&e.message))?'timeout':'proxy_error'};}
   await page.waitForTimeout(20000);
   const url=page.url();let title='';try{title=await page.title();}catch{}
   if(url.includes('accounts.google.com')||url.includes('ServiceLogin')||title.includes('Sign in')||title.includes('登录'))return {result:'login_required'};
   if(title.includes('Available regions')||title.includes('not available'))return {result:'region_blocked'};
   let host='';try{host=new URL(url).hostname;}catch{}
   if(!/(^|\.)(aistudio\.google\.com|ai\.studio)$/.test(host))return {result:'unexpected_page'};
   const state=await ctx.storageState();
   if(!state.cookies.some(c=>KEYS.includes(c.name)&&/(^|\.)google\.com$/.test(c.domain)&&(c.expires===-1||c.expires>Date.now()/1000)))return {result:'no_cookies'};
   const data={result:'ok',account:target,state};
   if(Buffer.byteLength(JSON.stringify(data))>390000)return {result:'too_large'};
   return data;
  }finally{clearTimeout(hard);if(ctx)await ctx.close().catch(()=>{});keeping=false;}
 };
 system._createExpressApp=()=>{
  const outer=express();
  outer.disable('x-powered-by');
  outer.use((req,res,next)=>{
   res.setHeader('Cache-Control','no-store');
   const supplied=req.headers['x-worker-key'];
   const a=Buffer.from(typeof supplied==='string'?supplied:''),b=Buffer.from(secret);
   if(a.length !== b.length)return res.setHeader('X-AIS-Worker-Rejection','control_auth').status(401).json({error:'Unauthorized worker access'});
   if(crypto.timingSafeEqual(a,b)===false)return res.setHeader('X-AIS-Worker-Rejection','control_auth').status(401).json({error:'Unauthorized worker access'});
    if(req.method==='POST' && req.path==='/internal/auth/snapshot'){
     system.exportAuth(Number(req.headers['x-auth-account']),req.headers['x-worker-epoch'])
      .then(data=>{if(!res.destroyed)res.json(data);})
      .catch(()=>{if(!res.destroyed)res.status(409).json({error:'Auth snapshot unavailable'});});
     return;
    }
   if(req.method==='POST' && req.path==='/internal/auth/keepalive'){
    let size=0;const chunks=[];
    req.on('data',c=>{size+=c.length;if(size>300000){req.destroy();return;}chunks.push(c);});
    req.on('end',()=>{
     if(res.writableEnded)return;
     let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return res.status(400).json({error:'Invalid body'});}
     system.spareKeepalive(body).then(r=>{if(!res.destroyed)res.json(r);}).catch(()=>{if(!res.destroyed)res.status(409).json({result:'busy'});});
    });
    return;
   }
   if(req.method==='GET' && req.path==='/internal/status')return res.json({...system.workerStatus(),authSnapshotProtocol:1,keepaliveProtocol:1});
   if(req.method==='POST' && req.path==='/internal/set-mode'){
    let size=0;const chunks=[];
    req.on('data',chunk=>{size+=chunk.length;if(size>1024){req.destroy();return;}chunks.push(chunk);});
    req.on('end',()=>{
     if(res.writableEnded)return;
     let mode=null;
     try{mode=JSON.parse(Buffer.concat(chunks).toString('utf8')).mode;}catch{}
     if(mode!=='fake'&&mode!=='real')return res.status(400).json({error:'Invalid mode'});
     system.streamingMode=mode;
     res.json({mode});
    });
    return;
   }
   if(req.method==='POST' && req.path.startsWith('/internal/retire-execution/')){
    if(!system.executions)return res.status(503).json({error:'Execution protocol unavailable'});
    const id=req.path.slice('/internal/retire-execution/'.length);
    try{return res.json(system.executions.retire(id,req.headers['x-worker-epoch'],Number(req.headers['x-execution-account'])));}
    catch{return res.status(409).json({error:'Retirement unconfirmed'});}
   }
   if(req.method==='GET' && req.path.startsWith('/internal/executions/')){
    if(!system.executions)return res.status(503).json({error:'Execution protocol unavailable'});
    const id=req.path.slice('/internal/executions/'.length);
    if(!/^[a-f0-9-]{36}$/.test(id))return res.status(400).json({error:'Invalid execution ID'});
    return res.json(system.executions.read(id,Number(req.headers['x-admission-deadline'])));
   }
   if(req.method==='POST' && req.path==='/internal/debug/rpc-probe'){
    // Diagnostics only: send ONE short request to an allow-listed MakerSuite RPC from the live page,
    // reusing the page's signer. Requires the worker key, an idle worker and a ready signer.
    let size=0;const chunks=[];
    req.on('data',c=>{size+=c.length;if(size>8192){req.destroy();return;}chunks.push(c);});
    req.on('end',async()=>{
     if(res.writableEnded)return;
     let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return res.status(400).json({error:'Invalid body'});}
     const ALLOW={CreateInteractionStream:[4],CreateOrchestrationStream:[5]};
     const method=body&&body.method;
     if(!Object.hasOwn(ALLOW,method)||!Array.isArray(body.request)||typeof body.hashText!=='string'||body.hashText.length>2000)
      return res.status(400).json({error:'Method not allowed or bad request'});
     if(probing)return res.status(409).json({error:'Probe already running'});
     if(!idle())return res.status(409).json({error:'Worker not idle'});
     const page=system.browserManager.page;
     probing=true;
     try{
      const code='('+String(rpcProbe)+')('+JSON.stringify(method)+','+JSON.stringify(body.request)+','+JSON.stringify(body.hashText)+','+JSON.stringify(ALLOW[method])+')';
      let tmo;const raw=await Promise.race([page.evaluate(c=>window.wrappedJSObject.eval(c),code),new Promise(r=>{tmo=setTimeout(()=>r(JSON.stringify({err:'timeout'})),120000);})]).finally(()=>clearTimeout(tmo));
      let out;try{out=JSON.parse(raw);}catch{out={err:'unparseable',raw:String(raw).slice(0,300)};}
      if(!res.destroyed)res.json(out);
     }catch(e){if(!res.destroyed)res.status(500).json({err:String(e&&e.message||e).slice(0,200)});}
     finally{probing=false;}
    });
    return;
   }
   if(req.method==='GET' && req.path==='/internal/models'){
    if(!system.modelCatalog)return res.status(503).json({error:'Catalog unavailable'});
    return res.json(system.modelCatalog.status());
   }
   if(req.method==='POST' && req.path==='/internal/models/refresh'){
    if(!system.modelCatalog)return res.status(503).json({error:'Catalog unavailable'});
    const result=system.modelCatalog.refresh(
      req.headers['x-catalog-job'],Number(req.headers['x-catalog-account']));

    return res.status(result.accepted?202:409).json(result);
   }
   const prefix='/v1beta/models/';
   const suffix=req.path.slice(prefix.length);
   const native=req.path.startsWith(prefix) && suffix.includes('/')===false && (suffix.endsWith(':generateContent')||suffix.endsWith(':streamGenerateContent'));
   const generation=req.method==='POST' && (req.path==='/v1/chat/completions'||native);
   if(generation===false)return res.status(404).json({error:'Worker endpoint unavailable'});
   next();
  });
  outer.use(original());
  return outer;
 };
}
module.exports={install};
