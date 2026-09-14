from pathlib import Path
root=Path('/opt/ais2api/dual-stage')
p=root/'start-worker.js'
s=p.read_text()
old=' const tracker=install(worker.system);'
assert old in s
s=s.replace(old," require('./worker-protocol').install(worker.system.connectionRegistry);\n"+old,1)
p.write_text(s)
p=root/'worker-system.js'
s=p.read_text()
old='system.connectionRegistry.hasActiveConnections();'
assert old in s
s=s.replace(old,'system.connectionRegistry.hasActiveConnections() && system.connectionRegistry.protocolReady?.()===true;',1)
p.write_text(s)
p=root/'worker-container-spec.js'
s=p.read_text()
s=s.replace("const files=['worker-system.js'","const files=['worker-protocol.js','worker-system.js'",1)
p.write_text(s)
p=root/'black-browser.js'
s=p.read_text()
old='      switch (requestSpec.event_type) {'
assert old in s
s=s.replace(old,old+'''
        case "worker_challenge":
          if (requestSpec.protocol === 1 && typeof requestSpec.challenge === "string") {
            this.connectionManager.transmit({
              event_type: "worker_hello", protocol: 1, operation_done: true,
              challenge: requestSpec.challenge
            });
          }
          break;
''',1)
p.write_text(s)
p=root/'test-worker-system.js'
s=p.read_text()
s=s.replace('hasActiveConnections:()=>true,messageQueues','protocolReady:()=>true,hasActiveConnections:()=>true,messageQueues',1)
s=s.replace('  assert.equal(w.status().ready,true);','''  assert.equal(w.status().ready,true);
  w.system.connectionRegistry.protocolReady=()=>false;
  assert.equal(w.status().ready,false);
  w.system.connectionRegistry.protocolReady=()=>true;''',1)
p.write_text(s)
print('PROTOCOL_CONNECTED_IN_STAGE_ONLY')
