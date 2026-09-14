from pathlib import Path
import subprocess,json,time,shutil
root=Path('/opt/ais2api/dual-runtime')
backup=Path((root/'cutover-backup-path').read_text().strip())
rollback=backup/'rollback.py'
s=rollback.read_text()
marker='for name in '
pos=s.index(marker)
if 'systemctl' not in s:
 s=s[:pos]+'''subprocess.run(['systemctl','kill','--signal=SIGKILL','ais2api-dual-coordinator'],capture_output=True,timeout=15)
'''+s[pos:]
 compile(s,str(rollback),'exec')
 rollback.write_text(s)
state=json.loads((root/'recovery-candidate-1789251999704.json').read_text())
assert all(until<=time.time()*1000 for _,until in state['pool']['cooldowns'])
ds=json.loads(subprocess.check_output(['docker','inspect','ais2api-dual-a','ais2api-dual-b'],text=True))
assert all(not d['State']['Running'] and d['State']['Pid']==0 for d in ds)
shutil.copy2(root/'state.json',root/('state.before-live-'+str(int(time.time()))+'.json'))
unit='ais2api-validation-rollback-'+str(int(time.time()))
subprocess.run(['systemd-run','--unit='+unit,'--on-active=10m','/usr/bin/python3',str(rollback)],check=True,capture_output=True)
(backup/'timer-unit').write_text(unit)
print('LIVE_ONCE_STARTED; watchdog armed',flush=True)
try:
 subprocess.run(['python3','/opt/ais2api/dual-stage/start-workers-safely.py'],check=True,timeout=240)
 state['dispatch']['halted']=False
 temp=root/'state.live-candidate.json'
 temp.write_text(json.dumps(state));temp.chmod(0o600)
 subprocess.run(['node','-e','const d=require(process.argv[1]).restore(process.argv[2]);d.checkpoint();','/opt/ais2api/dual-runtime/code/restore-dispatch.js',str(temp)],check=True,timeout=15)
 temp.replace(root/'state.json')
 subprocess.run(['systemctl','reset-failed','ais2api-dual-coordinator'],check=True)
 subprocess.run(['systemctl','start','ais2api-dual-coordinator'],check=True,timeout=20)
 time.sleep(4)
 subprocess.run(['python3','/opt/ais2api/dual-stage/test-live-concurrency.py'],check=True,timeout=180)
 ds=json.loads(subprocess.check_output(['docker','inspect','ais2api-dual-a','ais2api-dual-b'],text=True))
 assert all(d['State']['Running'] and not d['State']['OOMKilled'] for d in ds)
 print('LIVE_GENERATION_PASSED; maintenance retained; watchdog armed',flush=True)
except Exception as e:
 print('LIVE_VALIDATION_FAILED',type(e).__name__,flush=True)
 subprocess.run(['python3',str(rollback)],check=True,timeout=180)
 subprocess.run(['systemctl','stop',unit+'.timer'],check=True)
 print('ROLLED_BACK; readiness pending',flush=True)
