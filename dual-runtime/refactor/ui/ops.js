'use strict';
// 运维 page: host, services, containers, headless accounts, maintenance and logs. Uses /api/ops/* only.
(()=>{
const $=id=>document.getElementById(id);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined&&text!==null)n.textContent=String(text);if(cls)n.className=cls;return n;};
const gb=n=>n==null?'—':n>=1073741824?(n/1073741824).toFixed(1)+' GB':(n/1048576).toFixed(0)+' MB';
const ago=t=>{if(!t)return '—';const s=Math.max(0,(Date.now()-t)/1000);return s<90?Math.round(s)+' 秒':s<5400?Math.round(s/60)+' 分钟':s<172800?Math.round(s/3600)+' 小时':Math.round(s/86400)+' 天';};
const dur=s=>s<3600?Math.round(s/60)+' 分钟':s<172800?Math.round(s/3600)+' 小时':Math.round(s/86400)+' 天';
const clock=t=>t?new Date(t).toLocaleString('zh-CN',{hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
let token='',tokenTask=null;
async function getToken(force){
 if(token&&!force)return token;
 if(!tokenTask)tokenTask=(async()=>{const r=await fetch('/import',{credentials:'same-origin',redirect:'error',cache:'no-store'});const t=await r.text();
  const m=/name="import-token" content="([0-9a-f]{64})"/.exec(t)||/const token="([0-9a-f]{64})"/.exec(t);if(!m)throw Error('无法取得请求校验码，请刷新页面');token=m[1];return token;})().finally(()=>{tokenTask=null;});
 return tokenTask;
}
async function post(url,body,retry=true){
 const r=await fetch(url,{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json','X-Import-Token':await getToken(!retry)},body:JSON.stringify(body||{})});
 if(r.status===403&&retry)return post(url,body,false);
 const d=await r.json().catch(()=>({}));
 if(!r.ok)throw Error(d.error||(Array.isArray(d.skipped)&&d.skipped.map(x=>x&&x.reason).filter(Boolean).join('；'))||('操作失败（'+r.status+'）'));return d;
}
async function get(url){const r=await fetch(url,{credentials:'same-origin',redirect:'error',cache:'no-store'});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||('读取失败（'+r.status+'）'));return d;}
window.AisOps={post,get};
const say=(id,text,bad)=>{const n=$(id);if(!n)return;n.textContent=text||'';n.classList.toggle('bad',!!bad);};
async function act(button,fn,msgId,done){
 button.disabled=true;say(msgId,'处理中…');
 try{const r=await fn();say(msgId,done?done(r):'已完成');await load();}
 catch(e){say(msgId,e.message,true);}finally{button.disabled=false;}
}
function meter(used,total,label){
 const wrap=el('div',undefined,'ops-meter'),bar=el('div',undefined,'ops-meter-bar'),fill=el('i');
 const f=total?Math.max(0,Math.min(1,used/total)):0;fill.style.width=(f*100).toFixed(1)+'%';
 wrap.dataset.level=f>.9?'high':f>.75?'mid':'ok';bar.append(fill);
 wrap.append(el('span',label,'ops-meter-label'),bar);return wrap;
}
function renderHost(h){
 const box=$('ops-host');box.replaceChildren();
 const m=h.memory||{},d=h.disk;
 const cell=(name,value,extra)=>{const c=el('div',undefined,'ops-host-cell');c.append(el('span',name,'ops-k'),el('strong',value,'ops-v'));if(extra)c.append(extra);box.append(c);};
 cell('负载',h.load.map(x=>x.toFixed(2)).join(' / '),el('small',h.cpus+' 核 · 1/5/15 分钟','muted'));
 cell('内存',gb(m.total-m.available)+' / '+gb(m.total),meter(m.total-m.available,m.total,'可用 '+gb(m.available)));
 cell('Swap',gb(m.swapTotal-m.swapFree)+' / '+gb(m.swapTotal),meter(m.swapTotal-m.swapFree,m.swapTotal,''));
 if(d)cell('磁盘',gb(d.total-d.free)+' / '+gb(d.total),meter(d.total-d.free,d.total,'剩余 '+gb(d.free)));
 cell('运行时间',dur(h.uptime),el('small',h.hostname,'muted'));
}
const btn=(label,cls)=>{const b=el('button',label,'small'+(cls?' '+cls:''));b.type='button';return b;};
function renderUnits(units){
 const body=$('ops-units');body.replaceChildren();
 for(const u of units){
  const tr=el('tr'),ok=u.state==='active',starting=u.state==='activating';
  // In browser modes the no-browser service is stopped on purpose: show that as idle, not as a failure.
  const unused=u.key==='headless'&&!ok&&!starting&&u.state!=='failed'&&runMode&&runMode!=='headless';
  const name=el('td');name.append(el('strong',u.name),el('small',unused?'当前模式不使用':u.unit,'muted'));
  const st=el('td');st.append(el('span',ok?'运行中':starting?'启动中':u.state==='failed'?'已失败':'已停止','ops-pill '+(ok?'ok':starting?'warn':unused?'idle':'bad')));
  const mem=el('td');mem.append(!ok?el('span','—','muted'):u.memoryMax?meter(u.memory,u.memoryMax,gb(u.memory)+' / '+gb(u.memoryMax)):el('span',gb(u.memory)));
  const since=el('td',ok?ago(u.since):'—');
  const rs=el('td',u.restarts??'—');
  const op=el('td'),box=el('div',undefined,'ops-row-actions');op.append(box);
  if(u.key==='headless'){
   const running=ok||starting,b=btn(running?'停止':'启动',running?'ghost':'');
   b.addEventListener('click',()=>{
    const warn=running
     ?(runMode==='headless'?'停止无浏览器服务：现在是无浏览器模式，停止后所有请求都会失败，直到重新启动。继续？':'停止无浏览器服务？当前模式不使用它。')
     :(runMode==='headless'?'启动无浏览器服务？':'启动无浏览器服务：现在是浏览器模式，不会用到它，启动后只占内存。继续？');
    if(!confirm(warn))return;
    act(b,()=>post('/api/ops/unit',{unit:'headless',action:running?'stop':'start'}),'ops-units-msg',()=>'无浏览器服务已'+(running?'停止':'启动'));});
   box.append(b);
  }
  if(ok||u.key!=='headless'){
   const b=btn('重启');
   b.addEventListener('click',()=>{
    const warn=u.key==='coordinator'?'重启调度器：正在处理的请求会中断，约 5 秒后恢复。继续？':u.key==='headless'?'重启无浏览器服务：正在处理的请求会失败，约 10 秒后恢复。继续？':'重启登录服务：正在进行的登录会中断。继续？';
    if(!confirm(warn))return;
    act(b,()=>post('/api/ops/restart',{unit:u.key}),'ops-units-msg',r=>r.scheduled?u.name+' 将在 2 秒后重启':u.name+' 已重启');});
   box.append(b);
  }
  tr.append(name,st,mem,since,rs,op);body.append(tr);
 }
}
const CTR={'ais2api-dual-a':['浏览器实例 A','A'],'ais2api-dual-b':['浏览器实例 B','B'],'ais2api-dual-management':['管理后台',null]};
function renderContainers(list){
 const box=$('ops-containers');box.replaceChildren();
 for(const c of list){
  const [label,slot]=CTR[c.name]||[c.name,null],run=c.state==='running',row=el('div',undefined,'ops-ctr');
  const name=el('div',undefined,'ops-ctr-name');name.append(el('strong',label),el('small',c.status||(c.state==='missing'?'还没有创建':'—'),'muted'));
  const st=el('span',run?'运行中':c.state==='missing'?'不存在':'已停止','ops-pill '+(run?'ok':'idle'));
  const mem=el('div',undefined,'ops-ctr-mem');
  if(run&&c.memory!=null)mem.append(c.memoryMax?meter(c.memory,c.memoryMax,gb(c.memory)+' / '+gb(c.memoryMax)):el('span',gb(c.memory)));
  else mem.append(el('span',run?'读不到内存占用':'未占用内存','muted'));
  const ops=el('div',undefined,'ops-row-actions');
  if(slot){
   const lg=btn('日志','ghost');lg.setAttribute('aria-label','查看'+label+'的日志');
   lg.addEventListener('click',()=>{logPicked=true;selectLog('worker-'+slot.toLowerCase());$('ops-log-tabs').scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});});
   ops.append(lg);
   if(run){const rs=btn('重启');rs.setAttribute('aria-label','重启'+label);
    rs.addEventListener('click',()=>{if(!confirm('重启'+label+'：这个实例上正在处理的请求会中断，重新加载页面期间它不可用。继续？'))return;
     act(rs,()=>post('/api/restart',{slot}),'ops-units-msg',r=>Array.isArray(r.started)&&r.started.includes(slot)?label+' 正在重启':label+' 没有重启：'+((r.skipped||[]).map(x=>x.reason).filter(Boolean).join('；')||'原因未知'));});
    ops.append(rs);}
  }
  row.append(name,st,mem,ops);box.append(row);
 }
}
const MODE_NOTE={headless:'所有账号同时可用，不启动浏览器',dual:'实例 A、B 各承载一个账号，其余账号待命轮换',single:'只保留一个浏览器实例'};
function renderMode(o,bs){
 runMode=o.runMode||null;
 document.querySelectorAll('#ops-mode-seg button').forEach(b=>{b.setAttribute('aria-checked',String(b.dataset.mode===runMode));b.disabled=modeBusy||!runMode;});
 say('ops-mode-sub',MODE_NOTE[runMode]||'读不到当前运行模式');
 const sw=$('ops-build'),known=!!bs&&typeof bs.enabled==='boolean';
 if(!buildBusy){sw.disabled=!known;if(known)sw.checked=bs.enabled;}
 say('ops-build-text',!known?'读不到状态':bs.enabled?'已开启':'已关闭');
 if(!logPicked&&runMode&&runMode!=='headless'&&logSource==='headless')selectLog('coordinator');
}
// What the server's memory is spent on: this project's services and browser instances, everything else, and what is free.
function renderMem(o){
 const box=$('ops-mem');box.replaceChildren();const m=(o.host||{}).memory||{};if(!m.total)return;
 const parts=[];
 for(const u of o.units)if(u.state==='active'&&u.memory)parts.push([u.key==='coordinator'?'调度器':u.name,u.memory,u.key==='coordinator'?'c1':'c2']);
 for(const c of o.containers)if(c.memory){const x=CTR[c.name]||[c.name,null];parts.push([x[0],c.memory,x[1]==='B'?'c4':'c3']);}
 const mine=parts.reduce((n,p)=>n+p[1],0),used=Math.max(0,m.total-m.available);
 parts.push(['服务器上其他程序',Math.max(0,used-mine),'c5'],['可用',m.available,'c6']);
 const bar=el('div',undefined,'ops-mem-bar'),leg=el('div',undefined,'ops-mem-legend');
 bar.setAttribute('role','img');bar.setAttribute('aria-label','内存占用构成：'+parts.filter(p=>p[1]).map(p=>p[0]+' '+gb(p[1])).join('，'));
 for(const [name,n,cls] of parts){if(!n)continue;
  const s=el('i',undefined,cls);s.style.flexGrow=String(n);s.title=name+' '+gb(n);bar.append(s);
  const k=el('span',undefined,'ops-mem-key '+cls);k.append(el('i'),el('span',name),el('b',gb(n)));leg.append(k);}
 const head=el('div',undefined,'ops-mem-head');head.append(el('strong','本项目占用 '+gb(mine)),el('span','服务器内存 '+gb(m.total)+'，已用 '+gb(used),'muted'));
 box.append(head,bar,leg);
}
function renderAccounts(co){
 const box=$('ops-accounts'),cc=$('ops-cc');box.replaceChildren();
 if(!co||co.mode!=='headless'){$('ops-headless').hidden=true;return;}
 $('ops-headless').hidden=false;if(!cc.dataset.touched)cc.value=co.perAccount;
 say('ops-hl-sum','处理中 '+co.active+' · 排队 '+co.queue+(co.halted?' · 调度已停止':'')+(co.paused?' · 已暂停派发':''));
 paused=!!co.paused;const pb=$('ops-pause');pb.textContent=paused?'恢复派发':'暂停派发';pb.setAttribute('aria-pressed',String(paused));
 renderRunning(co.running||[]);
 co.impl=Array.isArray(co.groups)?'go':'node';streamMode=co.streamingMode||null;
 {const sb=$('ops-stream');if(sb){sb.hidden=!streamMode;sb.textContent='流模式：'+(streamMode==='fake'?'假流式':'真流式');sb.setAttribute('aria-pressed',String(streamMode==='fake'));}}
 if(co.groups&&co.groups.length)say('ops-hl-sum',$('ops-hl-sum').textContent+' · 分组 '+co.groups.join('、'));
 for(const a of co.accounts){
  const tr=el('tr',undefined,a.disabled?'is-off':''),now=Date.now(),cool=a.cooldownUntil>now;
  const id=el('td');id.append(el('strong','#'+a.id),el('small',a.email||'—','muted'));
  const st=el('td');st.append(el('span',a.flag==='invalid'?'登录失效':!a.imported?'未导入':a.disabled?(a.busy?'已停用 · 收尾 '+a.busy:'已停用'):cool?'冷却中':a.busy?'处理中 '+a.busy:'空闲','ops-pill '+(a.flag==='invalid'||!a.imported?'bad':a.disabled?'idle':cool?'warn':a.busy?'busy':'ok')));
  const tr0=tests.get(a.id);if(tr0)st.append(el('div',tr0.text,'ops-test '+(tr0.ok?'ok':'bad')));
  const cd=el('td');
  if(cool)cd.append(el('div','账号到 '+clock(a.cooldownUntil)));
  for(const m of a.modelCooldowns)cd.append(el('div',m.model+' 到 '+clock(m.until),'muted'));
  if(!cool&&!a.modelCooldowns.length)cd.textContent='—';
  const sc=el('td','','ops-sched');
  if(co.impl==='go'||Array.isArray(a.groups)){
   const g=(a.groups||[]).join('、');sc.append(el('div',(g?'分组 '+g:'无分组')+' · 优先级 '+(a.priority||0)));
   const eb=el('button','编辑','small ghost');eb.type='button';eb.title='设置这个账号的分组和优先级';
   eb.addEventListener('click',()=>{const gs=prompt('#'+a.id+' 的分组（多个用逗号或空格分开，留空清除）：',(a.groups||[]).join(','));if(gs===null)return;
    const ps=prompt('#'+a.id+' 的优先级（-100 到 100，数字大的先用，默认 0）：',String(a.priority||0));if(ps===null)return;const pr=Number(ps.trim()||'0');
    if(!Number.isInteger(pr)||pr<-100||pr>100){say('ops-hl-msg','优先级只能是 -100 到 100 的整数',true);return;}
    const groups=gs.split(/[,，、\s]+/).map(x=>x.trim()).filter(Boolean);
    act(eb,()=>post('/api/ops/account-schedule',{id:a.id,groups,priority:pr}),'ops-hl-msg',r=>'#'+a.id+' 已保存：'+(r.groups.length?'分组 '+r.groups.join('、'):'无分组')+' · 优先级 '+r.priority);});
   sc.append(eb);
  }else sc.textContent='—';
  const on=el('td'),sw=el('label',undefined,'ops-switch'),ck=el('input');ck.type='checkbox';ck.checked=!a.disabled;ck.setAttribute('aria-label','#'+a.id+' 参与派发');
  ck.addEventListener('change',()=>{const want=ck.checked;
   if(!want&&!confirm('停用 #'+a.id+'：新请求不再分给这个账号，正在处理的会继续完成。继续？')){ck.checked=true;return;}
   ck.disabled=true;say('ops-hl-msg','处理中…');
   post('/api/ops/account-enable',{id:a.id,enabled:want}).then(r=>{say('ops-hl-msg','#'+a.id+(r.enabled?' 已启用':' 已停用'));return load();}).catch(e=>{ck.checked=!want;say('ops-hl-msg',e.message,true);}).finally(()=>{ck.disabled=false;});});
  sw.append(ck,el('span',a.disabled?'停用':'启用'));on.append(sw);
  const op=el('td','','ops-row-actions');
  if(a.imported){const t=el('button','测试','small');t.type='button';t.title='用 flash 模型发一条很短的请求，检查这个账号能否正常回复（不计入额度）';
   t.addEventListener('click',async()=>{t.disabled=true;t.textContent='测试中…';say('ops-hl-msg','');
    try{const r=await post('/api/ops/test-account',{id:a.id});tests.set(a.id,{ok:r.ok,text:(r.ok?'正常':'失败')+' · '+r.model+' · '+(r.ms/1000).toFixed(1)+' 秒'+(r.ok?'':' · '+(r.error||r.status))});}
    catch(e){tests.set(a.id,{ok:false,text:'测试失败 · '+e.message});}
    finally{t.disabled=false;t.textContent='测试';load();}});op.append(t);}
  if(cool||a.modelCooldowns.length){const b=el('button','解除冷却','small');b.type='button';b.addEventListener('click',()=>act(b,()=>post('/api/ops/clear-cooldown',{id:a.id}),'ops-hl-msg',()=>'#'+a.id+' 已解除冷却'));op.append(b);}
  const r=el('button','清零额度','small ghost');r.type='button';
  r.addEventListener('click',()=>{const t=prompt('把 #'+a.id+' 今天已用次数清零（不影响 Google 那边的真实额度）。\n输入 RESET '+a.id+' 确认：');if(t===null)return;
   act(r,()=>post('/api/ops/reset-quota',{id:a.id,confirm:t.trim()}),'ops-hl-msg',x=>'#'+a.id+' 已清零 '+x.reset+' 个模型的计数');});
  op.append(r);tr.append(id,st,cd,sc,on,op);box.append(tr);
 }
}
function renderRunning(list){
 const box=$('ops-running');box.replaceChildren();
 if(!list.length){const tr=el('tr',undefined,'ops-empty-row'),td=el('td','当前没有正在处理的请求');td.colSpan=5;tr.append(td);box.append(tr);return;}
 for(const x of list.sort((a,b)=>a.createdAt-b.createdAt)){
  const tr=el('tr');const fam={flash:'Flash',pro:'Pro',ultra:'Ultra'}[x.kind]||x.kind||'';
  const m=el('td');m.append(el('span',x.model||'—'),el('small',fam+(x.phase&&x.phase!=='running'?' · '+x.phase:''),'muted'));
  const s=Math.max(0,Math.round((Date.now()-x.createdAt)/1000));
  const op=el('td');
  if(x.cancellable){const b=el('button','取消','small ghost');b.type='button';b.setAttribute('aria-label','取消请求 '+x.id.slice(0,8));
   b.addEventListener('click',()=>{if(!confirm('取消这个请求？客户端会收到中断。'))return;act(b,()=>post('/api/ops/cancel-request',{id:x.id}),'ops-hl-msg',()=>'已取消 '+x.id.slice(0,8));});op.append(b);}
  tr.append(el('td',x.id.slice(0,8),'ops-id'),el('td','#'+x.account),m,el('td',s<120?s+' 秒':Math.round(s/60)+' 分钟'),op);box.append(tr);
 }
}
function renderMaint(o){
 const v=o.version||{};
 say('ops-version',v.hash?(v.hash+' · '+clock(v.at)+' · '+v.subject+(v.dirty?' · 有 '+v.dirty+' 个未提交改动':'')):'—');
 const list=$('ops-backups');list.replaceChildren();
 for(const b of (o.backups||[]).slice(0,6))list.append(el('li',b.name+' · '+(b.size/1024).toFixed(0)+' KB · '+ago(b.at)+'前'));
 if(!(o.backups||[]).length)list.append(el('li','还没有备份','muted'));
}
let loading=false,paused=false,streamMode=null,runMode=null,modeBusy=false,buildBusy=false;const tests=new Map();
async function load(){
 if(loading||$('ops').hidden)return;loading=true;
 try{const [o,bs]=await Promise.all([get('/api/ops/overview'),get('/api/build/settings').catch(()=>null)]);
  renderMode(o,bs);renderHost(o.host);renderMem(o);renderUnits(o.units);renderContainers(o.containers);renderAccounts(o.coordinator);renderMaint(o);say('ops-updated','更新于 '+new Date(o.at).toLocaleTimeString('zh-CN',{hour12:false}));say('ops-error','');}
 catch(e){say('ops-error','运维数据读取失败：'+e.message,true);}finally{loading=false;}
}
// ---- logs ----
let logSource='headless',logTimer=null,logLines=[],logShown=[],logPicked=false;
function selectLog(src){logSource=src;document.querySelectorAll('#ops-log-tabs button').forEach(x=>x.setAttribute('aria-selected',String(x.dataset.src===src)));logLines=[];renderLogs();loadLogs();}
function renderLogs(){
 const box=$('ops-log'),q=$('ops-log-q').value.trim().toLowerCase(),lv=$('ops-log-level').value;
 const keep=l=>(lv==='all'||(lv==='warn'?['warn','error'].includes(l.level):l.level===lv))&&(!q||(l.msg+' '+l.source).toLowerCase().includes(q));
 const rows=logLines.filter(keep).slice(-400);logShown=rows;
 const atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<40;
 box.replaceChildren(...rows.map(l=>{const r=el('div',undefined,'ops-log-row lv-'+l.level);
  r.append(el('time',l.t?new Date(l.t).toLocaleTimeString('zh-CN',{hour12:false}):''),el('span',{error:'错误',warn:'警告',info:'信息',debug:'调试'}[l.level]||l.level,'lv'),el('span',l.source||'','src'),el('span',l.msg,'msg'));return r;}));
 if(!rows.length)box.append(el('div',logLines.length?'没有符合条件的日志':'暂无日志','ops-log-empty'));
 if(atBottom||$('ops-log-follow').checked)box.scrollTop=box.scrollHeight;
 say('ops-log-count',rows.length+' / '+logLines.length+' 行');
}
async function loadLogs(){
 if($('ops').hidden)return;
 try{const d=await get('/api/ops/logs?source='+logSource+'&n='+$('ops-log-n').value);logLines=d.lines||[];renderLogs();say('ops-log-msg','');}
 catch(e){say('ops-log-msg',e.message,true);}
}
function schedule(){clearInterval(logTimer);logTimer=null;if($('ops-log-auto').checked&&!$('ops').hidden)logTimer=setInterval(loadLogs,5000);}
function init(){
 if(!$('ops'))return;
 document.querySelectorAll('#ops-log-tabs button').forEach(b=>b.addEventListener('click',()=>{logPicked=true;selectLog(b.dataset.src);}));
 for(const id of ['ops-log-q','ops-log-level'])$(id).addEventListener('input',renderLogs);
 $('ops-log-n').addEventListener('change',loadLogs);$('ops-log-auto').addEventListener('change',schedule);
 $('ops-log-reload').addEventListener('click',loadLogs);
 $('ops-cc').addEventListener('input',()=>{$('ops-cc').dataset.touched='1';});
 $('ops-cc-save').addEventListener('click',e=>{const n=Number($('ops-cc').value);if(!Number.isInteger(n)||n<1||n>10){say('ops-hl-msg','并发数只能是 1 到 10 的整数',true);return;}
  act(e.currentTarget,()=>post('/api/ops/headless-concurrency',{perAccount:n}),'ops-hl-msg',r=>{delete $('ops-cc').dataset.touched;return '每个账号最多同时处理 '+r.perAccount+' 个请求';});});
 $('ops-stream')?.addEventListener('click',e=>{const next=streamMode==='fake'?'real':'fake';
  if(!confirm(next==='fake'?'切换为假流式：流式请求会等上游完整生成后再一次性按流式格式发出，等待期间保持连接。继续？':'切换为真流式：上游边生成边发送。继续？'))return;
  act(e.currentTarget,()=>post('/api/ops/stream-mode',{mode:next}),'ops-hl-msg',r=>'流模式已切换为'+(r.mode==='fake'?'假流式':'真流式'));});
 $('ops-pause').addEventListener('click',e=>{const next=!paused;
  if(next&&!confirm('暂停派发：新请求会排队等待（最长 2 分钟后超时），正在处理的请求不受影响。继续？'))return;
  act(e.currentTarget,()=>post('/api/ops/pause',{paused:next}),'ops-hl-msg',r=>r.paused?'已暂停派发，新请求排队等待':'已恢复派发');});
 $('ops-backup').addEventListener('click',e=>act(e.currentTarget,()=>post('/api/ops/backup'),'ops-maint-msg',r=>'已备份：'+r.name));
 $('ops-writeback').addEventListener('click',e=>act(e.currentTarget,()=>post('/api/ops/write-back'),'ops-maint-msg',r=>r.written?.length?'已写回 '+r.written.length+' 个账号：'+r.written.join('、'):'没有需要写回的 Cookie'));
 $('ops-sync').addEventListener('click',e=>act(e.currentTarget,()=>post('/api/sync-accounts'),'ops-maint-msg',r=>'同步完成'+(r.added?.length?'，新增 '+r.added.join('、'):'')+(r.removed?.length?'，移除 '+r.removed.join('、'):'')));
 $('ops-refresh').addEventListener('click',()=>{load();loadLogs();});
 document.querySelectorAll('#ops-mode-seg button').forEach(b=>b.addEventListener('click',async()=>{
  const next=b.dataset.mode,cur=runMode;if(!cur||next===cur||modeBusy)return;
  const restart=next==='headless'||cur==='headless';
  const what={headless:'切到无浏览器模式：停止浏览器实例，启动无浏览器服务，所有账号同时可用。',
   dual:'切到双浏览器模式：'+(restart?'停止无浏览器服务，':'')+'启动实例 A、B。'+(restart?'浏览器要重新打开页面，大约 2 到 3 分钟后才能处理请求。':''),
   single:'切到单浏览器模式：'+(restart?'停止无浏览器服务，':'')+'只保留一个浏览器实例。'+(restart?'浏览器要重新打开页面，大约 2 到 3 分钟后才能处理请求。':'')}[next];
  if(!confirm(what+(restart?'\n调度器会在当前请求完成后重启。':'')+'\n继续？'))return;
  modeBusy=true;document.querySelectorAll('#ops-mode-seg button').forEach(x=>{x.disabled=true;});say('ops-mode-msg','正在切换…');
  try{await post('/api/run-mode',{mode:next});
   say('ops-mode-msg','已切换到'+b.textContent+'模式'+(restart?'，调度器正在重启，这个页面会短暂读不到数据':''));
   for(const t of [3000,9000,20000,45000])setTimeout(load,t);}
  catch(e){say('ops-mode-msg','切换失败：'+e.message,true);}
  finally{setTimeout(()=>{modeBusy=false;load();},restart?9000:1500);}
 }));
 $('ops-build').addEventListener('change',async e=>{const sw=e.currentTarget,want=sw.checked;
  if(!want&&!confirm('关闭 Build 通道：build/、build-st/、bridge/、code/ 开头的模型会立即返回错误，也不再自动新建或轮换项目。普通模型不受影响。继续？')){sw.checked=true;return;}
  buildBusy=true;sw.disabled=true;say('ops-mode-msg','处理中…');
  try{const r=await post('/api/build/settings',{enabled:want});
   if(typeof r.enabled!=='boolean')throw Error('当前调度器版本没有这个开关');
   say('ops-mode-msg',r.enabled?'Build 通道已开启':'Build 通道已关闭');}
  catch(err){sw.checked=!want;say('ops-mode-msg','Build 通道没有改动：'+err.message,true);}
  finally{buildBusy=false;load();}});
 $('ops-log-copy').addEventListener('click',async()=>{
  if(!logShown.length){say('ops-log-msg','没有可复制的日志',true);return;}
  const t=logShown.map(l=>(l.t?new Date(l.t).toLocaleString('zh-CN',{hour12:false}):'')+' ['+l.level+'] '+(l.source?l.source+' ':'')+l.msg).join('\n');
  try{if(navigator.clipboard&&isSecureContext)await navigator.clipboard.writeText(t);
   else{const a=document.createElement('textarea');a.value=t;a.setAttribute('readonly','');a.style.position='fixed';a.style.opacity='0';document.body.append(a);a.select();const ok=document.execCommand('copy');a.remove();if(!ok)throw Error('浏览器不允许复制');}
   say('ops-log-msg','已复制 '+logShown.length+' 行');}
  catch(err){say('ops-log-msg','复制失败：'+err.message,true);}});
 const onShow=()=>{if(!$('ops').hidden){load();loadLogs();schedule();}else schedule();};
 addEventListener('hashchange',()=>setTimeout(onShow,0));setTimeout(onShow,0);
 setInterval(load,15000);
}
let hlPaused=false,hlBusy=false;
async function hlLoad(){const box=$('hl-ops');if(!box||hlBusy||!document.body.classList.contains('mode-headless')||$('overview').hidden)return;hlBusy=true;
 try{const co=(await get('/api/ops/overview')).coordinator;if(!co||co.mode!=='headless')return;hlPaused=!!co.paused;
  const off=co.accounts.filter(a=>a.disabled).length;
  say('hl-ops-state',(co.paused?'已暂停派发':'正常派发')+' · 处理中 '+co.active+' · 排队 '+co.queue+(off?' · 停用账号 '+off:''));
  const b=$('hl-pause');b.textContent=hlPaused?'恢复派发':'暂停派发';b.setAttribute('aria-pressed',String(hlPaused));}
 catch(e){say('hl-ops-state','读取失败：'+e.message,true);}finally{hlBusy=false;}}
function hlInit(){const b=$('hl-pause');if(!b)return;
 b.addEventListener('click',async()=>{const next=!hlPaused;if(next&&!confirm('暂停派发：新请求会排队等待（最长 2 分钟后超时），正在处理的请求不受影响。继续？'))return;
  b.disabled=true;say('hl-ops-msg','处理中…');try{const r=await post('/api/ops/pause',{paused:next});say('hl-ops-msg',r.paused?'已暂停派发':'已恢复派发');}catch(e){say('hl-ops-msg',e.message,true);}finally{b.disabled=false;hlLoad();}});
 document.addEventListener('ais-status',()=>setTimeout(hlLoad,0));addEventListener('hashchange',()=>setTimeout(hlLoad,0));setInterval(hlLoad,15000);}
const boot=()=>{init();hlInit();};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
