import pathlib,json,subprocess,secrets,shutil,os
base=pathlib.Path('/opt/ais2api')
root=base/'dual-runtime'
if root.exists():
    raise SystemExit('Runtime already exists; inspect before continuing')
env={}
for line in (base/'app.env').read_text().splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        k,v=line.split('=',1)
        env[k]=v.strip().strip(chr(34)).strip(chr(39))
image=subprocess.check_output(['docker','inspect','ais2api','--format','{{.Image}}'],text=True).strip()
assert image.startswith('sha256:')
keys=[x.strip() for x in env['API_KEYS'].split(',') if x.strip()]
assert keys and env.get('SOCKS_UPSTREAM_URL') and env.get('TARGET_URL')
root.mkdir(mode=0o700)
code=root/'code'
code.mkdir(mode=0o755)
for p in (base/'dual-stage').glob('*.js'):
    shutil.copy2(p,code/p.name)
    (code/p.name).chmod(0o644)
shutil.copy2(base/'dual-stage/models.json',code/'models.json')
(code/'models.json').chmod(0o644)
for name in ['import-ui.html']:
    shutil.copy2(base/'dual-stage'/name,code/name)
    (code/name).chmod(0o644)
cfg={'image':image,'apiKeys':keys,'workers':{}}
(root/'slots').mkdir(mode=0o700)
for slot in ['A','B']:
    folder=root/'slots'/slot
    folder.mkdir(mode=0o700)
    (folder/'auth').mkdir(mode=0o700)
    control=secrets.token_hex(32)
    api=secrets.token_hex(32)
    cfg['workers'][slot]={'control':control,'api':api}
    allowed=['SOCKS_UPSTREAM_URL','TARGET_URL','STREAMING_MODE','CAMOUFOX_EXECUTABLE_PATH']
    worker={k:env[k] for k in allowed if k in env}
    worker.update(API_KEYS=api,WORKER_CONTROL_KEY=control,PORT='7860',HOST='0.0.0.0',SWITCH_ON_USES='80',IMMEDIATE_SWITCH_STATUS_CODES='',FAILURE_THRESHOLD='0')
    assert all('\n' not in v and '\r' not in v for v in worker.values())
    f=folder/'worker.env'
    fd=os.open(f,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as out:
        out.write(''.join(k+'='+v+'\n' for k,v in worker.items()))
fd=os.open(root/'coordinator.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as out:
    json.dump(cfg,out)
print('RUNTIME_PREPARED; independent credentials; pinned image; no auth copied; no containers started')
