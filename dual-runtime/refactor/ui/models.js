 'use strict';
(() => {
  let data, loading=false, submitting=false, available=false;
  const buttons=new Map();
  let policyDirty=false,editRevision=null;
  function policyGate(){
    const blocked=loading||submitting||!available||!fresh||state?.halted||
      !Number.isSafeInteger(data?.policyState?.revision)||data?.policyState?.blocked||
      state?.queue>0||Object.values(state?.slots||{}).some(s=>s.active>0||s.operation||s.pending);
    $("policy-save").disabled=Boolean(blocked)||!$("policy-model").value||!$("policy-bucket").value;
    for(const id of ["policy-model","policy-bucket","policy-anti"])$(id).disabled=loading||submitting;
  }
  function selectPolicy(){
    const id=$("policy-model").value,p=data?.policyState?.policies?.[id];
    $("policy-bucket").value=p?.quotaFamily||"";
    $("policy-anti").checked=p?.antiTruncation===true;
    editRevision=data?.policyState?.revision;
    policyDirty=false;policyGate();
  }
  function renderPolicies(){
    if(policyDirty){
      $("policy-message").textContent=editRevision!==data?.policyState?.revision?
        "规则版本已变化，保留你的编辑；保存时将核对冲突。":"正在编辑，自动刷新不会覆盖输入。";
      policyGate();return;
    }
    const selected=$("policy-model").value,ids=new Set();
    for(const item of Object.values(data?.slots||{})){
      for(const m of item?.catalog?.snapshot?.models||[]){
        if(typeof m.id==="string" && m.methods?.includes("generateContent"))ids.add(m.id);
      }
    }
    $("policy-model").replaceChildren(new Option("请选择模型",""));
    orderSelect($("policy-model"),[...ids].sort());
    if(ids.has(selected))$("policy-model").value=selected;
    selectPolicy();
    $("policy-message").textContent=data?.policyState?.blocked?
      "策略存储状态待核实，暂不能保存。":"";
  }
  async function savePolicy(){
    policyGate();if($("policy-save").disabled)return;
    const body={model:$("policy-model").value,quotaFamily:$("policy-bucket").value,
      antiTruncation:$("policy-anti").checked,revision:editRevision};
    if(!confirm("保存 "+body.model+" 的额度规则？"))return;
    submitting=true;gate();
    try{
      const result=await api("/api/models/policy",body);
      if(result.saved!==true)throw Error("规则未保存，请刷新状态");
      policyDirty=false;notice("规则已保存");
    }catch(e){notice("保存未确认："+e.message+"。请先核实版本，不要连续重复提交。");}
    finally{submitting=false;await refresh();await readCatalog();gate();}
  }

  const phrases={
    checking:'检查实例',starting:'启动待确认',syncing:'同步中',
    uncertain:'状态待核实',settling:'等待操作收尾',
    slot_not_idle:'实例当前非空闲',worker_not_idle:'实例当前非空闲',
    slot_operation_running:'实例有其他操作',
    retry_later:'请等待重试间隔',already_syncing:'已有同步任务',
    catalog_start_unconfirmed:'同步是否启动尚未确认',
    catalog_preflight_failed:'同步前检查失败',
    catalog_status_unavailable:'目录状态暂不可读',
    upstream_catalog_sync_failed:'目录同步失败',
    catalog_job_identity_unconfirmed:'同步任务标识未确认',
    catalog_reconciliation_unavailable:'无法核实同步任务状态'
  };
  const explain=value => phrases[value] || value || '—';
  function gate() {
    policyGate();
    for(const [slot,button] of buttons){
      const item=data?.slots?.[slot],s=state?.slots?.[slot];
      button.disabled=loading||submitting||!available||!fresh||state?.halted||
        !s?.ready||s.active!==0||Boolean(s.operation)||Boolean(s.pending)||
        s.rotationBlocked||Boolean(item?.operation)||Boolean(item?.catalog?.syncing)||
        Boolean(data?.errors?.[slot])||(item?.catalog?.retryAt||0)>Date.now();
    }
    $('catalog-read').disabled=loading||submitting;
  }
  function family(id){
    const p=data?.policyState?.policies?.[id]?.quotaFamily,n=id.toLowerCase();
    return p==='ultra'||/ultra|argon|deep/.test(n)?'ultra':p==='pro'||/pro\b|-pro/.test(n)?'pro':p==='flash'||/flash|lite/.test(n)?'flash':'other';
  }
  function avatar(id){
    const i=el('img',undefined,'catalog-model-avatar');i.src='/console-assets/nai-mdl-'+family(id)+'.webp';
    i.alt='';i.loading='lazy';i.decoding='async';return i;
  }
  // Request counts for the last 30 days; models never used stay hidden until asked for.
  let usage=new Map(),usageAt=0,showAll=false;
  async function readUsage(){
    if(Date.now()-usageAt<60000)return;usageAt=Date.now();
    try{const now=Date.now(),d=await api('/api/usage?'+new URLSearchParams({from:String(now-30*86400000),to:String(now)}));
      usage=new Map((d.models||[]).filter(m=>typeof m.model==='string').map(m=>[m.model,Number(m.requests)||0]));
      window.aisModelUsage=usage;document.dispatchEvent(new Event('ais-model-usage'));}
    catch{usageAt=0;}
  }
  const used=id=>(usage.get(id)||0)>0;
  function catalogModels(){
    const map=new Map();
    for(const slot of Object.keys(data?.slots||{}).length?Object.keys(data.slots):['A','B']){
      const item=data?.slots?.[slot],snapshot=item?.catalog?.snapshot;
      for(const model of snapshot?.models||[]){
        if(typeof model.id!=='string')continue;
        const e=map.get(model.id)||{id:model.id,slots:[],methods:new Set(),updatedAt:0};
        e.slots.push(slot);for(const m of Array.isArray(model.methods)?model.methods:[])e.methods.add(m);
        e.updatedAt=Math.max(e.updatedAt,snapshot.updatedAt||0);map.set(model.id,e);
      }
    }
    return [...map.values()].sort((x,y)=>(usage.get(y.id)||0)-(usage.get(x.id)||0)||x.id.localeCompare(y.id));
  }
  function orderSelect(select,ids){
    const keep=select.value,first=select.options[0];const live=ids.filter(used),idle=ids.filter(id=>!used(id));
    select.replaceChildren(first);
    if(!live.length){for(const id of idle)select.add(new Option(id,id));}
    else{for(const id of live)select.add(new Option(id,id));
      if(idle.length){const g=document.createElement('optgroup');g.label='未使用';for(const id of idle)g.append(new Option(id,id));select.append(g);}}
    if(ids.includes(keep))select.value=keep;
  }
  window.aisOrderModelSelect=orderSelect;
  function rows() {
    const target=$('catalog-rows');target.replaceChildren();
    const filter=$('catalog-search').value.trim().toLowerCase();
    const fragment=document.createDocumentFragment();let count=0,hidden=0;
    const all=catalogModels(),anyUsed=all.some(e=>used(e.id));
    for(const e of all){
      if(!e.id.toLowerCase().includes(filter))continue;
      if(!filter&&!showAll&&anyUsed&&!used(e.id)){hidden++;continue;}
      const row=el('tr'),identity=el('td'),modelName=el('div',undefined,'catalog-model-name');
      modelName.append(avatar(e.id),el('strong',e.id));identity.append(modelName);
      const owner=el('td');for(const slot of e.slots)owner.append(el('span',slot,'badge slot-chip'));
      const n=usage.get(e.id)||0,uses=el('td',n?n.toLocaleString('zh-CN'):'—','catalog-uses');
      const caps=el('td',undefined,'catalog-methods');
      if(e.methods.has('generateContent'))caps.append(el('span','文本','catalog-method'));
      for(const m of e.methods)if(!['generateContent','countTokens'].includes(m))caps.append(el('span',m,'catalog-method'));
      row.classList.toggle('idle',!n);row.title='目录更新 '+date(e.updatedAt);
      row.append(identity,owner,uses,caps);fragment.append(row);count++;
    }
    if(!count){const row=el('tr'),cell=el('td',filter?'没有匹配的模型':hidden?'近 30 天没有使用记录':'尚无成功同步的目录');cell.colSpan=4;row.append(cell);fragment.append(row);}
    target.append(fragment);
    const more=$('catalog-more');more.hidden=Boolean(filter)||(!hidden&&!showAll);
    more.textContent=showAll?'只看使用过的':'显示未使用（'+hidden+'）';
  }
  function renderCatalog() {
    $('catalog-workers').replaceChildren();buttons.clear();
    const hl=!!data.slots?.H;
    for(const slot of hl?['H']:['A','B']){
      const item=data.slots[slot]||{},c=item.catalog,snapshot=c?.snapshot;
      const box=el('article',undefined,'card worker catalog-worker'),head=el('div',undefined,'worker-head');
      const phase=data.errors?.[slot]?'状态不可读':item.operation?
        explain(item.operation.phase):c?.syncing?'同步中':c?.error?'同步失败':
        snapshot?(snapshot.stale?'历史目录':'已有目录'):'未同步';
      const identity=el('div',undefined,'catalog-worker-identity'),title=el('div');
      title.append(el('h2',hl?'无浏览器服务':'实例 '+slot),el('small',(hl?'所有账号共用':'#'+(item.account??'—'))+' · '+(snapshot?.models?.length??'—')+' 个模型','muted'));
      identity.append(el('span',hl?'H':slot,'catalog-slot-icon'),title);
      head.append(identity,el('span',phase,'badge '+(snapshot&&!snapshot.stale&&!c?.error&&!data.errors?.[slot]?'good':'warn')));
      box.title='最近更新 '+date(snapshot?.updatedAt);box.append(head);
      const error=data.errors?.[slot]||item.operation?.error||c?.error;
      if(error)box.append(el('p',explain(error),'warn'));
      if(data.errors?.[slot]&&snapshot)box.append(el('p','显示的是旧目录','warn'));
      const button=el('button','同步','catalog-sync');button.type='button';
      button.addEventListener('click',() => sync(slot));buttons.set(slot,button);
      box.append(button);$('catalog-workers').append(box);
    }
    renderPolicies();rows();gate();
  }
  async function readCatalog() {
    if(loading||submitting)return;loading=true;gate();
    try{
      const [result]=await Promise.all([api('/api/models'),readUsage()]);
      if(!result||typeof result.slots!=='object'||!result.slots)throw Error('目录接口格式错误');
      data=result;available=true;renderCatalog();
      $('catalog-message').textContent='';
    }catch(e){
      available=false;
      $('catalog-message').textContent='目录状态读取失败，保留的内容为旧数据。'+e.message;
    }finally{loading=false;gate();}
  }
  async function sync(slot) {
    gate();if(buttons.get(slot)?.disabled)return;
    if(!confirm(slot==='H'?'重新读取无浏览器服务的模型目录？':'同步实例 '+slot+' 的模型目录？'))return;
    submitting=true;gate();
    try{
      const result=await api('/api/models/refresh',{slot});
      notice(result.pending?'同步状态待确认，请勿重复提交':
        result.accepted?'同步中':'未启动：'+explain(result.reason));
    }catch(e){notice('同步提交未确认。'+e.message+'。请先刷新任务状态，避免重复提交。');}
    finally{submitting=false;await refresh();await readCatalog();gate();}
  }

  $("policy-model").addEventListener("change",()=>{selectPolicy();renderPolicies();});
  for(const id of ["policy-bucket","policy-anti"])$(id).addEventListener("change",()=>{
    policyDirty=true;policyGate();
  });
  $("policy-save").addEventListener("click",savePolicy);
  $('catalog-read').addEventListener('click',readCatalog);
  $('catalog-search').addEventListener('input',rows);
  $('catalog-more').addEventListener('click',()=>{showAll=!showAll;rows();});
  addEventListener('hashchange',() => {if(location.hash==='#models')readCatalog();});
  setInterval(() => {
    gate();if(!document.hidden&&location.hash==='#models')readCatalog();
  },5000);
  if(location.hash==='#models')readCatalog();
})();
