'use strict';
// Ops theme: overview status band. Reads the status payload console.js already broadcasts (ais-status); no extra requests.
(()=>{
 const tierName={free:'Free',pro:'Pro',ultra:'Ultra',ultra20:'Ultra 20x'};
 const mk=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n;};
 let band=null;
 const mount=()=>{
  const page=document.getElementById('overview');if(!page||band)return;
  band=mk('div',undefined,'ops-band');band.setAttribute('role','status');band.setAttribute('aria-live','polite');
  band.append(mk('div','正在读取实例状态…','ops-meta'));page.prepend(band);
 };
 const slotState=s=>{
  if(!s)return ['bad','状态缺失'];
  if(s.healthCheck?.error||s.recoveryBlocked||s.rotationBlocked||s.legacyUnresolved)return ['bad','需要处理'];
  if(!s.ready)return ['warn',s.operation?'操作中':'未就绪'];
  if(s.active)return ['busy','处理中'];
  return ['ok','空闲'];
 };
 const render=d=>{
  mount();if(!band)return;
  const slots=d.slots||{},keys=Object.keys(slots).sort(),accounts=d.accounts||[];
  band.style.setProperty('--n',String(Math.max(1,Math.min(keys.length,3))));
  const nodes=[];let ready=0;
  for(const k of keys){if(slots[k]?.ready)ready++;}
  const meta=mk('div',undefined,'ops-meta'),item=(label,value,bad)=>{const sp=mk('span',label+' ');const b=mk('b',value);if(bad)sp.className='bad';sp.append(b);meta.append(sp);};
  item('调度',d.halted?'已暂停':'运行中',d.halted);
  item('在线',ready+' / '+keys.length,ready<keys.length);
  item('排队',d.queue??0,(d.queue??0)>0);
  item('处理中',keys.reduce((n,k)=>n+(slots[k]?.active||0),0));
  item('账号',accounts.length);
  nodes.push(meta);band.replaceChildren(...nodes);
 };
 const fail=()=>{mount();if(band)band.replaceChildren(Object.assign(mk('div','调度服务不可用','ops-meta'),{}));};
 document.addEventListener('ais-status',e=>{try{render(e.detail||{});}catch{fail();}});
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();
// Accounts page: add-account methods behind a tab strip, one at a time; remembers the last one.
(()=>{
 const ready=()=>{
  const root=document.getElementById('accounts-add');if(!root||root.querySelector('.add-tabs'))return;
  const cards=[...root.querySelectorAll('.form-card.legacy')];if(!cards.length)return;
  const label=c=>(c.querySelector('h2')?.firstChild?.textContent||'').trim();
  const short={'Cookie 导入':'Cookie','浏览器油猴脚本':'油猴脚本','账号密码登录':'账号密码','Workspace 激活':'Workspace'};
  const bar=document.createElement('div');bar.className='settings-tabs add-tabs';bar.setAttribute('role','tablist');bar.setAttribute('aria-label','添加方式');
  let cur=0;try{cur=Math.min(cards.length-1,Math.max(0,Number(localStorage.getItem('ais-add-tab'))||0));}catch{}
  const show=i=>{cur=i;cards.forEach((c,n)=>c.classList.toggle('tab-hidden',n!==i));[...bar.children].forEach((b,n)=>{b.setAttribute('aria-selected',String(n===i));b.tabIndex=n===i?0:-1;});try{localStorage.setItem('ais-add-tab',String(i));}catch{}};
  cards.forEach((c,i)=>{const t=label(c);const b=document.createElement('button');b.type='button';b.setAttribute('role','tab');b.dataset.addTab=String(i);b.textContent=short[t]||t||('方式 '+(i+1));b.addEventListener('click',()=>show(i));b.addEventListener('keydown',e=>{const k={ArrowRight:1,ArrowLeft:-1}[e.key];if(!k)return;e.preventDefault();const n=(cur+k+cards.length)%cards.length;show(n);bar.children[n].focus();});bar.append(b);});
  root.prepend(bar);root.classList.add('add-tabbed');show(cur);
 };
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();
})();
