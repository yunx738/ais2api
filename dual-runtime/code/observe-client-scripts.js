const crypto=require('crypto');
function observe(page,report){
 const pending=new Set();
 const handler=response=>{
  if(response.request().resourceType()!=='script')return;
  const task=(async()=>{
   try{
    const url=new URL(response.url());
    const length=Number(response.headers()['content-length']||0);
    if(length>2097152)return;
    const body=await response.body();
    if(body.length>2097152)return;
    const text=body.toString('utf8');
    const markers=['ProxySystem','RequestProcessor','initializeProxySystem','operation_done','generativelanguage.googleapis.com'];
    const features=Object.fromEntries(markers.map(k=>[k,text.includes(k)]));
    if(!Object.values(features).some(Boolean))return;
    if(crypto.createHash('sha256').update(body).digest('hex')==='3e1ed4e84cf3bbb02a3cc1026c98137c39c1218c169229e2496cc158e45b979d'){
      const fs=require('fs');
      fs.mkdirSync('/tmp/ais-client-evidence',{recursive:true,mode:448});
      fs.writeFileSync('/tmp/ais-client-evidence/preview-client.js',body,{mode:384});
    }

    report({host:url.hostname,status:response.status(),bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex'),features});
   }catch{report({observationFailed:true});}
  })(); pending.add(task);task.finally(()=>pending.delete(task));
 };
 page.on('response',handler);
 return async()=>{page.off('response',handler);await Promise.allSettled([...pending]);};
}
module.exports={observe};