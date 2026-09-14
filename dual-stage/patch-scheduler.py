from pathlib import Path
p=Path('/opt/ais2api/dual-stage/request-scheduler.js')
s=p.read_text()
old='  this.credentials=credentials;this.queue=[];this.pumping=false;'
new=old+'''
  this.closed=false;
  this.wakeup=setInterval(()=>this.pump(),1000);
  this.wakeup.unref();
'''
assert old in s and 'this.wakeup=' not in s
s=s.replace(old,new,1)
s=s.replace(' submit(route,body,res){',''' close(){
  this.closed=true;
  clearInterval(this.wakeup);
  for(const item of [...this.queue]){
   item.remove();
   if(!item.res.destroyed){item.res.statusCode=503;item.res.end('Coordinator stopping');}
  }
 }
 submit(route,body,res){
  if(this.closed){res.statusCode=503;res.end('Coordinator stopping');return;}
''',1)
s=s.replace('  if(this.pumping)return;','  if(this.closed||this.pumping)return;',1)
p.write_text(s)
print('SCHEDULER_WAKEUP_AND_SHUTDOWN_PATCHED')
