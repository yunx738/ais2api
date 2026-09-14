from pathlib import Path
import shutil,time
p=Path('/opt/ais2api/dual-stage/request-scheduler.js')
s=p.read_text()
old='''   let status;
   try{status=await this.client.waitReady(ticket.slot,ticket.account,15000);}catch{}'''
new='''   // Preserve upstream restrictions even when browser completion is uncertain.
   if(result && [401,403,429].includes(result.status)){
    const now=Date.now();
    if(result.status===429){
     const raw=result.retryAfter;
     const seconds=typeof raw==='string' && raw.trim()!==''?Number(raw):NaN;
     const date=typeof raw==='string'?Date.parse(raw):NaN;
     const until=Number.isFinite(seconds)?now+Math.max(60,seconds)*1000:
      Number.isFinite(date)?Math.max(now+60000,date):now+60000;
     this.dispatch.globalUntil=Math.max(this.dispatch.globalUntil,until);
     this.dispatch.pool.cooldown(ticket.account,until);
    }else{
     this.dispatch.pool.cooldown(ticket.account,now+86400000);
    }
    this.dispatch.checkpoint();
   }
   let status;
   try{status=await this.client.waitReady(ticket.slot,ticket.account,15000);}catch{}'''
assert s.count(old)==1
shutil.copy2(p,p.with_name('request-scheduler.before-cooldown-'+str(int(time.time()))+'.bak'))
p.write_text(s.replace(old,new,1))
print('PATCHED_STAGE_ONLY')
