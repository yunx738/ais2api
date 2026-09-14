from pathlib import Path
import subprocess,json,time,urllib.request,urllib.error
root=Path('/opt/ais2api/dual-runtime')
backup=Path((root/'cutover-backup-path').read_text().strip())
conf=Path('/opt/1panel/apps/openresty/openresty/conf/conf.d/aisbuild.129357.xyz.conf')
cfg=json.loads((root/'coordinator.json').read_text())
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
result=root/'cutover-final-result.json'
def run(args,timeout=40):
 return subprocess.run(args,check=True,capture_output=True,text=True,timeout=timeout).stdout
def status(base):
 req=urllib.request.Request(base+'/internal/coordinator-status',headers={'Authorization':'Bearer '+cfg['apiKeys'][0]})
 with op.open(req,timeout=10) as r:return json.load(r)
def healthy(s):
 return not s['halted'] and all(x['ready'] and not x['busy'] for x in s['slots'].values())
unit='ais2api-final-watchdog-'+str(int(time.time()))
phase='preflight'
try:
 report=json.loads((root/'concurrency-validation.json').read_text())
 assert report['observed_browser_overlap'] and all(x['status']==200 and x['valid_content'] for x in report['results'])
 state=json.loads((root/'state.json').read_text())
 assert all(not s['busy'] for _,s in state['dispatch']['slots'])
 run(['systemd-run','--unit='+unit,'--on-active=10m','/usr/bin/python3',str(backup/'rollback.py')])
 phase='workers'
 print(phase,flush=True)
 print(run(['python3','/opt/ais2api/dual-stage/start-workers-safely.py'],240),flush=True)
 phase='coordinator'
 run(['systemctl','reset-failed','ais2api-dual-coordinator'])
 run(['systemctl','start','ais2api-dual-coordinator'])
 for i in range(20):
  try:
   if healthy(status('http://127.0.0.1:8890')):break
  except Exception:pass
  time.sleep(2)
 else:raise RuntimeError('Local readiness timeout')
 phase='nginx'
 text=(backup/'original.conf').read_text()
 assert text.count('proxy_pass http://127.0.0.1:8889;')==1
 conf.write_text(text.replace('proxy_pass http://127.0.0.1:8889;','proxy_pass http://127.0.0.1:8890;'))
 run(['docker','exec','1Panel-openresty-LykW','nginx','-t'])
 run(['docker','exec','1Panel-openresty-LykW','nginx','-s','reload'])
 phase='public-verification'
 success=0
 for i in range(20):
  try:
   s=status('https://aisbuild.129357.xyz')
   success=success+1 if healthy(s) else 0
   if success>=3:break
  except Exception as e:
   success=0
   print('PUBLIC_CHECK',type(e).__name__,getattr(e,'code',0),flush=True)
  time.sleep(3)
 else:raise RuntimeError('Public readiness timeout')
 ds=json.loads(run(['docker','inspect','ais2api','ais2api-dual-a','ais2api-dual-b']))
 assert not ds[0]['State']['Running']
 assert all(d['State']['Running'] and not d['State']['OOMKilled'] for d in ds[1:])
 run(['systemctl','stop',unit+'.timer'])
 result.write_text(json.dumps({'success':True,'status':s,'time':time.time()}))
 result.chmod(0o600)
 print('PUBLIC_DUAL_VERIFIED',flush=True)
except Exception as e:
 print('FAILED_PHASE',phase,type(e).__name__,getattr(e,'code',0),flush=True)
 try:
  print(run(['python3',str(backup/'rollback.py')],180),flush=True)
  subprocess.run(['systemctl','stop',unit+'.timer'],capture_output=True)
  rolled=True
 except Exception:rolled=False
 result.write_text(json.dumps({'success':False,'phase':phase,'errorType':type(e).__name__,'rolledBack':rolled,'time':time.time()}))
 result.chmod(0o600)
