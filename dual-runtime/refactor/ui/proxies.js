'use strict';
(()=>{
 const root=document.getElementById('proxy-forms'),message=document.getElementById('proxy-message'),read=document.getElementById('proxy-read');
 const entries=new Map();let loading=false,timer;
 async function call(suffix,body){
  const ctl=new AbortController(),timeout=setTimeout(()=>ctl.abort(),18000);
  try{
   const opt={credentials:'same-origin',redirect:'error',signal:ctl.signal,headers:{Accept:'application/json'}};
   if(body!==undefined){opt.method='POST';opt.headers['Content-Type']='application/json';opt.body=JSON.stringify(body);}
   const res=await fetch('/api/proxies'+suffix,opt);
   if(!(res.headers.get('content-type')||'').includes('application/json'))throw Error('请重新登录管理页');
   const data=await res.json();
   if(!res.ok)throw Error(data.error||'操作失败，请重新读取状态');
   return data;
  }finally{clearTimeout(timeout);}
 }
 function controls(e){
  const d=e.data,disabled=e.busy||!d||d.applying;
  for(const x of e.form.elements)x.disabled=disabled||d.blocked;
  e.apply.disabled=disabled||e.dirty;
  e.rollback.hidden=!d?.blocked;
  e.rollback.disabled=disabled||!d?.blocked||e.dirty;
 }
 for(const slot of ['A','B']){
  const form=document.createElement('form');form.className='card form-card';
  form.innerHTML=`<h3>实例 ${slot} · SOCKS5</h3><p role="status"></p><div class="form-row">
   <label>主机<input name="host" required maxlength="253" placeholder="域名或 IP"></label>
   <label>端口<input name="port" type="number" required min="1" max="65535"></label>
   <label>用户名<input name="username" type="password" autocomplete="new-password" maxlength="512" placeholder="留空保留原用户名"></label>
   <label>密码<input name="password" type="password" autocomplete="new-password" maxlength="512" placeholder="留空保留原密码"></label>
   </div><div class="form-row"><button type="submit" class="primary">保存配置</button>
   <button type="button" data-apply>应用已保存配置</button><button type="button" data-rollback hidden>恢复原容器</button></div>`;
  root.append(form);
  const e={form,data:null,dirty:false,busy:false,status:form.querySelector('p'),apply:form.querySelector('[data-apply]'),rollback:form.querySelector('[data-rollback]')};
  entries.set(slot,e);
  form.addEventListener('input',()=>{e.dirty=true;controls(e);});
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(!e.data||e.busy||e.data.blocked)return;
   const f=form.elements,body={slot,revision:e.data.revision,host:f.host.value.trim(),port:Number(f.port.value),username:f.username.value,password:f.password.value};
   e.busy=true;controls(e);
   try{
    await call('',body);e.dirty=false;
    f.username.value='';f.password.value='';
    message.textContent='实例 '+slot+' 已保存，当前连接未重启。下次重建或点击应用后生效。';
   }catch(error){e.data=null;message.textContent='保存未完成或未确认：'+error.message+'。请重新读取后核对。';}
   finally{e.busy=false;controls(e);await load(false);}
  });
  for(const action of ['apply','rollback'])e[action].addEventListener('click',async()=>{
   if(!e.data||e.busy||e.dirty)return;
   const prompt=action==='apply'?'应用实例 '+slot+' 已保存的代理？仅在实例空闲且请求结算后重建，连接会短暂中断。':'恢复实例 '+slot+' 的原容器及原代理？已保存的新配置仍保留，下次重建仍会使用。';
   if(!confirm(prompt))return;
   e.busy=true;controls(e);
   try{await call('/apply',{slot,revision:e.data.revision,action});message.textContent='实例 '+slot+' 操作已受理，请等待状态更新。';}
   catch(error){message.textContent='操作未完成或未确认：'+error.message;}
   finally{e.busy=false;controls(e);await load(false);}
  });
  controls(e);
 }
 async function load(force){
  if(loading)return;
  loading=true;read.disabled=true;clearTimeout(timer);
  try{
   const data=await call('');
   for(const d of data.slots){
    const e=entries.get(d.slot);if(!e||e.busy)continue;
    if(e.dirty&&!force&&e.data)continue;
    e.data=d;e.dirty=false;
    e.form.elements.host.value=d.host;e.form.elements.port.value=d.port;
    e.form.elements.username.value='';e.form.elements.password.value='';
    e.status.textContent=d.applying?'正在应用，请等待…':d.blocked?(d.error||'上次操作中断，可重试或恢复原容器'):
      d.applied===true?'已保存配置与当前容器一致':d.applied===false?'已保存，尚未应用到当前容器':'当前容器状态暂不可确认';
    e.apply.textContent=d.blocked?'重试上次操作':'应用已保存配置';controls(e);
   }
   if(data.slots.some(d=>d.applying))timer=setTimeout(()=>load(false),3000);
  }catch(error){
   message.textContent='读取失败：'+error.message;
   for(const e of entries.values()){e.data=null;controls(e);}
  }finally{loading=false;read.disabled=false;}
 }
 read.addEventListener('click',()=>{
  if([...entries.values()].some(e=>e.dirty)&&!confirm('重新读取将放弃未保存输入，继续？'))return;
  load(true);
 });
 load(true);
})();
