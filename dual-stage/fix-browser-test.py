from pathlib import Path
p=Path('/opt/ais2api/dual-stage/test-browser-protocol.js')
s=p.read_text()
s=s.replace(chr(11)+'m.runInContext','vm.runInContext')
p.write_text(s)
