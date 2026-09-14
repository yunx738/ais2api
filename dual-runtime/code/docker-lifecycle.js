'use strict';
const {execFile}=require('child_process');
const {promisify}=require('util');
const exec=promisify(execFile);
class DockerLifecycle {
 constructor(run=exec){this.run=run;}
 name(slot){
  if(['A','B'].includes(slot)===false)throw Error('Invalid worker slot');
  return 'ais2api-dual-'+slot.toLowerCase();
 }
 async describe(slot){
  const name=this.name(slot);
  const result=await this.run('docker',['inspect',name],{timeout:15000,maxBuffer:1048576});
  const items=JSON.parse(result.stdout);
  if(items.length!==1)throw Error('Ambiguous container identity');
  const d=items[0],labels=d.Config?.Labels||{};
  if(d.Name!=='/'+name||labels['operit.project']!=='ais2api-dual'||labels['operit.slot']!==slot)throw Error('Container ownership mismatch');
  return d;
 }
 async stop(slot){
  const before=await this.describe(slot);
  if(before.State.Running===true){
   await this.run('docker',['stop','--time','30',before.Id],{timeout:45000,maxBuffer:16384});
  }
  const after=await this.describe(slot);
  if(after.Id!==before.Id||after.State.Running!==false||after.State.Pid!==0)throw Error('Container stop unconfirmed');
 }
 async inspect(slot){
  const d=await this.describe(slot);
  const stopped=d.State.Running===false && d.State.Pid===0 && ['exited','created'].includes(d.State.Status);
  return {running:d.State.Running,processesStopped:stopped,id:d.Id};
 }
}
module.exports={DockerLifecycle};
