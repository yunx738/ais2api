'use strict';
// Workspace activation jobs: one container per job, under the shared browser lease.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {spawn}=require('child_process');
const DIR='/opt/ais2api/auto-register',DATA=path.join(DIR,'data'),IMAGE='ais-workspace-register:1';
const CFG=path.join(DATA,'ws-config.json'),PROXY='/opt/ais2api-direct/login-proxy.json';
const KEYS=['domain','mailbox','graph_client_id','recovery_email','mail_subject_keywords','mail_provider','tempmail_api','tempmail_name'];
function jwtAddress(j){try{const p=JSON.parse(Buffer.from(String(j).split('.')[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'));return typeof p.address==='string'?p.address:'';}catch{return '';}}
function readJson(f,d){try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return d;}}
function writeSecure(f,obj,uid){const t=f+'.tmp';fs.writeFileSync(t,JSON.stringify(obj),{mode:0o600});if(uid)fs.chownSync(t,uid,uid);fs.renameSync(t,f);}
function config(){const c=readJson(CFG,{});const o=Object.fromEntries(KEYS.map(k=>[k,c[k]??(k==='mail_subject_keywords'?['新的 Google','Google 帐号']:k==='mail_provider'?'tempmail':k==='tempmail_api'?'':'')]));
 o.tempmail_address=c.mailbox||jwtAddress(c.tempmail_jwt||'');o.has_tempmail_admin=!!c.tempmail_admin;return o;}
function ready(c){return !!(c.domain&&c.recovery_email&&(c.mail_provider==='tempmail'?c.tempmail_address:(c.mailbox&&c.graph_client_id)));}
function saveConfig(b){
 const c=config(),em=/^[^\s@]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;
 if(b.domain!==undefined){if(!/^[a-z0-9.-]{3,190}$/i.test(b.domain))throw Error('域名格式不正确');c.domain=b.domain;}
 for(const k of ['mailbox','recovery_email'])if(b[k]!==undefined){if(!em.test(b[k]))throw Error('邮箱格式不正确');c[k]=b[k];}
 if(b.graph_client_id!==undefined){if(!/^[0-9a-f-]{36}$/i.test(b.graph_client_id))throw Error('应用 ID 格式不正确');c.graph_client_id=b.graph_client_id;}
 if(b.tempmail_name!==undefined){if(!/^[a-z0-9._-]{1,64}$/i.test(b.tempmail_name))throw Error('邮箱名格式不正确');c.tempmail_name=b.tempmail_name;}
 if(b.mail_provider!==undefined){if(!['tempmail','graph'].includes(b.mail_provider))throw Error('邮箱类型无效');c.mail_provider=b.mail_provider;}
 if(b.tempmail_api!==undefined&&b.tempmail_api!==''){let u;try{u=new URL(b.tempmail_api);}catch{throw Error('接口地址不正确');}if(u.protocol!=='https:')throw Error('接口地址需为 https');c.tempmail_api=u.origin;}
 let admin;const jt=String(b.tempmail_admin||'').trim();if(jt)admin=jt.slice(0,128);
   if(Array.isArray(b.mail_subject_keywords))c.mail_subject_keywords=b.mail_subject_keywords.map(String).filter(Boolean).slice(0,8).map(x=>x.slice(0,40));
 const raw=readJson(CFG,{});delete c.tempmail_address;const keep={...c,tempmail_admin:admin||raw.tempmail_admin||'',tempmail_jwt:admin?'':(raw.tempmail_jwt||'')};
 if(keep.mail_provider==='tempmail'&&!keep.recovery_email)keep.recovery_email=jwtAddress(keep.tempmail_jwt);
 writeSecure(CFG,keep,1000);return config();
}
// Login proxy: independent of A/B egress. Password never returned.
function proxyRaw(){return readJson(PROXY,null);}
function proxyView(){const p=proxyRaw();if(!p||!p.host)return {enabled:false,source:legacyUp()?'default':'none'};return {enabled:p.enabled!==false,type:p.type,host:p.host,port:p.port,username:p.username||'',hasPassword:!!p.password};}
function legacyUp(){try{const l=fs.readFileSync('/opt/ais2api-direct/login-upstream.env','utf8').split('\n').find(x=>x.startsWith('UPSTREAM='));return l?l.slice(9).trim():'';}catch{return '';}}
function saveProxy(b){
 if(b.clear===true){try{fs.unlinkSync(PROXY);}catch{}return proxyView();}
 const old=proxyRaw()||{};
 const type=['socks5','http'].includes(b.type)?b.type:'socks5',host=String(b.host||'').trim(),port=Number(b.port);
 if(!/^[a-z0-9.-]{1,190}$/i.test(host)||!Number.isInteger(port)||port<1||port>65535)throw Error('代理地址或端口不正确');
 const username=String(b.username||'').slice(0,128);
 const password=typeof b.password==='string'&&b.password?b.password.slice(0,256):(username===old.username?old.password||'':'');
 writeSecure(PROXY,{type,host,port,username,password,enabled:b.enabled!==false});return proxyView();
}
// Upstream URL for login browsers. Mode: 'proxy' (configured) | 'default' (legacy env) | 'direct'.
function upstreamFor(){
 const p=proxyRaw();
 if(p&&p.host){if(p.enabled===false)return '';const a=p.username?encodeURIComponent(p.username)+':'+encodeURIComponent(p.password||'')+'@':'';return p.type+'://'+a+p.host+':'+p.port;}
 return legacyUp();
}
module.exports={DIR,DATA,IMAGE,config,ready,saveConfig,proxyView,saveProxy,upstreamFor,readJson};
