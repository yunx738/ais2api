'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {AccountPool}=require('../code/account-pool');
const {DispatchCore}=require('./dispatch-core');
const {RotationController}=require('./rotation-controller');
const {RetiredResourceCleanup}=require('./retired-resource-cleanup');
const DAY=86400000;

function fixture(t,options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ais-retired-cleanup-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source');fs.mkdirSync(source);
 const keyFiles=new Map();
 const putKey=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);keyFiles.set(file,Buffer.from(data));};
 for(const account of [1,2,3,4])putKey(path.join(source,'auth-'+account+'.json'),JSON.stringify({cookies:[{name:'cookie-'+account,value:'secret-'+account}],origins:[]}));
 for(const filename of ['state.json','config.json','history/requests.jsonl'])putKey(path.join(root,filename),'critical-'+filename);
 const pool=new AccountPool([1,2,3,4]);
 let checkpoints=0;
 const dispatch=new DispatchCore(pool,()=>{checkpoints++;throw Error('Cleanup must not mutate dispatch checkpoints');});
 const containers=new Map(),commands=[];
 for(const [slot,account] of [['A',1],['B',2]]){
  const id=(slot==='A'?'a':'b').repeat(64),auth=path.join(root,'slots',slot,'auth');
  putKey(path.join(auth,'auth-'+account+'.json'),fs.readFileSync(path.join(source,'auth-'+account+'.json')));
  pool.slots.set(slot,{current:account,pending:null});pool.owners.set(account,slot);
  containers.set(id,{Id:id,Name:'/ais2api-dual-'+slot.toLowerCase(),
   Config:{Labels:{'operit.project':'ais2api-dual','operit.slot':slot,'operit.account':String(account)}},
   State:{Running:true,Pid:account,Status:'running'},Mounts:[{Type:'bind',Source:auth,Destination:'/auth'}]});
  dispatch.update(slot,{account,workerEpoch:randomUUID(),ready:true,busy:false,browserOperations:0,quarantined:false,hardQuarantine:false,pendingCompletions:0});
 }
 const clock={now:Date.now(),stopping:false,waiting:false};
 const engine={containers,commands,before:null,after:null};
 const find=id=>containers.get(id)||[...containers.values()].find(c=>c.Name==='/'+id);
 const driver={root,authSource:source,name:slot=>'ais2api-dual-'+slot.toLowerCase(),
  describe:async slot=>JSON.parse(JSON.stringify(find('ais2api-dual-'+slot.toLowerCase()))),
  run:async(cmd,args,limits)=>{
   assert.equal(cmd,'docker');commands.push([...args]);
   assert(limits?.timeout>0,'Docker operations must have a deadline');
   await engine.before?.(args);
   let stdout='';
   if(args[0]==='ps')stdout=[...containers.keys()].join('\n');
   else if(args[0]==='inspect'){
    const matches=args.slice(1).map(id=>find(id));
    if(matches.some(c=>!c))throw Error('No such container');
    stdout=JSON.stringify(matches);
   }else if(args[0]==='rm'){
    assert.equal(args.length,2,'Cleanup must never force removal or remove volumes');
    const c=containers.get(args[1]);assert(c);assert.equal(c.State.Running,false);assert.equal(c.State.Pid,0);
    containers.delete(c.Id);
   }else assert.fail('Unexpected Docker mutation '+args.join(' '));
   await engine.after?.(args);
   return {stdout};
  }};
 const cleanup=new RetiredResourceCleanup({dispatch,driver,root,options,now:()=>clock.now,isStopping:()=>clock.stopping,hasWaiting:()=>clock.waiting});
 t.after(()=>cleanup.close?.());
 const add=(token,slot='A',account=3,record=true)=>{
  const id=createHash('sha256').update(slot+':'+token).digest('hex'),tag=token+'-'+id.slice(0,12);
  const dir=path.join(root,'slots',slot,'auth-retired-'+tag),file=path.join(dir,'auth-'+account+'.json');
  fs.mkdirSync(dir);fs.copyFileSync(path.join(source,'auth-'+account+'.json'),file);
  const c={Id:id,Name:'/ais2api-dual-'+slot.toLowerCase()+'-retired-'+tag,
   Config:{Labels:{'operit.project':'ais2api-dual','operit.slot':slot,'operit.account':String(account)}},
   State:{Running:false,Pid:0,Status:'exited'},Mounts:[{Type:'bind',Source:dir,Destination:'/auth'}]};
  containers.set(id,c);
  const marker={token,oldContainerId:id,oldAccount:account,account:pool.slots.get(slot).current};
  if(record)assert.equal(cleanup.record(slot,marker),true,'Completed retirement should produce a receipt');
  clock.now+=1000;
  return {id,dir,file,container:c,marker};
 };
 const three=()=>{const candidates=[add(1),add(2),add(3)];clock.now+=8*DAY;return candidates;};
 const preserved=()=>{for(const [file,data] of keyFiles)assert.deepEqual(fs.readFileSync(file),data,'Critical data preserved: '+file);assert.equal(checkpoints,0);};
 return {root,source,dispatch,engine,driver,clock,cleanup,add,three,preserved,keyFiles};
}

