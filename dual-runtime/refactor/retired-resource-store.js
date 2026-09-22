'use strict';
const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');

const MAX_RECEIPT_BYTES=8192,MAX_RECEIPTS=10000;
const HEX=/^[a-f0-9]{64}$/;
const RECEIPT_NAME=/^([AB])-([a-f0-9]{64})\.json$/;
// Only our own interrupted writes may be ignored. In particular, an arbitrary
// .tmp file or a symlink must not hide an unrecognized resource from the audit.
const TEMP_NAME=/^[AB]-[a-f0-9]{64}\.json\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/;
const positive=value=>Number.isSafeInteger(value)&&value>0;
const nonnegative=value=>Number.isSafeInteger(value)&&value>=0;
const fail=message=>{throw Error('Retirement journal: '+message);};

function keys(value,expected){
 return value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===expected.length&&expected.every(key=>Object.hasOwn(value,key));
}
function validateReceipt(value){
 if(!keys(value,['version','slot','containerId','account','token','retiredAt','auth'])||
  value.version!==1||!['A','B'].includes(value.slot)||typeof value.containerId!=='string'||!HEX.test(value.containerId)||
  !positive(value.account)||!positive(value.token)||!positive(value.retiredAt)||
  !keys(value.auth,['dev','ino','fileDev','fileIno','sha256'])||
  !['dev','ino','fileDev','fileIno'].every(key=>nonnegative(value.auth[key]))||
  typeof value.auth.sha256!=='string'||!HEX.test(value.auth.sha256))fail('invalid receipt');
 return {version:1,slot:value.slot,containerId:value.containerId,account:value.account,
  token:value.token,retiredAt:value.retiredAt,auth:{dev:value.auth.dev,ino:value.auth.ino,
   fileDev:value.auth.fileDev,fileIno:value.auth.fileIno,sha256:value.auth.sha256}};
}
function sameIdentity(a,b){return a.dev===b.dev&&a.ino===b.ino;}
function sameFile(a,b){
 return sameIdentity(a,b)&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
}
function ownerOnly(stat){
 return (stat.mode&0o077)===0&&(typeof process.getuid!=='function'||stat.uid===process.getuid());
}
function assertDirectory(directory){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.includes('\0')||path.resolve(directory)!==directory)
  fail('directory path must be absolute and canonical');
 let current=path.parse(directory).root,stat=fs.lstatSync(current);
 if(!stat.isDirectory()||stat.isSymbolicLink())fail('unsafe directory');
 for(const part of directory.slice(current.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);stat=fs.lstatSync(current);
  if(!stat.isDirectory()||stat.isSymbolicLink())fail('unsafe directory component');
 }
 return stat;
}
function syncDirectory(directory){
 const before=assertDirectory(directory);
 const fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 try{
  if(!sameIdentity(before,fs.fstatSync(fd)))fail('directory changed');
  fs.fsyncSync(fd);
 }finally{fs.closeSync(fd);}
}

