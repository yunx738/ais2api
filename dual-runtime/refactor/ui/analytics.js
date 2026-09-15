'use strict';
(()=>{
 const byId=id=>document.getElementById(id);
 const node=(tag,text,cls)=>{
  const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(cls)e.className=cls;return e;
 };
 const fmt=v=>Number.isFinite(v)?v.toLocaleString('zh-CN',{maximumFractionDigits:2}):'未知';
 const time=v=>Number.isFinite(v)?new Date(v).toLocaleString('zh-CN',{hour12:false}):'未记录';
 const money=v=>Number.isFinite(v)?'$'+v.toFixed(6):'未知';
 const labels={success:'响应正常结束',http_error:'HTTP 错误',application_error:'应用错误',cancelled:'连接取消',uncertain:'结果待核实',pending:'尚未记录结束',rejected:'已拒绝'};
 const sources={'response-reported-unverified':'响应报告（来源待核实）','upstream-reported':'上游报告','local-estimate':'本地估算'};
 let page=1,total=0,historyBusy=false,usageBusy=false,accountData=[];
 let applied={model:'',account:'',outcome:''};
 async function read(path){
  const control=new AbortController(),timer=setTimeout(()=>control.abort(),15000);
  try{
   const response=await fetch(path,{credentials:'same-origin',redirect:'error',headers:{Accept:'application/json'},signal:control.signal});
   if(!(response.headers.get('content-type')||'').includes('application/json'))throw Error('请重新登录');
   const data=await response.json();
   if(!response.ok)throw Error(typeof data.error==='string'?data.error:'接口不可用');
   return data;
  }finally{clearTimeout(timer);}
 }
 function recordingWarning(d){
  const h=d.recording?.history||d.health;
  const failed=(d.recording?.beginFailures||0)+(d.recording?.finishFailures||0);
  return h?.degraded||h?.ready===false||failed?' · 记录系统存在异常，统计可能不完整':'';
 }
 function card(title,value,note){
  const e=node('article',undefined,'card stat');
  e.append(node('span',title),node('strong',value),node('small',note));return e;
 }
 function rangeQuery(){
  const choice=byId('usage-range').value,params=new URLSearchParams();
  if(choice!=='all'){
   let from;
   if(choice==='today'){const d=new Date();d.setHours(0,0,0,0);from=d.getTime();}
   else from=Date.now()-Number(choice)*86400000;
   params.set('from',String(from));
  }
  return params.toString();
 }
 async function loadUsage(){
  if(usageBusy)return;usageBusy=true;
  byId('usage-refresh').disabled=true;byId('usage-range').disabled=true;
  try{
   const d=await read('/api/usage?'+rangeQuery());
   if(!Number.isSafeInteger(d.requests)||!Array.isArray(d.models))throw Error('统计数据格式不完整');
   const box=byId('usage-cards');box.replaceChildren();
   box.append(
    card('已记录请求',fmt(d.requests),'正常结束 '+fmt(d.success)+' · 错误 '+fmt(d.errors)),
    card('已知 Token 小计',d.tokenKnownRequests?fmt(d.knownTokenTotal):'未知',fmt(d.tokenUnknownRequests)+' 个请求用量未知或不完整'),
    card('估算费用小计',d.pricedRequests?money(d.estimatedCostKnownSubtotal):'未知',fmt(d.pricedRequests)+' 个可估价 · '+fmt(d.unpricedRequests)+' 个未计价'),
    card('响应平均耗时',Number.isFinite(d.averageDurationMs)?fmt(d.averageDurationMs/1000)+' 秒':'未知','不含排队；只计算有耗时记录的已结束响应'),
    card('RPM / 已知 TPM',fmt(d.rpm)+' / '+fmt(d.tpmKnown),fmt(d.tpmUnknownRequests)+' 个最近结束请求 Token 未知'),
    card('可判定响应错误率',Number.isFinite(d.errorRate)?fmt(d.errorRate*100)+'%':'未知','不包含取消、待核实及尚未结束')
   );
   const models=byId('usage-models');models.replaceChildren();
   if(!d.models.length)models.append(node('p','当前范围暂无记录','muted'));
   for(const item of d.models){
    const row=node('div',undefined,'distribution-row'),bar=node('progress');
    bar.max=Math.max(1,d.requests);bar.value=item.requests;
    bar.setAttribute('aria-label',item.model+' 请求占比');
    row.append(node('strong',item.model),bar,node('span',fmt(item.requests)+' 次 · 已知 Token '+fmt(item.knownTokenTotal)+' · '+fmt(item.tokenUnknownRequests)+' 次用量未知'));
    models.append(row);
   }
   byId('usage-message').textContent='更新于 '+time(Date.now())+recordingWarning(d);
   byId('usage').classList.remove('analytics-stale');
  }catch(e){
   byId('usage-message').textContent='统计读取失败，旧数据已过期：'+e.message;
   byId('usage').classList.add('analytics-stale');
  }finally{usageBusy=false;byId('usage-refresh').disabled=false;byId('usage-range').disabled=false;}
 }
 function pair(container,title,value){
  const p=node('div',undefined,'metric-cell');p.append(node('small',title),node('span',value));container.append(p);
 }
 function requestCard(r){
  const box=node('article',undefined,'card request-card'),head=node('div',undefined,'worker-head');
  const endedBeforeClose=r.metrics?.streamDoneSeen===true && r.metrics?.transportComplete!==true && ['cancelled','uncertain'].includes(r.outcome);
  const outcomeLabel=endedBeforeClose?'已收到结束标记 · 连接随后关闭':labels[r.outcome]||'未知';
  head.append(node('strong',r.requestedModel||r.model),node('span',outcomeLabel,'badge '+(r.outcome==='success'?'good':'warn')));
  if(endedBeforeClose)box.append(node('p','已收到模型流结束标记；HTTP 传输未确认完整结束。这不代表用户主动取消，也不代表 worker 执行账本已结算。','muted'));
  box.append(head,node('p',time(r.createdAt)+' · 账号 #'+(r.account??'未知')+' · 实例 '+(r.slot||'未知')+' · '+(r.stream?'流式':'非流式'),'muted'));
  const metrics=node('div',undefined,'request-metrics'),u=r.metrics?.usage;
  pair(metrics,'输入 Token',fmt(u?.input));pair(metrics,'输出 Token',fmt(u?.output));
  pair(metrics,'缓存 Token',fmt(u?.cached));pair(metrics,'思考 Token',fmt(u?.reasoning));
  pair(metrics,'响应耗时',Number.isFinite(r.metrics?.durationMs)?fmt(r.metrics.durationMs/1000)+' 秒':'未知');
  pair(metrics,'首内容时间',Number.isFinite(r.metrics?.firstContentMs)?fmt(r.metrics.firstContentMs)+' 毫秒':'未知');
  pair(metrics,'估算费用',money(r.cost?.amount));pair(metrics,'HTTP 状态',fmt(r.httpStatus));
  box.append(metrics);
  box.append(node('p',(sources[u?.source]||'用量未提供')+' · '+(r.metrics?.usageComplete?'响应用量采集完整':'用量缺失或采集不完整'),'muted'));
  if(!Number.isFinite(r.cost?.amount))box.append(node('small','尚未计价：'+(r.cost?.reason||'未记录结束'),'muted'));
  box.append(node('code',r.id,'request-id'));
  if(r.outcome==='pending')box.append(node('p','可能仍在执行，也可能因重启或记录失败未写入结束；请结合实例执行状态判断。','warn'));
  return box;
 }
 function pager(){
  byId('history-prev').disabled=historyBusy||page<=1;
  byId('history-next').disabled=historyBusy||page*20>=total;
  byId('history-page').textContent='第 '+page+' 页 · 共 '+total+' 条';
 }
 async function loadHistory(){
  if(historyBusy)return;historyBusy=true;pager();byId('history-refresh').disabled=true;
  const params=new URLSearchParams({page:String(page),pageSize:'20'});
  for(const [key,value] of Object.entries(applied))if(value!=='')params.set(key,value);
  try{
   const d=await read('/api/requests?'+params.toString());
   if(!Array.isArray(d.items)||!Number.isSafeInteger(d.total))throw Error('记录数据格式不完整');
   total=d.total;const list=byId('history-list');list.replaceChildren();
   for(const item of d.items)list.append(requestCard(item));
   if(!d.items.length)list.append(node('div','暂无匹配记录。历史记录不会从旧额度计数中伪造。','card empty'));
   byId('history-message').textContent='更新于 '+time(Date.now())+recordingWarning(d);
   byId('history').classList.remove('analytics-stale');
  }catch(e){
   byId('history-message').textContent='记录读取失败，旧数据已过期：'+e.message;
   byId('history').classList.add('analytics-stale');
  }finally{historyBusy=false;byId('history-refresh').disabled=false;pager();}
 }
 function renderAccounts(){
  const box=byId('quota-accounts'),query=byId('quota-search').value.trim().toLowerCase();
  const open=new Set([...box.querySelectorAll('details[open]')].map(e=>e.dataset.id));
  box.replaceChildren();
  for(const a of accountData){
   if(query&&!String(a.id).includes(query)&&!String(a.name||'').toLowerCase().includes(query))continue;
   const detail=node('details',undefined,'card quota-detail');detail.dataset.id=String(a.id);detail.open=open.has(String(a.id));
   detail.append(node('summary','#'+a.id+' · '+(a.name||'未命名')+' · '+(a.owner?'实例 '+a.owner:a.cooldownUntil>Date.now()?'冷却中':'未分配')));
   if(!a.quota){detail.append(node('p','额度信息不可用，不代表余额为零。','warn'));box.append(detail);continue;}
   for(const q of Object.values(a.quota.models||{})){
    const row=node('div',undefined,'quota'),line=node('div',undefined,'quota-label');
    const valid=Number.isFinite(q.used)&&Number.isFinite(q.limit)&&q.limit>0;
    const remaining=valid?Math.max(0,q.limit-q.used):undefined;
    line.append(node('strong',q.model),node('span',q.legacyBlocked?'历史待核实':valid?'剩余 '+remaining+' / '+q.limit:'额度未知'));
    row.append(line);
    if(valid&&!q.legacyBlocked){
     const bar=node('progress');bar.max=q.limit;bar.value=remaining;
     bar.setAttribute('aria-label',q.model+' 本地剩余次数 '+remaining);
     row.append(bar,node('small','已记录 '+q.used+' 次 · 剩余 '+fmt(remaining/q.limit*100)+'%','muted'));
    }
    row.append(node('p',q.legacyBlocked?'历史窗口截止 '+time(q.legacyUntil):q.cooldownUntil>Date.now()?'模型冷却至 '+time(q.cooldownUntil):q.windowEnd?'额度窗口结束 '+time(q.windowEnd):'窗口尚未启用','muted'));
    detail.append(row);
   }
   box.append(detail);
  }
  if(!box.children.length)box.append(node('div','暂无匹配账号','card empty'));
 }
 function pageChanged(){
  if(location.hash==='#usage')loadUsage();
  if(location.hash==='#history')loadHistory();
 }
 byId('usage-refresh').addEventListener('click',loadUsage);
 byId('usage-range').addEventListener('change',loadUsage);
 byId('history-refresh').addEventListener('click',loadHistory);
 byId('history-filter').addEventListener('submit',event=>{
  event.preventDefault();if(historyBusy)return;
  applied={model:byId('history-model').value.trim(),account:byId('history-account').value.trim(),outcome:byId('history-outcome').value};
  page=1;loadHistory();
 });
 byId('history-prev').addEventListener('click',()=>{if(!historyBusy&&page>1){page--;loadHistory();}});
 byId('history-next').addEventListener('click',()=>{if(!historyBusy&&page*20<total){page++;loadHistory();}});
 byId('quota-search').addEventListener('input',renderAccounts);
 document.addEventListener('ais-status',event=>{accountData=event.detail.accounts||[];renderAccounts();});
 addEventListener('hashchange',pageChanged);pageChanged();
})();