test('cleanup removes only expired receipted resources beyond the two newest backups',async t=>{
 const f=fixture(t),[old,...recent]=f.three();
 await f.cleanup.sweep('A');
 assert.equal(f.engine.containers.has(old.id),false);assert.equal(fs.existsSync(old.dir),false);
 for(const c of recent){assert(f.engine.containers.has(c.id));assert(fs.existsSync(c.file));}
 assert.deepEqual(f.engine.commands.filter(a=>a[0]==='rm'),[['rm',old.id]]);
 f.preserved();assert.equal(f.dispatch.halted,false);assert.equal(f.dispatch.operations.has('A'),false);
});

test('minimum retention protects recently retired credentials even with many backups',async t=>{
 const f=fixture(t),candidates=[f.add(1),f.add(2),f.add(3),f.add(4)];
 await f.cleanup.sweep('A');
 for(const c of candidates){assert(f.engine.containers.has(c.id));assert(fs.existsSync(c.file));}
 assert.equal(f.engine.commands.some(a=>a[0]==='rm'),false);f.preserved();
});

test('unreceipted legacy containers and authentication directories are preserved',async t=>{
 const f=fixture(t),orphan=f.add(40,'A',3,false);f.three();await f.cleanup.sweep('A');
 assert(f.engine.containers.has(orphan.id));assert(fs.existsSync(orphan.file));f.preserved();
});

for(const mode of ['running','nonzero pid','restarting','foreign project','foreign slot','foreign account','renamed']){
 test('cleanup preserves a retired candidate with '+mode,async t=>{
  const f=fixture(t),[old]=f.three(),c=old.container;
  if(mode==='running')c.State={Running:true,Pid:55,Status:'running'};
  if(mode==='nonzero pid')c.State.Pid=22;
  if(mode==='restarting')c.State.Status='restarting';
  if(mode==='foreign project')c.Config.Labels['operit.project']='another-project';
  if(mode==='foreign slot')c.Config.Labels['operit.slot']='B';
  if(mode==='foreign account')c.Config.Labels['operit.account']='4';
  if(mode==='renamed')c.Name='/unrelated-container';
  await f.cleanup.sweep('A');assert(f.engine.containers.has(old.id));assert(fs.existsSync(old.file));f.preserved();
 });
}

