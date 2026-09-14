import pathlib,subprocess,json,time,shutil
root=pathlib.Path('/opt/ais2api/dual-runtime')
backup=pathlib.Path((root/'cutover-backup-path').read_text().strip())
conf=pathlib.Path('/opt/1panel/apps/openresty/openresty/conf/conf.d/aisbuild.129357.xyz.conf')
def run(args,timeout=45):
    r=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
    if r.returncode:
        if args[0]=='node' and args[-1].endswith('verify-workers-ready.js'):
            print(r.stdout,flush=True)
        raise RuntimeError('Command failed: '+args[0]+' '+args[1])
    return r.stdout
def inspect(name):
    return json.loads(run(['docker','inspect',name]))[0]
def reload_config(source):
    shutil.copyfile(source,conf)
    run(['docker','exec','1Panel-openresty-LykW','nginx','-t'])
    run(['docker','exec','1Panel-openresty-LykW','nginx','-s','reload'])
def stop_checked(name):
    d=inspect(name)
    if d['State']['Running']:
        run(['docker','stop','--time','30',d['Id']],60)
    after=inspect(name)
    if after['Id']!=d['Id'] or after['State']['Running'] or after['State']['Pid']!=0:
        raise RuntimeError('Container stop not confirmed')
try:
    assert conf.read_bytes()==(backup/'original.conf').read_bytes()
    for name in ['ais2api-dual-a','ais2api-dual-b']:
        d=inspect(name)
        assert d['State']['Status'] in ['created','exited'] and d['State']['Pid']==0 and not d['State']['Running']
    reload_config(backup/'maintenance.conf')
    print('MAINTENANCE_ENABLED',flush=True)
    deadline=time.monotonic()+630
    quiet=0
    while time.monotonic()<deadline:
        active=run(['ss','-Htn','state','established','( sport = :8889 or dport = :8889 )'])
        quiet=quiet+1 if not active.strip() else 0
        if quiet>=5:
            break
        time.sleep(2)
    else:
        raise RuntimeError('Old connections did not drain')
    stop_checked('ais2api')
    print('OLD_INSTANCE_STOP_CONFIRMED',flush=True)
    for name in ['ais2api-dual-a','ais2api-dual-b']:
        run(['docker','start',name])
    result=run(['node','/opt/ais2api/dual-stage/verify-workers-ready.js'],210)
    print(result,flush=True)
    for name in ['ais2api-dual-a','ais2api-dual-b']:
        d=inspect(name)
        assert d['State']['Running'] and not d['State']['OOMKilled']
    (root/'workers-ready').write_text(str(time.time()))
    print('WORKERS_READY; maintenance retained for generation validation',flush=True)
except Exception as error:
    print('STARTUP_FAILED',type(error).__name__,flush=True)
    try:
        for name in ['ais2api-dual-a','ais2api-dual-b']:
            stop_checked(name)
        run(['docker','start','ais2api'])
        reload_config(backup/'original.conf')
        print('ROLLBACK_COMPLETE; old instance restarted; browser readiness requires verification',flush=True)
    except Exception:
        print('ROLLBACK_BLOCKED; closure uncertain; do not start overlapping accounts',flush=True)
    raise SystemExit(1)
