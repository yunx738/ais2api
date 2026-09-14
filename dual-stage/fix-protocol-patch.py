from pathlib import Path
p=Path('/opt/ais2api/dual-stage/connect-protocol.py')
s=p.read_text().replace(chr(92)+chr(34),chr(34))
s=s.replace(chr(92)+chr(92)+'n',chr(92)+'n')
p.write_text(s)
