 'use strict';
const $=id=>document.getElementById(id);
const titles={overview:'仪表盘',accounts:'账号管理',models:'模型目录',usage:'使用统计',history:'请求记录',settings:'系统运维'};
let state=null,reading=false,mutating=false,fresh=false,readTask=null,statusError=false;
let accountPage=1;
const accountColumns=['账号','实例','模型额度','状态','冷却结束','操作'];
const hiddenAccountColumns=new Set();
try{const saved=JSON.parse(localStorage.getItem('ais-account-columns')||'[]');if(Array.isArray(saved))for(const index of saved)if([1,2,3,4].includes(index))hiddenAccountColumns.add(index);}catch{}
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n;}
function consoleIcon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS('http://www.w3.org/2000/svg','use');svg.classList.add('icon');svg.setAttribute('aria-hidden','true');use.setAttribute('href','#i-'+name);svg.append(use);return svg;}
function statusBadge(label,tone=''){const badge=el('span',undefined,'badge '+tone);badge.append(el('i',undefined,'status-dot'),document.createTextNode(label));return badge;}
function openAccount(id){document.dispatchEvent(new CustomEvent('ais-account-details',{detail:{id}}));}
function quotaFraction(q){return !q?.legacyBlocked&&Number.isFinite(q?.used)&&Number.isFinite(q?.limit)&&q.limit>0?Math.max(0,Math.min(1,(q.limit-q.used)/q.limit)):null;}
function quotaTone(fraction){return fraction===null?'unknown':fraction<=.1?'low':fraction<=.25?'limited':'healthy';}
function applyAccountColumns(){
 document.querySelectorAll('.account-table tr').forEach(row=>{if(row.children.length===6)[...row.children].forEach((cell,index)=>{cell.hidden=hiddenAccountColumns.has(index);});else if(row.children[0])row.children[0].colSpan=6-hiddenAccountColumns.size;});
 const table=document.querySelector('.account-table');if(table)table.style.minWidth=hiddenAccountColumns.size?[220,90,170,90,130,50].reduce((total,width,index)=>total+(hiddenAccountColumns.has(index)?0:width),0)+'px':'';
 if($('account-columns-count'))$('account-columns-count').textContent=(6-hiddenAccountColumns.size)+'/6';
}
function setupAccountColumns(){
 const toolbar=document.querySelector('.account-toolbar');if(!toolbar)return;
 const details=el('details',undefined,'column-control'),summary=el('summary'),count=el('span',undefined,'column-count');
 count.id='account-columns-count';summary.append(consoleIcon('columns'),document.createTextNode('列设置'),count);
 const options=el('div',undefined,'column-options');options.append(el('strong','显示列'));
 accountColumns.forEach((name,index)=>{const label=el('label'),input=el('input');input.type='checkbox';input.checked=!hiddenAccountColumns.has(index);input.disabled=index===0||index===5;
  input.addEventListener('change',()=>{if(input.checked)hiddenAccountColumns.delete(index);else hiddenAccountColumns.add(index);try{localStorage.setItem('ais-account-columns',JSON.stringify([...hiddenAccountColumns]));}catch{}applyAccountColumns();});label.append(input,document.createTextNode(name));options.append(label);});
 details.append(summary,options);toolbar.append(details);applyAccountColumns();
 document.addEventListener('click',event=>{if(!details.contains(event.target))details.open=false;});details.addEventListener('keydown',event=>{if(event.key==='Escape'){details.open=false;summary.focus();}});
}
function notice(message){$('notice').textContent=message;$('notice').hidden=!message;}
function date(value){return Number.isFinite(value)&&value>0?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';}
function navigate(){const name=location.hash.slice(1);const page=titles[name]?name:'overview';for(const key of Object.keys(titles))$(key).hidden=key!==page;document.querySelectorAll('[data-page]').forEach(a=>{a.classList.toggle('selected',a.dataset.page===page);if(a.dataset.page===page)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});$('page-title').textContent=titles[page];$('refresh').hidden=page==='usage'||page==='history';if(page==='overview')loadOverviewUsage();}
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
let overviewUsageRead=null,overviewUsageReadAt=0,overviewUsageDay=0;
const overviewMetrics=[['今日请求','requests','chart'],['已知 Token','tokens','model'],['估算费用','cost','dollar'],['RPM','rpm','clock'],['已知 TPM','tpm','zap'],['平均耗时','duration','activity']];
function overviewUsagePanel(){
 let panel=$('overview-usage');if(panel)return panel;
 panel=el('article',undefined,'card overview-usage');panel.id='overview-usage';const head=el('div',undefined,'overview-usage-head'),title=el('div'),link=el('a','查看统计 →');link.href='#usage';title.append(el('h2','使用统计'),el('span','今日 · 浏览器本地时间','muted'));head.append(title,link);
 const metrics=el('div',undefined,'overview-usage-grid');for(const [title,key,icon] of overviewMetrics){const item=el('div',undefined,'overview-metric overview-metric-'+key),mark=el('span',undefined,'overview-metric-icon'),copy=el('div'),value=el('strong','—');mark.append(consoleIcon(icon));value.id='overview-'+key;copy.append(el('span',title),value);item.append(mark,copy);metrics.append(item);}
 const note=el('p','正在读取今日数据…','overview-usage-note');note.id='overview-usage-note';note.setAttribute('role','status');panel.append(head,metrics,note);document.querySelector('#overview>.stats').after(panel);return panel;
}
async function loadOverviewUsage(force=false){
 if($('overview').hidden)return;
 const panel=overviewUsagePanel(),now=Date.now(),today=new Date();today.setHours(0,0,0,0);const from=today.getTime();
 if(overviewUsageRead)return overviewUsageRead;
 if(!force&&overviewUsageDay===from&&now-overviewUsageReadAt<30000)return;
 overviewUsageReadAt=now;overviewUsageDay=from;panel.setAttribute('aria-busy','true');
 const compact=value=>Number.isFinite(value)?value.toLocaleString('en-US',{notation:value>=1000?'compact':'standard',maximumFractionDigits:1}):'未知';
 overviewUsageRead=(async()=>{
  try{
   const d=await api('/api/usage?'+new URLSearchParams({from:String(from),to:String(now)}));
   if(!Number.isSafeInteger(d.requests)||!Array.isArray(d.models))throw Error('统计数据格式不完整');
   const values={requests:compact(d.requests),tokens:d.tokenKnownRequests>0?compact(d.knownTokenTotal):'未知',cost:d.pricedRequests>0&&Number.isFinite(d.estimatedCostKnownSubtotal)?'$'+d.estimatedCostKnownSubtotal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'未知',rpm:compact(d.rpm),tpm:compact(d.tpmKnown),duration:Number.isFinite(d.averageDurationMs)?(d.averageDurationMs>=1000?(d.averageDurationMs/1000).toLocaleString('en-US',{maximumFractionDigits:1})+'s':Math.round(d.averageDurationMs)+'ms'):'未知'};
   for(const [,key] of overviewMetrics)$('overview-'+key).textContent=values[key];
   const health=d.recording?.history||d.health,recordingIssue=health?.degraded||health?.ready===false||(d.recording?.beginFailures||0)+(d.recording?.finishFailures||0)>0;
   $('overview-usage-note').textContent=recordingIssue?'记录系统存在异常，统计可能不完整':'仅计已记录请求 · Token 与费用仅汇总已知部分';panel.classList.remove('overview-usage-unavailable');
  }catch(error){for(const [,key] of overviewMetrics)$('overview-'+key).textContent='未获取';$('overview-usage-note').textContent='统计暂不可用 · '+error.message;panel.classList.add('overview-usage-unavailable');}
  finally{panel.removeAttribute('aria-busy');overviewUsageRead=null;}
 })();return overviewUsageRead;
}
function renderAccountRows(d=state){
 if(!d)return;
 const query=$('quota-search').value.trim().toLowerCase(),status=$('account-status').value,size=Number($('account-page-size').value);
 const accounts=d.accounts.filter(a=>(!query||String(a.id).includes(query)||String(a.name||'').toLowerCase().includes(query))&&(status==='all'||accountState(a)===status));
 accountPage=Math.max(1,Math.min(accountPage,Math.ceil(accounts.length/size)||1));
 const rows=$('account-rows');rows.replaceChildren();
 for(const a of accounts.slice((accountPage-1)*size,accountPage*size)){
  const row=el('tr'),identity=el('td'),name=el('button',undefined,'account-name account-name-button'),text=el('div',undefined,'account-identity');
  name.type='button';name.setAttribute('aria-label','查看账号 '+a.id+' 的额度详情');name.addEventListener('click',()=>openAccount(a.id));
  const nameLine=el('div',undefined,'account-title-line');nameLine.append(el('strong',a.name||'未命名账号'));
  text.append(nameLine,el('small','账号 #'+a.id));name.append(el('span',String(a.name||a.id).slice(0,1).toUpperCase(),'avatar'),text);identity.append(name);row.append(identity);
  const owner=el('td');owner.append(el('span',a.owner?'实例 '+a.owner:'未分配',a.owner?'instance-chip':'muted'));row.append(owner);
  const quotaCell=el('td'),quotaBox=el('button',undefined,'account-model-quota'),models=Object.values(a.quota?.models||{}),known=models.map(quotaFraction).filter(value=>value!==null);
  const fraction=known.length?Math.min(...known):null,line=el('div',undefined,'account-quota-line');quotaBox.type='button';quotaBox.title='查看各模型本地次数额度';quotaBox.setAttribute('aria-label','查看账号 '+a.id+' 的模型额度');quotaBox.addEventListener('click',()=>openAccount(a.id));quotaBox.classList.add(quotaTone(fraction));
  line.append(el('span',models.length?models.length+' 个模型':'未配置额度'),el('span',fraction===null?'—':Math.round(fraction*100)+'%','quota-percent'));quotaBox.append(line);
  if(fraction!==null){const bar=el('progress');bar.max=100;bar.value=fraction*100;bar.setAttribute('aria-label','最低已知本地剩余额度 '+Math.round(fraction*100)+'%');quotaBox.append(bar);}
  else quotaBox.append(el('span',undefined,'quota-unknown-track'));
  quotaBox.append(el('small',models.some(q=>q.legacyBlocked)?'含待核实模型':models.some(q=>q.cooldownUntil>Date.now())?'部分模型冷却中':fraction===null?'本地余量未知':'最低已知本地余量'));
  quotaCell.append(quotaBox);row.append(quotaCell);
  const statusCell=el('td'),kind=accountState(a);statusCell.append(statusBadge(kind==='cooling'?'冷却中':kind==='assigned'?'已分配':'备用',kind==='cooling'?'warn':kind==='available'?'good':'assigned'));row.append(statusCell);
  const cooldown=el('td',a.cooldownUntil>Date.now()?date(a.cooldownUntil):'—','cooldown-cell');row.append(cooldown);
  const actions=el('td'),details=el('button',undefined,'account-detail-button');details.type='button';details.title='查看账号详情';details.setAttribute('aria-label','查看账号 '+a.id+' 的额度详情');details.append(consoleIcon('chart'));details.addEventListener('click',()=>openAccount(a.id));actions.append(details);row.append(actions);rows.append(row);
 }
 if(!accounts.length){const row=el('tr'),cell=el('td',d.accounts.length?'没有匹配的账号，请调整筛选条件':'暂无账号，导入后点击同步账号池。','empty');cell.colSpan=6;row.append(cell);rows.append(row);}
 $('account-page').textContent=accounts.length?'显示 '+((accountPage-1)*size+1)+'–'+Math.min(accountPage*size,accounts.length)+' / 共 '+accounts.length+' 条':'共 0 条';
 $('account-prev').disabled=accountPage<=1;$('account-next').disabled=accountPage*size>=accounts.length;
 let pageNumber=$('account-page-number');if(!pageNumber){pageNumber=el('span',undefined,'page-number');pageNumber.id='account-page-number';pageNumber.setAttribute('aria-label','当前页');$('account-prev').insertAdjacentElement('afterend',pageNumber);}pageNumber.textContent=accountPage;
 const summary=$('account-summary');
 for(const [key,title,count,label,tone] of [['all','账号总数',d.accounts.length,'全部',''],['available','备用账号',d.accounts.filter(a=>accountState(a)==='available').length,'备用','good'],['assigned','已分配',d.accounts.filter(a=>accountState(a)==='assigned').length,'分配','assigned'],['cooling','冷却账号',d.accounts.filter(a=>accountState(a)==='cooling').length,'冷却','warn']]){
  let box=summary.querySelector('[data-account-filter="'+key+'"]');
  if(!box){box=el('button',undefined,'card account-summary-card summary-'+key);box.type='button';box.dataset.accountFilter=key;const copy=el('div');copy.append(el('span',title),el('strong',count));box.append(copy,statusBadge(label,tone));box.addEventListener('click',()=>{$('account-status').value=key;accountPage=1;renderAccountRows();});summary.append(box);}
  box.querySelector('strong').textContent=count;box.classList.toggle('selected',status===key);box.setAttribute('aria-pressed',String(status===key));
 }
 applyAccountColumns();
}
function render(d){
 const ready=Object.values(d.slots).filter(s=>s?.ready&&!s?.rotationBlocked&&!s?.healthCheck?.error).length;
 $('service').textContent=d.halted?'已暂停':ready===2?'运行正常':ready?'部分可用':'暂不可用';$('service').className=d.halted||ready<2?'warn':'good';
 $('service-note').textContent=d.halted?'协调器已停止分配请求':ready+' / 2 实例可调度';
 $('queued').textContent=d.queue;$('account-count').textContent=d.accounts.length;
 $('active').textContent=Object.values(d.slots).reduce((n,s)=>n+(s.active||0),0);
 $('mode-current').textContent=d.streamingMode||'unknown';
 const workers=$('workers'),expanded=new Set([...workers.querySelectorAll('details[open][data-slot]')].map(node=>node.dataset.slot));workers.replaceChildren();
 for(const slot of ['A','B']){
  const s=d.slots[slot];if(!s){workers.append(el('article','实例 '+slot+' 状态缺失','card empty'));continue;}
  const box=el('article',undefined,'card worker runtime-worker'),head=el('div',undefined,'worker-head'),identity=el('div',undefined,'worker-identity'),icon=el('span',undefined,'worker-icon');icon.append(consoleIcon('server'));
  const title=el('div'),account=d.accounts.find(a=>a.id===s.account);title.append(el('h2','实例 '+slot),el('small',account?.name||'账号 #'+(s.account??'—'),'muted'));identity.append(icon,title);
  const health=s.workerHealth,healthFresh=health?.account===s.account && health?.workerEpoch===s.workerEpoch && Date.now()-health.observedAt<15000;
  const pending=(s.pendingExecutions||[]).filter(t=>t.phase==='reconciling').length;
  const label=s.legacyUnresolved?'历史请求待核实':healthFresh&&health.hardQuarantine?'故障隔离':
   healthFresh&&health.pendingCompletions>0?'等待完成回执':pending?'请求待核实':s.pendingRetirements?'等待清理确认':s.operation?({catalog:'模型同步',rotation:'账号轮换',recovery:'安全恢复',cleanup:'资源清理'}[s.operation.kind]||'操作中'):s.rotationBlocked?'轮换受阻':s.pending?'轮换中':s.ready?(s.active?'处理中':'已就绪'):'未就绪';
  const unhealthy=s.healthCheck?.error||s.legacyUnresolved||s.rotationBlocked||s.recoveryBlocked||(healthFresh&&health.hardQuarantine);
  head.append(identity,statusBadge(label,unhealthy||!s.ready?'warn':s.active?'assigned':'good'));box.append(head);
  const metrics=el('div',undefined,'worker-metrics');
  const quotas=Object.values(s.quota?.models||{});
  for(const [label,value] of [['调度占用',s.active??0],['本地模型',s.quota?quotas.length:'—'],['待核实执行',pending]]){const metric=el('div');metric.append(el('span',label),el('strong',value));metrics.append(metric);}box.append(metrics);
  const alerts=[];
  if(s.healthCheck?.error)alerts.push('健康检查失败 '+(s.healthCheck.failureCount||1)+' 次');
  if(s.recoveryBlocked)alerts.push('恢复受阻，请检查实例与登录状态');
  if(s.rotationFailure)alerts.push(s.rotationFailure.retryable?'轮换失败，'+date(s.rotationFailure.retryAt)+' 重试':'轮换失败，请检查实例登录与账号状态');
  if(!healthFresh)alerts.push('浏览器健康状态待更新');
  if(s.pendingRetirements)alerts.push(s.pendingRetirements+' 个请求等待清理确认，暂不轮换');
  if(pending)alerts.push(pending+' 个执行等待完成证据，占用已保留');
  if(s.quota?.legacy)alerts.push('历史汇总用量已保留，未归入模型精确计数');
  if(alerts.length){const area=el('div',undefined,'worker-alerts');for(const message of alerts)area.append(el('p',message));box.append(area);}
  const quotaHeader=el('div',undefined,'worker-quota-heading');quotaHeader.append(el('span','模型额度'),el('small','本地剩余次数'));box.append(quotaHeader);
  if(!s.quota)box.append(el('div','额度状态暂不可用','worker-empty warn'));
  else if(!quotas.length)box.append(el('div','尚未配置模型额度','worker-empty muted'));
  const quotaList=el('div',undefined,'worker-quota-list');let extra=null;
  if(quotas.length>3){extra=el('details',undefined,'worker-quota-more');extra.dataset.slot=slot;extra.open=expanded.has(slot);extra.append(el('summary','查看其余 '+(quotas.length-3)+' 个模型'));}
  quotas.forEach((item,index)=>{
   const fraction=quotaFraction(item),q=el('div',undefined,'quota worker-model-quota '+quotaTone(fraction)),line=el('div',undefined,'quota-label');
   line.append(el('span',item.model),el('span',item.legacyBlocked?'待核实':fraction===null?'未知':Math.max(0,item.limit-item.used)+' / '+item.limit));q.append(line);
   if(fraction!==null){const bar=el('progress');bar.max=100;bar.value=fraction*100;bar.setAttribute('aria-label',item.model+' 本地剩余额度 '+Math.round(fraction*100)+'%');q.append(bar);}
   if(item.legacyBlocked)q.append(el('small','暂停派单 · 历史窗口至 '+date(item.legacyUntil),'warn'));
   else if(item.cooldownUntil>Date.now())q.append(el('small','冷却至 '+date(item.cooldownUntil),'warn'));
   else q.append(el('small',item.windowEnd?'窗口结束 '+date(item.windowEnd):'窗口未启用','muted'));
   if(index<3)quotaList.append(q);else extra.append(q);
  });box.append(quotaList);if(extra)box.append(extra);
  const foot=el('div',undefined,'worker-foot');foot.append(el('span','账号 #'+(s.account??'—')),el('span','每模型独立计数'));box.append(foot);workers.append(box);
 }
 let cleanupNote=$('cleanup-status');
 if(!cleanupNote){cleanupNote=el('p',undefined,'note');cleanupNote.id='cleanup-status';workers.insertAdjacentElement('afterend',cleanupNote);}
 const cleanup=d.retiredCleanup;cleanupNote.hidden=!cleanup;
 if(cleanup){
  const scans=Object.values(cleanup.slots||{}),issue=cleanup.error||scans.some(s=>s.error);
  cleanupNote.textContent='退役清理 · '+(cleanup.enabled?'保留 '+cleanup.retentionDays+' 天，每实例至少 '+cleanup.keepPerSlot+' 份':'已关闭')+
   (issue?' · 部分资源未清理，已保留备份':scans.some(s=>s.running)?' · 检查中':'')+' · 原始凭据与运行数据保留';
  cleanupNote.className='note'+(issue?' warn':'');
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
   if(statusError){notice('');statusError=false;}return true;
  }catch(e){fresh=false;statusError=true;document.body.classList.add('stale');$('updated').textContent='状态已过期';notice('状态读取失败，已保留上次数据。'+e.message);return false;}
  finally{reading=false;$('refresh').disabled=false;$('refresh').removeAttribute('aria-busy');controls();}
 })();return readTask;
}
async function action(path,body,message,format){
 if(mutating||!fresh)return;if(message&&!confirm(message))return;
 mutating=true;controls();try{
  const result=await api(path,body);if(readTask)await readTask;
  if(await refresh()){notice(format(result));statusError=false;}
 }catch(e){
  fresh=false;document.body.classList.add('stale');$('updated').textContent='操作后状态待核实';
  notice(e.message+'；请刷新状态后再操作。');
 }finally{mutating=false;controls();}
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
document.addEventListener('ais-refresh',()=>loadOverviewUsage(true));
for(const id of ['quota-search','account-status','account-page-size'])$(id).addEventListener(id==='quota-search'?'input':'change',()=>{accountPage=1;renderAccountRows();});
$('account-prev').addEventListener('click',()=>{accountPage--;renderAccountRows();});
$('account-next').addEventListener('click',()=>{accountPage++;renderAccountRows();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!mutating)refresh();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadOverviewUsage();});
$('theme').addEventListener('click',()=>{const dark=document.documentElement.classList.toggle('dark');try{localStorage.setItem('ais-theme',dark?'dark':'light');}catch{}});
try{const theme=localStorage.getItem('ais-theme');document.documentElement.classList.toggle('dark',theme==='dark'||(!theme&&matchMedia('(prefers-color-scheme: dark)').matches));}catch{}
setupAccountColumns();
addEventListener('hashchange',navigate);navigate();controls();refresh();
setInterval(()=>{if(!document.hidden&&!mutating)refresh();},5000);
setInterval(()=>{if(!document.hidden)loadOverviewUsage();},30000);
