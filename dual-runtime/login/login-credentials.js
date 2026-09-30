'use strict';
// Encrypted password store (AES-256-GCM). Key and data live in a root-only directory.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const DIR='/opt/ais2api-direct',KEYF=path.join(DIR,'cred.key'),DATAF=path.join(DIR,'credentials.json');
function key(){
 if(!fs.existsSync(KEYF)){const fd=fs.openSync(KEYF,'wx',0o600);try{fs.writeFileSync(fd,crypto.randomBytes(32));}finally{fs.closeSync(fd);}}
 const k=fs.readFileSync(KEYF);if(k.length!==32)throw Error('bad key');return k;
}
function load(){try{const d=JSON.parse(fs.readFileSync(DATAF,'utf8'));return d&&typeof d==='object'&&!Array.isArray(d)?d:{};}catch{return {};}}
function save(d){
 const tmp=DATAF+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
 const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(d));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(tmp,DATAF);
}
function put(id,email,password){
 const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key(),iv);
 const data=Buffer.concat([c.update(String(password),'utf8'),c.final()]);
 const d=load();d[id]={email,iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64'),savedAt:Date.now(),...(d[id]?{lastAttemptAt:d[id].lastAttemptAt,lastResult:d[id].lastResult}:{})};
 save(d);
}
function get(id){
 const r=load()[id];if(!r)return null;
 const dc=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(r.iv,'base64'));dc.setAuthTag(Buffer.from(r.tag,'base64'));
 return {email:r.email,password:Buffer.concat([dc.update(Buffer.from(r.data,'base64')),dc.final()]).toString('utf8')};
}
function meta(){const d=load(),o={};for(const [id,r] of Object.entries(d))o[id]={email:r.email,lastAttemptAt:r.lastAttemptAt||0,lastResult:r.lastResult||null};return o;}
function mark(id,result){const d=load();if(!d[id])return;d[id].lastAttemptAt=Date.now();d[id].lastResult=result;save(d);}
function remove(id){const d=load();if(d[id]){delete d[id];save(d);}}
module.exports={put,get,meta,mark,remove};
