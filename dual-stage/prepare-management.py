import pathlib,json,subprocess,os
base=pathlib.Path('/opt/ais2api')
root=base/'dual-runtime'
cfg=json.loads((root/'coordinator.json').read_text())
folder=root/'management'
folder.mkdir(mode=0o700)
f=folder/'management.env'
with os.fdopen(os.open(f,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as out:
    out.write('API_KEYS='+','.join(cfg['apiKeys'])+'\n')
args=['docker','create','--name','ais2api-dual-management','--label','operit.project=ais2api-dual',
      '--network','host','--restart=no','--security-opt','no-new-privileges:true','--cap-drop','ALL',
      '--memory','256m','--pids-limit','64','--log-opt','max-size=5m','--log-opt','max-file=2',
      '--env-file',str(f)]
files={'start-management.js':'start-management.js','unified-server.runtime.js':'unified-server.js',
       'stability.js':'stability.js','import-ui.js':'import-ui.js','import-ui.html':'import-ui.html'}
for source,target in files.items():
    args+=['--mount','type=bind,source='+str(root/'code'/source)+',target=/app/'+target+',readonly']
args+=['--mount','type=bind,source='+str(base/'auth')+',target=/app/auth,readonly',
       cfg['image'],'node','start-management.js']
r=subprocess.run(args,capture_output=True,text=True)
if r.returncode:
    raise SystemExit('Management container creation failed; inspect locally')
print('MANAGEMENT_CREATED',r.stdout.strip()[:12])
