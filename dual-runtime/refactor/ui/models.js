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
    $("policy-model").replaceChildren(new Option("请选择已同步模型",""));
    for(const id of [...ids].sort())$("policy-model").add(new Option(id,id));
    if(ids.has(selected))$("policy-model").value=selected;
    selectPolicy();
    $("policy-message").textContent=data?.policyState?.blocked?
      "策略存储状态待核实，暂不能保存。":"规则版本 "+(data?.policyState?.revision??"未知")+" · 未配置模型不会自动分配额度类别";
  }
  async function savePolicy(){
    policyGate();if($("policy-save").disabled)return;
    const body={model:$("policy-model").value,quotaFamily:$("policy-bucket").value,
      antiTruncation:$("policy-anti").checked,revision:editRevision};
    if(!confirm("保存 "+body.model+" 的额度规则？仅影响后续派单，不重置已用额度。"))return;
    submitting=true;gate();
    try{
      const result=await api("/api/models/policy",body);
      if(result.saved!==true)throw Error("规则未保存，请刷新状态");
      policyDirty=false;notice("规则已保存；可用性仍取决于同步目录与实例状态。");
    }catch(e){notice("保存未确认："+e.message+"。请先核实版本，不要连续重复提交。");}
    finally{submitting=false;await refresh();await readCatalog();gate();}
  }

  const phrases={
    checking:'检查实例',starting:'启动待确认',syncing:'同步中',
    uncertain:'状态待核实',settling:'等待操作收尾',
    slot_not_idle:'实例当前非空闲',worker_not_idle:'worker 当前非空闲',
    slot_operation_running:'实例有其他操作',
    retry_later:'请等待重试间隔',already_syncing:'已有同步任务',
    catalog_start_unconfirmed:'同步是否启动尚未确认',
    catalog_preflight_failed:'同步前检查失败',
    catalog_status_unavailable:'目录状态暂不可读',
    upstream_catalog_sync_failed:'上游目录同步失败',
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
  function rows() {
    const target=$('catalog-rows');target.replaceChildren();
    const filter=$('catalog-search').value.trim().toLowerCase();
    const fragment=document.createDocumentFragment();let count=0;
    for(const slot of ['A','B']){
      const item=data?.slots?.[slot],snapshot=item?.catalog?.snapshot;
      for(const model of snapshot?.models||[]){
        if(typeof model.id!=='string'||!model.id.toLowerCase().includes(filter))continue;
        const row=el('tr'),identity=el('td'),modelName=el('div',undefined,'catalog-model-name');
        modelName.append(el('span','G','catalog-model-avatar'),el('strong',model.id));identity.append(modelName);
        const owner=el('td'),ownerLabel=el('span','实例 '+slot,'badge');
        owner.append(ownerLabel,el('small','账号 #'+item.account,'catalog-account'));
        const methods=el('td'),methodList=el('div',undefined,'catalog-methods');
        for(const method of Array.isArray(model.methods)&&model.methods.length?model.methods:['未知']){
          methodList.append(el('span',method==='generateContent'?'文本生成':method==='countTokens'?'Token 计数':method,'catalog-method'));
        }
        methods.append(methodList);row.append(identity,owner,methods,el('td',date(snapshot.updatedAt),'catalog-updated'));
        fragment.append(row);count++;
      }
    }
    if(!count){const row=el('tr'),cell=el('td',filter?'没有匹配的模型':'尚无成功同步的目录');cell.colSpan=4;row.append(cell);fragment.append(row);}
    target.append(fragment);
  }
  function renderCatalog() {
    $('catalog-workers').replaceChildren();buttons.clear();
    for(const slot of ['A','B']){
      const item=data.slots[slot]||{},c=item.catalog,snapshot=c?.snapshot;
      const box=el('article',undefined,'card worker catalog-worker'),head=el('div',undefined,'worker-head');
      const phase=data.errors?.[slot]?'状态不可读':item.operation?
        explain(item.operation.phase):c?.syncing?'同步中':c?.error?'同步失败':
        snapshot?(snapshot.stale?'历史目录':'已有目录'):'未同步';
      const identity=el('div',undefined,'catalog-worker-identity'),title=el('div');
      title.append(el('h2','实例 '+slot),el('small','账号 #'+(item.account??'—'),'muted'));
      identity.append(el('span',slot,'catalog-slot-icon'),title);
      head.append(identity,el('span',phase,'badge '+(snapshot&&!snapshot.stale&&!c?.error&&!data.errors?.[slot]?'good':'warn')));
      const metric=el('div',undefined,'catalog-count');metric.append(el('strong',snapshot?.models?.length??'—'),el('span','已同步模型','muted'));
      box.append(head,metric,el('p','最近更新 '+date(snapshot?.updatedAt),'catalog-timestamp'));
      const error=data.errors?.[slot]||item.operation?.error||c?.error;
      if(error)box.append(el('p',explain(error),'warn'));
      if(data.errors?.[slot]&&snapshot)box.append(el('p','下方保留历史目录，不代表当前状态。','warn'));
      const button=el('button','同步目录','catalog-sync');button.type='button';
      button.addEventListener('click',() => sync(slot));buttons.set(slot,button);
      box.append(button);$('catalog-workers').append(box);
    }
    renderPolicies();rows();gate();
  }
  async function readCatalog() {
    if(loading||submitting)return;loading=true;gate();
    try{
      const result=await api('/api/models');
      if(!result||typeof result.slots!=='object'||!result.slots)throw Error('目录接口格式错误');
      data=result;available=true;renderCatalog();
      $('catalog-message').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN');
    }catch(e){
      available=false;
      $('catalog-message').textContent='目录状态读取失败，保留的内容为旧数据。'+e.message;
    }finally{loading=false;gate();}
  }
  async function sync(slot) {
    gate();if(buttons.get(slot)?.disabled)return;
    if(!confirm('确认同步实例 '+slot+' 的上游模型目录？同步期间暂停该实例派单，不发送生成请求。'))return;
    submitting=true;gate();
    try{
      const result=await api('/api/models/refresh',{slot});
      notice(result.pending?'同步启动结果尚未确认，请观察任务状态，不要重复提交。':
        result.accepted?'已接受同步任务，不代表已同步成功。':'未启动同步。'+explain(result.reason));
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
  addEventListener('hashchange',() => {if(location.hash==='#models')readCatalog();});
  setInterval(() => {
    gate();if(!document.hidden&&location.hash==='#models')readCatalog();
  },5000);
  if(location.hash==='#models')readCatalog();
})();