class RetiredResourceStore{
 constructor(root){this.root=root;}
 directory(){
  assertDirectory(this.root);
  const directory=path.join(this.root,'retired-resources');
  let created=false;
  try{fs.mkdirSync(directory,{mode:0o700});created=true;}catch(error){if(error.code!=='EEXIST')throw error;}
  const stat=assertDirectory(directory);
  if(!ownerOnly(stat))fail('directory must be owned by this process and owner-only');
  if(created)syncDirectory(this.root);
  return directory;
 }
 names(directory){
  assertDirectory(directory);
  const names=[],handle=fs.opendirSync(directory);
  try{
   let entry;
   while((entry=handle.readSync())!==null){
    if(names.length>=MAX_RECEIPTS)fail('too many receipt files');
    names.push(entry.name);
   }
  }finally{handle.closeSync();}
  return names.sort();
 }
 read(directory,name,{temporary=false}={}){
  assertDirectory(directory);
  const file=path.join(directory,name),before=fs.lstatSync(file);
  if(!before.isFile()||before.isSymbolicLink()||!ownerOnly(before)||before.size>MAX_RECEIPT_BYTES)
   fail('unsafe or oversized receipt file');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
   const opened=fs.fstatSync(fd);
   if(!sameFile(before,opened))fail('receipt changed while opening');
   if(temporary)return {stat:opened};
   const buffer=Buffer.alloc(MAX_RECEIPT_BYTES+1);
   let length=0;
   while(length<buffer.length){
    const count=fs.readSync(fd,buffer,length,buffer.length-length,null);
    if(count===0)break;
    length+=count;
   }
   if(length>MAX_RECEIPT_BYTES||length!==opened.size||!sameFile(opened,fs.fstatSync(fd)))fail('receipt changed while reading');
   const receipt=validateReceipt(JSON.parse(buffer.subarray(0,length).toString('utf8')));
   if(name!==this.filename(receipt))fail('receipt filename does not match its identity');
   return {receipt,stat:opened};
  }finally{fs.closeSync(fd);}
 }
 filename(receipt){return receipt.slot+'-'+receipt.containerId+'.json';}
 list(){
  const directory=this.directory(),receipts=[];
  for(const name of this.names(directory)){
   if(TEMP_NAME.test(name)){this.read(directory,name,{temporary:true});continue;}
   if(!RECEIPT_NAME.test(name))fail('unknown receipt directory entry');
   receipts.push(this.read(directory,name).receipt);
  }
  return receipts;
 }
 record(value){
  const receipt=validateReceipt(value),directory=this.directory(),name=this.filename(receipt);
  // Validate the entire small journal before adding data. Corruption may mean
  // the evidence cannot be trusted; silently skipping it would be unsafe.
  this.list();
  const file=path.join(directory,name),serialized=JSON.stringify(receipt);
  const existing=()=>{
   const stored=this.read(directory,name).receipt;
   if(JSON.stringify(stored)!==serialized)fail('existing retirement evidence cannot be replaced');
   syncDirectory(directory);return stored;
  };
  try{return existing();}catch(error){if(error.code!=='ENOENT')throw error;}
  if(this.names(directory).length>=MAX_RECEIPTS)fail('too many receipt files');
  const temporary=name+'.'+randomUUID()+'.tmp',temp=path.join(directory,temporary);
  let fd,created=false,tempIdentity;
  const removeTemporary=()=>{
   assertDirectory(directory);
   const current=fs.lstatSync(temp);
   if(!current.isFile()||current.isSymbolicLink()||!sameIdentity(current,tempIdentity))fail('temporary receipt identity changed');
   fs.unlinkSync(temp);created=false;
  };
  try{
   assertDirectory(directory);
   fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
   created=true;tempIdentity=fs.fstatSync(fd);fs.writeFileSync(fd,serialized);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
   assertDirectory(directory);
   // rename() would replace existing evidence. A hard link publishes a fully
   // flushed file atomically and fails if another writer already won.
   try{fs.linkSync(temp,file);}catch(error){if(error.code!=='EEXIST')throw error;return existing();}
   removeTemporary();syncDirectory(directory);
   return receipt;
  }finally{
   if(fd!==undefined)fs.closeSync(fd);
   if(created){
    // No recursive removal and no cleanup of files we did not create.
    try{removeTemporary();syncDirectory(directory);}catch{}
   }
  }
 }
 remove(value){
  const receipt=validateReceipt(value),directory=this.directory(),name=this.filename(receipt);
  this.list();
  let stored;
  try{stored=this.read(directory,name);}catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(JSON.stringify(stored.receipt)!==JSON.stringify(receipt))fail('retirement evidence changed');
  assertDirectory(directory);
  const file=path.join(directory,name),current=fs.lstatSync(file);
  if(!current.isFile()||current.isSymbolicLink()||!sameFile(current,stored.stat))fail('receipt identity changed before removal');
  fs.unlinkSync(file);syncDirectory(directory);return true;
 }
}
module.exports={RetiredResourceStore,assertDirectory,validateReceipt,MAX_RECEIPT_BYTES,MAX_RECEIPTS};
