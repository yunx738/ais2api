'use strict';
(()=>{
 const byId=id=>document.getElementById(id);
 const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(cls)e.className=cls;return e;};
 const fmt=v=>Number.isFinite(v)?v.toLocaleString('zh-CN',{maximumFractionDigits:2}):'未知';
 const compact=v=>Number.isFinite(v)?v>=1e6?fmt(v/1e6)+'M':v>=1e3?fmt(v/1e3)+'K':fmt(v):'未知';
 const time=v=>Number.isFinite(v)?new Date(v).toLocaleString('zh-CN',{hour12:false}):'未记录';
 const money=v=>Number.isFinite(v)?'$'+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:6}):'未知';
 const seconds=v=>Number.isFinite(v)?fmt(v/1000)+'s':'未知';
 const labels={success:'响应正常结束',http_error:'HTTP 错误',application_error:'应用错误',cancelled:'连接取消',uncertain:'结果待核实',pending:'等待完成',rejected:'已拒绝'};
 const sources={'response-reported-unverified':'响应报告（来源待核实）','upstream-reported':'上游报告','local-estimate':'本地估算'};
 const paths={requests:'M3 12h4l3-8 4 16 3-8h4',tokens:'m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9',cost:'M12 8v8m3-7h-4a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',rpm:'M12 7v5l3 2M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',tpm:'m13 2-10 12h8l-1 8 11-12h-8l1-8',errors:'m10.3 4-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0M12 9v4m0 4h.01',chart:'M4 3v18h17M8 15v-4m5 4V7m5 8v-6',info:'M12 11v6m0-10h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',check:'m6 12 4 4 8-8',chevron:'m9 5 7 7-7 7',account:'M20 21v-2a7 7 0 0 0-14 0v2M13 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8'};
 function icon(name){const e=document.createElementNS('http://www.w3.org/2000/svg','svg'),p=document.createElementNS(e.namespaceURI,'path');e.setAttribute('viewBox','0 0 24 24');e.setAttribute('fill','none');e.setAttribute('stroke','currentColor');e.setAttribute('stroke-width','1.6');e.setAttribute('stroke-linecap','round');e.setAttribute('stroke-linejoin','round');e.setAttribute('aria-hidden','true');p.setAttribute('d',paths[name]||paths.requests);e.append(p);return e;}
 let page=1,total=0,historyBusy=false,accountData=[],selectedAccount=null,historyController=null,usageController=null,modelMetric='requests',latestUsage=null;
 let applied={model:'',account:'',outcome:''};
 async function read(path,control){
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;control.abort();},15000);
  try{const response=await fetch(path,{credentials:'same-origin',redirect:'error',headers:{Accept:'application/json'},signal:control.signal});
   if(response.status===401||response.status===403)throw Error('登录已失效，请重新登录');
   if(!(response.headers.get('content-type')||'').includes('application/json'))throw Error('接口未返回 JSON，请检查登录状态');
   const data=await response.json();if(!response.ok)throw Error(typeof data.error==='string'?data.error:'接口不可用');return data;
  }catch(e){if(timedOut)throw Error('接口 15 秒未响应，请稍后重试');throw e;}finally{clearTimeout(timer);}
 }
 function recordingWarning(d){const h=d.recording?.history||d.health;return h?.degraded||h?.ready===false||(d.recording?.beginFailures||0)+(d.recording?.finishFailures||0)?' · 记录系统存在异常，统计可能不完整':'';}
 function card(title,value,note,kind){const e=node('article',undefined,'card stat stat-'+kind),head=node('div',undefined,'stat-heading'),mark=node('span',undefined,'stat-mark');mark.append(icon(kind));head.append(node('span',title),mark);e.append(head,node('strong',value),node('small',note));return e;}
 function rangeQuery(){const choice=byId('usage-range').value,params=new URLSearchParams();if(choice!=='all'){let from;if(choice==='today'){const d=new Date();d.setHours(0,0,0,0);from=d.getTime();}else from=Date.now()-Number(choice)*86400000;params.set('from',String(from));}return params.toString();}
 function panelHeader(title,description,name){const h=node('div',undefined,'insight-header'),mark=node('span',undefined,'insight-icon'),label=node('div',undefined,'insight-title');mark.append(icon(name));label.append(node('h2',title),node('p',description));h.append(mark,label);return h;}
 function renderModels(d){
  const models=byId('usage-models'),card=models.closest('.distribution-card'),head=card.querySelector('.section-head');models.replaceChildren();
  let toggle=head.querySelector('.usage-metric-toggle');if(!toggle){toggle=node('div',undefined,'usage-metric-toggle');toggle.setAttribute('role','group');toggle.setAttribute('aria-label','模型分布统计方式');for(const [value,label] of [['requests','按请求'],['tokens','按 Token']]){const b=node('button',label);b.type='button';b.dataset.metric=value;b.addEventListener('click',()=>{modelMetric=value;if(latestUsage)renderModels(latestUsage);});toggle.append(b);}head.append(toggle);}
  toggle.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.metric===modelMetric)));
  if(!d.models.length){models.append(node('div','当前时间范围内暂无模型请求','empty'));card.querySelector('.distribution-note')?.remove();return;}
  const palette=['#0668ce','#8c79d9','#13a9b0','#e2a339','#d9709b','#65a58d','#7996bf','#aa8fb9'];
  const isTokens=modelMetric==='tokens',value=item=>Math.max(0,Number.isFinite(item[isTokens?'knownTokenTotal':'requests'])?item[isTokens?'knownTokenTotal':'requests']:0),all=isTokens?d.knownTokenTotal:d.requests;
  const ringWrap=node('figure',undefined,'distribution-ring-wrap'),ring=node('div',undefined,'distribution-ring'),center=node('div',undefined,'distribution-center');
  center.append(node('small','主要模型合计'),node('strong',isTokens&&!d.tokenKnownRequests?'未知':compact(all)),node('small',isTokens?'已知 Token':'请求数'));ring.append(center);ring.setAttribute('role','img');ring.setAttribute('aria-label',(isTokens?'已知 Token ':'请求数 ')+fmt(all)+'，各模型分布');
  const items=[...d.models].sort((a,b)=>value(b)-value(a));let start=0;const stops=[];
  items.forEach((item,index)=>{const end=Math.min(100,start+value(item)/Math.max(1,all)*100);if(end>start)stops.push(palette[index%palette.length]+' '+start+'% '+end+'%');start=end;});
  if(start<100)stops.push('var(--border) '+start+'% 100%');ring.style.background='conic-gradient('+stops.join(',')+')';ringWrap.append(ring);models.append(ringWrap);
  const list=node('div',undefined,'distribution-list'),heading=node('div',undefined,'distribution-list-heading');heading.append(node('span','模型'),node('span',(isTokens?'Token':'请求数')+' · %'));list.append(heading);list.tabIndex=0;list.setAttribute('role','region');list.setAttribute('aria-label','模型使用排名');
  items.forEach((item,index)=>{const row=node('div',undefined,'distribution-row'),heading=node('div',undefined,'distribution-heading'),name=node('strong',undefined,'distribution-model'),dot=node('i',undefined,'model-dot'),number=node('div',undefined,'distribution-value'),bar=node('div',undefined,'usage-share-track'),fill=node('div'),meta=node('div',undefined,'distribution-meta');dot.style.background=palette[index%palette.length];name.append(dot,node('span',item.model));number.append(node('strong',compact(value(item))),node('span',all>0?fmt(value(item)/all*100)+'%':'—'));heading.append(name,number);fill.style.width=(all>0?Math.min(100,value(item)/all*100):0)+'%';fill.style.background=palette[index%palette.length];bar.append(fill);bar.setAttribute('aria-hidden','true');
   for(const [title,v] of [['请求',fmt(item.requests)],['已知 Token',compact(item.knownTokenTotal)]]){const label=node('span',title+' ');label.append(node('b',v));meta.append(label);}if(item.tokenUnknownRequests)meta.append(node('span','用量不完整 '+fmt(item.tokenUnknownRequests),'warn'));row.append(heading,meta,bar);list.append(row);
  });models.append(list);
  let note=card.querySelector('.distribution-note');if(!note){note=node('div',undefined,'distribution-note');card.append(note);}note.replaceChildren(icon('info'),node('span',isTokens?'仅统计已完整采集的 Token；缺失用量不计作 0。':'占比按当前时间范围内的已记录请求计算。'));
 }
 function renderComposition(d){
  let box=byId('usage-composition');if(!box){const modelPanel=byId('usage-models').closest('.distribution-card');let layout=modelPanel.closest('.usage-insights');if(!layout){layout=node('div',undefined,'usage-insights');modelPanel.before(layout);layout.append(modelPanel);}box=node('article',undefined,'card composition-card');box.id='usage-composition';layout.append(box);}box.replaceChildren(panelHeader('请求结果','响应结果与用量记录完整度。','requests'));
  const transport=node('div',undefined,'result-overview'),values=node('div',undefined,'result-values'),track=node('div',undefined,'result-track');
  for(const [label,count,cls] of [['正常结束',d.success,'result-success'],['错误',d.errors,'result-errors']]){const e=node('div',undefined,cls),n=node('div');e.append(node('span',label));n.append(node('strong',compact(count)),node('small',d.requests>0&&Number.isFinite(count)?fmt(count/d.requests*100)+'%':'—'));e.append(n);values.append(e);const fill=node('span',undefined,cls);fill.style.width=(d.requests>0&&Number.isFinite(count)?Math.min(100,count/d.requests*100):0)+'%';track.append(fill);}track.setAttribute('aria-hidden','true');transport.append(values,track);box.append(transport);
  const traits=node('div',undefined,'result-traits');for(const [label,count,kind] of [['用量完整',d.tokenKnownRequests,'tokens'],['用量待补全',d.tokenUnknownRequests,'errors'],['已估算费用',d.pricedRequests,'cost'],['尚未计价',d.unpricedRequests,'rpm']]){const e=node('div',undefined,'result-trait result-trait-'+kind),mark=node('span',undefined,'result-trait-icon'),c=node('div'),v=node('div');mark.append(icon(kind));v.append(node('strong',compact(count)),node('small',d.requests>0&&Number.isFinite(count)?fmt(count/d.requests*100)+'%':'—'));c.append(node('span',label),v);e.append(mark,c);traits.append(e);}box.append(traits);
  const footer=node('div',undefined,'result-footer');for(const [label,count] of [['连接取消',d.cancelled],['待核实',d.uncertain],['等待完成',d.pending]]){const item=node('span',label+' ');item.append(node('b',fmt(count)));footer.append(item);}box.append(footer);
 }
 async function loadUsage(){
  usageController?.abort();const control=new AbortController();usageController=control;byId('usage-refresh').disabled=true;byId('usage').setAttribute('aria-busy','true');
  try{const d=await read('/api/usage?'+rangeQuery(),control);if(usageController!==control)return;
   if(!Number.isSafeInteger(d.requests)||!Array.isArray(d.models))throw Error('统计数据格式不完整');latestUsage=d;
   const box=byId('usage-cards'),period=byId('usage-range').value==='today'?'今日':'区间';box.replaceChildren();box.append(
    card(period+'请求数',compact(d.requests),'成功 '+fmt(d.success)+' · 错误 '+fmt(d.errors),'requests'),
    card('已知 TOKEN',d.tokenKnownRequests?compact(d.knownTokenTotal):'未知',fmt(d.tokenUnknownRequests)+' 次用量未知或不完整','tokens'),
    card('估算费用',d.pricedRequests?money(d.estimatedCostKnownSubtotal):'未知',fmt(d.pricedRequests)+' 次已估价 · '+fmt(d.unpricedRequests)+' 次未计价','cost'),
    card('RPM',fmt(d.rpm),'每分钟派单数','rpm'),
    card('已知 TPM',compact(d.tpmKnown),fmt(d.tpmUnknownRequests)+' 次近期响应用量未知','tpm'),
    card('响应错误率',Number.isFinite(d.errorRate)?fmt(d.errorRate*100)+'%':'未知','平均延迟 '+(Number.isFinite(d.averageDurationMs)?fmt(d.averageDurationMs)+'ms':'未知'),'errors')
   );renderModels(d);renderComposition(d);byId('usage-message').textContent='更新于 '+time(Date.now())+recordingWarning(d);byId('usage').classList.remove('analytics-stale');
  }catch(e){if(usageController!==control||e.name==='AbortError')return;byId('usage-message').textContent='统计读取失败，旧数据已过期：'+e.message;byId('usage').classList.add('analytics-stale');}
  finally{if(usageController===control){byId('usage-refresh').disabled=false;byId('usage').removeAttribute('aria-busy');}}
 }
 function pair(container,title,value,cls){const p=node('div',undefined,'metric-cell '+(cls||''));p.append(node('small',title),node('span',value));container.append(p);return p;}
 function requestCard(r){
  const box=node('article',undefined,'request-card'),detail=node('details',undefined,'request-diagnostics'),summary=node('summary',undefined,'request-summary'),grid=node('div',undefined,'request-grid');box.dataset.requestId=String(r.id);
  const endedBeforeClose=r.metrics?.streamDoneSeen===true&&r.metrics?.transportComplete!==true&&['cancelled','uncertain'].includes(r.outcome);
  const outcomeLabel=endedBeforeClose?'结束标记已收到 · 连接关闭':labels[r.outcome]||'未知',statusKind=r.outcome==='success'?'good':['http_error','application_error','rejected'].includes(r.outcome)?'bad':'warn',u=r.metrics?.usage;
  const status=node('div',undefined,'request-status-cell'),model=node('div',undefined,'request-model-cell'),account=node('div',undefined,'request-account-cell'),type=node('div',undefined,'request-type-cell');
  status.append(node('span',Number.isFinite(r.httpStatus)?r.httpStatus:outcomeLabel,'badge '+statusKind));status.title=outcomeLabel;model.append(node('strong',r.requestedModel||r.model||'模型未知','request-model'));
  account.append(node('span','账号 #'+(r.account??'未知')),node('small','实例 '+(r.slot||'未知')));type.append(node('span',r.stream?'stream':'同步','badge stream-badge'));grid.append(status,model,account,type);
  const tokens=pair(grid,'TOKEN  输入 / 输出',compact(u?.input)+' / '+compact(u?.output),'metric-token');tokens.title='输入 '+fmt(u?.input)+' / 输出 '+fmt(u?.output);
  pair(grid,'缓存 / 思考',compact(u?.cached)+' / '+compact(u?.reasoning),'metric-cache');
  pair(grid,'首内容 / 总耗时',seconds(r.metrics?.firstContentMs)+' / '+seconds(r.metrics?.durationMs),'metric-duration');
  pair(grid,'估算费用',money(r.cost?.amount),'metric-price');
  const when=node('time',time(r.createdAt),'request-time'),created=new Date(r.createdAt);if(Number.isFinite(r.createdAt)&&Number.isFinite(created.getTime()))when.dateTime=created.toISOString();grid.append(when);
  const more=node('span',undefined,'request-expand');more.append(node('span','详情'),icon('chevron'));grid.append(more);summary.append(grid);detail.append(summary);
  const body=node('div',undefined,'request-detail-body'),intro=node('div',undefined,'request-detail-intro');intro.append(node('span',outcomeLabel,'badge '+statusKind),node('span',(sources[u?.source]||'用量未提供')+' · '+(r.metrics?.usageComplete?'响应用量采集完整':'用量缺失或采集不完整'),'muted'));body.append(intro);
  if(endedBeforeClose)body.append(node('p','已收到模型结束标记，HTTP 传输未确认完整结束；不代表用户主动取消，也不代表实例执行账本已结算。','warn'));
  if(!Number.isFinite(r.cost?.amount))body.append(node('p','尚未计价：'+(r.cost?.reason||'未记录结束'),'muted'));
  if(r.outcome==='pending')body.append(node('p','可能仍在执行，或因重启、记录失败未写入结束。请结合实例运行状态判断。','warn'));
  const exact=node('div',undefined,'exact-metrics');for(const [title,value] of [['输入 Token',u?.input],['输出 Token',u?.output],['缓存 Token',u?.cached],['思考 Token',u?.reasoning]])pair(exact,title,fmt(value));body.append(exact);
  body.append(node('p','响应结束与实例执行结算是独立状态；记录不保存提示词及回复正文。','muted'),node('code',r.id,'request-id'));detail.append(body);box.append(detail);return box;
 }
 function tableHead(){const head=node('div',undefined,'request-table-head');head.setAttribute('aria-hidden','true');for(const title of ['状态','模型','来源账号','类型','TOKEN','缓存 / 思考','首内容 / 总耗时','估算费用','时间',''])head.append(node('span',title));return head;}
 function pager(){byId('history-prev').disabled=historyBusy||page<=1;byId('history-next').disabled=historyBusy||page*20>=total;byId('history-page').textContent='第 '+page+' / '+Math.max(1,Math.ceil(total/20))+' 页 · 共 '+total+' 条';}
 async function loadHistory(){
  historyController?.abort();const control=new AbortController();historyController=control;historyBusy=true;pager();byId('history-refresh').disabled=true;byId('history-list').setAttribute('aria-busy','true');
  const params=new URLSearchParams({page:String(page),pageSize:'20'});for(const [key,value] of Object.entries(applied))if(value!=='')params.set(key,value);
  try{const d=await read('/api/requests?'+params.toString(),control);if(historyController!==control)return;if(!Array.isArray(d.items)||!Number.isSafeInteger(d.total))throw Error('记录数据格式不完整');
   total=d.total;const last=Math.max(1,Math.ceil(total/20));if(page>last){page=last;loadHistory();return;}
   const list=byId('history-list'),open=new Set([...list.querySelectorAll('.request-card')].filter(e=>e.querySelector('details[open]')).map(e=>e.dataset.requestId));list.replaceChildren();
   if(d.items.length)list.append(tableHead());for(const item of d.items){const row=requestCard(item);row.querySelector('details').open=open.has(String(item.id));list.append(row);}
   if(!d.items.length)list.append(node('div','暂无匹配记录，请调整筛选条件或稍后刷新。','empty'));
   byId('history-message').textContent='更新于 '+time(Date.now())+recordingWarning(d);byId('history').classList.remove('analytics-stale');
  }catch(e){if(historyController!==control||e.name==='AbortError')return;byId('history-message').textContent='记录读取失败，旧数据已过期：'+e.message;byId('history').classList.add('analytics-stale');}
  finally{if(historyController===control){historyBusy=false;byId('history-refresh').disabled=false;byId('history-list').removeAttribute('aria-busy');pager();}}
 }
 function renderAccountDetail(){
  const box=byId('quota-accounts'),a=accountData.find(item=>String(item.id)===String(selectedAccount));box.replaceChildren();
  if(!a){box.append(node('div','该账号已不在当前账号池中。','card empty'));return;}
  byId('account-dialog-title').textContent=a.name||'未命名账号';byId('account-dialog-subtitle').textContent='账号 #'+a.id+' · '+(a.owner?'实例 '+a.owner:a.cooldownUntil>Date.now()?'冷却中':'未分配');
  const overview=node('div',undefined,'account-detail-overview'),title=node('h3','状态与额度'),fields=node('div',undefined,'account-detail-fields');overview.append(title);pair(fields,'当前实例',a.owner||'未分配');pair(fields,'账号状态',a.cooldownUntil>Date.now()?'冷却中':a.owner?'已分配':'备用');pair(fields,'计数来源','本地账本');pair(fields,'额度范围','模型独立');overview.append(fields);box.append(overview);
  if(a.cooldownUntil>Date.now())box.append(node('div','账号冷却至 '+time(a.cooldownUntil),'note warn'));
  if(!a.quota){box.append(node('div','额度信息不可用，不代表余额为零。','note warn'));return;}
  const models=Object.values(a.quota.models||{});if(!models.length){box.append(node('div','尚未配置模型额度策略','empty'));return;}
  const heading=node('div',undefined,'quota-section-heading');heading.append(node('h3','模型额度'),node('span',models.length+' 个模型','badge'));box.append(heading);
  const list=node('div',undefined,'quota-model-list');
  for(const q of models){
   const row=node('div',undefined,'quota'),line=node('div',undefined,'quota-label'),valid=Number.isFinite(q.used)&&Number.isFinite(q.limit)&&q.limit>0,remaining=valid?Math.max(0,q.limit-q.used):undefined,percent=valid?remaining/q.limit*100:undefined;
   const name=node('div',undefined,'quota-model-name');name.append(node('strong',q.model),node('small',q.legacyBlocked?'历史记录待核实':valid?'已记录 '+fmt(q.used)+' 次 / 上限 '+fmt(q.limit)+' 次':'额度信息未提供'));
   const state=node('div',undefined,'quota-model-state'),reset=q.legacyBlocked?'历史窗口截止 '+time(q.legacyUntil):q.cooldownUntil>Date.now()?'冷却至 '+time(q.cooldownUntil):q.windowEnd?'窗口结束 '+time(q.windowEnd):'额度窗口尚未启用';state.append(node('small',reset,q.cooldownUntil>Date.now()?'warn':''),node('strong',q.legacyBlocked?'待核实':valid?fmt(percent)+'%':'未知',q.legacyBlocked?'warn':''));line.append(name,state);row.append(line);
   if(valid&&!q.legacyBlocked){const bar=node('progress');bar.max=q.limit;bar.value=remaining;bar.setAttribute('aria-label',q.model+' 本地剩余次数 '+remaining);if(percent<=20)bar.className='quota-low';row.append(bar);}list.append(row);
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
