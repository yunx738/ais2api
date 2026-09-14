from pathlib import Path
import datetime,shutil,subprocess
root=Path('/opt/ais2api/dual-runtime')
conf=Path('/opt/1panel/apps/openresty/openresty/conf/conf.d/aisbuild.129357.xyz.conf')
backup=root/('cutover-backup-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
backup.mkdir(mode=0o700)
shutil.copy2(conf,backup/'original.conf')
text=conf.read_text()
assert text.count('proxy_pass http://127.0.0.1:8889;')==1
maintenance=text.replace(' location / {\n proxy_pass http://127.0.0.1:8889;', ''' location / {
 add_header Retry-After 120 always;
 return 503 "Service upgrade in progress; retry shortly.";
 proxy_pass http://127.0.0.1:8889;''')
assert maintenance!=text
(backup/'maintenance.conf').write_text(maintenance)
(root/'cutover-backup-path').write_text(str(backup))
r=subprocess.run(['docker','exec','1Panel-openresty-LykW','nginx','-t'],capture_output=True,text=True)
print('CURRENT_NGINX_CONFIG_VALID',r.returncode==0)
if r.returncode:
    raise SystemExit('Existing nginx configuration check failed')
print('CUTOVER_BACKUP',backup)
print('Maintenance candidate prepared only; live configuration unchanged')
