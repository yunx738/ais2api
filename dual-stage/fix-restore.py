from pathlib import Path
p=Path('/opt/ais2api/dual-stage/restore-dispatch.js')
lines=p.read_text().splitlines()
for i,line in enumerate(lines):
    if 'if(id===undefined' in line:
        lines[i]='   if((id ?? undefined)===undefined)continue;'
    if 'Unassigned slot' in line:
        lines[i]='  if((state.current ?? undefined)===undefined && !state.pending)throw Error(' + repr('Unassigned slot') + ');'
p.write_text('\n'.join(lines)+'\n')
