'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const mk = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  };
  const fmt = n => Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—';
  const fmtK = n => !Number.isFinite(n) || n <= 0 ? '—' : n >= 1048576 ? (n / 1048576).toFixed(n % 1048576 === 0 ? 0 : 1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : String(n);
  const msText = v => !Number.isFinite(v) || v < 0 ? '—' : v < 1000 ? Math.round(v) + 'ms' : (v / 1000).toFixed(2) + 's';

  let csrfToken = '', csrfTask = null;
  async function getCsrf(force) {
    if (csrfToken && !force) return csrfToken;
    if (!csrfTask) {
      csrfTask = (async () => {
        const r = await fetch('/import', { credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
        const t = await r.text();
        const m = /name="import-token" content="([0-9a-f]{64})"/.exec(t) || /const token="([0-9a-f]{64})"/.exec(t);
        if (!m) throw Error('无法获取校验令牌，请刷新页面');
        csrfToken = m[1];
        return csrfToken;
      })().finally(() => { csrfTask = null; });
    }
    return csrfTask;
  }

  async function hlGet(path) {
    const r = await fetch(path, { credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(d?.error?.message || d?.error || ('请求失败 (' + r.status + ')'));
    return d;
  }

  async function hlPost(path, body, retry = true) {
    const r = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Import-Token': await getCsrf(!retry) },
      body: JSON.stringify(body || {})
    });
    if (r.status === 403 && retry) return hlPost(path, body, false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(d?.error?.message || d?.error || ('操作失败 (' + r.status + ')'));
    return d;
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = prev; }, 1400);
      }
    } catch {
      const ta = mk('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = prev; }, 1400);
      }
    }
  }

  // Shared live state from /api/hl/live + /api/models
  let live = { requests: [], cooldowns: [], exits: [], accounts: [], catalog: [], config: {} };
  let publicModels = [];
  let latestCoordStatus = null;
  let liveBusy = false;

  async function refreshLive() {
    if (liveBusy || document.hidden) return;
    liveBusy = true;
    try {
      const d = await hlGet('/api/hl/live');
      if (d && typeof d === 'object') {
        live = {
          requests: Array.isArray(d.requests) ? d.requests : [],
          cooldowns: Array.isArray(d.cooldowns) ? d.cooldowns : [],
          exits: Array.isArray(d.exits) ? d.exits : [],
          accounts: Array.isArray(d.accounts) ? d.accounts : [],
          catalog: Array.isArray(d.catalog) ? d.catalog : [],
          config: d.config || {}
        };
      }
      renderNavBadge();
      renderTelemetry();
      renderPeriodicTable();
      renderExits();
      renderLiveRequests();
      renderEngineSwitches();
      syncModelOptions();
    } catch { /* silent when switching or starting */ }
    finally { liveBusy = false; }
  }

  async function refreshPublicModels() {
    try {
      const d = await hlGet('/api/models');
      const pol = d?.policyState?.policies || {};
      const ids = [];
      for (const [id, p] of Object.entries(pol)) {
        if (id.includes('-build')) continue;
        ids.push(id);
        if (p && p.antiTruncation) ids.push('anti-truncation/' + id);
      }
      ids.sort((a, b) => {
        const ba = a.startsWith('anti-truncation/') ? 1 : 0;
        const bb = b.startsWith('anti-truncation/') ? 1 : 0;
        if (ba !== bb) return ba - bb;
        return a.localeCompare(b);
      });
      if (ids.length) publicModels = ids;
      syncModelOptions();
    } catch {}
  }

  function availableChatModels() {
    if (publicModels.length) return publicModels;
    return live.catalog
      .filter(m => !String(m.id || '').includes('-build') && (m.capabilities?.chat_model !== false))
      .map(m => m.id);
  }

  function renderNavBadge() {
    const link = document.querySelector('.sidebar-nav a[data-page="history"]');
    if (!link) return;
    let pill = link.querySelector('.nav-live-pill');
    const n = live.requests.length;
    if (!n) {
      if (pill) pill.remove();
      return;
    }
    if (!pill) {
      pill = mk('span', '', 'nav-live-pill');
      link.append(pill);
    }
    pill.textContent = n + ' 运行';
  }

  // =========================================================================
  // 0. Overview Telemetry Strip
  // =========================================================================
  function renderTelemetry() {
    const box = $('uf-overview-telemetry');
    if (!box) return;
    const d = latestCoordStatus || {};
    const readyAcc = live.accounts.filter(a => a.enabled && a.state === 'ready').length;
    const totalAcc = live.accounts.length || (d.accounts || []).length;
    const runningReq = live.requests.length;
    const coolingCnt = live.cooldowns.length;
    const baseModels = publicModels.filter(m => !m.startsWith('anti-truncation/')).length || live.catalog.length;

    box.replaceChildren();
    const cell = (label, dotCls, val, sub, hash) => {
      const c = mk('div', null, 'uf-tele-cell');
      if (hash) {
        c.style.cursor = 'pointer';
        c.addEventListener('click', () => { location.hash = hash; });
      }
      const lb = mk('div', null, 'uf-tele-label');
      lb.append(mk('i', null, 'uf-dot ' + dotCls), mk('span', label));
      c.append(lb, mk('div', val, 'uf-tele-val'), mk('div', sub, 'uf-tele-sub'));
      box.append(c);
    };
    cell('调度状态', d.halted ? 'warn' : 'ok', d.halted ? '已暂停' : '填充优先', '单号占满并发再切下一号', '#ops');
    cell('就绪账号', readyAcc > 0 ? 'ok' : 'bad', readyAcc + ' / ' + totalAcc, live.exits.length ? ('出口 ' + live.exits.map(e => e.country || '未知').join(', ')) : '点击管理账号池', '#accounts');
    cell('实时进行中', runningReq > 0 ? 'pulse' : 'ok', String(runningReq), runningReq > 0 ? '点击查看阶段或手动停止' : '当前空闲无卡顿', '#history');
    cell('冷却计数', coolingCnt > 0 ? 'warn' : 'ok', String(coolingCnt), coolingCnt > 0 ? '存在限流冷却条目' : '全部模型可正常调度', '#history');
    cell('对外模型', 'info', String(publicModels.length || baseModels), baseModels + ' 个基座 · 自动防截断', '#models');
  }

  document.addEventListener('ais-status', e => {
    latestCoordStatus = e.detail || {};
    renderTelemetry();
  });

  // =========================================================================
  // 1. Gemini 4 Periodic Table (Models Page)
  // =========================================================================
  const EL_SYMS = [
    'H','He','Li','Be','B','C','N','O','F','Ne','Na','Mg','Al','Si','P','S','Cl','Ar',
    'K','Ca','Sc','Ti','V','Cr','Mn','Fe','Co','Ni','Cu','Zn','Ga','Ge','As','Se','Br','Kr',
    'Rb','Sr','Y','Zr','Nb','Mo','Tc','Ru','Rh','Pd','Ag','Cd','In','Sn','Sb','Te','I','Xe',
    'Cs','Ba','Hf','Ta','W','Re','Os','Ir','Pt','Au','Hg','Tl','Pb','Bi','Po','At','Rn'
  ];
  const EL_CN = [
    '氢','氦','锂','铍','硼','碳','氮','氧','氟','氖','钠','镁','铝','硅','磷','硫','氯','氩',
    '钾','钙','钪','钛','钒','铬','锰','铁','钴','镍','铜','锌','镓','锗','砷','硒','溴','氪',
    '铷','锶','钇','锆','铌','钼','锝','钌','铑','钯','银','镉','铟','锡','锑','碲','碘','氙',
    '铯','钡','铪','钽','钨','铼','锇','铱','铂','金','汞','铊','铅','铋','钋','砹','氡'
  ];
  const EL_CODES = [
    'hydrogen','helium','lithium','beryllium','boron','carbon','nitrogen','oxygen','fluorine','neon',
    'sodium','magnesium','aluminum','silicon','phosphorus','sulfur','chlorine','argon',
    'potassium','calcium','scandium','titanium','vanadium','chromium','manganese','iron','cobalt','nickel','copper','zinc','gallium','germanium','arsenic','selenium','bromine','krypton',
    'rubidium','strontium','yttrium','zirconium','niobium','molybdenum','technetium','ruthenium','rhodium','palladium','silver','cadmium','indium','tin','antimony','tellurium','iodine','xenon',
    'cesium','barium','hafnium','tantalum','tungsten','rhenium','osmium','iridium','platinum','gold','mercury','thallium','lead','bismuth','polonium','astatine','radon'
  ];
  const P_STARTS = [1, 3, 11, 19, 37, 55, 87];
  const NONMETALS = new Set([1, 6, 7, 8, 15, 16, 34]);
  const METALLOIDS = new Set([5, 14, 32, 33, 51, 52]);
  function elPos(num) {
    const period = P_STARTS.findIndex(s => num < s);
    const off = num - P_STARTS[period - 1];
    if (period === 1) return { period, group: off === 0 ? 1 : 18 };
    if (period <= 3) return { period, group: off < 2 ? off + 1 : off + 11 };
    if (period === 6 && num > 71) return { period, group: off - 13 };
    return { period, group: off + 1 };
  }
  function elFamily(num, group) {
    if (NONMETALS.has(num)) return 'nonmetal';
    if (METALLOIDS.has(num)) return 'metalloid';
    if (group === 1) return 'alkali';
    if (group === 2) return 'alkaline';
    if (group <= 12) return 'transition';
    if (group === 17) return 'halogen';
    if (group === 18) return 'noble';
    return 'postTransition';
  }
  const PERIODIC = EL_SYMS.map((sym, idx) => {
    const num = idx < 56 ? idx + 1 : idx + 16;
    const { period, group } = elPos(num);
    return { num, sym, cn: EL_CN[idx], code: EL_CODES[idx], period, group, family: elFamily(num, group) };
  });
  let selectedElCode = '';

  function renderPeriodicTable() {
    const wrap = $('uf-periodic-mount');
    if (!wrap) return;
    const byCode = new Map();
    for (const m of live.catalog) {
      const mt = /^gemini-4-([a-z]+)(-|$)/.exec(m.id || '');
      if (!mt) continue;
      const code = mt[1];
      const cur = byCode.get(code);
      if (!cur || m.id.length < cur.id.length) byCode.set(code, m);
    }
    if (!selectedElCode || !byCode.has(selectedElCode)) {
      if (byCode.has('neon')) selectedElCode = 'neon';
      else if (byCode.has('carbon')) selectedElCode = 'carbon';
      else selectedElCode = byCode.keys().next().value || '';
    }

    wrap.replaceChildren();
    const card = mk('div', null, 'card uf-periodic-card');
    const head = mk('div', null, 'uf-head-row');
    const left = mk('div');
    left.append(mk('h2', 'Gemini 4 元素周期表'), mk('span', '按账号实时模型目录自动点亮已发布的代号模型，点击元素查看完整规格', 'muted'));
    const meta = mk('div', null, 'uf-head-meta');
    meta.append(mk('span', '已点亮 ' + byCode.size + ' 个元素', 'uf-chip info'));
    meta.append(mk('span', '目录共 ' + live.catalog.length + ' 个模型', 'uf-chip'));
    head.append(left, meta);

    const scroll = mk('div', null, 'uf-ptable-scroll');
    const grid = mk('div', null, 'uf-ptable');
    for (const el of PERIODIC) {
      const m = byCode.get(el.code);
      const cell = mk('button', null, 'uf-el' + (m ? ' released' : '') + (m && el.code === selectedElCode ? ' active' : ''));
      cell.type = 'button';
      cell.style.gridRow = String(el.period);
      cell.style.gridColumn = String(el.group);
      cell.dataset.family = el.family;
      cell.disabled = !m;
      cell.title = m ? `${m.id}（原子序数 ${el.num} · ${el.cn}）` : `${el.sym} ${el.cn}（尚未发布）`;
      cell.append(mk('span', String(el.num), 'el-num'), mk('span', el.sym, 'el-sym'), mk('span', el.cn, 'el-cn'));
      if (m) {
        cell.addEventListener('click', () => {
          selectedElCode = el.code;
          renderPeriodicTable();
        });
      }
      grid.append(cell);
    }
    // Lanthanide placeholder (period 6, group 3)
    const lan = mk('div', null, 'uf-el');
    lan.style.gridRow = '6';
    lan.style.gridColumn = '3';
    lan.append(mk('span', '57-71', 'el-num'), mk('span', 'La-Lu', 'el-sym'), mk('span', '镧系', 'el-cn'));
    grid.append(lan);
    scroll.append(grid);
    card.append(head, scroll);

    const picked = selectedElCode ? byCode.get(selectedElCode) : null;
    if (picked) {
      const det = mk('div', null, 'uf-el-detail');
      const specs = mk('div', null, 'uf-el-specs');
      const addSpec = (k, v) => {
        const sp = mk('span', k + ' ');
        sp.append(mk('b', v));
        specs.append(sp);
      };
      addSpec('模型', picked.id);
      addSpec('输入上限', fmtK(picked.input_token_limit));
      addSpec('输出上限', fmtK(picked.output_token_limit));
      if (Array.isArray(picked.thinking_levels) && picked.thinking_levels.length) {
        addSpec('思考档位', picked.thinking_levels.join(' / ') + (picked.default_thinking_level ? ` (默认 ${picked.default_thinking_level})` : ''));
      }
      if (picked.paid) specs.append(mk('span', '付费档', 'uf-chip warn'));
      if (picked.hidden) specs.append(mk('span', '官网隐藏模型', 'uf-chip info'));
      if (publicModels.includes('anti-truncation/' + picked.id)) specs.append(mk('span', '已开防截断', 'uf-chip ok'));

      const acts = mk('div', null, 'tools');
      const btnTry = mk('button', '去试用台测试', 'small primary');
      btnTry.type = 'button';
      btnTry.addEventListener('click', () => {
        pgState.panes[0].model = picked.id;
        location.hash = '#playground';
        renderPlayground();
      });
      const btnAcc = mk('button', '生成接入配置', 'small');
      btnAcc.type = 'button';
      btnAcc.addEventListener('click', () => {
        accState.model = picked.id;
        location.hash = '#access';
        renderAccessPanel();
      });
      acts.append(btnTry, btnAcc);
      det.append(specs, acts);
      card.append(det);
    }
    wrap.append(card);
  }

  // =========================================================================
  // 2. Client Quick-Access Panel (#access)
  // =========================================================================
  const CLIENTS = [
    {
      id: 'sillytavern', group: '对话与创作', name: 'SillyTavern（酒馆）',
      protocols: ['chat', 'gemini', 'anthropic'],
      desc: '酒馆直连配置，支持防截断前缀模型与完整流式思维链。',
      render: ctx => ({
        fields: [
          ['聊天补全来源', ctx.protocol === 'gemini' ? 'Google AI Studio' : ctx.protocol === 'anthropic' ? 'Claude' : '自定义 (兼容 OpenAI)'],
          ['反向代理 / API 地址', ctx.url],
          ['API 密钥', ctx.key],
          ['模型名称', ctx.model]
        ],
        codeTitle: '模型名快速复制（含防截断版本）',
        code: `${ctx.baseModel}\nanti-truncation/${ctx.baseModel}`
      })
    },
    {
      id: 'claude-code', group: '编程 Agent', name: 'Claude Code',
      protocols: ['anthropic'],
      desc: '通过 Anthropic Messages 兼容层驱动 Claude Code CLI。',
      render: ctx => {
        const envLines = ctx.shell === 'windows'
          ? `$env:ANTHROPIC_BASE_URL = "${ctx.origin}"\n$env:ANTHROPIC_AUTH_TOKEN = "${ctx.key}"\n$env:ANTHROPIC_MODEL = "${ctx.model}"\n$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "${ctx.model}"\n$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "${ctx.model}"\nclaude`
          : `export ANTHROPIC_BASE_URL="${ctx.origin}"\nexport ANTHROPIC_AUTH_TOKEN="${ctx.key}"\nexport ANTHROPIC_MODEL="${ctx.model}"\nexport ANTHROPIC_DEFAULT_OPUS_MODEL="${ctx.model}"\nexport ANTHROPIC_DEFAULT_SONNET_MODEL="${ctx.model}"\nclaude`;
        return {
          fields: [['Base URL', ctx.origin], ['Auth Token', ctx.key], ['默认模型', ctx.model]],
          codeTitle: '终端启动命令（' + (ctx.shell === 'windows' ? 'PowerShell' : 'Bash / Zsh') + '）',
          code: envLines
        };
      }
    },
    {
      id: 'codex', group: '编程 Agent', name: 'Codex CLI',
      protocols: ['responses', 'chat'],
      desc: 'OpenAI Codex CLI 配置（推荐使用 Responses 协议）。',
      render: ctx => ({
        fields: [['base_url', `${ctx.origin}/v1`], ['wire_api', ctx.protocol === 'responses' ? 'responses' : 'chat'], ['model', ctx.model]],
        codeTitle: '~/.codex/config.toml',
        code: `model = "${ctx.model}"\nmodel_provider = "ais2api"\n\n[model_providers.ais2api]\nname = "AIS2API"\nbase_url = "${ctx.origin}/v1"\nenv_key = "AISTUDIO2API_KEY"\nwire_api = "${ctx.protocol === 'responses' ? 'responses' : 'chat'}"\n\n# 终端环境变量：\n# ${ctx.shell === 'windows' ? `$env:AISTUDIO2API_KEY = "${ctx.key}"` : `export AISTUDIO2API_KEY="${ctx.key}"`}`
      })
    },
    {
      id: 'opencode', group: '编程 Agent', name: 'OpenCode',
      protocols: ['chat', 'responses', 'anthropic', 'gemini'],
      desc: '直接写入 ~/.config/opencode/opencode.json 即可使用。',
      render: ctx => {
        const pkg = { chat: '@ai-sdk/openai-compatible', responses: '@ai-sdk/openai', anthropic: '@ai-sdk/anthropic', gemini: '@ai-sdk/google' }[ctx.protocol];
        const burl = ctx.protocol === 'anthropic' ? `${ctx.origin}/v1` : ctx.url;
        const cfg = {
          $schema: 'https://opencode.ai/config.json',
          model: `ais2api/${ctx.model}`,
          provider: {
            ais2api: {
              npm: pkg,
              name: 'AIS2API',
              options: { baseURL: burl, apiKey: ctx.key },
              models: { [ctx.model]: { name: ctx.model } }
            }
          }
        };
        return {
          fields: [['Provider SDK', pkg], ['baseURL', burl], ['Model', `ais2api/${ctx.model}`]],
          codeTitle: '~/.config/opencode/opencode.json',
          code: JSON.stringify(cfg, null, 2)
        };
      }
    },
    {
      id: 'antigravity', group: '编程 Agent', name: 'Antigravity CLI (agy)',
      protocols: ['gemini'],
      desc: 'Google Antigravity CLI 接入本服务 Gemini 兼容端点。',
      render: ctx => ({
        fields: [['GEMINI_API_BASE_URL', `${ctx.origin}/v1beta`], ['GEMINI_API_KEY', ctx.key]],
        codeTitle: '启动命令',
        code: ctx.shell === 'windows'
          ? `$env:GEMINI_API_KEY = "${ctx.key}"\n$env:GEMINI_API_BASE_URL = "${ctx.origin}/v1beta"\nagy`
          : `export GEMINI_API_KEY="${ctx.key}"\nexport GEMINI_API_BASE_URL="${ctx.origin}/v1beta"\nagy`
      })
    },
    {
      id: 'cherry', group: '对话与创作', name: 'Cherry Studio',
      protocols: ['chat', 'responses', 'anthropic', 'gemini'],
      desc: '支持一键深链接唤醒导入，或手动填入提供商地址。',
      render: ctx => {
        const tmap = { chat: 'openai', responses: 'openai-response', anthropic: 'anthropic', gemini: 'gemini' };
        const payload = btoa(unescape(encodeURIComponent(JSON.stringify({
          id: 'ais2api', name: 'AIS2API', type: tmap[ctx.protocol], baseUrl: ctx.url, apiKey: ctx.key
        }))));
        return {
          link: { label: '一键导入到 Cherry Studio', href: `cherrystudio://providers/api-keys?v=1&data=${payload}` },
          fields: [['提供商类型', tmap[ctx.protocol]], ['API 地址', ctx.url], ['API 密钥', ctx.key], ['模型 ID', ctx.model]]
        };
      }
    },
    {
      id: 'lobechat', group: '对话与创作', name: 'LobeChat / OpenWebUI',
      protocols: ['chat', 'responses', 'gemini', 'anthropic'],
      desc: '在设置 → AI 服务商中填入以下代理地址与密钥。',
      render: ctx => ({
        fields: [['接口协议', ctx.protocolName], ['API 代理地址', ctx.url], ['API Key', ctx.key], ['模型列表', ctx.model]]
      })
    },
    {
      id: 'newapi', group: '网关与代码', name: 'New API / One API',
      protocols: ['chat', 'gemini', 'anthropic'],
      desc: '作为上游渠道挂载到二次分发网关。',
      render: ctx => ({
        fields: [
          ['渠道类型', ctx.protocol === 'gemini' ? 'Google Gemini' : ctx.protocol === 'anthropic' ? 'Anthropic Claude' : 'OpenAI'],
          ['代理地址 / Base URL', ctx.origin],
          ['密钥', ctx.key],
          ['模型', ctx.model]
        ]
      })
    },
    {
      id: 'sdk', group: '网关与代码', name: 'cURL / Python / TS 代码',
      protocols: ['chat', 'responses', 'anthropic', 'gemini'],
      desc: '直接复制到脚本验证流式输出与工具调用。',
      render: ctx => {
        let code = '';
        if (ctx.protocol === 'gemini') {
          code = `curl -N "${ctx.origin}/v1beta/models/${ctx.model}:streamGenerateContent?alt=sse" \\\n  -H "x-goog-api-key: ${ctx.key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"contents":[{"role":"user","parts":[{"text":"你好，请用一句话介绍自己"}]}]}'`;
        } else if (ctx.protocol === 'anthropic') {
          code = `curl -N "${ctx.origin}/v1/messages" \\\n  -H "x-api-key: ${ctx.key}" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${ctx.model}","max_tokens":1024,"stream":true,"messages":[{"role":"user","content":"你好"}]}'`;
        } else if (ctx.protocol === 'responses') {
          code = `curl -N "${ctx.origin}/v1/responses" \\\n  -H "Authorization: Bearer ${ctx.key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${ctx.model}","stream":true,"input":"你好"}'`;
        } else {
          code = `curl -N "${ctx.origin}/v1/chat/completions" \\\n  -H "Authorization: Bearer ${ctx.key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${ctx.model}","stream":true,"messages":[{"role":"user","content":"你好"}]}'\n\n# Python (OpenAI SDK)\nfrom openai import OpenAI\nclient = OpenAI(base_url="${ctx.origin}/v1", api_key="${ctx.key}")\nfor chunk in client.chat.completions.create(model="${ctx.model}", messages=[{"role":"user","content":"你好"}], stream=True):\n    print(chunk.choices[0].delta.content or "", end="", flush=True)`;
        }
        return { fields: [['Endpoint', ctx.url], ['Model', ctx.model]], codeTitle: '调用示例', code };
      }
    }
  ];

  const PROTO_NAMES = {
    chat: 'OpenAI Chat (/v1)',
    responses: 'OpenAI Responses (/v1)',
    anthropic: 'Anthropic Messages',
    gemini: 'Gemini API (/v1beta)'
  };

  const accState = {
    client: 'sillytavern',
    model: 'gemini-4-neon',
    anti: false,
    protocol: 'chat',
    key: '',
    shell: 'unix'
  };

  function renderAccessPanel() {
    const root = $('uf-access-mount');
    if (!root) return;
    const models = availableChatModels().filter(m => !m.startsWith('anti-truncation/'));
    if (models.length && !models.includes(accState.model)) {
      accState.model = models.includes('gemini-4-neon') ? 'gemini-4-neon' : models.includes('gemini-4-carbon') ? 'gemini-4-carbon' : models[0];
    }
    const client = CLIENTS.find(c => c.id === accState.client) || CLIENTS[0];
    if (!client.protocols.includes(accState.protocol)) accState.protocol = client.protocols[0];

    const finalModel = accState.anti ? ('anti-truncation/' + accState.model) : accState.model;
    const origin = location.origin;
    const urlMap = { chat: origin + '/v1', responses: origin + '/v1', anthropic: origin, gemini: origin + '/v1beta' };
    const ctx = {
      origin,
      url: urlMap[accState.protocol],
      key: accState.key.trim() || '<你的_API_KEY>',
      model: finalModel,
      baseModel: accState.model,
      protocol: accState.protocol,
      protocolName: PROTO_NAMES[accState.protocol],
      shell: accState.shell
    };

    root.replaceChildren();
    // Top bar
    const bar = mk('div', null, 'card uf-access-bar');
    const fModel = mk('label', null, 'uf-field');
    fModel.append(mk('span', '选择模型'));
    const selModel = mk('select');
    for (const m of (models.length ? models : [accState.model])) {
      const opt = new Option(m, m, false, m === accState.model);
      selModel.append(opt);
    }
    selModel.addEventListener('change', () => { accState.model = selModel.value; renderAccessPanel(); });
    fModel.append(selModel);

    const fProto = mk('label', null, 'uf-field');
    fProto.append(mk('span', '接入协议'));
    const selProto = mk('select');
    for (const p of client.protocols) {
      selProto.append(new Option(PROTO_NAMES[p], p, false, p === accState.protocol));
    }
    selProto.addEventListener('change', () => { accState.protocol = selProto.value; renderAccessPanel(); });
    fProto.append(selProto);

    const fKey = mk('label', null, 'uf-field');
    fKey.append(mk('span', '预填 API Key（仅本地浏览器生成片段）'));
    const inpKey = mk('input');
    inpKey.type = 'password';
    inpKey.placeholder = '留空显示占位符，粘贴后自动替换';
    inpKey.value = accState.key;
    inpKey.addEventListener('input', () => { accState.key = inpKey.value; renderAccessDetail(detailBox, client, ctx); });
    fKey.append(inpKey);

    const fOpts = mk('div', null, 'uf-field');
    fOpts.append(mk('span', '附加选项'));
    const optRow = mk('div', null, 'tools');
    const chkWrap = mk('label', null, 'chk');
    chkWrap.style.margin = '0';
    const chkAnti = mk('input');
    chkAnti.type = 'checkbox';
    chkAnti.checked = accState.anti;
    chkAnti.disabled = accState.protocol === 'gemini';
    chkAnti.addEventListener('change', () => { accState.anti = chkAnti.checked; renderAccessPanel(); });
    chkWrap.append(chkAnti, document.createTextNode(' 防截断前缀'));
    const btnShell = mk('button', accState.shell === 'unix' ? 'Linux / macOS' : 'PowerShell', 'small');
    btnShell.type = 'button';
    btnShell.addEventListener('click', () => { accState.shell = accState.shell === 'unix' ? 'windows' : 'unix'; renderAccessPanel(); });
    optRow.append(chkWrap, btnShell);
    fOpts.append(optRow);

    bar.append(fModel, fProto, fKey, fOpts);

    // Layout: left client list + right detail
    const layout = mk('div', null, 'uf-access-layout');
    const navCard = mk('div', null, 'card uf-client-list');
    let lastGroup = '';
    for (const c of CLIENTS) {
      if (c.group !== lastGroup) {
        lastGroup = c.group;
        navCard.append(mk('div', lastGroup, 'uf-client-group'));
      }
      const b = mk('button', null, 'uf-client-btn' + (c.id === client.id ? ' active' : ''));
      b.type = 'button';
      b.append(mk('span', c.name));
      b.addEventListener('click', () => { accState.client = c.id; renderAccessPanel(); });
      navCard.append(b);
    }

    const detailBox = mk('div', null, 'card uf-client-detail');
    renderAccessDetail(detailBox, client, ctx);
    layout.append(navCard, detailBox);
    root.append(bar, layout);
  }

  function renderAccessDetail(detailBox, client, baseCtx) {
    const ctx = { ...baseCtx, key: accState.key.trim() || '<你的_API_KEY>' };
    const out = client.render(ctx);
    detailBox.replaceChildren();
    const head = mk('div', null, 'uf-head-row');
    const titleBox = mk('div');
    titleBox.append(mk('h2', client.name), mk('span', client.desc, 'muted'));
    head.append(titleBox);
    if (out.link) {
      const a = mk('a', out.link.label, 'button primary small');
      a.href = out.link.href;
      head.append(a);
    }
    detailBox.append(head);

    if (out.fields && out.fields.length) {
      const kv = mk('div', null, 'uf-kv-grid');
      for (const [k, v] of out.fields) {
        kv.append(mk('span', k, 'uf-kv-k muted'));
        const code = mk('code', v);
        code.style.wordBreak = 'break-all';
        const cp = mk('button', '复制', 'small');
        cp.type = 'button';
        cp.addEventListener('click', () => copyText(v, cp));
        kv.append(code, cp);
      }
      detailBox.append(kv);
    }

    if (out.code) {
      const box = mk('div', null, 'uf-code-box');
      const ch = mk('div', null, 'uf-code-head');
      ch.append(mk('span', out.codeTitle || '配置片段'));
      const cp = mk('button', '复制全部', 'small');
      cp.type = 'button';
      cp.addEventListener('click', () => copyText(out.code, cp));
      ch.append(cp);
      const pre = mk('pre', out.code);
      box.append(ch, pre);
      detailBox.append(box);
    }
  }

  // =========================================================================
  // 3. In-Console Streaming Playground & Compare Mode (#playground)
  // =========================================================================
  const pgState = {
    compare: false,
    system: '',
    temperature: 1,
    topP: 0.95,
    maxTokens: 16384,
    thinking: 'high',
    stream: true,
    prompt: '',
    panes: [
      { model: 'gemini-4-neon', turns: [], busy: false, ctrl: null },
      { model: 'gemini-4-carbon', turns: [], busy: false, ctrl: null }
    ]
  };

  function syncModelOptions() {
    const models = availableChatModels();
    if (!models.length) return;
    for (const pane of pgState.panes) {
      if (!models.includes(pane.model)) {
        pane.model = models.find(m => m.includes('neon')) || models.find(m => m.includes('carbon')) || models[0];
      }
    }
    document.querySelectorAll('select[data-pg-model]').forEach(sel => {
      const idx = Number(sel.dataset.pgModel);
      const cur = pgState.panes[idx]?.model || models[0];
      sel.replaceChildren();
      for (const m of models) sel.append(new Option(m, m, false, m === cur));
    });
    if (location.hash === '#access') renderAccessPanel();
  }

  async function runPane(paneIdx, userText) {
    const pane = pgState.panes[paneIdx];
    if (pane.busy) return;
    if (String(pane.model).toLowerCase().includes('-build')) {
      alert('-build 模型已封存，禁止调用');
      return;
    }
    pane.turns.push({ role: 'user', content: userText });
    const assistantTurn = { role: 'assistant', reasoning: '', content: '', stats: '请求已发出…', error: '' };
    pane.turns.push(assistantTurn);
    pane.busy = true;
    const ctrl = new AbortController();
    pane.ctrl = ctrl;
    renderPlaygroundTurns(paneIdx);

    const msgs = [];
    if (pgState.system.trim()) msgs.push({ role: 'system', content: pgState.system.trim() });
    for (let i = 0; i < pane.turns.length - 1; i++) {
      const t = pane.turns[i];
      if (!t.error && t.content) msgs.push({ role: t.role, content: t.content });
    }

    const body = {
      model: pane.model,
      messages: msgs,
      stream: pgState.stream,
      temperature: Number(pgState.temperature),
      top_p: Number(pgState.topP),
      max_tokens: Number(pgState.maxTokens)
    };
    if (pgState.thinking && pgState.thinking !== 'default') body.reasoning_effort = pgState.thinking;

    const t0 = performance.now();
    let tFirst = 0, usage = null;
    try {
      const r = await fetch('/api/hl/playground', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Import-Token': await getCsrf(false) },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!r.ok) {
        const txt = await r.text();
        let msg = txt;
        try { const j = JSON.parse(txt); msg = j?.error?.message || j?.error || txt; } catch {}
        throw Error(`HTTP ${r.status}: ${msg}`);
      }
      if (!pgState.stream) {
        const j = await r.json();
        tFirst = performance.now() - t0;
        const m = j?.choices?.[0]?.message || {};
        assistantTurn.reasoning = m.reasoning_content || '';
        assistantTurn.content = m.content || '';
        usage = j?.usage;
      } else {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let chunk;
            try { chunk = JSON.parse(raw); } catch { continue; }
            if (chunk.error) throw Error(chunk.error.message || JSON.stringify(chunk.error));
            if (chunk.usage) usage = chunk.usage;
            const delta = chunk?.choices?.[0]?.delta;
            if (delta) {
              if (!tFirst && (delta.reasoning_content || delta.content)) tFirst = performance.now() - t0;
              if (delta.reasoning_content) assistantTurn.reasoning += delta.reasoning_content;
              if (delta.content) assistantTurn.content += delta.content;
              assistantTurn.stats = `首字 ${(tFirst / 1000).toFixed(2)}s · 生成中…`;
              renderPlaygroundTurns(paneIdx);
            }
          }
        }
      }
      const totalSec = Math.max(0.01, (performance.now() - t0) / 1000);
      const outTok = usage?.completion_tokens || 0;
      const inTok = usage?.prompt_tokens || 0;
      const speed = outTok && tFirst ? (outTok / Math.max(0.05, totalSec - tFirst / 1000)).toFixed(1) + ' tok/s' : '';
      assistantTurn.stats = [
        tFirst ? `首字 ${(tFirst / 1000).toFixed(2)}s` : '',
        `总耗时 ${totalSec.toFixed(2)}s`,
        inTok ? `输入 ${fmt(inTok)}` : '',
        outTok ? `输出 ${fmt(outTok)}` : '',
        speed
      ].filter(Boolean).join(' · ');
    } catch (e) {
      assistantTurn.error = e.name === 'AbortError' ? '已手动停止' : e.message;
      assistantTurn.stats = '';
    } finally {
      pane.busy = false;
      pane.ctrl = null;
      renderPlaygroundTurns(paneIdx);
      renderPlaygroundButtons();
    }
  }

  function renderPlaygroundTurns(paneIdx) {
    const box = $('uf-pg-turns-' + paneIdx);
    if (!box) return;
    const pane = pgState.panes[paneIdx];
    box.replaceChildren();
    if (!pane.turns.length) {
      const empty = mk('div', null, 'muted');
      empty.style.padding = '32px 16px';
      empty.style.textAlign = 'center';
      empty.textContent = '输入提示词开始测试（服务端自动通过本地 8890 调度器鉴权，不向浏览器暴露密钥）';
      box.append(empty);
      return;
    }
    for (const t of pane.turns) {
      const card = mk('div', null, 'uf-turn ' + t.role);
      const roleRow = mk('div', null, 'uf-turn-role');
      roleRow.append(mk('span', t.role === 'user' ? '用户 (User)' : pane.model));
      if (t.content) {
        const cp = mk('button', '复制', 'small ghost');
        cp.type = 'button';
        cp.addEventListener('click', () => copyText(t.content, cp));
        roleRow.append(cp);
      }
      card.append(roleRow);
      if (t.reasoning) {
        const det = mk('details', null, 'uf-thought');
        if (pane.busy && !t.content) det.open = true;
        det.append(mk('summary', `思考过程 (${t.reasoning.length} 字)`), mk('pre', t.reasoning));
        card.append(det);
      }
      if (t.content) card.append(mk('div', t.content, 'uf-turn-body'));
      if (t.error) {
        const err = mk('div', t.error, 'uf-chip bad');
        err.style.borderRadius = '6px';
        err.style.padding = '6px 10px';
        card.append(err);
      }
      if (t.stats) card.append(mk('div', t.stats, 'uf-turn-stats'));
      box.append(card);
    }
    box.scrollTop = box.scrollHeight;
  }

  function renderPlaygroundButtons() {
    const anyBusy = pgState.panes.some(p => p.busy);
    const send = $('uf-pg-send');
    const stop = $('uf-pg-stop');
    if (send) send.disabled = anyBusy;
    if (stop) stop.hidden = !anyBusy;
  }

  function renderPlayground() {
    const root = $('uf-playground-mount');
    if (!root) return;
    const models = availableChatModels();
    root.replaceChildren();

    const shell = mk('div', null, 'uf-pg-shell');
    const main = mk('div', null, 'uf-pg-main');

    // Toolbar
    const bar = mk('div', null, 'card uf-pg-toolbar');
    const leftTools = mk('div', null, 'tools');
    const btnCompare = mk('button', pgState.compare ? '退出双模型对比' : '开启双模型对比', 'small' + (pgState.compare ? ' primary' : ''));
    btnCompare.type = 'button';
    btnCompare.addEventListener('click', () => { pgState.compare = !pgState.compare; renderPlayground(); });
    const btnClear = mk('button', '清空对话', 'small');
    btnClear.type = 'button';
    btnClear.addEventListener('click', () => {
      pgState.panes.forEach(p => { p.ctrl?.abort(); p.turns = []; });
      renderPlayground();
    });
    const btnExport = mk('button', '复制 cURL 代码', 'small');
    btnExport.type = 'button';
    btnExport.addEventListener('click', () => {
      const m = pgState.panes[0].model;
      const msgs = pgState.panes[0].turns.filter(t => !t.error && t.content).map(t => ({ role: t.role, content: t.content }));
      const sample = msgs.length ? msgs : [{ role: 'user', content: pgState.prompt || '你好' }];
      const curl = `curl -N "${location.origin}/v1/chat/completions" \\\n  -H "Authorization: Bearer <API_KEY>" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ model: m, stream: pgState.stream, messages: sample })}'`;
      copyText(curl, btnExport);
    });
    leftTools.append(btnCompare, btnClear, btnExport);
    bar.append(leftTools, mk('span', '走本地 8890 调度器（支持防截断与填充优先选号）', 'muted'));

    // Panes
    const panesWrap = mk('div', null, 'uf-pg-panes' + (pgState.compare ? ' compare' : ''));
    const count = pgState.compare ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const pane = pgState.panes[i];
      const pCard = mk('div', null, 'card uf-pg-pane');
      const pHead = mk('div', null, 'uf-pg-pane-head');
      pHead.append(mk('span', pgState.compare ? `窗格 ${i + 1}` : '当前模型', 'uf-chip'));
      const sel = mk('select');
      sel.dataset.pgModel = String(i);
      for (const m of (models.length ? models : [pane.model])) {
        sel.append(new Option(m, m, false, m === pane.model));
      }
      sel.addEventListener('change', () => { pane.model = sel.value; });
      pHead.append(sel);
      const turnsBox = mk('div', null, 'uf-pg-turns');
      turnsBox.id = 'uf-pg-turns-' + i;
      pCard.append(pHead, turnsBox);
      panesWrap.append(pCard);
    }

    // Composer
    const comp = mk('div', null, 'card uf-pg-composer');
    const ta = mk('textarea');
    ta.placeholder = '输入测试内容（Ctrl + Enter 发送）…';
    ta.value = pgState.prompt;
    ta.addEventListener('input', () => { pgState.prompt = ta.value; });
    const cFoot = mk('div', null, 'uf-head-row');
    cFoot.style.marginBottom = '0';
    cFoot.append(mk('span', '支持多轮上下文续聊；开启双模型对比时同一问题同时发给两个模型', 'muted'));
    const cBtns = mk('div', null, 'tools');
    const btnStop = mk('button', '停止生成', 'danger-outline');
    btnStop.type = 'button';
    btnStop.id = 'uf-pg-stop';
    btnStop.hidden = true;
    btnStop.addEventListener('click', () => pgState.panes.forEach(p => p.ctrl?.abort()));
    const btnSend = mk('button', '发送', 'primary');
    btnSend.type = 'button';
    btnSend.id = 'uf-pg-send';
    const triggerSend = () => {
      const text = ta.value.trim();
      if (!text) return;
      pgState.prompt = '';
      ta.value = '';
      runPane(0, text);
      if (pgState.compare) runPane(1, text);
      renderPlaygroundButtons();
    };
    btnSend.addEventListener('click', triggerSend);
    ta.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        triggerSend();
      }
    });
    cBtns.append(btnStop, btnSend);
    cFoot.append(cBtns);
    comp.append(ta, cFoot);

    main.append(bar, panesWrap, comp);

    // Settings sidebar
    const side = mk('div', null, 'card uf-pg-settings');
    side.append(mk('h3', '运行参数'));
    const sysField = mk('label', null, 'uf-field');
    sysField.append(mk('span', '系统指令 (System Instruction)'));
    const sysTa = mk('textarea');
    sysTa.rows = 3;
    sysTa.placeholder = '可选系统提示词…';
    sysTa.value = pgState.system;
    sysTa.addEventListener('input', () => { pgState.system = sysTa.value; });
    sysField.append(sysTa);

    const thinkField = mk('label', null, 'uf-field');
    thinkField.append(mk('span', '思考档位 (Reasoning Effort)'));
    const thinkSel = mk('select');
    for (const [v, l] of [['default', '模型默认'], ['low', '低 (low)'], ['medium', '中 (medium)'], ['high', '高 (high)'], ['extra_high', '超高 (extra_high)']]) {
      thinkSel.append(new Option(l, v, false, v === pgState.thinking));
    }
    thinkSel.addEventListener('change', () => { pgState.thinking = thinkSel.value; });
    thinkField.append(thinkSel);

    const tempField = mk('label', null, 'uf-field');
    tempField.append(mk('span', `温度 (Temperature): ${pgState.temperature}`));
    const tempInp = mk('input');
    tempInp.type = 'number'; tempInp.step = '0.05'; tempInp.min = '0'; tempInp.max = '2';
    tempInp.value = String(pgState.temperature);
    tempInp.addEventListener('change', () => { pgState.temperature = Number(tempInp.value) || 1; });
    tempField.append(tempInp);

    const maxField = mk('label', null, 'uf-field');
    maxField.append(mk('span', '最大输出 Token'));
    const maxInp = mk('input');
    maxInp.type = 'number'; maxInp.step = '1024'; maxInp.min = '128'; maxInp.max = '65536';
    maxInp.value = String(pgState.maxTokens);
    maxInp.addEventListener('change', () => { pgState.maxTokens = Number(maxInp.value) || 16384; });
    maxField.append(maxInp);

    const stChk = mk('label', null, 'chk');
    const stInp = mk('input');
    stInp.type = 'checkbox';
    stInp.checked = pgState.stream;
    stInp.addEventListener('change', () => { pgState.stream = stInp.checked; });
    stChk.append(stInp, document.createTextNode(' 流式逐字输出 (SSE)'));

    side.append(sysField, thinkField, tempField, maxField, stChk);
    shell.append(main, side);
    root.append(shell);
    for (let i = 0; i < count; i++) renderPlaygroundTurns(i);
    renderPlaygroundButtons();
  }

  // =========================================================================
  // 4. Live Active Requests, WAA 4-Phase Ledger & Body Drawer (#history)
  // =========================================================================
  let recRange = 'today', recItems = [], recLoading = false;

  function phaseLabel(r) {
    const now = Date.now();
    const started = r.started_at ? Date.parse(r.started_at) : now;
    const dur = Math.max(0, Math.round((now - started) / 1000)) + 's';
    if (r.state === 'queued') return `排队等待 · ${dur}`;
    if (r.last_event_at) {
      const idle = Math.max(0, Math.round((now - Date.parse(r.last_event_at)) / 1000));
      return `正在流式输出 · 距上次收包 ${idle}s（总计 ${dur}）`;
    }
    return `已发出，等待谷歌响应头 · ${dur}`;
  }

  function renderLiveRequests() {
    const box = $('uf-live-requests-mount');
    if (!box) return;
    box.replaceChildren();
    const card = mk('div', null, 'card uf-live-panel');
    const head = mk('div', null, 'uf-head-row');
    const hLeft = mk('div');
    hLeft.append(mk('h2', '实时进行中请求与模型冷却'), mk('span', '实时同步无浏览器引擎活动状态，可直接掐断卡住的请求', 'muted'));
    const hRight = mk('div', null, 'tools');
    hRight.append(mk('span', `进行中 ${live.requests.length}`, live.requests.length ? 'uf-chip info' : 'uf-chip'));
    hRight.append(mk('span', `冷却中 ${live.cooldowns.length}`, live.cooldowns.length ? 'uf-chip warn' : 'uf-chip'));
    const btnReload = mk('button', '立即刷新', 'small');
    btnReload.type = 'button';
    btnReload.addEventListener('click', () => { refreshLive(); loadUpstreamRecords(); });
    hRight.append(btnReload);
    head.append(hLeft, hRight);
    card.append(head);

    const list = mk('div', null, 'uf-live-list');
    if (!live.requests.length && !live.cooldowns.length) {
      list.append(mk('div', '当前没有正在处理的请求，也没有冷却中的账号。', 'muted'));
    }
    for (const r of live.requests) {
      const row = mk('div', null, 'uf-live-row');
      const info = mk('div');
      info.append(
        mk('strong', r.model || '未知模型', 'mono'),
        mk('span', ' · ' + (r.account || '分配中') + ' · ', 'muted'),
        mk('span', phaseLabel(r), 'uf-chip info')
      );
      const stopBtn = mk('button', '停止此请求', 'small danger-outline');
      stopBtn.type = 'button';
      stopBtn.addEventListener('click', async () => {
        if (!confirm(`确定掐断正在运行的请求 ${r.id} (${r.model})？`)) return;
        stopBtn.disabled = true;
        try {
          await hlPost('/api/hl/cancel-request', { id: r.id });
          await refreshLive();
        } catch (e) {
          alert('取消失败：' + e.message);
          stopBtn.disabled = false;
        }
      });
      row.append(info, stopBtn);
      list.append(row);
    }

    for (const c of live.cooldowns) {
      const row = mk('div', null, 'uf-live-row');
      const until = c.until ? new Date(c.until).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
      const info = mk('div');
      info.append(
        mk('span', '冷却', 'uf-chip warn'),
        mk('strong', ' ' + (c.account_label || c.account_id || '') + ' · ' + (c.scope || '全局'), 'mono'),
        mk('span', ` · 恢复时间 ${until} · ${c.reason || ''}`, 'muted')
      );
      row.append(info);
      list.append(row);
    }
    card.append(list);
    box.append(card);
  }

  async function loadUpstreamRecords() {
    const mount = $('uf-waa-records-mount');
    if (!mount || recLoading) return;
    recLoading = true;
    try {
      const d = await hlGet(`/api/hl/records?range=${encodeURIComponent(recRange)}&limit=60`);
      recItems = Array.isArray(d.items) ? d.items : [];
      renderUpstreamRecords();
    } catch { /* ignore */ }
    finally { recLoading = false; }
  }

  function waaBarNode(r) {
    const p = r.proof_phases || {};
    const lock = Number(p.lock_ms) || 0;
    const ui = Number(p.interaction_ms) || 0;
    const ref = Number(p.refresh_ms) || 0;
    const cmp = Number(p.compute_ms) || 0;
    const sum = lock + ui + ref + cmp;
    const wrap = mk('div');
    if (!sum && !r.proof_ms) {
      wrap.append(mk('span', '—', 'muted'));
      return wrap;
    }
    const bar = mk('div', null, 'uf-waa-bar');
    const total = Math.max(sum, 1);
    const seg = (cls, val) => {
      if (val <= 0) return;
      const i = mk('i', null, cls);
      i.style.width = Math.max(6, Math.round(val / total * 100)) + '%';
      bar.append(i);
    };
    seg('w-lock', lock); seg('w-ui', ui); seg('w-ref', ref); seg('w-cmp', cmp);
    const tip = `总计 ${msText(r.proof_ms ?? sum)} = 等待页面 ${msText(lock)} / 页面操作 ${msText(ui)} / 刷新 ${msText(ref)} / 计算 ${msText(cmp)}`;
    wrap.title = tip;
    wrap.append(bar, mk('small', `${msText(r.proof_ms ?? sum)} (页${Math.round(ui)}·算${Math.round(cmp)})`, 'muted mono'));
    return wrap;
  }

  async function openBodyDrawer(rec) {
    let dlg = $('uf-body-dialog');
    if (!dlg) {
      dlg = mk('dialog', null, 'uf-drawer');
      dlg.id = 'uf-body-dialog';
      dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
      document.body.append(dlg);
    }
    dlg.replaceChildren();
    const head = mk('div', null, 'dialog-head');
    const hTitle = mk('div');
    hTitle.append(mk('h2', '请求诊断与收发原文'), mk('span', `${rec.id} · ${rec.model}`, 'muted mono'));
    const closeBtn = mk('button', '×', 'icon-button');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => dlg.close());
    head.append(hTitle, closeBtn);

    const body = mk('div', null, 'uf-drawer-body');
    const p = rec.proof_phases || {};
    const metaGrid = mk('div', null, 'uf-kv-grid');
    const rows = [
      ['时间与状态', `${new Date(rec.time).toLocaleString('zh-CN', { hour12: false })} · HTTP ${rec.status} (${rec.state})`],
      ['执行账户与通道', `${rec.account || '—'} · ${rec.channel || 'playground'}`],
      ['耗时明细', `排队 ${msText(rec.queue_ms)} · 首字 ${msText(rec.first_event_ms)} · 总耗时 ${msText(rec.duration_ms)}`],
      ['WAA 四阶段拆解', `等待页面 ${msText(p.lock_ms || 0)} | 页面操作 ${msText(p.interaction_ms || 0)} | 等待刷新 ${msText(p.refresh_ms || 0)} | WAA 计算 ${msText(p.compute_ms || 0)}`],
      ['Token 与缓存', `输入 ${fmt(rec.input_tokens)}（缓存命中 ${fmt(rec.cached_tokens)}） · 思考 ${fmt(rec.reasoning_tokens)} · 回复 ${fmt(rec.reply_tokens)}`]
    ];
    if (rec.error) rows.push(['上游错误原文', rec.error]);
    for (const [k, v] of rows) {
      metaGrid.append(mk('span', k, 'uf-kv-k muted'), mk('code', v), mk('span', ''));
    }
    body.append(metaGrid);

    const rawHolder = mk('div', '正在读取请求与响应原文…', 'muted');
    body.append(rawHolder);
    dlg.append(head, body);
    dlg.showModal();

    try {
      const b = await hlGet(`/api/hl/request-body?id=${encodeURIComponent(rec.id)}`);
      rawHolder.replaceChildren();
      for (const [title, content] of [['请求正文 (Request Body)', b.request_body || b.request || ''], ['响应正文 (Response / SSE)', b.response_body || b.response || '']]) {
        const cbox = mk('div', null, 'uf-code-box');
        cbox.style.marginBottom = '10px';
        const ch = mk('div', null, 'uf-code-head');
        ch.append(mk('span', title));
        const cp = mk('button', '复制', 'small');
        cp.type = 'button';
        cp.addEventListener('click', () => copyText(String(content), cp));
        ch.append(cp);
        const pre = mk('pre', String(content || '(空)'));
        pre.style.maxHeight = '260px';
        cbox.append(ch, pre);
        rawHolder.append(cbox);
      }
    } catch (e) {
      rawHolder.replaceChildren();
      const tip = mk('div', null, 'uf-el-detail');
      const msg = live.config?.request_body_log
        ? `该请求未保存正文（${e.message}）`
        : '当前尚未开启「记录请求与响应原文 (REQUEST_BODY_LOG)」，历史请求未落盘正文。开启后新请求可在此直接检视完整 Prompt 与 SSE 流。';
      tip.append(mk('span', msg, 'muted'));
      if (!live.config?.request_body_log) {
        const goSet = mk('button', '前往设置页开启', 'small primary');
        goSet.type = 'button';
        goSet.addEventListener('click', () => { dlg.close(); location.hash = '#settings'; });
        tip.append(goSet);
      }
      rawHolder.append(tip);
    }
  }

  function renderUpstreamRecords() {
    const mount = $('uf-waa-records-mount');
    if (!mount) return;
    mount.replaceChildren();
    const card = mk('div', null, 'card uf-live-panel');
    const head = mk('div', null, 'uf-head-row');
    const hLeft = mk('div');
    hLeft.append(mk('h2', '精细请求账本与 WAA 四阶段耗时'), mk('span', '展示每次请求在本地页面/WAA 签名与谷歌上游之间的真实耗时分布', 'muted'));
    const hRight = mk('div', null, 'tools');
    const sel = mk('select');
    for (const [v, l] of [['1h', '最近 1 小时'], ['6h', '最近 6 小时'], ['today', '最近 24 小时'], ['7d', '最近 7 天'], ['30d', '最近 30 天']]) {
      sel.append(new Option(l, v, false, v === recRange));
    }
    sel.addEventListener('change', () => { recRange = sel.value; loadUpstreamRecords(); });
    hRight.append(sel);
    head.append(hLeft, hRight);
    card.append(head);

    if (!recItems.length) {
      card.append(mk('div', '所选时间范围内暂无引擎账本记录。', 'muted'));
      mount.append(card);
      return;
    }

    const scroll = mk('div', null, 'table-wrap');
    const tbl = mk('table', null, 'uf-records-table');
    const thead = mk('thead'), hr = mk('tr');
    for (const h of ['时间', '状态', '模型', '首字 / 总耗时', 'WAA 四阶段拆解', '输入 (缓存) / 输出', '操作']) hr.append(mk('th', h));
    thead.append(hr);
    const tbody = mk('tbody');
    for (const r of recItems) {
      const tr = mk('tr');
      const tStr = r.time ? new Date(r.time).toLocaleTimeString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
      tr.append(mk('td', tStr, 'mono muted'));
      const stTd = mk('td');
      const ok = r.status >= 200 && r.status < 300;
      stTd.append(mk('span', String(r.status || '—'), 'uf-chip ' + (ok ? 'ok' : r.status === 429 ? 'warn' : 'bad')));
      tr.append(stTd);
      tr.append(mk('td', r.model || '—', 'mono'));
      tr.append(mk('td', `${msText(r.first_event_ms)} / ${msText(r.duration_ms)}`, 'mono'));
      const waaTd = mk('td');
      waaTd.append(waaBarNode(r));
      tr.append(waaTd);
      tr.append(mk('td', `${fmtK(r.input_tokens)}${r.cached_tokens ? ` (${fmtK(r.cached_tokens)})` : ''} / ${fmt(r.output_tokens)}`, 'mono'));
      const opTd = mk('td');
      const bView = mk('button', '详情 / 原文', 'small');
      bView.type = 'button';
      bView.addEventListener('click', () => openBodyDrawer(r));
      opTd.append(bView);
      tr.append(opTd);
      tbody.append(tr);
    }
    tbl.append(thead, tbody);
    scroll.append(tbl);
    card.append(scroll);
    mount.append(card);
  }

  // =========================================================================
  // 5. Account Exit IP Geo Grouping (#accounts) & Engine Switches (#settings)
  // =========================================================================
  function renderExits() {
    const mount = $('uf-account-exits-mount');
    if (!mount) return;
    mount.replaceChildren();
    if (!live.exits.length) return;
    const strip = mk('div', null, 'uf-exits-strip');
    for (const ex of live.exits) {
      const matched = live.accounts.filter(a => a.proxy === ex.proxy);
      const readyN = matched.filter(a => a.enabled && a.state === 'ready').length;
      const card = mk('div', null, 'uf-exit-card');
      const top = mk('div', null, 'uf-head-row');
      top.style.marginBottom = '2px';
      top.append(
        mk('strong', `${ex.country || '未知地区'} · ${ex.ip || '查询中'}`, 'mono'),
        mk('span', `${readyN}/${matched.length || live.accounts.length} 就绪`, readyN > 0 ? 'uf-chip ok' : 'uf-chip')
      );
      const sub = mk('div', `时区 ${ex.timezone || '—'} · 语言 ${ex.locale || '—'} · 代理 ${ex.proxy || '直连'}`, 'muted');
      sub.style.fontSize = '12px';
      card.append(top, sub);
      strip.append(card);
    }
    mount.append(strip);
  }

  const ENGINE_SWITCHES = [
    {
      key: 'strip_thought_signatures',
      title: '剥离历史思考签名 (STRIP_THOUGHT_SIGNATURES)',
      desc: '发往谷歌前清除对话历史中的旧思考签名并为函数调用附带跳过校验标记。强烈建议在超长多轮工具调用（防重启后 400 invalid argument）或节省输入 Token 时开启。（需重启无浏览器服务生效）'
    },
    {
      key: 'request_body_log',
      title: '记录请求与响应正文 (REQUEST_BODY_LOG)',
      desc: '在本地账本保存最近 1000 条请求的 Prompt 与 SSE 响应原文（单条截断 64 KiB），开启后可在「实时与记录」抽屉中直接查看原文。（需重启无浏览器服务生效）'
    },
    {
      key: 'search_model_aliases',
      title: '提供 -search 搜索后缀型号',
      desc: '为支持联网的模型暴露 -search 型号，调用该型号时自动开启 Google 搜索依据。（保存后立即对新请求生效）'
    },
    {
      key: 'google_search',
      title: '全部模型默认启用 Google 搜索',
      desc: '对普通生成请求默认挂载 Google 搜索工具。（保存后立即对新请求生效）'
    },
    {
      key: 'nonstream_keepalive',
      title: '非流式请求心跳保活',
      desc: '上游长思考期间持续向客户端发送空白保活，防止反代或客户端连接超时断开。（保存后立即生效）'
    },
    {
      key: 'youtube_links',
      title: 'YouTube 链接自动转视频附件',
      desc: '识别提示词中的 YouTube 网址并作为原生视频输入传给模型。（需重启无浏览器服务生效）'
    }
  ];

  let cfgDraft = null, cfgSaving = false;

  function renderEngineSwitches() {
    const mount = $('uf-engine-switches-mount');
    if (!mount || cfgSaving) return;
    if (!live.config || !Object.keys(live.config).length) return;
    if (!cfgDraft) cfgDraft = { ...live.config };

    mount.replaceChildren();
    const card = mk('div', null, 'card form-card');
    const head = mk('div', null, 'uf-head-row');
    const hLeft = mk('div');
    hLeft.append(mk('h2', '无浏览器引擎特性开关（v0.3.12）'), mk('span', '直接读写 2048 协议引擎配置，与上游管理面板同源', 'muted'));
    const saveBtn = mk('button', '保存引擎开关', 'primary');
    saveBtn.type = 'button';
    head.append(hLeft, saveBtn);
    card.append(head);

    const list = mk('div', null, 'uf-switch-list');
    for (const item of ENGINE_SWITCHES) {
      const row = mk('label', null, 'uf-switch-row');
      const copy = mk('div');
      copy.append(mk('strong', item.title), mk('small', item.desc));
      const inp = mk('input');
      inp.type = 'checkbox';
      inp.checked = Boolean(cfgDraft[item.key]);
      inp.addEventListener('change', () => { cfgDraft[item.key] = inp.checked; });
      row.append(copy, inp);
      list.append(row);
    }
    const msg = mk('p', '', 'muted');
    msg.style.marginTop = '10px';

    saveBtn.addEventListener('click', async () => {
      cfgSaving = true;
      saveBtn.disabled = true;
      msg.textContent = '正在保存…';
      try {
        const patch = {};
        for (const item of ENGINE_SWITCHES) patch[item.key] = Boolean(cfgDraft[item.key]);
        const r = await hlPost('/api/hl/config', { patch });
        live.config = r.config || cfgDraft;
        cfgDraft = { ...live.config };
        if (r.needsRestart) {
          msg.textContent = '已写入 .env！你改动了需重启生效的项，空闲时可点击右侧按钮重启无浏览器服务。';
          const rb = mk('button', '现在重启无浏览器服务', 'small danger-outline');
          rb.type = 'button';
          rb.style.marginLeft = '10px';
          rb.addEventListener('click', async () => {
            if (!confirm('重启无浏览器服务会中断正在生成的请求（约 5 秒恢复），确认现在重启？')) return;
            rb.disabled = true;
            try {
              await hlPost('/api/ops/restart', { unit: 'headless' });
              msg.textContent = '无浏览器服务正在重启，约 5 秒后生效。';
            } catch (e) {
              alert('重启失败：' + e.message);
              rb.disabled = false;
            }
          });
          msg.append(rb);
        } else {
          msg.textContent = '保存成功，已对新请求立即生效。';
        }
      } catch (e) {
        msg.textContent = '保存失败：' + e.message;
      } finally {
        cfgSaving = false;
        saveBtn.disabled = false;
      }
    });

    card.append(list, msg);
    mount.append(card);
  }

  // =========================================================================
  // Lifecycle & Polling
  // =========================================================================
  function init() {
    renderAccessPanel();
    renderPlayground();
    refreshPublicModels();
    refreshLive();
    loadUpstreamRecords();

    addEventListener('hashchange', () => {
      const h = location.hash.slice(1);
      if (h === 'access') renderAccessPanel();
      if (h === 'playground') renderPlayground();
      if (h === 'history') { refreshLive(); loadUpstreamRecords(); }
      if (h === 'models') renderPeriodicTable();
      if (h === 'accounts') renderExits();
      if (h === 'settings') { cfgDraft = null; renderEngineSwitches(); }
    });

    document.addEventListener('ais-refresh', () => {
      refreshPublicModels();
      refreshLive();
      if (location.hash === '#history') loadUpstreamRecords();
    });

    setInterval(() => {
      if (document.hidden) return;
      const h = location.hash.slice(1) || 'overview';
      if (h === 'history' || h === 'overview' || live.requests.length > 0) {
        refreshLive();
      }
    }, 4000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();