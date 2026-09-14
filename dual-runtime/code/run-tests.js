'use strict';
const fs=require('fs'),path=require('path');
const {spawnSync}=require('child_process');
const files=fs.readdirSync(__dirname).filter(n=>n.startsWith('test-') && n.endsWith('.js')).sort();
for(const name of files){
 const result=spawnSync(process.execPath,[path.join(__dirname,name)],{stdio:'inherit',timeout:30000,env:process.env});
 if(result.error||result.status!==0){
  console.error('FAILED',name);
  process.exit(1);
 }
}
console.log('ALL TESTS PASSED:',files.length);
