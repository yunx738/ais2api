'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {DockerLifecycle}=require('../code/docker-lifecycle');
const {buildSpec}=require('./worker-container-spec');
const {prepareAuth}=require('../code/prepare-auth');
class WorkerDriver extends DockerLifecycle {
 constructor(root,image,client,run,options={}){
  super(run);this.root=root;this.image=image;this.client=client;
  this.prepared=new Map();this.authSource=options.authSource||'/opt/ais2api/auth';
 }
 validateAccount(account){
  if(!Number.isSafeInteger(account)||account<1)throw Error('Invalid account');
  const source=path.join(this.authSource,'auth-'+account+'.json');
  const fd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
   const stat=fs.fstatSync(fd);
   if(!stat.isFile()||stat.size>262144)throw Error('Invalid authentication source');
   const data=JSON.parse(fs.readFileSync(fd,'utf8'));
   if(!Array.isArray(data.cookies)||!data.cookies.length||!Array.isArray(data.origins))
    throw Error('Invalid authentication structure');
  }finally{fs.closeSync(fd);}
 }
 async prepare(slot,account){
  const d=await this.describe(slot);
  if(d.State.Running!==false||d.State.Pid!==0||!['exited','created'].includes(d.State.Status))
   throw Error('Old worker not safely stopped');
  const base=path.join(this.root,'slots',slot);
  const auth=path.join(base,'auth');
  const st=fs.lstatSync(auth);
  if(!st.isDirectory()||st.isSymbolicLink())throw Error('Invalid authentication directory');
  const tag=Date.now()+'-'+crypto.randomBytes(6).toString('hex');
  // Validate and stage the new credentials before changing the old container's
  // name or mount. A missing/broken account file cannot destroy its working path.
  const staged=path.join(base,'auth-next-'+tag);
  fs.mkdirSync(staged,{mode:448});
  try{prepareAuth(this.authSource,staged,account,true);}
  catch(error){fs.rmSync(staged,{recursive:true,force:true});throw error;}
  // Retain the old container and its bind-mounted inode; never overwrite credentials.
  try{await this.run('docker',['rename',d.Id,this.name(slot)+'-retired-'+tag],{timeout:15000,maxBuffer:16384});}
  catch(error){fs.rmSync(staged,{recursive:true,force:true});throw error;}
  fs.renameSync(auth,path.join(base,'auth-retired-'+tag));
  fs.renameSync(staged,auth);
  this.prepared.set(slot,account);
 }
 async start(slot,account){
  if(this.prepared.get(slot)!==account)throw Error('Account not prepared by this driver');
  const result=await this.run('docker',buildSpec(slot,account,this.root,this.image),{timeout:30000,maxBuffer:16384});
  const id=result.stdout.trim();
  if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid created container identity');
  const d=await this.describe(slot);
  if(d.Id!==id||d.Config.Labels['operit.account']!==String(account))throw Error('Created worker mismatch');
  await this.run('docker',['start',id],{timeout:30000,maxBuffer:16384});
  this.prepared.delete(slot);
 }
 waitReady(slot,account){return this.client.waitReady(slot,account,180000);}
 probeReady(slot,account){return this.client.status(slot,account);}
}
module.exports={WorkerDriver};
