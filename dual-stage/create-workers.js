'use strict';
const fs=require('fs'),path=require('path');
const {execFileSync}=require('child_process');
const {AccountPool}=require('./account-pool');
const {DispatchCore}=require('./dispatch-core');
const {save}=require('./dispatch-state');
const {prepareAuth}=require('./prepare-auth');
const {buildSpec}=require('./worker-container-spec');
const root='/opt/ais2api/dual-runtime';
const cfg=JSON.parse(fs.readFileSync(path.join(root,'coordinator.json')));
const file=path.join(root,'state.json');
const run=args=>execFileSync('docker',args,{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();
function main(){
 if(fs.existsSync(file))throw Error('Existing state requires reconciliation');
 for(const slot of ['A','B']){
  const name='ais2api-dual-'+slot.toLowerCase();
  const existing=run(['ps','-a','--filter','name=^/'+name+'$','--format','{{.ID}}']);
  if(existing)throw Error('Existing worker requires reconciliation');
  if(fs.readdirSync(path.join(root,'slots',slot,'auth')).length)throw Error('Authentication directory not empty');
 }
 const pool=new AccountPool([4,5,6,7]);
 const tickets=['A','B'].map(slot=>pool.reserve(slot));
 const dispatch=new DispatchCore(pool,x=>save(x,file));
 dispatch.checkpoint();
 for(const ticket of tickets){
  const slot=ticket.slot,name='ais2api-dual-'+slot.toLowerCase();
  const networks=run(['network','ls','--filter','name=^'+name+'$','--format','{{.Name}}']);
  if(networks)throw Error('Existing network requires inspection');
  run(['network','create','--label','operit.project=ais2api-dual',name]);
  prepareAuth('/opt/ais2api/auth',path.join(root,'slots',slot,'auth'),ticket.id,true);
  const id=run(buildSpec(slot,ticket.id,root,cfg.image));
  const d=JSON.parse(run(['inspect',id]))[0];
  if(d.State.Running||d.State.Pid!==0||d.State.Status!=='created')throw Error('Unexpected worker state');
  if(d.Config.User!=='1000:1000')throw Error('Unexpected worker user');
  const mount=d.Mounts.find(m=>m.Destination==='/app/auth');
  if(!mount||mount.RW||mount.Source!==path.join(root,'slots',slot,'auth'))throw Error('Authentication isolation failed');
  console.log('CREATED_NOT_STARTED',slot,'account',ticket.id,'memory',d.HostConfig.Memory,'pids',d.HostConfig.PidsLimit);
 }
 console.log('Both accounts reserved; no browser started; old instance unchanged');
}
try{main();}catch(e){console.error('Worker preparation stopped:',e.message.split('\n')[0]);process.exitCode=1;}
