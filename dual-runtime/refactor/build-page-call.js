'use strict';
// In-page Build call, evaluated in the worker's AI Studio page. Reuses the page signer (window.__gcS/__gcH) exactly
// like GenerateContent does. Never returns the signature or auth headers.
// Args: parts, model, thinking (1 low,2 medium,3 high), hx {tier,ext,visit}, app, key, opts {hardMs,op}
const PAGE_FN=String(async function(parts,model,think,hx,app,key,opts){
 var w=window,tb=w.__tb;opts=opts||{};hx=hx||{};
 if(!tb||!w.__gcS||!w.__gcH)return JSON.stringify({s:503,stage:'signer',t:'signer_not_ready'});
 var md=tb.getMetadata()||{},waa=md['X-Goog-Api-Key'];
 if(!key){for(var sk in tb){var mb;try{mb=tb[sk];}catch(e){continue;}if(!mb||typeof mb!=='object')continue;for(var k in mb){var v;try{v=mb[k];}catch(e){continue;}if(typeof v==='string'&&/^AIza[0-9A-Za-z_-]{30,}$/.test(v)&&v!==waa){key=v;break;}}if(key)break;}}
 var base='https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/';
 var hd={'content-type':'application/json+protobuf','x-user-agent':'grpc-web-javascript/0.1','x-goog-api-key':key||waa,'authorization':md.Authorization,'x-goog-authuser':String(md['X-Goog-AuthUser']!=null?md['X-Goog-AuthUser']:'0')};
 if(hx.tier)hd['x-aistudio-g1-tier']=hx.tier;if(hx.ext)hd['x-goog-ext-519733851-bin']=hx.ext;if(hx.visit)hd['x-aistudio-visit-id']=hx.visit;
 var ht=parts.map(function(p){return p[1]!=null?p[1]:(p[2]?p[2][1]:'');}).join(' ');
 var ac=new AbortController(),hm=opts.hardMs||600000,wd=setTimeout(function(){ac.abort();},hm);
 var ab=w.__gcAb=w.__gcAb||{};if(opts.op)ab[opts.op]=ac;
 var t0=Date.now(),r1,t1='',tries=0;
 try{
  for(;;){
   tries++;
   var sig=await w.__gcS(tb,await w.__gcH(ht));
   // Fields 21/23 are a oneof (page: d.MN ? set 23=true : set 21=trajectoryId). 23=true asks Google for a NEW chat,
   // so the applet's stored chat is not replayed as input. A made-up id in 21 is rejected (404).
   // Reusing a trajectory makes Google replay the whole stored chat as input on each call.
   var b=[[[parts,'user']],sig,null,null,null,2,null,'models/'+model,null,null,null,app,null,[2],null,1,null,null,think?[1,null,null,think]:null,null,null,null,true,null,null,null,null,null,crypto.randomUUID().toUpperCase()];
   r1=await fetch(base+'CodeAssistantOffline',{method:'POST',credentials:'include',headers:hd,body:JSON.stringify(b),signal:ac.signal});
   t1=await r1.text();
   // Signatures are occasionally refused with 403 "caller does not have permission" (no quota used): re-sign.
   if(r1.status===403&&/caller does not have permission/i.test(t1)&&tries<5){await new Promise(function(x){setTimeout(x,1500*tries);});continue;}
   break;
  }
  if(r1.status!==200)return JSON.stringify({s:r1.status,stage:'create',tries:tries,t:t1.slice(0,2000),ms:Date.now()-t0});
  var gid;try{gid=JSON.parse(t1)[0];}catch(e){}
  if(typeof gid!=='string')return JSON.stringify({s:502,stage:'create',tries:tries,t:'no generation id: '+t1.slice(0,300)});
  var hd2=Object.assign({},hd);delete hd2['x-aistudio-g1-tier'];
  // The stream can close while the model turn is still in progress (no usage yet). Re-open it for the same
  // generation id until the final turn carries usage (["n","n"(,"n")],"<gid>"]); each response is cumulative.
  var done=new RegExp('\\["\\d+","\\d+"(?:,"\\d+")?\\],"'+gid+'"\\]');
  var r2,t2='',polls=0;
  for(;;){
   polls++;
   r2=await fetch(base+'StreamCodeAssistantOfflineGeneration',{method:'POST',credentials:'include',headers:hd2,body:JSON.stringify([gid,null,null,app]),signal:ac.signal});
   var tx=await r2.text();
   if(r2.status!==200){if(!t2)t2=tx;break;}
   t2=tx;
   if(done.test(t2)||polls>=20)break;
   await new Promise(function(x){setTimeout(x,1000);});
  }
  return JSON.stringify({s:r2.status,stage:'stream',tries:tries,polls:polls,gid:gid,t:t2,ms:Date.now()-t0});
 }catch(e){
  if(ac.__cancel)return JSON.stringify({s:499,stage:'cancel',t:'cancelled'});
  return JSON.stringify({s:504,stage:'fetch',t:(ac.signal.aborted?'timeout after '+hm+'ms':'connection lost: '+String(e&&e.message||e)).slice(0,200),ms:Date.now()-t0});
 }finally{clearTimeout(wd);if(opts.op)delete ab[opts.op];}
});
function expression(args){
 return '('+PAGE_FN+')('+[args.parts,args.model,args.thinking||null,args.hx||{},args.app,args.key||null,args.opts||{}].map(x=>JSON.stringify(x)).join(',')+')';
}
module.exports={PAGE_FN,expression};
