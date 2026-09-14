'use strict';
const crypto=require('crypto');
function install(registry){
 const verified=new Set(),challenges=new Map();
 const add=registry.addConnection.bind(registry);
 registry.addConnection=function(socket,info){
  const challenge=crypto.randomBytes(24).toString('hex');
  challenges.set(socket,challenge);
  socket.on('message',raw=>{
   try{
    const m=JSON.parse(raw.toString());
    if(m.event_type==='worker_hello' && m.protocol===1 &&
       m.operation_done===true && m.challenge===challenges.get(socket) &&
       challenges.has(socket))verified.add(socket);
   }catch{}
  });
  socket.on('close',()=>{verified.delete(socket);challenges.delete(socket);});
  const prior=new Set(socket.listeners('message'));
  add(socket,info);
  // Only the verified current socket may feed the registry's request queues.
  for(const listener of socket.listeners('message')){
   if(prior.has(listener))continue;
   socket.removeListener('message',listener);
   socket.on('message',raw=>{
    let m;try{m=JSON.parse(raw.toString());}catch{return;}
    if(m.event_type==='worker_hello')return;
    if(!registry.protocolReady()||registry.getFirstConnection()!==socket)return;
    listener.call(socket,raw);
   });
  }
  socket.send(JSON.stringify({event_type:'worker_challenge',protocol:1,challenge}));
 };
 const first=registry.getFirstConnection.bind(registry);
 registry.protocolReady=()=>{
  const socket=first();
  return registry.connections.size===1 && verified.has(socket) && socket.readyState===1;
 };
 registry.getFirstConnection=()=>{
  if(!registry.protocolReady())return undefined;
  return first();
 };
 return {ready:registry.protocolReady};
}
module.exports={install};