for(const mount of ['exact','parent','child','filesystem root']){
 test('any other container mounting the '+mount+' path protects retired resources',async t=>{
  const f=fixture(t),[old]=f.three(),id='f'.repeat(64);
  const source=mount==='exact'?old.dir:mount==='parent'?path.dirname(old.dir):mount==='filesystem root'?path.parse(old.dir).root:old.file;
  f.engine.containers.set(id,{Id:id,Name:'/unrelated-container',Config:{Labels:{}},State:{Running:false,Pid:0,Status:'exited'},Mounts:[{Type:'bind',Source:source,Destination:'/saved'}]});
  await f.cleanup.sweep('A');assert(f.engine.containers.has(old.id));assert(fs.existsSync(old.file));f.preserved();
 });
}

test('a retired directory configured as the primary credential source is never removed',async t=>{
 const f=fixture(t),[old]=f.three(),bytes=fs.readFileSync(old.file);
 f.driver.authSource=old.dir;
 await f.cleanup.sweep('A');
 assert(f.engine.containers.has(old.id));assert.deepEqual(fs.readFileSync(old.file),bytes);
 assert.equal(f.engine.commands.some(a=>a[0]==='rm'),false);f.preserved();
});

test('protected backlog does not starve an older cleanable receipt across bounded sweeps',async t=>{
 const f=fixture(t,{maxPerSweep:2}),old=f.add(1),protectedCopies=[];
 for(let token=2;token<=5;token++){
  const copy=f.add(token);fs.writeFileSync(copy.file,JSON.stringify({cookies:[{name:'unique-session-'+token}],origins:[]}));
  protectedCopies.push(copy);
 }
 const newest=[f.add(6),f.add(7)];f.clock.now+=8*DAY;
 for(let round=0;round<4&&f.engine.containers.has(old.id);round++){
  await f.cleanup.sweep('A');f.clock.now+=DAY;
 }
 assert.equal(f.engine.containers.has(old.id),false,'Older eligible receipts must eventually be considered');
 assert.equal(fs.existsSync(old.dir),false);
 for(const copy of [...protectedCopies,...newest]){assert(f.engine.containers.has(copy.id));assert(fs.existsSync(copy.file));}
 assert.deepEqual(f.engine.commands.filter(a=>a[0]==='rm'),[['rm',old.id]]);f.preserved();
});

test('journal removal failure resumes after the container and redundant credentials were already removed',async t=>{
 const f=fixture(t),[old]=f.three(),remove=f.cleanup.store.remove.bind(f.cleanup.store);let failed=false;
 f.cleanup.store.remove=receipt=>{if(!failed){failed=true;throw Error('Journal directory sync unavailable');}return remove(receipt);};
 await f.cleanup.sweep('A');
 assert.equal(f.engine.containers.has(old.id),false);assert.equal(fs.existsSync(old.dir),false);
 assert(f.cleanup.store.list().some(r=>r.containerId===old.id),'Unfinished cleanup retains its receipt');
 f.clock.now+=DAY;await f.cleanup.sweep('A');
 assert.equal(f.cleanup.store.list().some(r=>r.containerId===old.id),false);
 assert.deepEqual(f.engine.commands.filter(a=>a[0]==='rm'),[['rm',old.id]]);f.preserved();
});

for(const stage of ['describe','inspect'])for(const change of ['revoked','retention extended']){
 test('receipt '+change+' during '+stage+' prevents container and credential deletion',async t=>{
  const f=fixture(t),[old]=f.three(),file=path.join(f.root,'retired-resources','A-'+old.id+'.json');let changed=false;
  const revise=()=>{
   if(changed)return;changed=true;
   if(change==='revoked')fs.unlinkSync(file);
   else{const receipt=JSON.parse(fs.readFileSync(file));receipt.retiredAt=f.clock.now;fs.writeFileSync(file,JSON.stringify(receipt));}
  };
  if(stage==='describe'){
   const describe=f.driver.describe;f.driver.describe=async slot=>{const result=await describe(slot);revise();return result;};
  }else f.engine.after=async args=>{if(args[0]==='inspect'&&args.length===2&&args[1]===old.id)revise();};
  await f.cleanup.sweep('A');assert(changed,'Regression must alter receipt during the awaited operation');
  assert(f.engine.containers.has(old.id));assert(fs.existsSync(old.file));
  assert.equal(f.engine.commands.some(args=>args[0]==='rm'),false);f.preserved();
 });
}

