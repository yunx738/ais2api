'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {DockerLifecycle}=require('./docker-lifecycle');
const {buildSpec}=require('./worker-container-spec');
const {prepareAuth}=require('./prepare-auth');
class WorkerDriver extends DockerLifecycle {
 constructor(root,image,client,run){
  super(run);this.root=root;this.image=image;this.client=client;
  this.prepared=new Map();
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
  // Retain the old container and its bind-mounted inode; never overwrite credentials.
  await this.run('docker',['rename',d.Id,this.name(slot)+'-retired-'+tag],{timeout:15000,maxBuffer:16384});
  fs.renameSync(auth,path.join(base,'auth-retired-'+tag));
  fs.mkdirSync(auth,{mode:448});
  prepareAuth('/opt/ais2api/auth',auth,account,true);
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
}
module.exports={WorkerDriver};
