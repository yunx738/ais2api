import subprocess,re,pathlib
secrets=[]
for p in [pathlib.Path('/opt/ais2api/app.env'),*pathlib.Path('/opt/ais2api/dual-runtime/slots').glob('*/worker.env')]:
 for line in p.read_text().splitlines():
  if '=' in line:
   k,v=line.split('=',1)
   if any(x in k for x in ['KEY','TOKEN','PASSWORD','PROXY','SOCKS']):
    if v: secrets.append(v)
for name in ['ais2api-dual-a','ais2api-dual-b']:
 r=subprocess.run(['docker','logs','--tail','250',name],capture_output=True,text=True)
 print('CONTAINER',name)
 lines=[]
 for line in (r.stdout+r.stderr).splitlines():
  if not re.search(r'403|PERMISSION|denied|forbidden|错误|失败|quarant|operation_done|结束|取消',line,re.I): continue
  for secret in secrets: line=line.replace(secret,'[REDACTED]')
  line=re.sub(r'https?://\S+','[URL]',line)
  line=re.sub(r'[\w.+-]+@[\w.-]+','[EMAIL]',line)
  line=re.sub(r'(?i)(bearer\s+)\S+',r'\1[REDACTED]',line)
  line=re.sub(r'AIza[\w-]+','[KEY]',line)
  lines.append(line[:700])
 print('\n'.join(lines[-25:]))
