'use strict';
const fs=require('fs');
const {execFileSync}=require('child_process');
const {restore}=require('./restore-dispatch');
const {WorkerClient}=require('./worker-client');
async function main(){
 const root='/opt/ais2api/dual-runtime';
 const old=JSON.parse(execFileSync('docker',['inspect','ais2api'],{encoding:'utf8'}))[0];
 if(old.State.Running||old.State.Pid!==0)throw Error('Old instance not stopped');
 const cfg=JSON.parse(fs.readFileSync(root+'/coordinator.json'));
 const d=restore(root+'/state.json');
 const client=new WorkerClient(Object.fromEntries(['A','B'].map(s=>[s,cfg.workers[s].control])));
 for(const [slot,account] of [['A',4],['B',5]]){
  const owner=d.pool.slots.get(slot);
  if(owner.current!==undefined||owner.pending?.id!==account)throw Error('Unexpected initial reservation');
  const status=await client.waitReady(slot,account,15000);
  d.pool.commit({slot,id:account,token:owner.pending.token},true);
  d.update(slot,status);d.checkpoint();
  console.log('ASSIGNMENT_COMMITTED',slot,account);
 }
}
main().catch(()=>{console.error('Initial activation failed; inspect state before retry');process.exitCode=1;});
