'use strict';
// model-access.json {ultraOnly:[model...]}: premium (ultra family) models listed here run on Ultra accounts only;
// the console's "开放给 Pro" button removes a model from the list. Re-read when the file changes.
const fs=require('fs'),path=require('path');
const file=()=>path.join(process.env.DUAL_ROOT||'/opt/ais2api/dual-runtime','model-access.json');
let tag='',list=[];
function ultraOnly(model){
 let st;try{st=fs.statSync(file());}catch{tag='';list=[];return false;}
 const t=st.ino+':'+st.mtimeMs+':'+st.size;
 if(t!==tag){try{const d=JSON.parse(fs.readFileSync(file(),'utf8'));list=Array.isArray(d.ultraOnly)?d.ultraOnly.filter(x=>typeof x==='string'):[];tag=t;}catch{}}
 return list.includes(model);
}
module.exports={ultraOnly,file};
