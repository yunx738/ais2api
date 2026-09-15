'use strict';
function parseAnalyticsQuery(params,{summary=false}={}){
 const out={};
 const allowed=new Set(['from','to','model','account','outcome',...(summary?[]:['page','pageSize'])]);
 for(const key of params.keys()){
  if(!allowed.has(key)||params.getAll(key).length!==1)throw Error('Invalid analytics query');
  const value=params.get(key);
  if(['from','to','account','page','pageSize'].includes(key)){
   if(!/^\d{1,16}$/.test(value))throw Error('Invalid numeric filter');
   const n=Number(value);
   if(!Number.isSafeInteger(n))throw Error('Invalid numeric filter');
   out[key]=n;
  }else if(key==='model'){
   if(!/^[a-zA-Z0-9._/-]{1,200}$/.test(value))throw Error('Invalid model filter');
   out[key]=value;
  }else{
   if(!['success','http_error','application_error','cancelled','uncertain','rejected','pending'].includes(value))throw Error('Invalid outcome filter');
   out[key]=value;
  }
 }
 if(out.page!==undefined && out.page<1)throw Error('Invalid page');
 if(out.pageSize!==undefined && (out.pageSize<1||out.pageSize>100))throw Error('Invalid page size');
 if((out.to??Number.MAX_SAFE_INTEGER)<(out.from??0))throw Error('Invalid time range');
 return out;
}
module.exports={parseAnalyticsQuery};
