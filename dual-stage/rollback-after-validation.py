import subprocess,json,pathlib,shutil
root=pathlib.Path('/opt/ais2api/dual-runtime')
def run(args,timeout=60):
 r=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
 if r.returncode: raise RuntimeError('Failed operation: '+args[0])
 return r.stdout
def inspect(name):
 return json.loads(run(['docker','inspect',name]))[0]
run(['systemctl','kill','--signal=SIGKILL','ais2api-dual-coordinator'])
for name in ['ais2api-dual-a','ais2api-dual-b']:
 d=inspect(name)
 if d['State']['Running']:
  run(['docker','stop','--time','30',d['Id']])
 after=inspect(name)
 assert after['Id']==d['Id'] and not after['State']['Running'] and after['State']['Pid']==0
 print('STOP_CONFIRMED',name,flush=True)
run(['docker','start','ais2api'])
backup=pathlib.Path((root/'cutover-backup-path').read_text().strip())
conf=pathlib.Path('/opt/1panel/apps/openresty/openresty/conf/conf.d/aisbuild.129357.xyz.conf')
shutil.copyfile(backup/'original.conf',conf)
run(['docker','exec','1Panel-openresty-LykW','nginx','-t'])
run(['docker','exec','1Panel-openresty-LykW','nginx','-s','reload'])
print('ORIGINAL_ROUTE_RESTORED; old browser readiness pending',flush=True)
