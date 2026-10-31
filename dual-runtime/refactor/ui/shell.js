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
    more.classList.toggle('selected', sheet.open || page === 'settings' || page === 'history' || page === 'add' || page === 'build');
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

// Settings: one group at a time behind a tab strip; remembers the last tab.
(()=>{
 const bar=document.querySelector('.settings-tabs');if(!bar)return;
 const groups=[...document.querySelectorAll('#settings .settings-group')];
 const name=g=>(g.querySelector('.group-head h2')?.firstChild?.textContent||'').trim();
 let cur=0;try{cur=Math.min(groups.length-1,Math.max(0,Number(localStorage.getItem('ais-settings-tab'))||0));}catch{}
 const show=i=>{cur=i;groups.forEach((g,n)=>g.classList.toggle('tab-hidden',n!==i));[...bar.children].forEach((b,n)=>b.setAttribute('aria-selected',String(n===i)));try{localStorage.setItem('ais-settings-tab',String(i));}catch{}};
 groups.forEach((g,i)=>{const b=document.createElement('button');b.type='button';b.role='tab';b.textContent=name(g)||('分组 '+(i+1));b.addEventListener('click',()=>show(i));bar.append(b);});
 show(cur);
})();