test('receipt changed during successful Docker removal retains credentials',async t=>{
 const f=fixture(t),[old]=f.three(),file=path.join(f.root,'retired-resources','A-'+old.id+'.json');let changed=false;
 f.engine.after=async args=>{if(args[0]==='rm'){
  const receipt=JSON.parse(fs.readFileSync(file));receipt.retiredAt=f.clock.now;
  fs.writeFileSync(file,JSON.stringify(receipt));changed=true;
 }};
 await f.cleanup.sweep('A');assert(changed);assert.equal(f.engine.containers.has(old.id),false);
 assert(fs.existsSync(old.file));assert(fs.existsSync(file));f.preserved();
});

test('parallel cleanup never occupies both slots while the other slot remains dispatchable',async t=>{
 const f=fixture(t),[oldA]=f.three(),oldB=f.add(4,'B');f.add(5,'B');f.add(6,'B');f.clock.now+=8*DAY;
 let entered,release;const waiting=new Promise(resolve=>{entered=resolve;});
 f.engine.before=async args=>{if(args[0]==='rm'&&args[1]===oldA.id){entered();await new Promise(resolve=>{release=resolve;});}};
 const cleaningA=f.cleanup.sweep('A');await waiting;
 assert.equal(f.dispatch.operations.status('A')?.kind,'cleanup');
 const skippedB=await f.cleanup.sweep('B');assert.equal(skippedB.skipped,'other_slot_cleanup');
 assert.equal(f.dispatch.operations.has('B'),false);assert(f.engine.containers.has(oldB.id));
 // An actual B admission must remain available while A waits for Docker. This
 // test replaces only persistence, so its fixture's critical files stay fixed.
 f.dispatch.persist=()=>{};
 const ticket=f.dispatch.acquire(randomUUID(),{model:'test-model',quotaFamily:'flash'},slot=>slot==='B');
 assert.equal(ticket?.slot,'B');assert.equal(ticket?.account,2);
 release();await cleaningA;
 assert.equal(f.engine.containers.has(oldA.id),false);assert(f.engine.containers.has(oldB.id));
 assert.deepEqual(f.engine.commands.filter(args=>args[0]==='rm'),[['rm',oldA.id]]);f.preserved();
});

test('parent path substitution immediately before unlink cannot redirect deletion into primary credentials',async t=>{
 const f=fixture(t),[old]=f.three(),moved=old.dir+'-moved',unlink=fs.unlinkSync;let swapped=false;
 t.mock.method(fs,'unlinkSync',file=>{
  if(!swapped&&typeof file==='string'&&/^\/proc\/self\/fd\/\d+\/auth-3\.json$/.test(file)){
   swapped=true;fs.renameSync(old.dir,moved);fs.symlinkSync(f.source,old.dir);
  }
  return unlink(file);
 });
 await f.cleanup.sweep('A');assert(swapped,'Credential deletion must use a pinned directory');
 assert.equal(fs.existsSync(path.join(moved,'auth-3.json')),false,'Only the redundant backup was unlinked');
 assert(fs.lstatSync(old.dir).isSymbolicLink());assert(fs.existsSync(path.join(f.source,'auth-3.json')));
 assert(f.cleanup.store.list().some(receipt=>receipt.containerId===old.id),'Path change keeps unfinished receipt');f.preserved();
});

