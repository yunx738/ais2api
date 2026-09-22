'use strict';
(()=>{
 const byId=id=>document.getElementById(id);
 const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(cls)e.className=cls;return e;};
 const fmt=v=>Number.isFinite(v)?v.toLocaleString('zh-CN',{maximumFractionDigits:2}):'未知';
 const compact=v=>Number.isFinite(v)?v>=1e6?fmt(v/1e6)+'M':v>=1e3?fmt(v/1e3)+'K':fmt(v):'未知';
 const time=v=>Number.isFinite(v)?new Date(v).toLocaleString('zh-CN',{hour12:false}):'未记录';
 const money=v=>Number.isFinite(v)?'$'+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:6}):'未知';
 const labels={success:'响应正常结束',http_error:'HTTP 错误',application_error:'应用错误',cancelled:'连接取消',uncertain:'结果待核实',pending:'等待完成',rejected:'已拒绝'};
 const sources={'response-reported-unverified':'响应报告（来源待核实）','upstream-reported':'上游报告','local-estimate':'本地估算'};
 let page=1,total=0,historyBusy=false,accountData=[],selectedAccount=null,historyController=null,usageController=null;
 let applied={model:'',account:'',outcome:''};
 async function read(path,control){
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;control.abort();},15000);
  try{
   const response=await fetch(path,{credentials:'same-origin',redirect:'error',headers:{Accept:'application/json'},signal:control.signal});
   if(response.status===401||response.status===403)throw Error('登录已失效，请重新登录');
   if(!(response.headers.get('content-type')||'').includes('application/json'))throw Error('接口未返回 JSON，请检查登录状态');
   const data=await response.json();if(!response.ok)throw Error(typeof data.error==='string'?data.error:'接口不可用');return data;
  }catch(e){if(timedOut)throw Error('接口 15 秒未响应，请稍后重试');throw e;}finally{clearTimeout(timer);}
 }
 function recordingWarning(d){const h=d.recording?.history||d.health;return h?.degraded||h?.ready===false||(d.recording?.beginFailures||0)+(d.recording?.finishFailures||0)?' · 记录系统存在异常，统计可能不完整':'';}
 function card(title,value,note,kind){const e=node('article',undefined,'card stat stat-'+kind);e.append(node('span',title),node('i',undefined,'stat-mark'),node('strong',value),node('small',note));return e;}
 function rangeQuery(){const choice=byId('usage-range').value,params=new URLSearchParams();if(choice!=='all'){let from;if(choice==='today'){const d=new Date();d.setHours(0,0,0,0);from=d.getTime();}else from=Date.now()-Number(choice)*86400000;params.set('from',String(from));}return params.toString();}
 function renderModels(d){
  const models=byId('usage-models');models.replaceChildren();
  if(!d.models.length){models.append(node('div','当前时间范围内暂无模型请求','empty'));return;}
  const palette=['#0878df','#8c79d9','#1cbbba','#e8ac53','#dc7893','#78a594','#7d9dbf','#ac93ae'];
  const ringWrap=node('div',undefined,'distribution-ring-wrap'),ring=node('div',undefined,'distribution-ring'),center=node('div',undefined,'distribution-center');
  center.append(node('small','已记录请求'),node('strong',compact(d.requests)),node('small','按请求数分布'));ring.append(center);ring.setAttribute('role','img');ring.setAttribute('aria-label',fmt(d.requests)+' 个请求的模型分布');
  const items=[...d.models].sort((a,b)=>(b.requests||0)-(a.requests||0));let start=0;const stops=[];
  items.forEach((item,index)=>{const end=Math.min(100,start+Math.max(0,item.requests||0)/Math.max(1,d.requests)*100);stops.push(palette[index%palette.length]+' '+start+'% '+end+'%');start=end;});
  if(start<100)stops.push('var(--border) '+start+'% 100%');ring.style.background='conic-gradient('+stops.join(',')+')';ringWrap.append(ring);models.append(ringWrap);
  const list=node('div',undefined,'distribution-list');
  items.forEach((item,index)=>{const row=node('div',undefined,'distribution-row'),heading=node('div',undefined,'distribution-heading'),name=node('strong',item.model),dot=node('i',undefined,'model-dot'),bar=node('progress');dot.style.background=palette[index%palette.length];name.prepend(dot);heading.append(name,node('span',fmt(item.requests)+' 次 · '+fmt(item.requests/Math.max(1,d.requests)*100)+'%'));bar.max=Math.max(1,d.requests);bar.value=item.requests;bar.setAttribute('aria-label',item.model+' 请求占比');row.append(heading,node('small','已知 Token '+compact(item.knownTokenTotal)+' · '+fmt(item.tokenUnknownRequests)+' 次用量未知','muted'),bar);list.append(row);});models.append(list);
 }
 async function loadUsage(){
  usageController?.abort();const control=new AbortController();usageController=control;byId('usage-refresh').disabled=true;byId('usage').setAttribute('aria-busy','true');
  try{const d=await read('/api/usage?'+rangeQuery(),control);if(usageController!==control)return;
   if(!Number.isSafeInteger(d.requests)||!Array.isArray(d.models))throw Error('统计数据格式不完整');
   const box=byId('usage-cards');box.replaceChildren();box.append(
    card('已记录请求',compact(d.requests),'正常结束 '+fmt(d.success)+' · 错误 '+fmt(d.errors),'requests'),
    card('已知 TOKEN',d.tokenKnownRequests?compact(d.knownTokenTotal):'未知',fmt(d.tokenUnknownRequests)+' 次用量未知或不完整','tokens'),
    card('估算费用',d.pricedRequests?money(d.estimatedCostKnownSubtotal):'未知',fmt(d.pricedRequests)+' 次可估价 · '+fmt(d.unpricedRequests)+' 次未计价','cost'),
    card('RPM',fmt(d.rpm),'最近一分钟派单数','rpm'),
    card('已知 TPM',compact(d.tpmKnown),fmt(d.tpmUnknownRequests)+' 次近期响应 Token 未知','tpm'),
    card('响应错误率',Number.isFinite(d.errorRate)?fmt(d.errorRate*100)+'%':'未知','平均耗时 '+(Number.isFinite(d.averageDurationMs)?fmt(d.averageDurationMs/1000)+' 秒':'未知'),'errors')
   );renderModels(d);byId('usage-message').textContent='更新于 '+time(Date.now())+recordingWarning(d);byId('usage').classList.remove('analytics-stale');
  }catch(e){if(usageController!==control||e.name==='AbortError')return;byId('usage-message').textContent='统计读取失败，旧数据已过期：'+e.message;byId('usage').classList.add('analytics-stale');}
  finally{if(usageController===control){byId('usage-refresh').disabled=false;byId('usage').removeAttribute('aria-busy');}}
 }
 function pair(container,title,value,cls){const p=node('div',undefined,'metric-cell '+(cls||''));p.append(node('small',title),node('span',value));container.append(p);}
 function requestCard(r){
  const box=node('article',undefined,'card request-card'),head=node('div',undefined,'request-head'),pills=node('div',undefined,'request-pills');box.dataset.requestId=String(r.id);
  const endedBeforeClose=r.metrics?.streamDoneSeen===true&&r.metrics?.transportComplete!==true&&['cancelled','uncertain'].includes(r.outcome);
  const outcomeLabel=endedBeforeClose?'结束标记已收到 · 连接关闭':labels[r.outcome]||'未知',statusKind=r.outcome==='success'?'good':['http_error','application_error','rejected'].includes(r.outcome)?'bad':'warn';
  pills.append(node('span',Number.isFinite(r.httpStatus)?r.httpStatus:outcomeLabel,'badge '+statusKind),node('strong',r.requestedModel||r.model||'模型未知','request-model'),node('span',r.stream?'流式':'非流式','badge stream-badge'));
  head.append(pills,node('time',time(r.createdAt),'request-time'));box.append(head);
  const meta=node('div',undefined,'request-meta');meta.append(node('span','账号 #'+(r.account??'未知')+' · 实例 '+(r.slot||'未知')));if(Number.isFinite(r.httpStatus))meta.append(node('span',outcomeLabel,statusKind));box.append(meta);
  const metrics=node('div',undefined,'request-metrics'),u=r.metrics?.usage;
  pair(metrics,'TOKEN  输入 / 输出',compact(u?.input)+' / '+compact(u?.output),'metric-token');
  pair(metrics,'缓存 / 思考',compact(u?.cached)+' / '+compact(u?.reasoning),'metric-cache');
  pair(metrics,'首内容 / 响应耗时',(Number.isFinite(r.metrics?.firstContentMs)?fmt(r.metrics.firstContentMs/1000)+'s':'未知')+' / '+(Number.isFinite(r.metrics?.durationMs)?fmt(r.metrics.durationMs/1000)+'s':'未知'),'metric-duration');
  pair(metrics,'估算费用',money(r.cost?.amount),'metric-price');box.append(metrics);
  const detail=node('details',undefined,'request-diagnostics'),summary=node('summary','请求详情');
  const preview=node('span',r.metrics?.usageComplete?'响应用量采集完整':'用量不完整','muted');summary.append(preview);detail.append(summary);
  detail.append(node('p',(sources[u?.source]||'用量未提供')+' · '+(r.metrics?.usageComplete?'响应用量采集完整':'用量缺失或采集不完整'),'muted'));
  if(endedBeforeClose)detail.append(node('p','已收到模型结束标记，HTTP 传输未确认完整结束；不代表用户主动取消，也不代表实例执行账本已结算。','warn'));
  if(!Number.isFinite(r.cost?.amount))detail.append(node('p','尚未计价：'+(r.cost?.reason||'未记录结束'),'muted'));
  if(r.outcome==='pending')detail.append(node('p','可能仍在执行，或因重启、记录失败未写入结束。请结合实例运行状态判断。','warn'));
  detail.append(node('p','响应结束与实例执行结算是独立状态；记录不保存提示词及回复正文。','muted'));
  const exact=node('div',undefined,'exact-metrics');for(const [title,value] of [['输入 Token',u?.input],['输出 Token',u?.output],['缓存 Token',u?.cached],['思考 Token',u?.reasoning]])pair(exact,title,fmt(value));detail.append(exact,node('code',r.id,'request-id'));box.append(detail);return box;
 }
 function pager(){byId('history-prev').disabled=historyBusy||page<=1;byId('history-next').disabled=historyBusy||page*20>=total;byId('history-page').textContent='第 '+page+' / '+Math.max(1,Math.ceil(total/20))+' 页 · 共 '+total+' 条';}
 async function loadHistory(){
  historyController?.abort();const control=new AbortController();historyController=control;historyBusy=true;pager();byId('history-refresh').disabled=true;byId('history-list').setAttribute('aria-busy','true');
  const params=new URLSearchParams({page:String(page),pageSize:'20'});for(const [key,value] of Object.entries(applied))if(value!=='')params.set(key,value);
  try{const d=await read('/api/requests?'+params.toString(),control);if(historyController!==control)return;if(!Array.isArray(d.items)||!Number.isSafeInteger(d.total))throw Error('记录数据格式不完整');
   total=d.total;const last=Math.max(1,Math.ceil(total/20));if(page>last){page=last;loadHistory();return;}
   const list=byId('history-list'),open=new Set([...list.querySelectorAll('.request-card')].filter(e=>e.querySelector('details[open]')).map(e=>e.dataset.requestId));list.replaceChildren();
   for(const item of d.items){const row=requestCard(item);row.querySelector('details').open=open.has(String(item.id));list.append(row);}
   if(!d.items.length)list.append(node('div','暂无匹配记录，请调整筛选条件或稍后刷新。','card empty'));
   byId('history-message').textContent='更新于 '+time(Date.now())+recordingWarning(d);byId('history').classList.remove('analytics-stale');
  }catch(e){if(historyController!==control||e.name==='AbortError')return;byId('history-message').textContent='记录读取失败，旧数据已过期：'+e.message;byId('history').classList.add('analytics-stale');}
  finally{if(historyController===control){historyBusy=false;byId('history-refresh').disabled=false;byId('history-list').removeAttribute('aria-busy');pager();}}
 }
 function renderAccountDetail(){
  const box=byId('quota-accounts'),a=accountData.find(item=>String(item.id)===String(selectedAccount));box.replaceChildren();
  if(!a){box.append(node('div','该账号已不在当前账号池中。','card empty'));return;}
  byId('account-dialog-title').textContent=a.name||'未命名账号';byId('account-dialog-subtitle').textContent='账号 #'+a.id+' · '+(a.owner?'实例 '+a.owner:a.cooldownUntil>Date.now()?'冷却中':'未分配');
  if(a.cooldownUntil>Date.now())box.append(node('div','账号冷却至 '+time(a.cooldownUntil),'card note warn'));
  if(!a.quota){box.append(node('div','额度信息不可用，不代表余额为零。','card note warn'));return;}
  const models=Object.values(a.quota.models||{});if(!models.length){box.append(node('div','尚未配置模型额度策略','card empty'));return;}
  const list=node('div',undefined,'card quota-model-list');
  for(const q of models){
   const row=node('div',undefined,'quota'),line=node('div',undefined,'quota-label'),valid=Number.isFinite(q.used)&&Number.isFinite(q.limit)&&q.limit>0,remaining=valid?Math.max(0,q.limit-q.used):undefined;
   line.append(node('strong',q.model),node('span',q.legacyBlocked?'历史待核实':valid?'剩余 '+remaining+' / '+q.limit:'额度未知',q.legacyBlocked?'warn':''));row.append(line);
   if(valid&&!q.legacyBlocked){const bar=node('progress');bar.max=q.limit;bar.value=remaining;bar.setAttribute('aria-label',q.model+' 本地剩余次数 '+remaining);row.append(bar,node('small','已记录 '+q.used+' 次 · 剩余 '+fmt(remaining/q.limit*100)+'%','muted'));}
   row.append(node('p',q.legacyBlocked?'历史窗口截止 '+time(q.legacyUntil):q.cooldownUntil>Date.now()?'模型冷却至 '+time(q.cooldownUntil):q.windowEnd?'额度窗口结束 '+time(q.windowEnd):'额度窗口尚未启用',q.cooldownUntil>Date.now()?'warn':'muted'));list.append(row);
  }box.append(list);
 }
 function pageChanged(){if(location.hash==='#usage')loadUsage();if(location.hash==='#history')loadHistory();}
 byId('usage-refresh').addEventListener('click',loadUsage);byId('usage-range').addEventListener('change',loadUsage);byId('history-refresh').addEventListener('click',loadHistory);
 byId('history-filter').addEventListener('submit',event=>{event.preventDefault();applied={model:byId('history-model').value.trim(),account:byId('history-account').value.trim(),outcome:byId('history-outcome').value};page=1;loadHistory();});
 byId('history-prev').addEventListener('click',()=>{if(!historyBusy&&page>1){page--;loadHistory();}});byId('history-next').addEventListener('click',()=>{if(!historyBusy&&page*20<total){page++;loadHistory();}});
 document.addEventListener('ais-status',event=>{accountData=event.detail.accounts||[];if(byId('account-dialog').open)renderAccountDetail();});
 document.addEventListener('ais-account-details',event=>{selectedAccount=event.detail.id;renderAccountDetail();byId('account-dialog').showModal();});
 byId('account-dialog-close').addEventListener('click',()=>byId('account-dialog').close());
 byId('account-dialog').addEventListener('click',event=>{const box=byId('account-dialog').getBoundingClientRect();if(event.target===byId('account-dialog')&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom))byId('account-dialog').close();});
 document.addEventListener('ais-refresh',pageChanged);addEventListener('hashchange',pageChanged);pageChanged();
})();
