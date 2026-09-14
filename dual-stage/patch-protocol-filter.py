from pathlib import Path
p=Path('/opt/ais2api/dual-stage/worker-protocol.js')
s=p.read_text()
old='''  add(socket,info);
  socket.send(JSON.stringify({event_type:'worker_challenge',protocol:1,challenge}));'''
new='''  const prior=new Set(socket.listeners('message'));
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
  socket.send(JSON.stringify({event_type:'worker_challenge',protocol:1,challenge}));'''
assert s.count(old)==1
p.write_text(s.replace(old,new))
p=Path('/opt/ais2api/dual-stage/test-worker-protocol.js')
s=p.read_text()
s=s.replace('const r={','const received=[];\nconst r={',1)
s=s.replace("addConnection(s){this.connections.add(s);", "addConnection(s){s.on('message',raw=>received.push(JSON.parse(raw)));this.connections.add(s);",1)
s=s.replace("const a=socket();r.addConnection(a,{});", "const a=socket();r.addConnection(a,{});\na.emit('message',JSON.stringify({event_type:'operation_done',request_id:'forged'}));\nassert.equal(received.length,0);",1)
s=s.replace('assert.equal(r.getFirstConnection(),a);', "assert.equal(r.getFirstConnection(),a);\na.emit('message',JSON.stringify({event_type:'operation_done',request_id:'valid'}));\nassert.equal(received.length,1);\nassert.equal(received[0].request_id,'valid');",1)
s=s.replace("a.emit('close');assert.equal(r.protocolReady(),false);", "a.emit('close');assert.equal(r.protocolReady(),false);\na.emit('message',JSON.stringify({event_type:'operation_done',request_id:'stale'}));\nassert.equal(received.length,1);",1)
p.write_text(s)