for(const mode of ['missing original','changed original','invalid original','changed backup','replaced backup inode','unexpected extra file','symlink backup','symlink directory']){
 test('credentials are protected when '+mode,async t=>{
  const f=fixture(t),[old]=f.three(),original=path.join(f.source,'auth-3.json');
  if(mode==='missing original'){fs.unlinkSync(original);f.keyFiles.delete(original);}
  if(mode==='changed original'){fs.writeFileSync(original,JSON.stringify({cookies:[{name:'new'}],origins:[]}));f.keyFiles.delete(original);}
  if(mode==='invalid original'){fs.writeFileSync(original,'{}');f.keyFiles.delete(original);}
  if(mode==='changed backup')fs.writeFileSync(old.file,JSON.stringify({cookies:[{name:'unique-session'}],origins:[]}));
  if(mode==='replaced backup inode'){const data=fs.readFileSync(old.file);fs.renameSync(old.file,old.file+'.saved');fs.writeFileSync(old.file,data);fs.unlinkSync(old.file+'.saved');}
  if(mode==='unexpected extra file')fs.writeFileSync(path.join(old.dir,'do-not-delete.txt'),'unique data');
  if(mode==='symlink backup'){fs.unlinkSync(old.file);fs.symlinkSync(original,old.file);}
  if(mode==='symlink directory'){fs.renameSync(old.dir,old.dir+'-saved');fs.symlinkSync(old.dir+'-saved',old.dir);}
  await f.cleanup.sweep('A');assert(f.engine.containers.has(old.id));assert(fs.existsSync(old.dir));
  if(mode==='unexpected extra file')assert.equal(fs.readFileSync(path.join(old.dir,'do-not-delete.txt'),'utf8'),'unique data');
  f.preserved();
 });
}

for(const obstruction of ['active','request','execution','retirement','pending','rotation','recovery','catalog','not ready','halted','shutdown','lease']){
 test('cleanup skips slot with '+obstruction,async t=>{
  const f=fixture(t),[old]=f.three(),s=f.dispatch.slots.get('A');
  if(obstruction==='active')s.active=1;
  if(obstruction==='request')s.requests.add(randomUUID());
  if(obstruction==='execution')s.executions[randomUUID()]={};
  if(obstruction==='retirement')s.retirements[randomUUID()]={};
  if(obstruction==='pending')f.dispatch.pool.slots.get('A').pending={id:4,token:4};
  if(obstruction==='rotation')s.rotation={};
  if(obstruction==='recovery')s.recovery={};
  if(obstruction==='catalog')s.catalogTask={};
  if(obstruction==='not ready')s.ready=false;
  if(obstruction==='halted')f.dispatch.halted=true;
  if(obstruction==='shutdown')f.clock.stopping=true;
  const lease=obstruction==='lease'?f.dispatch.operations.acquire('A','catalog'):null;
  await f.cleanup.sweep('A');assert(f.engine.containers.has(old.id));assert(fs.existsSync(old.file));assert.equal(f.engine.commands.some(a=>a[0]==='rm'),false);
  if(lease)f.dispatch.operations.release(lease);f.preserved();
 });
}

test('Docker removal with a lost response keeps credentials until a later positive inventory',async t=>{
 const f=fixture(t),[old]=f.three();let failed=false;
 f.engine.after=async args=>{if(args[0]==='rm'&&!failed){failed=true;throw Error('Lost Docker removal response');}};
 await f.cleanup.sweep('A');
 assert.equal(f.engine.containers.has(old.id),false);assert(fs.existsSync(old.file),'Ambiguous command response cannot authorize credential deletion');
 f.engine.after=null;f.clock.now+=DAY;await f.cleanup.sweep('A');
 assert.equal(fs.existsSync(old.dir),false);assert.equal(f.engine.commands.filter(a=>a[0]==='rm').length,1);f.preserved();
});

test('incomplete Docker inventory never authorizes deleting any resource',async t=>{
 const f=fixture(t),[old]=f.three();
 f.engine.before=async args=>{if(args[0]==='inspect')throw Error('Docker inventory unavailable');};
 await f.cleanup.sweep('A');assert(f.engine.containers.has(old.id));assert(fs.existsSync(old.file));f.preserved();
});

