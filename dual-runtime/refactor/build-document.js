'use strict';
// Build anti-truncation ("document output"), after qiwu622/build-standalone.
// The model writes the full answer into a reserved project file __bridge_reply_<24 hex>.txt; the worker finds
// that file's SHA-256 in the generation response (step[8][4] = [[name, sha256], ...]) and downloads it from
// /_/upload/<applet>/file/<sha256> inside the logged-in page, verifying the hash before using it as the reply.
// The project is still renewed after every Build request, so the file never outlives its request.
const crypto=require('crypto');
const NAME=/^__bridge_reply_[a-f0-9]{24}\.txt$/;
const HASH=/^[a-f0-9]{64}$/;
const APP=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES=8*1024*1024;
function documentName(nonce=crypto.randomBytes(12).toString('hex')){
 const name='__bridge_reply_'+nonce+'.txt';
 if(!NAME.test(name))throw Error('invalid document name');
 return name;
}
function instruction(name){
 if(!NAME.test(name))throw Error('invalid document name');
 return 'Output delivery: write the complete answer into the UTF-8 project file '+name+' using the Build file-writing tool. '+
  'The file body is the API reply: preserve the requested text, Markdown, JSON, whitespace and any tool-call protocol exactly. '+
  'Do not summarize, shorten, or add a receipt. Do not run commands. After writing the file, reply in chat with only: DONE';
}
// Latest hash recorded for `name` in the response (snapshots repeat; the last one is the final file).
function findHash(raw,name){
 if(!NAME.test(name))return null;
 let J;try{J=JSON.parse(raw);}catch{return null;}
 let hit=null;
 const walk=(v,d)=>{
  if(d>14||!Array.isArray(v))return;
  if(v.length>=2&&v[0]===name&&typeof v[1]==='string'&&HASH.test(v[1]))hit=v[1];
  for(const x of v)walk(x,d+1);
 };
 walk(J,0);
 return hit;
}
// Page-side download + integrity check. Returns a JSON string {s, len, ok, text?, err?}.
function pageRead({applet,hash}){
 return (async()=>{try{
  const r=await fetch(location.origin+'/_/upload/'+applet+'/file/'+hash,{credentials:'include',redirect:'error'});
  if(!r.ok)return JSON.stringify({s:r.status,ok:false});
  const b=new Uint8Array(await r.arrayBuffer());
  if(b.length>MAX)return JSON.stringify({s:r.status,len:b.length,ok:false,err:'too_large'});
  const d=[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');
  if(d!==hash)return JSON.stringify({s:r.status,len:b.length,ok:false,err:'hash_mismatch'});
  return JSON.stringify({s:r.status,len:b.length,ok:true,text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b)});
 }catch(e){return JSON.stringify({ok:false,err:String(e&&e.message||e).slice(0,160)});}})();
}
function readExpression(applet,hash){
 if(!APP.test(applet||'')||!HASH.test(hash||''))throw Error('invalid document reference');
 return '(()=>{const MAX='+MAX_BYTES+';return ('+pageRead.toString()+')('+JSON.stringify({applet,hash})+');})()';
}
// Chat text that is only the acknowledgement (or empty) cannot stand in for a missing file.
const isAck=t=>!String(t||'').trim()||/^\s*\**\s*done\s*\**\s*[.!。]?\s*$/i.test(String(t));
module.exports={documentName,instruction,findHash,readExpression,isAck,NAME,MAX_BYTES};
// Coordinator-side switch, stored in build-document.json. enabled=false (default) turns the feature off for all
// prefixes; when on, a prefix uses it unless set false. code/ is off by default (tool-calling clients need speed).
const DEFAULT_PREFIXES={'build/':true,'build-st/':true,'bridge/':true,'code/':false};
class DocumentSwitch{
 constructor(file,{fs=require('fs')}={}){
  this.file=file;this.fs=fs;this.state={enabled:false,prefixes:{...DEFAULT_PREFIXES}};
  try{const d=JSON.parse(fs.readFileSync(file,'utf8'));
   if(typeof d.enabled==='boolean')this.state.enabled=d.enabled;
   for(const k of Object.keys(DEFAULT_PREFIXES))if(typeof d.prefixes?.[k]==='boolean')this.state.prefixes[k]=d.prefixes[k];
  }catch(e){if(e.code!=='ENOENT')console.error('[BuildDoc] build-document.json unreadable, using defaults');}
  this.stats={requests:0};
 }
 status(){return {enabled:this.state.enabled,prefixes:{...this.state.prefixes},stats:{...this.stats}};}
 uses(prefix){return this.state.enabled&&this.state.prefixes[prefix]===true;}
 set(body){
  const next={enabled:this.state.enabled,prefixes:{...this.state.prefixes}};
  if(body?.enabled!==undefined){if(typeof body.enabled!=='boolean')throw Object.assign(Error('enabled 必须是 true/false'),{statusCode:400});next.enabled=body.enabled;}
  if(body?.prefixes!==undefined){
   if(!body.prefixes||typeof body.prefixes!=='object')throw Object.assign(Error('prefixes 无效'),{statusCode:400});
   for(const [k,v] of Object.entries(body.prefixes)){
    if(!Object.hasOwn(DEFAULT_PREFIXES,k)||typeof v!=='boolean')throw Object.assign(Error('未知前缀或取值：'+k),{statusCode:400});
    next.prefixes[k]=v;
   }
  }
  const tmp=this.file+'.tmp';this.fs.writeFileSync(tmp,JSON.stringify(next,null,1));this.fs.renameSync(tmp,this.file);
  this.state=next;return this.status();
 }
}
module.exports.DocumentSwitch=DocumentSwitch;
module.exports.DEFAULT_PREFIXES=DEFAULT_PREFIXES;
