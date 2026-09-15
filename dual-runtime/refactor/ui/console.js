 'use strict';
const $=id=>document.getElementById(id);
const titles={overview:'运行总览',accounts:'实例与账号',models:'模型目录',usage:'使用统计',history:'请求记录',settings:'运行设置'};
let state=null,reading=false,mutating=false,fresh=false;
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n;}
function notice(message){$('notice').textContent=message;$('notice').hidden=!message;}
function date(value){return Number.isFinite(value)&&value>0?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';}
function navigate(){const name=location.hash.slice(1);const page=titles[name]?name:'overview';for(const key of Object.keys(titles))$(key).hidden=key!==page;document.querySelectorAll('[data-page]').forEach(a=>{a.classList.toggle('selected',a.dataset.page===page);if(a.dataset.page===page)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});$('page-title').textContent=titles[page];}
function controls(){for(const id of ['sync','rotate','save-mode'])$(id).disabled=mutating||!fresh;}
async function api(path,body){
 const c=new AbortController(),timer=setTimeout(()=>c.abort(),body===undefined?10000:65000);
 try{const options={credentials:'same-origin',redirect:'error',signal:c.signal,headers:{Accept:'application/json'}};if(body!==undefined){options.method='POST';options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
 const r=await fetch(path,options);
 if(r.status===401||r.status===403)throw Error('登录状态已失效，请重新登录');
 if(!(r.headers.get('content-type')||'').includes('application/json'))throw Error('接口未返回 JSON，请检查登录状态');
 const d=await r.json();if(!r.ok)throw Error(typeof d.error==='string'?d.error:'接口请求失败');return d;
 }catch(e){if(e.name==='AbortError')throw Error('请求超时，操作可能仍在执行，请刷新核实后再操作');throw e;}finally{clearTimeout(timer);}
}
function render(d){
 $('service').textContent=d.halted?'Halted':'Running';$('service').className=d.halted?'warn':'good';
 $('service-note').textContent=d.halted?'协调器已停止分配请求':'仍需查看各实例状态';
 $('queued').textContent=d.queue;$('account-count').textContent=d.accounts.length;
 $('active').textContent=Object.values(d.slots).reduce((n,s)=>n+(s.active||0),0);
 $('mode-current').textContent=d.streamingMode||'unknown';
 const workers=$('workers');workers.replaceChildren();
 for(const slot of ['A','B']){
  const s=d.slots[slot];if(!s){workers.append(el('article','实例 '+slot+' 状态缺失','card empty'));continue;}
  const box=el('article',undefined,'card worker'),head=el('div',undefined,'worker-head');
  const title=el('div');title.append(el('h2','实例 '+slot),el('small','账号 #'+(s.account??'—'),'muted'));
  const health=s.workerHealth,healthFresh=health?.account===s.account && health?.workerEpoch===s.workerEpoch && Date.now()-health.observedAt<15000;
   const pending=(s.pendingExecutions||[]).filter(t=>t.phase==="reconciling").length;
   const label=s.legacyUnresolved?"历史请求待核实":healthFresh && health.hardQuarantine?"严重故障，已隔离":
    healthFresh && health.pendingCompletions>0?"等待浏览器完成回执":pending?"请求完成待核实":s.pendingRetirements?"完成记录清理待确认":s.operation?({catalog:'模型同步',rotation:'账号轮换',recovery:'安全恢复'}[s.operation.kind]||'实例操作中'):s.rotationBlocked?'轮换受阻':s.pending?'轮换中':s.ready?(s.active?'请求处理中':'已就绪'):'未就绪';
  head.append(title,el('span',label,'badge '+(s.ready?'good':'warn')));box.append(head);
   if(!healthFresh)box.append(el("p","浏览器健康状态未更新，不代表当前已恢复","muted"));
   if(s.pendingRetirements)box.append(el("p",s.pendingRetirements+" 个请求已结算，等待清理确认；暂不轮换账号","warn"));
   if(pending)box.append(el("p",pending+" 个请求保留占用，等待完成证据","warn"));
  const quotas=Object.values(s.quota?.models||{});
  if(!s.quota)box.append(el('p','额度状态不可用，不代表剩余额度为零或已恢复','warn'));
  else if(!quotas.length)box.append(el('p','尚未配置模型额度策略','muted'));
  for(const item of quotas){
   const q=el('div',undefined,'quota'),line=el('div',undefined,'quota-label'),p=el('progress');
   line.append(el('span',item.model),el('span',item.legacyBlocked?'历史用量待核实':item.used+' / '+item.limit));
   p.max=item.limit;p.value=Math.min(item.used,item.limit);
   p.setAttribute('aria-label',item.model+' 已记录用量 '+item.used+' 次');
   q.append(line);
   if(!item.legacyBlocked)q.append(p);
   if(item.legacyBlocked)q.append(el('small','暂不可派单；历史窗口截止 '+date(item.legacyUntil),'warn'));
   else if(item.cooldownUntil>Date.now())q.append(el('small','模型冷却至 '+date(item.cooldownUntil),'warn'));
   else q.append(el('small',item.windowEnd?'账号窗口结束 '+date(item.windowEnd):'窗口未启用','muted'));
   box.append(q);
  }
  if(s.quota?.legacy)box.append(el('p','保留历史汇总证据；未将无法归属的用量伪装成模型精确计数。','muted'));
  box.append(el('div','调度占用 '+(s.active??0)+' · 每账号、每模型独立额度','worker-foot'));workers.append(box);
 }
 const rows=$('account-rows');rows.replaceChildren();const selected=$('target').value;$('target').replaceChildren(new Option('自动选择下一账号',''));
 for(const a of d.accounts){
  const cooling=a.cooldownUntil>Date.now(),row=el('tr');
  for(const value of ['#'+a.id,a.name||'未命名',a.owner||'—',a.owner?'已分配':cooling?'冷却中':'可用',date(a.cooldownUntil)])row.append(el('td',value));
  rows.append(row);const option=new Option('#'+a.id+' · '+(a.name||'未命名'),String(a.id));option.disabled=!!a.owner||cooling;$('target').add(option);
 }
 if(!d.accounts.length){const row=el('tr'),cell=el('td','调度池暂无账号');cell.colSpan=5;row.append(cell);rows.append(row);}
 if([...$('target').options].some(o=>o.value===selected&&!o.disabled))$('target').value=selected;
}
async function refresh(){
 if(reading)return;reading=true;$('refresh').disabled=true;
 try{const d=await api('/api/status');if(typeof d.halted!=='boolean'||!Number.isInteger(d.queue)||!d.slots||!Array.isArray(d.accounts))throw Error('状态数据格式不完整');
 render(d);state=d;fresh=true;document.dispatchEvent(new CustomEvent('ais-status',{detail:d}));document.body.classList.remove('stale');$('updated').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN');
 }catch(e){fresh=false;document.body.classList.add('stale');$('updated').textContent='状态已过期';notice('状态读取失败。保留的旧数据不代表当前状态。\n'+e.message+'；可访问 /login 重新登录。');}
 finally{reading=false;$('refresh').disabled=false;controls();}
}
async function action(path,body,message,format){
 if(mutating||!fresh)return;if(message&&!confirm(message))return;
 mutating=true;controls();try{const result=await api(path,body);notice(format(result));await refresh();}catch(e){notice(e.message);}finally{mutating=false;controls();}
}
$('rotate').addEventListener('click',()=>{
 const slot=$('slot').value,s=state?.slots?.[slot];
 if(!s?.ready||s.active>0||s.operation||s.pending||s.rotationBlocked){notice('所选实例当前不满足安全轮换条件。');return;}
 const body={slot};if($('target').value)body.targetAccount=Number($('target').value);
 action('/api/rotate',body,'确认仅轮换实例 '+slot+' 的账号？该实例轮换期间暂停接收新请求。',r=>Array.isArray(r.started)&&r.started.includes(slot)?'实例 '+slot+' 已接受轮换，请观察状态确认完成。':'未启动轮换。'+JSON.stringify(r.skipped||r));
});
$('sync').addEventListener('click',()=>action('/api/sync-accounts',{},'将已导入的账号加入调度池？',r=>'账号同步返回，新增 '+(Array.isArray(r.added)?r.added.length:'未知')+' 个账号。'));
$('save-mode').addEventListener('click',()=>action('/api/set-mode',{mode:$('mode').value},'确认向 A / B 应用所选流模式？',r=>['A','B'].map(s=>'实例 '+s+' '+(r.results?.[s]||'未返回结果')).join('\n')));
$('refresh').addEventListener('click',refresh);
$('theme').addEventListener('click',()=>{const dark=document.documentElement.classList.toggle('dark');try{localStorage.setItem('ais-theme',dark?'dark':'light');}catch{}});
try{const theme=localStorage.getItem('ais-theme');document.documentElement.classList.toggle('dark',theme==='dark'||(!theme&&matchMedia('(prefers-color-scheme: dark)').matches));}catch{}
addEventListener('hashchange',navigate);navigate();controls();refresh();
setInterval(()=>{if(!document.hidden&&!mutating)refresh();},5000);
