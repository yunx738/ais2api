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
  if(a.deniedModels&&a.deniedModels.length){const b=badge('可用 · 不支持 '+a.deniedModels.join('、'),'warn');b.title='Google 拒绝了这些模型，6 小时内不会把它们分给这个账号';return b;}
  return badge('可用','good');
 }
 function render(d){
  presets(d.presets||[]);
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
   cell(tr,'#'+a.account);cell(tr,badge((tierName[a.tier]||a.tier)+(a.tier==='standard'?' · 仅 Flash':''),a.tier==='standard'?'muted':''));
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
 // Uploaded SillyTavern presets: their prompt text goes into the Build composer, everything else into the attachment.
 const post=async body=>{const r=await fetch('/api/build/presets',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(typeof d.error==='string'?d.error:'操作失败');return d;};
 const pmsg=(text,bad)=>{const m=$('build-preset-message');if(m){m.textContent=text||'';m.classList.toggle('bad',!!bad);}};
 function presets(list){
  const body=$('build-presets');if(!body)return;
  if(!list.length)return empty(body,6,'还没有上传预设');
  body.replaceChildren(...list.map(p=>{const tr=el('tr');
   const name=el('td');name.append(document.createTextNode(p.name),el('span','prompts',p.prompts.join('、')));name.title=p.prompts.join('\n');tr.append(name);
   cell(tr,fmt(p.prompts.length),'num');cell(tr,fmt(p.requests),'num');cell(tr,time(p.lastHitAt));
   const box=el('input');box.type='checkbox';box.checked=p.enabled;box.setAttribute('aria-label','启用 '+p.name);
   box.addEventListener('change',async()=>{box.disabled=true;try{await post({action:'enable',id:p.id,enabled:box.checked});pmsg('');}catch(e){box.checked=!box.checked;pmsg(e.message,true);}finally{box.disabled=false;}});
   cell(tr,box);
   const del=el('button','small','删除');del.type='button';
   del.addEventListener('click',async()=>{if(!confirm('删除预设“'+p.name+'”？'))return;del.disabled=true;try{await post({action:'remove',id:p.id});load();}catch(e){pmsg(e.message,true);del.disabled=false;}});
   cell(tr,del);return tr;}));
 }
 async function upload(files){
  const done=[];
  for(const f of files){
   try{
    if(f.size>4*1024*1024)throw Error('文件超过 4MB');
    let preset;try{preset=JSON.parse(await f.text());}catch{throw Error('不是有效的 JSON 文件');}
    const r=await post({action:'add',name:f.name,preset});done.push(r.name+'（'+r.prompts+' 个条目）');
   }catch(e){pmsg(f.name+'：'+e.message,true);load();return;}
  }
  pmsg('已上传 '+done.join('、'));load();
 }
 const init=()=>{const b=$('build-refresh');if(b)b.addEventListener('click',load);
  const f=$('build-preset-file');if(f)f.addEventListener('change',()=>{const list=[...f.files];f.value='';if(list.length)upload(list);});
  load();};
 addEventListener('hashchange',load);
 document.addEventListener('ais-refresh',load);
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
