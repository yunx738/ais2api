'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {RetiredResourceStore,assertDirectory,MAX_RECEIPT_BYTES,MAX_RECEIPTS}=require('./retired-resource-store');

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ais-retirement-journal-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'auth-1.json'),checkpoint=path.join(root,'state.json');
 fs.writeFileSync(source,'critical source credentials');fs.writeFileSync(checkpoint,'critical coordinator state');
 const store=new RetiredResourceStore(root),directory=path.join(root,'retired-resources');
 const receipt={version:1,slot:'A',containerId:'a'.repeat(64),account:1,token:3,retiredAt:1720000000000,
  auth:{dev:1,ino:2,fileDev:1,fileIno:3,sha256:'b'.repeat(64)}};
 const file=path.join(directory,'A-'+receipt.containerId+'.json');
 const intact=()=>{
  assert.equal(fs.readFileSync(source,'utf8'),'critical source credentials');
  assert.equal(fs.readFileSync(checkpoint,'utf8'),'critical coordinator state');
 };
 return {root,source,checkpoint,store,directory,receipt,file,intact};
}
test('retirement journal preserves exact evidence and removes only its own receipt',t=>{
 const f=fixture(t);
 assert.deepEqual(f.store.list(),[]);
 assert.deepEqual(f.store.record(f.receipt),f.receipt);
 const initial=fs.statSync(f.file);
 assert.deepEqual(f.store.record({...f.receipt,auth:{...f.receipt.auth}}),f.receipt);
 assert.equal(fs.statSync(f.file).ino,initial.ino,'idempotence must not rewrite the timestamp or inode');
 assert.deepEqual(f.store.list(),[f.receipt]);
 assert.equal(fs.statSync(f.directory).mode&0o777,0o700);
 assert.equal(initial.mode&0o777,0o600);
 assert.equal(f.store.remove(f.receipt),true);assert.equal(f.store.remove(f.receipt),false);
 assert.deepEqual(f.store.list(),[]);f.intact();
});
test('retirement evidence cannot be rejuvenated or changed after recording',t=>{
 const f=fixture(t);f.store.record(f.receipt);
 for(const changed of [
  {...f.receipt,retiredAt:f.receipt.retiredAt+1},
  {...f.receipt,account:2},
  {...f.receipt,token:4},
  {...f.receipt,auth:{...f.receipt.auth,ino:4}}
 ]){
  assert.throws(()=>f.store.record(changed),/cannot be replaced/);
  assert.throws(()=>f.store.remove(changed),/evidence changed/);
 }
 assert.deepEqual(f.store.list(),[f.receipt]);f.intact();
});
test('invalid schema, traversal identifiers and unsafe numbers never create a journal',t=>{
 const f=fixture(t);
 const invalid=[null,[],{}, {...f.receipt,extra:true},{...f.receipt,version:2},
  {...f.receipt,slot:'../A'},{...f.receipt,containerId:'../auth-1.json'},
  {...f.receipt,account:0},{...f.receipt,account:Number.MAX_SAFE_INTEGER+1},
  {...f.receipt,token:-1},{...f.receipt,retiredAt:Infinity},
  {...f.receipt,auth:{...f.receipt.auth,ino:NaN}},
  {...f.receipt,auth:{...f.receipt.auth,fileIno:-1}},
  {...f.receipt,auth:{...f.receipt.auth,sha256:'xyz'}},
  {...f.receipt,auth:{...f.receipt.auth,path:f.source}}];
 for(const receipt of invalid){assert.throws(()=>f.store.record(receipt),/invalid receipt/);assert.throws(()=>f.store.remove(receipt),/invalid receipt/);}
 assert.equal(fs.existsSync(f.directory),false);f.intact();
});
test('constructing unavailable storage is harmless; journal operations fail closed',t=>{
 const f=fixture(t),missing=path.join(f.root,'missing');
 const store=new RetiredResourceStore(missing);
 assert.throws(()=>store.list(),{code:'ENOENT'});
 assert.throws(()=>store.record(f.receipt),{code:'ENOENT'});
 assert.equal(fs.existsSync(missing),false);f.intact();
});
test('canonical directory validation rejects path aliases and symlink ancestors',t=>{
 const f=fixture(t),alias=path.join(f.root,'alias');fs.symlinkSync(f.root,alias,'dir');
 for(const root of [f.root+'/../'+path.basename(f.root),f.root+'/.',f.root+'/',f.root+'\0','relative',alias,alias+'/retired-resources']){
  const store=new RetiredResourceStore(root);
  assert.throws(()=>store.list());assert.throws(()=>store.record(f.receipt));
 }
 assert.equal(assertDirectory(f.root).isDirectory(),true);f.intact();
});
test('symlink journal directories and symlink receipt entries are never followed',t=>{
 const f=fixture(t),outside=path.join(f.root,'other');fs.mkdirSync(outside);
 fs.symlinkSync(outside,f.directory,'dir');assert.throws(()=>f.store.list(),/unsafe directory/);
 assert.deepEqual(fs.readdirSync(outside),[]);fs.unlinkSync(f.directory);
 f.store.list();fs.symlinkSync(f.source,f.file);
 assert.throws(()=>f.store.list(),/unsafe/);assert.throws(()=>f.store.record(f.receipt),/unsafe/);
 assert.throws(()=>f.store.remove(f.receipt),/unsafe/);assert(fs.lstatSync(f.file).isSymbolicLink());f.intact();
});
test('unknown files and directories are preserved and block cleanup',t=>{
 const f=fixture(t);f.store.record(f.receipt);
 for(const name of ['unknown.json','credentials.tmp','nested']){
  const entry=path.join(f.directory,name);
  if(name==='nested')fs.mkdirSync(entry);else fs.writeFileSync(entry,'do not delete',{mode:0o600});
  assert.throws(()=>f.store.list(),/unknown/);assert.throws(()=>f.store.remove(f.receipt),/unknown/);
  assert(fs.existsSync(entry));assert(fs.existsSync(f.file));
  if(name==='nested')fs.rmdirSync(entry);else fs.unlinkSync(entry);
 }
 f.intact();
});
test('interrupted private temporary writes are ignored without deleting them',t=>{
 const f=fixture(t);f.store.list();
 const temp=f.file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,'{"version":',{mode:0o600});
 assert.deepEqual(f.store.list(),[]);f.store.record(f.receipt);assert.deepEqual(f.store.list(),[f.receipt]);
 f.store.remove(f.receipt);assert.equal(fs.readFileSync(temp,'utf8'),'{"version":');
 fs.unlinkSync(temp);fs.symlinkSync(f.source,temp);
 assert.throws(()=>f.store.list(),/unsafe/);assert(fs.lstatSync(temp).isSymbolicLink());f.intact();
});
test('corrupt, oversized and identity-mismatched receipts block every mutation',t=>{
 const f=fixture(t);f.store.list();
 for(const content of ['{',JSON.stringify({...f.receipt,slot:'B'}),'x'.repeat(MAX_RECEIPT_BYTES+1)]){
  fs.writeFileSync(f.file,content,{mode:0o600});
  assert.throws(()=>f.store.list());assert.throws(()=>f.store.record(f.receipt));assert.throws(()=>f.store.remove(f.receipt));
  assert.equal(fs.readFileSync(f.file,'utf8'),content);
 }
 f.intact();
});
test('existing broad-access journals and receipts are rejected without changing permissions',t=>{
 const f=fixture(t);fs.mkdirSync(f.directory,{mode:0o700});fs.chmodSync(f.directory,0o755);
 assert.throws(()=>f.store.list(),/owner-only/);assert.equal(fs.statSync(f.directory).mode&0o777,0o755);
 fs.chmodSync(f.directory,0o700);f.store.record(f.receipt);fs.chmodSync(f.file,0o644);
 assert.throws(()=>f.store.list(),/unsafe/);assert.throws(()=>f.store.remove(f.receipt),/unsafe/);
 assert.equal(fs.statSync(f.file).mode&0o777,0o644);f.intact();
});
test('failed receipt flush never publishes partial evidence or alters account data',t=>{
 const f=fixture(t);f.store.list();
 t.mock.method(fs,'fsyncSync',()=>{throw Object.assign(Error('Simulated full filesystem'),{code:'ENOSPC'});});
 assert.throws(()=>f.store.record(f.receipt),/full filesystem/);
 assert.equal(fs.existsSync(f.file),false);assert.deepEqual(fs.readdirSync(f.directory),[]);f.intact();
});
test('atomic publication never overwrites a concurrent retirement receipt',t=>{
 const f=fixture(t);f.store.list();const original=fs.linkSync;
 const concurrent={...f.receipt,retiredAt:f.receipt.retiredAt-1};
 t.mock.method(fs,'linkSync',(source,destination)=>{
  fs.writeFileSync(destination,JSON.stringify(concurrent),{flag:'wx',mode:0o600});
  return original(source,destination);
 });
 assert.throws(()=>f.store.record(f.receipt),/cannot be replaced/);
 assert.deepEqual(f.store.list(),[concurrent]);assert.deepEqual(fs.readdirSync(f.directory),[path.basename(f.file)]);f.intact();
});
test('receipt replacement between read and removal is detected by inode',t=>{
 const f=fixture(t);f.store.record(f.receipt);const original=fs.lstatSync;
 let reads=0;
 t.mock.method(fs,'lstatSync',(file,...args)=>{
  if(file===f.file&&++reads===3){
   const replacement=path.join(f.root,'replacement.json');
   fs.writeFileSync(replacement,JSON.stringify(f.receipt),{mode:0o600});fs.renameSync(replacement,f.file);
  }
  return original(file,...args);
 });
 assert.throws(()=>f.store.remove(f.receipt),/identity changed/);
 assert(fs.existsSync(f.file));f.intact();
});
test('receipt count limit prevents unbounded journal processing',t=>{
 const f=fixture(t);f.store.list();
 for(let i=0;i<=MAX_RECEIPTS;i++)fs.writeFileSync(path.join(f.directory,String(i)), '',{mode:0o600});
 assert.throws(()=>f.store.list(),/too many/);assert.throws(()=>f.store.record(f.receipt),/too many/);
 assert.equal(fs.readdirSync(f.directory).length,MAX_RECEIPTS+1);f.intact();
});
