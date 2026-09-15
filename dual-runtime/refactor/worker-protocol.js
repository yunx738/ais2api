"use strict";
const {randomUUID,randomBytes}=require("crypto");
function install(registry){
 const epoch=randomUUID(),verified=new WeakMap(),records=new Map();
 let sequence=0;
 const add=registry.addConnection.bind(registry),first=registry.getFirstConnection.bind(registry);
 const send=(socket,data)=>{if(socket.readyState===1)socket.send(JSON.stringify(data),()=>{});};
 registry.workerEpoch=epoch;
 registry.sessionIdentity=socket=>verified.get(socket);
 registry.protocolReady=()=>registry.connections.size===1 && Boolean(verified.get(first())) && first()?.readyState===1;
 registry.getFirstConnection=()=>registry.protocolReady()?first():undefined;
 registry.bindOperation=(id,socket)=>{
  const session=verified.get(socket);
  if(!session||socket!==registry.getFirstConnection()||records.has(id)||records.size>=20000||sequence>=Number.MAX_SAFE_INTEGER)
   throw Error("Operation ownership unavailable");
  const operationSequence=++sequence; records.set(id,{session,socket,done:false,operationSequence}); return operationSequence;
 };
 registry.addConnection=function(socket,info){
  const challenge=randomBytes(24).toString("hex");
  let admitted=false;
  const control=raw=>{
   let m;try{m=JSON.parse(raw.toString());}catch{return;}
   if(m.event_type==="worker_hello"){
    if(!admitted && m.protocol===2 && m.challenge===challenge &&
       m.workerEpoch===epoch && /^[a-f0-9-]{36}$/.test(m.sessionId||"")){
     admitted=true;verified.set(socket,m.sessionId);
     send(socket,{event_type:"worker_ready",protocol:2,workerEpoch:epoch,sessionId:m.sessionId});
    }
    return;
   }
   if(m.event_type==="operation_ack_received"){ const record=records.get(m.request_id),session=verified.get(socket); if(registry.protocolReady() && first()===socket && record?.done && record.session===session && m.sessionId===session && m.workerEpoch===epoch && m.operationSequence===record.operationSequence)records.delete(m.request_id); return; }
   if(m.event_type!=="operation_done")return;
   const session=verified.get(socket),record=records.get(m.request_id);
   if(!registry.protocolReady()||first()!==socket||!record||
      record.session!==session||m.sessionId!==session||m.workerEpoch!==epoch||m.operationSequence!==record.operationSequence)return;
   if(!record.done){
    // Synchronous subscribers update the execution ledger before receipt.
    registry.emit("operationDone",m.request_id);
    record.done=true;
   }
   send(socket,{event_type:"operation_ack",request_id:m.request_id,sessionId:session,workerEpoch:epoch,operationSequence:record.operationSequence});
  };
  socket.on("message",control);
  const prior=new Set(socket.listeners("message"));
  add(socket,info);
  for(const listener of socket.listeners("message")){
   if(prior.has(listener))continue;
   socket.removeListener("message",listener);
   socket.on("message",raw=>{
    let m;try{m=JSON.parse(raw.toString());}catch{return;}
    if(["worker_hello","operation_done","operation_ack_received"].includes(m.event_type))return;
    const record=records.get(m.request_id);
    // Old response chunks never enter a new connection or a new request.
    if(!registry.protocolReady()||first()!==socket||!record||record.done||record.socket!==socket)return;
    listener.call(socket,raw);
   });
  }
  // WeakMap retains closed socket identity for settlement; readiness checks membership.
  send(socket,{event_type:"worker_challenge",protocol:2,challenge,workerEpoch:epoch});
 };
 const receiptTimer=setInterval(()=>{ const socket=registry.getFirstConnection(),session=socket && verified.get(socket); if(!socket)return; for(const [request_id,record] of records){ if(record.done && record.session===session)send(socket,{event_type:"operation_ack",request_id,sessionId:session,workerEpoch:epoch,operationSequence:record.operationSequence}); } },2000); receiptTimer.unref?.();
 return {ready:registry.protocolReady,epoch,dispose:()=>clearInterval(receiptTimer)};
}
module.exports={install};
