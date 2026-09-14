'use strict';
const fs=require('fs'),path=require('path');
function prepareAuth(sourceDir,targetDir,account,stopped){
 if(stopped!==true)throw Error('Stopped environment confirmation required');
 if(Number.isSafeInteger(account)===false||account<1)throw Error('Invalid account');
 const source=path.join(sourceDir,'auth-'+account+'.json');
 const fd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 let content;
 try{
  const stat=fs.fstatSync(fd);
  if(stat.isFile()===false||stat.size>262144)throw Error('Invalid authentication source');
  content=fs.readFileSync(fd);
 }finally{fs.closeSync(fd);}
 const data=JSON.parse(content.toString('utf8'));
 if(Array.isArray(data.cookies)===false||data.cookies.length===0||Array.isArray(data.origins)===false)throw Error('Invalid authentication structure');
 const stat=fs.lstatSync(targetDir);
 if(stat.isDirectory()===false||stat.isSymbolicLink())throw Error('Invalid destination directory');
 if(fs.readdirSync(targetDir).length>0)throw Error('Destination must be empty');
 const dest=path.join(targetDir,'auth-'+account+'.json');
 const out=fs.openSync(dest,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,384);
 try{
  fs.writeFileSync(out,content);
  fs.fchownSync(out,1000,1000);
  fs.fsyncSync(out);
 }finally{fs.closeSync(out);}
 fs.chownSync(targetDir,1000,1000);
 fs.chmodSync(targetDir,448);
 return {account};
}
module.exports={prepareAuth};