for(const stop of ['shutdown','close']){
 test(stop+' during Docker inspect prevents subsequent removal',async t=>{
  const f=fixture(t),[old]=f.three();let entered,release;
  const waiting=new Promise(resolve=>{entered=resolve;});
  f.engine.before=async args=>{if(args[0]==='inspect'){entered();await new Promise(resolve=>{release=resolve;});}};
  const work=f.cleanup.sweep('A');await waiting;
  if(stop==='shutdown')f.clock.stopping=true;else f.cleanup.close();
  release();await work;assert(f.engine.containers.has(old.id));assert(fs.existsSync(old.file));f.preserved();
 });
}

test('cleanup lease rejects competing slot requests and rotations without blocking the other slot',async t=>{
 const f=fixture(t);f.three();let entered,release;
 const waiting=new Promise(resolve=>{entered=resolve;});
 f.engine.before=async args=>{if(args[0]==='rm'){entered();await new Promise(resolve=>{release=resolve;});}};
 const work=f.cleanup.sweep('A');await waiting;
 assert.equal(f.dispatch.operations.status('A')?.kind,'cleanup');assert.equal(f.dispatch.operations.has('B'),false);
 assert.equal(f.dispatch.acquire(randomUUID(),{model:'test-model',quotaFamily:'flash'},slot=>slot==='A'),undefined);
 const rotation=new RotationController(f.dispatch,f.driver);
 await assert.rejects(rotation.rotate('A',true,4),/operation.*running/i);
 release();await work;assert.equal(f.dispatch.operations.has('A'),false);f.preserved();
});

test('new request arriving during read-only inventory prevents cleanup without disrupting the request',async t=>{
 const f=fixture(t),[old]=f.three();let changed=false;
 f.engine.after=async args=>{if(args[0]==='inspect'&&!changed){changed=true;f.dispatch.slots.get('A').active=1;}};
 await f.cleanup.sweep('A');assert(f.engine.containers.has(old.id));assert(fs.existsSync(old.file));
 assert.equal(f.dispatch.slots.get('A').active,1);assert.equal(f.dispatch.operations.has('A'),false);f.preserved();
});

test('queued work arriving during Docker removal retains credentials and releases cleanup lease',async t=>{
 const f=fixture(t),[old]=f.three();
 f.engine.after=async args=>{if(args[0]==='rm')f.clock.waiting=true;};
 await f.cleanup.sweep('A');
 assert.equal(f.engine.containers.has(old.id),false);assert(fs.existsSync(old.file));
 assert.equal(f.dispatch.operations.has('A'),false);f.preserved();
});

test('missing retired credentials cannot authorize removal while the retired container still exists',async t=>{
 const f=fixture(t),[old]=f.three();fs.unlinkSync(old.file);fs.rmdirSync(old.dir);
 await f.cleanup.sweep('A');assert(f.engine.containers.has(old.id));f.preserved();
});

test('empty retired directory can finish cleanup only after inventory proves its container is absent',async t=>{
 const f=fixture(t),[old]=f.three();f.engine.containers.delete(old.id);fs.unlinkSync(old.file);
 await f.cleanup.sweep('A');assert.equal(fs.existsSync(old.dir),false);f.preserved();
});

for(const invalid of [{retentionDays:0},{keepPerSlot:0},{intervalMinutes:0},{maxPerSweep:0},{maxPerSweep:11},{retentionDays:'seven'}]){
 test('invalid cleanup configuration disables cleanup safely: '+JSON.stringify(invalid),async t=>{
  const f=fixture(t,invalid),old=f.add(1,'A',3,false);f.clock.now+=30*DAY;
  await f.cleanup.sweep('A');assert.equal(f.cleanup.status().enabled,false);
  assert(f.engine.containers.has(old.id));assert(fs.existsSync(old.file));assert.equal(f.dispatch.halted,false);f.preserved();
 });
}
