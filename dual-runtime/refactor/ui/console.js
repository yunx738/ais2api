 'use strict';
const $=id=>document.getElementById(id);
const titles={overview:'运行总览',accounts:'账号管理',models:'模型目录',usage:'使用统计',history:'请求记录',settings:'运行设置'};
let state=null,reading=false,mutating=false,fresh=false,readTask=null,statusError=false;
let accountPage=1;
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n;}
function notice(message){$('notice').textContent=message;$('notice').hidden=!message;}
function date(value){return Number.isFinite(value)&&value>0?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';}
function navigate(){const name=location.hash.slice(1);const page=titles[name]?name:'overview';for(const key of Object.keys(titles))$(key).hidden=key!==page;document.querySelectorAll('[data-page]').forEach(a=>{a.classList.toggle('selected',a.dataset.page===page);if(a.dataset.page===page)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});$('page-title').textContent=titles[page];$('refresh').hidden=page==='usage'||page==='history';}
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
function accountState(a){return a.cooldownUntil>Date.now()?'cooling':a.owner?'assigned':'available';}
function renderAccountRows(d=state){
 if(!d)return;
 const query=$('quota-search').value.trim().toLowerCase(),status=$('account-status').value,size=Number($('account-page-size').value);
 const accounts=d.accounts.filter(a=>(!query||String(a.id).includes(query)||String(a.name||'').toLowerCase().includes(query))&&(status==='all'||accountState(a)===status));
 accountPage=Math.max(1,Math.min(accountPage,Math.ceil(accounts.length/size)||1));
 const rows=$('account-rows');rows.replaceChildren();
 for(const a of accounts.slice((accountPage-1)*size,accountPage*size)){
  const row=el('tr'),identity=el('td'),name=el('button',undefined,'account-name account-name-button'),text=el('div');
  name.type='button';name.setAttribute('aria-label','查看账号 '+a.id+' 的额度详情');name.addEventListener('click',()=>document.dispatchEvent(new CustomEvent('ais-account-details',{detail:{id:a.id}})));
  text.append(el('strong',a.name||'未命名'),el('small','账号 #'+a.id+(a.cooldownUntil>Date.now()?' · 冷却中':'')));name.append(el('span',String(a.name||a.id).slice(0,1).toUpperCase(),'avatar'),text);identity.append(name);row.append(identity,el('td',a.owner?'实例 '+a.owner:'—'));
  const quotaCell=el('td'),quotaBox=el('div',undefined,'account-model-quota'),models=Object.values(a.quota?.models||{}),known=models.filter(q=>!q.legacyBlocked&&Number.isFinite(q.used)&&Number.isFinite(q.limit)&&q.limit>0);
  quotaBox.append(el('span',models.length?models.length+' 个模型':'额度未配置'));
  if(known.length){const fraction=Math.max(0,Math.min(...known.map(q=>(q.limit-q.used)/q.limit))),bar=el('progress');bar.max=100;bar.value=fraction*100;bar.setAttribute('aria-label','最低已知本地剩余额度 '+Math.round(fraction*100)+'%');quotaBox.append(bar,el('small','最低已知余量 '+Math.round(fraction*100)+'%'));}
  else quotaBox.append(el('small',models.some(q=>q.legacyBlocked)?'历史用量待核实':'本地余量未知'));
  quotaCell.append(quotaBox);row.append(quotaCell);
  const statusCell=el('td'),kind=accountState(a);statusCell.append(el('span',kind==='cooling'?'冷却中':kind==='assigned'?'已分配':'可用','badge '+(kind==='cooling'?'warn':kind==='available'?'good':'')));row.append(statusCell,el('td',a.cooldownUntil>Date.now()?date(a.cooldownUntil):'—'));
  const actions=el('td'),details=el('button','详情','account-detail-button');details.type='button';details.setAttribute('aria-label','查看账号 '+a.id+' 的额度详情');details.addEventListener('click',()=>document.dispatchEvent(new CustomEvent('ais-account-details',{detail:{id:a.id}})));actions.append(details);row.append(actions);rows.append(row);
 }
 if(!accounts.length){const row=el('tr'),cell=el('td',d.accounts.length?'没有匹配的账号，请调整搜索或状态筛选':'账号池为空，导入后同步即可加入调度。','empty');cell.colSpan=6;row.append(cell);rows.append(row);}
 $('account-page').textContent=accounts.length?'显示 '+((accountPage-1)*size+1)+'–'+Math.min(accountPage*size,accounts.length)+' / 共 '+accounts.length+' 条':'共 0 条';
 $('account-prev').disabled=accountPage<=1;$('account-next').disabled=accountPage*size>=accounts.length;
 const summary=$('account-summary');summary.replaceChildren();
 for(const [key,title,count] of [['all','全部账号',d.accounts.length],['assigned','已分配',d.accounts.filter(a=>accountState(a)==='assigned').length],['available','可用账号',d.accounts.filter(a=>accountState(a)==='available').length],['cooling','冷却中',d.accounts.filter(a=>accountState(a)==='cooling').length]]){const box=el('article',undefined,'card summary-'+key);box.append(el('span',title),el('strong',count));summary.append(box);}
}
function render(d){
 const ready=Object.values(d.slots).filter(s=>s?.ready&&!s?.rotationBlocked&&!s?.healthCheck?.error).length;
 $('service').textContent=d.halted?'已暂停':ready===2?'运行正常':ready?'部分可用':'暂不可用';$('service').className=d.halted||ready<2?'warn':'good';
 $('service-note').textContent=d.halted?'协调器已停止分配请求':ready+' / 2 实例可调度';
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
  head.append(title,el('span',label,'badge '+(s.ready&&!s.healthCheck?.error?'good':'warn')));box.append(head);
   if(s.healthCheck?.error)box.append(el('p','健康检查异常 · 连续 '+(s.healthCheck.failureCount||1)+' 次失败','warn'));
   if(s.recoveryBlocked)box.append(el('p','实例恢复受阻，请检查实例服务与账号状态。','warn'));
   if(s.rotationFailure)box.append(el('p',s.rotationFailure.retryable?'账号轮换失败，将于 '+date(s.rotationFailure.retryAt)+' 重试':'账号轮换失败，需要检查实例登录与账号状态','warn'));
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
 renderAccountRows(d);
 const selected=$('target').value;$('target').replaceChildren(new Option('自动选择下一账号',''));
 for(const a of d.accounts){const option=new Option('#'+a.id+' · '+(a.name||'未命名'),String(a.id));option.disabled=!!a.owner||a.cooldownUntil>Date.now();$('target').add(option);}
 if([...$('target').options].some(o=>o.value===selected&&!o.disabled))$('target').value=selected;
}
function refresh(){
 if(reading)return readTask;
 reading=true;$('refresh').disabled=true;$('refresh').setAttribute('aria-busy','true');
 readTask=(async()=>{
  try{const d=await api('/api/status');if(typeof d.halted!=='boolean'||!Number.isInteger(d.queue)||!d.slots||!Array.isArray(d.accounts))throw Error('状态数据格式不完整');
   state=d;render(d);fresh=true;document.dispatchEvent(new CustomEvent('ais-status',{detail:d}));document.body.classList.remove('stale');$('updated').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN');
   if(statusError){notice('');statusError=false;}
  }catch(e){fresh=false;statusError=true;document.body.classList.add('stale');$('updated').textContent='状态已过期';notice('状态读取失败，已保留上次数据。'+e.message);}
  finally{reading=false;$('refresh').disabled=false;$('refresh').removeAttribute('aria-busy');controls();}
 })();return readTask;
}
async function action(path,body,message,format){
 if(mutating||!fresh)return;if(message&&!confirm(message))return;
 mutating=true;controls();try{const result=await api(path,body);if(readTask)await readTask;await refresh();notice(format(result));statusError=false;}catch(e){notice(e.message);}finally{mutating=false;controls();}
}
$('rotate').addEventListener('click',()=>{
 const slot=$('slot').value,s=state?.slots?.[slot];
 if(!s?.ready||s.active>0||s.operation||s.pending||s.rotationBlocked){notice('所选实例当前不满足安全轮换条件。');return;}
 const body={slot};if($('target').value)body.targetAccount=Number($('target').value);
 action('/api/rotate',body,'确认仅轮换实例 '+slot+' 的账号？该实例轮换期间暂停接收新请求。',r=>Array.isArray(r.started)&&r.started.includes(slot)?'实例 '+slot+' 已接受轮换，请观察状态确认完成。':'未启动轮换。'+JSON.stringify(r.skipped||r));
});
$('sync').addEventListener('click',()=>action('/api/sync-accounts',{},'将已导入的账号加入调度池？',r=>'账号同步返回，新增 '+(Array.isArray(r.added)?r.added.length:'未知')+' 个账号。'));
$('save-mode').addEventListener('click',()=>action('/api/set-mode',{mode:$('mode').value},'确认向 A / B 应用所选流模式？',r=>['A','B'].map(s=>'实例 '+s+' '+(r.results?.[s]||'未返回结果')).join('\n')));
$('refresh').addEventListener('click',()=>{refresh();document.dispatchEvent(new Event('ais-refresh'));});
for(const id of ['quota-search','account-status','account-page-size'])$(id).addEventListener(id==='quota-search'?'input':'change',()=>{accountPage=1;renderAccountRows();});
$('account-prev').addEventListener('click',()=>{accountPage--;renderAccountRows();});
$('account-next').addEventListener('click',()=>{accountPage++;renderAccountRows();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!mutating)refresh();});
$('theme').addEventListener('click',()=>{const dark=document.documentElement.classList.toggle('dark');try{localStorage.setItem('ais-theme',dark?'dark':'light');}catch{}});
try{const theme=localStorage.getItem('ais-theme');document.documentElement.classList.toggle('dark',theme==='dark'||(!theme&&matchMedia('(prefers-color-scheme: dark)').matches));}catch{}
addEventListener('hashchange',navigate);navigate();controls();refresh();
setInterval(()=>{if(!document.hidden&&!mutating)refresh();},5000);
