'use strict';
// Build channel page (#build). Token usage per account; every account type can use Build.
(()=>{
 const $=id=>document.getElementById(id);
 const fmt=n=>Number.isFinite(n)?n.toLocaleString('zh-CN'):'—';
 const short=n=>!Number.isFinite(n)?'—':n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e4?(n/1e3).toFixed(1)+'K':n.toLocaleString('zh-CN');
 const time=v=>Number.isFinite(v)&&v>0?new Date(v).toLocaleString('zh-CN',{hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
 const clock=v=>Number.isFinite(v)&&v>0?new Date(v).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'}):'—';
 const tierName={standard:'Free',pro:'Pro',ultra:'Ultra',ultra20:'Ultra 20x'};
 const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;};
 const svg=name=>{const s=document.createElementNS('http://www.w3.org/2000/svg','svg'),u=document.createElementNS('http://www.w3.org/2000/svg','use');s.classList.add('icon');s.setAttribute('aria-hidden','true');u.setAttribute('href','#'+name);s.append(u);return s;};
 const badge=(text,kind)=>el('span','badge'+(kind?' '+kind:''),text);
 const cell=(tr,content,cls)=>{const td=el('td',cls);if(content instanceof Node)td.append(content);else td.textContent=content;tr.append(td);return td;};
 const two=(a,b)=>{const f=document.createDocumentFragment();f.append(document.createTextNode(a));if(b)f.append(el('span','sub',b));return f;};
 const empty=(body,cols,text)=>{const tr=el('tr');const td=cell(tr,text,'empty');td.colSpan=cols;body.replaceChildren(tr);};
 const stat=(label,value,note,icon)=>{const a=el('article','card stat'),h=el('div','stat-heading'),m=el('span','stat-mark');m.append(svg(icon));h.append(el('span',null,label),m);a.append(h,el('strong',null,value),el('small',null,note||''));return a;};
 let timer=null,loading=false;
 async function load(){
  if(loading||location.hash!=='#build')return;loading=true;
  const msg=$('build-message');
  try{
   const r=await fetch('/api/build-status',{credentials:'same-origin',redirect:'error',headers:{Accept:'application/json'}});
   if(r.status===401||r.status===403)throw Error('登录已失效，请重新登录');
   const d=await r.json();if(!r.ok)throw Error(typeof d.error==='string'?d.error:'读取失败');
   render(d);msg.textContent='更新于 '+clock(Date.now());
  }catch(e){msg.textContent='读取失败：'+e.message;}
  finally{loading=false;clearTimeout(timer);if(location.hash==='#build')timer=setTimeout(load,15000);}
 }
 function state(a,now){
  if(a.cooldownUntil>now)return badge('冷却至 '+clock(a.cooldownUntil),'warn');
  if(!a.allowed)return badge('额度已用完','bad');
  return badge('可用','good');
 }
 function render(d){
  const acc=d.accounts||[],now=Date.now();
  const sum=k=>acc.reduce((n,a)=>n+(a[k]||0),0);
  const input=sum('input'),cached=sum('cached'),ready=acc.filter(a=>a.allowed&&!(a.cooldownUntil>now)).length;
  const rot=d.appletRotation||{},rotAcc=Object.values(rot.accounts||{}),lastRot=Math.max(0,...rotAcc.map(x=>x.lastAt||0));
  $('build-cards').replaceChildren(
   stat('今日 Token',short(sum('used')),'输入 '+short(input)+' · 输出 '+short(sum('output')),'i-zap'),
   stat('缓存命中',input?Math.round(cached/input*100)+'%':'—',short(cached)+' Token','i-activity'),
   stat('今日请求',fmt(sum('requests')),sum('failed')?'失败 '+fmt(sum('failed')):'无失败','i-list'),
   stat('可用账号',ready+' / '+acc.length,lastRot?'上次清理 '+time(lastRot):'每晚 3:00 自动清理','i-users'));
  const rows=$('build-accounts');
  if(!acc.length)empty(rows,7,'还没有账号开通 Build');
  else rows.replaceChildren(...acc.map(a=>{const tr=el('tr');
   cell(tr,'#'+a.account);cell(tr,badge(tierName[a.tier]||a.tier,a.tier==='standard'?'muted':''));
   cell(tr,fmt(a.used),'num');cell(tr,two(fmt(a.input),fmt(a.output)),'num');cell(tr,fmt(a.cached),'num');
   cell(tr,two(fmt(a.requests),a.failed?'失败 '+a.failed:''),'num');cell(tr,state(a,now));return tr;}));
  const agg={};for(const a of acc)for(const [m,v] of Object.entries(a.models||{})){const x=agg[m]||(agg[m]={requests:0,tokens:0});x.requests+=v.requests;x.tokens+=v.tokens;}
  const list=Object.entries(agg).sort((a,b)=>b[1].tokens-a[1].tokens),models=$('build-models');
  if(!list.length)empty(models,4,'今日还没有调用');
  else models.replaceChildren(...list.map(([m,v])=>{const tr=el('tr');cell(tr,m);cell(tr,fmt(v.requests),'num');cell(tr,fmt(v.tokens),'num');cell(tr,v.requests?fmt(Math.round(v.tokens/v.requests)):'—','num');return tr;}));
  const items=d.recent||[],recent=$('build-recent');
  if(!items.length)empty(recent,7,'暂无记录');
  else recent.replaceChildren(...items.map(x=>{const tr=el('tr');
   cell(tr,time(x.at));cell(tr,'#'+x.account);cell(tr,x.model);
   cell(tr,x.status===200?badge('成功','good'):badge(String(x.status||'失败'),'bad'));
   cell(tr,x.input==null?'—':two(fmt(x.input),x.cached?'缓存 '+fmt(x.cached):''),'num');
   cell(tr,x.output==null?'—':fmt(x.output),'num');cell(tr,(x.ms/1000).toFixed(1)+'s','num');return tr;}));
 }
 const init=()=>{const b=$('build-refresh');if(b)b.addEventListener('click',load);load();};
 addEventListener('hashchange',load);
 document.addEventListener('ais-refresh',load);
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
