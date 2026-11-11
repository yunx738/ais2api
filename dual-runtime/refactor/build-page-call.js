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

 // build-st/ files: upload to AI Studio /_/upload (same as the official page), then reference by path (Part field 18).
 for(var ui=0;ui<parts.length;ui++){var pu=parts[ui];if(!pu||!pu.__upload)continue;
  var um=pu.__upload[0],ub=atob(pu.__upload[1]),ubytes=new Uint8Array(ub.length);for(var bi=0;bi<ub.length;bi++)ubytes[bi]=ub.charCodeAt(bi);
  var udg=new Uint8Array(await crypto.subtle.digest('SHA-256',ubytes)),uds='';for(var di=0;di<udg.length;di++)uds+=String.fromCharCode(udg[di]);
  var uh='sha256='+btoa(uds),uau=String(md['X-Goog-AuthUser']!=null?md['X-Goog-AuthUser']:'0');
  var us=await fetch(location.origin+'/_/upload',{method:'POST',credentials:'include',headers:{'X-Goog-Upload-Header-Content-Length':String(ubytes.length),'X-Goog-Upload-Header-Content-Type':um,'X-Goog-Hash':uh,'X-Goog-Upload-Protocol':'resumable','X-Goog-Upload-Command':'start','X-Goog-Authuser':uau}});
  var uurl=us.headers.get('X-Goog-Upload-URL');if(us.status!==200||!uurl)return JSON.stringify({s:502,stage:'upload',t:'upload start '+us.status+' '+(await us.text()).slice(0,300)});
  var uf=await fetch(uurl,{method:'POST',credentials:'include',headers:{'Content-Type':um,'X-Goog-Hash':uh,'X-Goog-Upload-Command':'upload, finalize','X-Goog-Upload-Offset':'0','X-Goog-Authuser':uau},body:ubytes});
  var upath=(await uf.text()).trim();if(uf.status!==200||!upath)return JSON.stringify({s:502,stage:'upload',t:'upload finalize '+uf.status+' '+upath.slice(0,300)});
  var uw=[];for(var wi=0;wi<18;wi++)uw.push(null);uw[17]=[um,upath,pu.__upload[2],String(ubytes.length)];parts[ui]=uw;
 }
 var ht=parts.map(function(p){return p[1]!=null?p[1]:(p[2]?p[2][1]:'');}).join(' ');
 var ac=new AbortController(),hm=opts.hardMs||1200000,wd=setTimeout(function(){ac.abort();},hm);
 var ab=w.__gcAb=w.__gcAb||{};if(opts.op)ab[opts.op]=ac;
 var t0=Date.now(),r1,t1='',tries=0,sds=[],gen=0,resent=0;
 try{
  // A generation can be accepted but never get a model turn (seen when one account runs Build calls concurrently).
  // Submit a fresh generation once in that case instead of failing with 'no model turn'.
  gen:for(;;gen++){
  var tg=0;
  for(;;){
   tries++;tg++;
   if(!window.__sdNet){(function(w){w.__sdR=[];try{new PerformanceObserver(function(l){var es=l.getEntries();for(var i=0;i<es.length;i++){var e=es[i];try{var u=new URL(e.name);var p=u.pathname.split('/');w.__sdR.push([Math.round(performance.timeOrigin+e.startTime),Math.round(performance.timeOrigin+e.responseEnd),u.hostname.split('.')[0]+'/'+p.slice(-2).join('/').slice(0,70),e.initiatorType]);}catch(x){}}if(w.__sdR.length>600)w.__sdR.splice(0,300);}).observe({type:'resource',buffered:true});}catch(x){w.__sdR=null;}w.__sdNet=function(since){var R=w.__sdR;if(!R)return null;var now=Date.now(),o=[],bg=-1,bgN=0;for(var i=0;i<R.length;i++){var r=R[i];if(/waa|botguard|jnn|recaptcha|Create$/i.test(r[2])){bg=r[1];bgN++;}if(since>0&&r[0]>=since&&o.length<12&&!/GenerateContent|CodeAssistant/.test(r[2]))o.push(r[2]+':'+r[3]+'@'+(r[0]-since));}return {bgAgeMs:bg>0?now-bg:-1,bgN:bgN,since:o,tot:R.length};};w.__sdFnv=function(s){if(typeof s!=='string')return '';var h=2166136261;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16);};})(window);}var sg0=Date.now();var sig=w.__pfSign?await w.__pfSign(tb,ht,opts.page!=null?opts.page:parts.filter(function(p){return typeof p[1]==='string'&&p[1]!=='';}).map(function(p){return p[1];}).join(' ')):await w.__gcS(tb,await w.__gcH(ht));var sd={pf:w.__pfStat||null,len:typeof sig==='string'?sig.length:-1,pre:typeof sig==='string'?sig.slice(0,3):'',signMs:Date.now()-sg0,n:(w.__sdN=(w.__sdN||0)+1),pageS:Math.round(performance.now()/1000),gapMs:w.__sdLast?sg0-w.__sdLast:-1,inflight:Object.keys(w.__gcAb||{}).length,vis:document.visibilityState,h:w.__sdFnv(sig),net:w.__sdNet(w.__sdLast||0)};w.__sdLast=sg0;sds.push(sd);
   // Fields 21/23 are a oneof (page: d.MN ? set 23=true : set 21=trajectoryId). 23=true asks Google for a NEW chat,
   // so the applet's stored chat is not replayed as input. A made-up id in 21 is rejected (404).
   // Reusing a trajectory makes Google replay the whole stored chat as input on each call.
   var b=[[[parts,'user']],sig,null,null,null,2,null,'models/'+model,null,null,null,app,null,[2],null,1,null,null,think?[1,null,null,think]:null,null,null,null,true,null,null,null,null,null,crypto.randomUUID().toUpperCase()];
   r1=await fetch(base+'CodeAssistantOffline',{method:'POST',credentials:'include',headers:hd,body:JSON.stringify(b),signal:ac.signal});
   t1=await r1.text();sd.s=r1.status;sd.ms=Date.now()-sg0;if(r1.status!==200)sd.err=t1.slice(0,400);
   // Signatures are occasionally refused with 403 "caller does not have permission" (no quota used): re-sign.
   if(r1.status===403&&/caller does not have permission/i.test(t1)&&tg<8){await new Promise(function(x){setTimeout(x,1500*tries);});continue;}
   break;
  }
  if(r1.status!==200)return JSON.stringify({s:r1.status,stage:'create',tries:tries,sd:sds,t:t1.slice(0,2000),ms:Date.now()-t0});
  var gid;try{gid=JSON.parse(t1)[0];}catch(e){}
  if(typeof gid!=='string')return JSON.stringify({s:502,stage:'create',tries:tries,sd:sds,t:'no generation id: '+t1.slice(0,300)});
  var hd2=Object.assign({},hd);delete hd2['x-aistudio-g1-tier'];
  // The stream can close while the model turn is still in progress (no usage yet). Re-open it for the same
  // generation id until the final turn carries usage (["n","n"(,"n")],"<gid>"]); each response is cumulative.
  var done=new RegExp('\\["\\d+","\\d+"(?:,"\\d+")?\\],"'+gid+'"\\]');
  var r2,t2='',polls=0,pS=Date.now(),firstModel=0;
  for(;;){
   polls++;
   r2=await fetch(base+'StreamCodeAssistantOfflineGeneration',{method:'POST',credentials:'include',headers:hd2,body:JSON.stringify([gid,null,null,app]),signal:ac.signal});
   var tx=await r2.text();
   if(r2.status!==200){if(!t2)t2=tx;break;}
   t2=tx;
   if(!firstModel&&t2.indexOf('"model"]')>=0)firstModel=polls;
   // Google failed the generation (turn [null x5,["message",[]],...]): no point polling or resending.
   if(/\[null,null,null,null,null,\["[^"]{1,300}",\[/.test(t2))break;
   if(done.test(t2)||polls>=20)break;
   if(!firstModel&&polls>=12&&gen<1)break;
   await new Promise(function(x){setTimeout(x,1000);});
  }
  if(r2.status===200&&!firstModel&&!done.test(t2)&&gen<1&&!/\[null,null,null,null,null,\["[^"]{1,300}",\[/.test(t2)){resent++;continue gen;}
  break;
  }
  return JSON.stringify({s:r2.status,stage:'stream',tries:tries,sd:sds,resent:resent,polls:polls,firstModel:firstModel,pollMs:Date.now()-pS,gid:gid,t:t2,ms:Date.now()-t0});
 }catch(e){
  if(ac.__cancel)return JSON.stringify({s:499,stage:'cancel',t:'cancelled'});
  return JSON.stringify({s:504,stage:'fetch',t:(ac.signal.aborted?'timeout after '+hm+'ms':'connection lost: '+String(e&&e.message||e)).slice(0,200),ms:Date.now()-t0});
 }finally{clearTimeout(wd);if(opts.op)delete ab[opts.op];}
});
function expression(args){
 return '('+PAGE_FN+')('+[args.parts,args.model,args.thinking||null,args.hx||{},args.app,args.key||null,args.opts||{}].map(x=>JSON.stringify(x)).join(',')+')';
}
module.exports={PAGE_FN,expression};
