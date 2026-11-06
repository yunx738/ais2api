'use strict';

// Navigation and presentation only. All API requests remain in the page modules.
(() => {
  const body = document.body;
  const toggle = document.getElementById('sidebar-toggle');
  const sheet = document.getElementById('more-menu');
  const more = document.getElementById('mobile-more');
  const description = document.getElementById('page-description');
  const descriptions = {
    overview: '',
    accounts: '',
    add: '',
    usage: '',
    history: '',
    build: '',
    models: '',
    settings: '',
    ops: '服务、日志与维护',
  };
  let restoreOverflow = '';
  let returnFocus = null;

  function updateSidebar(collapsed) {
    body.classList.toggle('sidebar-collapsed', collapsed);
    const label = collapsed ? '展开侧栏' : '收起侧栏';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    toggle.querySelector('span').textContent = label;
  }

  function updateMenuState() {
    const page = location.hash.slice(1);
    more.classList.toggle('selected', sheet.open || page === 'settings' || page === 'ops' || page === 'history' || page === 'add' || page === 'build');
    document.querySelectorAll('[data-more-open]').forEach(button => {
      button.setAttribute('aria-expanded', String(sheet.open));
    });
  }

  function closeMenu() {
    if (sheet.open) sheet.close();
  }

  function updatePage() {
    const page = location.hash.slice(1);
    description.textContent = descriptions[page] || descriptions.overview;
    document.body.dataset.page = page || 'overview';
    closeMenu();
    updateMenuState();
  }

  try { updateSidebar(localStorage.getItem('ais-sidebar-collapsed') === '1'); }
  catch { updateSidebar(false); }

  toggle.addEventListener('click', () => {
    const collapsed = !body.classList.contains('sidebar-collapsed');
    updateSidebar(collapsed);
    try { localStorage.setItem('ais-sidebar-collapsed', collapsed ? '1' : '0'); }
    catch { /* Storage can be unavailable without disabling the navigation. */ }
  });

  document.querySelectorAll('[data-more-open]').forEach(button => {
    button.addEventListener('click', () => {
      if (sheet.open) return;
      returnFocus = button;
      restoreOverflow = body.style.overflow;
      body.style.overflow = 'hidden';
      sheet.showModal();
      updateMenuState();
    });
  });
  document.getElementById('more-close').addEventListener('click', closeMenu);
  sheet.addEventListener('click', event => {
    if (event.target !== sheet) return;
    const rect = sheet.getBoundingClientRect();
    if (event.clientY < rect.top || event.clientY > rect.bottom || event.clientX < rect.left || event.clientX > rect.right) closeMenu();
  });
  sheet.addEventListener('close', () => {
    body.style.overflow = restoreOverflow;
    updateMenuState();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });
  sheet.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
  document.querySelectorAll('[data-theme-toggle]').forEach(button => {
    button.addEventListener('click', () => document.getElementById('theme').click());
  });
  const desktop = matchMedia('(min-width: 1024px)');
  desktop.addEventListener('change', event => { if (event.matches) closeMenu(); });
  addEventListener('hashchange', updatePage);
  updatePage();
})();

// Settings: all groups on one page; the strip jumps to a group, the box filters cards by text.
(()=>{
 const bar=document.querySelector('.settings-tabs');if(!bar)return;
 const groups=[...document.querySelectorAll('#settings .settings-group')];
 const name=g=>(g.querySelector('.group-head h2')?.firstChild?.textContent||'').trim();
 bar.setAttribute('role','navigation');bar.setAttribute('aria-label','设置目录');
 groups.forEach((g,i)=>{const b=document.createElement('button');b.type='button';b.textContent=name(g)||('分组 '+(i+1));b.addEventListener('click',()=>g.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'}));bar.append(b);});
 const q=document.createElement('input');q.type='search';q.className='settings-search';q.placeholder='搜索设置，如 代理、并发';q.setAttribute('aria-label','搜索设置');q.maxLength=40;
 const empty=document.createElement('p');empty.className='note settings-empty';empty.textContent='没有匹配的设置';empty.hidden=true;
 bar.after(q);q.after(empty);
 q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();let any=false;
  for(const g of groups){let hit=0;const gn=name(g).toLowerCase();for(const c of g.querySelectorAll('.settings-cards>.card,.settings-cards>div')){const ok=!v||gn.includes(v)||c.textContent.toLowerCase().includes(v);c.classList.toggle('filter-hidden',!ok);if(ok)hit++;}g.classList.toggle('filter-hidden',!!v&&!hit);if(hit)any=true;}
  empty.hidden=!v||any;});
 try{localStorage.removeItem('ais-settings-tab');}catch{}
})();
