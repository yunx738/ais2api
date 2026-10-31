'use strict';
// Build channel page (#build): separate from the regular per-model request counts.
// Token usage only; Pro/Ultra have no daily token cap, standard accounts are not allowed.
(()=>{
 const $=id=>document.getElementById(id);
 const fmt=n=>Number.isFinite(n)?n.toLocaleString('zh-CN'):'—';
 const short=n=>!Number.isFinite(n)?'—':n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n);
 const time=v=>Number.isFinite(v)&&v>0?new Date(v).toLocaleString('zh-CN',{hour12:false}):'—';
 const tierName={standard:'普通',pro:'Pro',ultra:'Ultra',ultra20:'Ultra 20x'};
 const cell=(tr,text,cls)=>{const td=document.createElement('td');td.textContent=text;if(cls)td.className=cls;tr.append(td);return td;};
 const stat=(label,value,sub)=>{const a=document.createElement('article');a.className='card stat';const s=document.createElement('span');s.textContent=label;const b=document.createElement('strong');b.textContent=value;a.append(s,b);if(sub){const m=document.createElement('small');m.className='muted';m.textContent=sub;a.append(m);}return a;};
 let timer=null,loading=false;
 async function load(){
  if(loading||location.hash!=='#build')return;loading=true;
  const msg=$('build-message');
  try{
   const r=await fetch('/api/build-status',{credentials:'same-origin',redirect:'error',headers:{Accept:'application/json'}});
   if(r.status===401||r.status===403)throw Error('登录状态已失效，请重新登录');
   const d=await r.json();if(!r.ok)throw Error(typeof d.error==='string'?d.error:'读取失败');
   render(d);msg.textContent='更新于 '+time(Date.now())+' · 统计窗口 '+time(d.windowStart)+' 起（每日北京时间 15:00 重置）';
  }catch(e){msg.textContent='读取失败：'+e.message;}
  finally{loading=false;clearTimeout(timer);if(location.hash==='#build')timer=setTimeout(load,15000);}
 }
 function render(d){
  const acc=d.accounts||[];
  const sum=k=>acc.reduce((n,a)=>n+(a[k]||0),0);
  const cards=$('build-cards');cards.replaceChildren(
   stat('今日 Token',short(sum('used')),'输入 '+short(sum('input'))+' · 输出 '+short(sum('output'))),
   stat('其中缓存命中',short(sum('cached')),sum('input')?Math.round(sum('cached')/sum('input')*100)+'% 的输入':''),
   stat('今日请求',fmt(sum('requests')),'失败 '+fmt(sum('failed'))),
   stat('上下文上限',Math.round((d.maxContextBytes||0)/1024)+' KB','单条消息 ≤ '+fmt(d.inlineBudget)+' token'));
  const rows=$('build-accounts');rows.replaceChildren();
  if(!acc.length){const tr=document.createElement('tr');cell(tr,'没有已开通 Build 项目的账号','muted').colSpan=8;rows.append(tr);}
  for(const a of acc){
   const tr=document.createElement('tr');
   cell(tr,'#'+a.account);cell(tr,tierName[a.tier]||a.tier);
   cell(tr,fmt(a.used));cell(tr,fmt(a.input));cell(tr,fmt(a.output));cell(tr,fmt(a.cached));
   cell(tr,fmt(a.requests)+(a.failed?' / 失败 '+a.failed:''));
   const now=Date.now();
   cell(tr,!a.premium||a.limit===0?'不可用（非 Pro/Ultra）':a.cooldownUntil>now?'冷却至 '+time(a.cooldownUntil):a.unlimited?'正常 · 不限额':'剩余 '+fmt(a.remaining));
   rows.append(tr);
  }
  const models=$('build-models');models.replaceChildren();
  const agg={};for(const a of acc)for(const [m,v] of Object.entries(a.models||{})){const x=agg[m]||(agg[m]={requests:0,tokens:0});x.requests+=v.requests;x.tokens+=v.tokens;}
  const list=Object.entries(agg).sort((a,b)=>b[1].tokens-a[1].tokens);
  if(!list.length){const tr=document.createElement('tr');cell(tr,'今日暂无调用','muted').colSpan=4;models.append(tr);}
  for(const [m,v] of list){const tr=document.createElement('tr');cell(tr,m);cell(tr,fmt(v.requests));cell(tr,fmt(v.tokens));cell(tr,v.requests?fmt(Math.round(v.tokens/v.requests)):'—');models.append(tr);}
  const recent=$('build-recent');recent.replaceChildren();
  const items=d.recent||[];
  if(!items.length){const tr=document.createElement('tr');cell(tr,'暂无记录','muted').colSpan=7;recent.append(tr);}
  for(const x of items){
   const tr=document.createElement('tr');
   cell(tr,time(x.at));cell(tr,'#'+x.account);cell(tr,x.model);
   cell(tr,String(x.status),x.status===200?'':'warning');
   cell(tr,x.input==null?'—':fmt(x.input)+(x.cached?'（缓存 '+fmt(x.cached)+'）':''));
   cell(tr,x.output==null?'—':fmt(x.output));
   cell(tr,(x.ms/1000).toFixed(1)+'s');
   recent.append(tr);
  }
 }
 addEventListener('hashchange',load);
 document.addEventListener('ais-refresh',load);
 document.addEventListener('DOMContentLoaded',()=>{const b=$('build-refresh');if(b)b.addEventListener('click',load);load();});
 if(document.readyState!=='loading'){const b=$('build-refresh');if(b)b.addEventListener('click',load);load();}
})();
