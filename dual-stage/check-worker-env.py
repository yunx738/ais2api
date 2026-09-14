from pathlib import Path
root=Path('/opt/ais2api/dual-runtime')
for slot in ['A','B']:
    env=dict(line.split('=',1) for line in (root/'slots'/slot/'worker.env').read_text().splitlines() if '=' in line)
    print(slot,'browser_path',env.get('CAMOUFOX_EXECUTABLE_PATH','image default'))
    print(slot,'target_matches',env.get('TARGET_URL','').endswith('f7809540-2218-407b-9210-0af3bda47602'))
    print(slot,'auth_file_count',len(list((root/'slots'/slot/'auth').iterdir())))
for name in ['start-worker.js','unified-server.runtime.js','black-browser.js']:
    p=root/'code'/name
    print(name,oct(p.stat().st_mode & 511))
