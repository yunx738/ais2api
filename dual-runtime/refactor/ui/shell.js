'use strict';

// Navigation and presentation only. All API requests remain in the page modules.
(() => {
  const body = document.body;
  const toggle = document.getElementById('sidebar-toggle');
  const sheet = document.getElementById('more-menu');
  const more = document.getElementById('mobile-more');
  const description = document.getElementById('page-description');
  const descriptions = {
    overview: '系统概览',
    accounts: '管理账号、模型额度与实例分配',
    usage: '请求日志与性能指标',
    history: '查看每次请求的响应结果与用量',
    models: '查看已同步模型与本地额度规则',
    settings: '实例响应设置与模型参考价格',
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
    more.classList.toggle('selected', sheet.open || page === 'models' || page === 'history');
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
