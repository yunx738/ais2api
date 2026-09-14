'use strict';
const express=require('express'),http=require('http');
const {ProxyServerSystem}=require('./unified-server');
async function main(){
 const system=new ProxyServerSystem();
 const denied=async()=>({success:false,reason:'Account assignment belongs to coordinator'});
 system.requestHandler._switchToNextAuth=denied;
 system.requestHandler._switchToSpecificAuth=denied;
 system.browserManager.launchOrSwitchContext=async()=>{throw Error('Management cannot launch browsers');};
 const app=system._createExpressApp();
 const allowed=new Set(['GET /login','POST /login','GET /import','POST /api/import-account','GET /','GET /api/status','GET /favicon.ico','POST /api/set-mode','POST /api/rotate','POST /api/sync-accounts']);
 const outer=express();
 outer.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  if(!allowed.has(req.method+' '+req.path))return res.status(404).json({error:'Management endpoint unavailable'});
  next();
 });
 // Insert authenticated dashboard before legacy routes but after session middleware.
 const router=app._router;
 const index=router.stack.findIndex(layer=>layer.route?.path==='/');
 if(index<0)throw Error('Dashboard route missing');
 const dashboard=express.Router();
 dashboard.use((req,res,next)=>{
  if(!req.session?.isAuthenticated)return res.redirect('/login');
  next();
 });
dashboard.get('/',(req,res)=>res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>双实例代理管理</title><style>
body { font-family: 'SF Mono','Consolas','Menlo',monospace; background:#f0f2f5; color:#333; padding:2em; }
.container { max-width:800px; margin:0 auto; background:#fff; padding:1em 2em 2em 2em; border-radius:12px; box-shadow:0 4px 6px rgba(0,0,0,0.1); }
h1,h2 { color:#333; border-bottom:2px solid #eee; padding-bottom:0.5em; }
pre { background:#2d2d2d; color:#f0f0f0; font-size:1.1em; padding:1.5em; border-radius:8px; white-space:pre-wrap; word-wrap:break-word; line-height:1.6; }
.status-ok { color:#2ecc71; font-weight:bold; }
.status-error { color:#e74c3c; font-weight:bold; }
.status-warn { color:#f39c12; font-weight:bold; }
.label { display:inline-block; width:220px; box-sizing:border-box; }
.dot { height:10px; width:10px; background:#bbb; border-radius:50%; display:inline-block; margin-left:10px; animation:blink 1s infinite alternate; }
@keyframes blink { from { opacity:0.3; } to { opacity:1; } }
.action-group { display:flex; flex-wrap:wrap; gap:15px; align-items:center; }
.action-group button, .action-group select { font-size:1em; border:1px solid #ccc; padding:10px 15px; border-radius:8px; cursor:pointer; transition:background-color 0.3s ease; }
.action-group button { background-color:#007bff; color:white; border-color:#007bff; }
.action-group button:hover { opacity:0.85; }
.action-group select { background-color:#fff; color:#000; -webkit-appearance:none; appearance:none; }
@media (max-width:600px){ body{padding:0.5em;} .container{padding:1em;margin:0;} pre{padding:1em;font-size:0.9em;} .label{width:auto;display:inline;} .action-group{flex-direction:column;align-items:stretch;} .action-group select,.action-group button{width:100%;box-sizing:border-box;} }
</style></head><body><div class="container">
<p><a href="/import">📥 导入账号（JSON）</a></p>
<h1>双实例代理管理 <span class="dot" title="数据动态刷新中..."></span></h1>
<div id="status-section"><pre id="status">正在读取状态…</pre></div>
<div id="actions-section" style="margin-top:2em;">
<h2>操作面板</h2>
<div class="action-group">
<select id="slotSelect"><option value="A">实例 A</option><option value="B">实例 B</option></select>
<select id="accountSelect"><option value="">— 选择目标账号 —</option></select>
<button onclick="switchToAccount()">切换到指定账号</button>
<button onclick="rotateNext()">轮换到下一账号</button>
<button onclick="syncAccounts()">📥 新账号加入调度池</button>
<button onclick="toggleStreamingMode()">切换流模式</button>
</div>
<p style="font-size:0.85em;color:#888;">每实例并发 1；Flash 额度 100 次、Pro 额度 10 次，独立统计；任一额度用满即按顺序自动轮换账号，并跳过占用/冷却账号。</p>
</div>
</div>
<script>
async function act(url,body,quiet){try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});const d=await r.json();if(!quiet)alert(JSON.stringify(d));return d;}catch(e){if(!quiet)alert('操作失败: '+e);}}
function syncAccounts(){return act('/api/sync-accounts').then(refresh);}
function rotateNext(){const slot=document.getElementById('slotSelect').value;if(!confirm('确定要轮换 '+slot+' 到账号池下一个可用账号吗？'))return;return act('/api/rotate',{slot}).then(refresh);}
function switchToAccount(){const slot=document.getElementById('slotSelect').value;const target=document.getElementById('accountSelect').value;if(!target){alert('请先选择目标账号');return;}if(!confirm('确定要将 '+slot+' 切换到账号 #'+target+' 吗？这会重建该实例的浏览器会话。'))return;return act('/api/rotate',{slot,targetAccount:parseInt(target,10)}).then(refresh);}
function toggleStreamingMode(){const cur=(window.__mode==='fake')?'real':'fake';if(!confirm('确定要将流模式切换为 '+cur+' 吗？'))return;return act('/api/set-mode',{mode:cur}).then(refresh);}
function esc(x){return String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;');}
async function refresh(){try{
const r=await fetch('/api/status');const d=await r.json();const el=document.getElementById('status');
window.__mode=d.streamingMode||'unknown';
const sel=document.getElementById('accountSelect');const prev=sel.value;
const slotOwner={};for(const [sl,st] of Object.entries(d.slots||{}))if(st.account!==undefined&&st.account!==null)slotOwner[st.account]=sl;
sel.innerHTML='<option value="">— 选择目标账号 —</option>'+(d.accounts||[]).map(a=>'<option value="'+a.id+'">账号 #'+a.id+' — '+esc(a.name)+'</option>').join('');
sel.value=prev&&[...sel.options].some(o=>o.value===prev)?prev:'';
const row=(slot,st)=>{const ok=st.ready&&st.active===0;return '<span class="label">实例 '+slot+' (账号 #'+(st.account??'-')+')</span>: <span class="'+(ok?"status-ok":"status-error")+'">'+(st.ready?((st.active||0)+' 个请求处理中'):(st.rotationBlocked?'轮换受阻，需人工恢复':'未就绪'))+'</span>  3.7flash '+(st.usesFlash37??0)+' / 100  3.8flash '+(st.usesFlash38??0)+' / 100  Pro '+(st.usesPro??0)+' / 10\\n';};
const accLine=a=>{const cooling=(a.cooldownUntil||0)>Date.now();const state=a.owner?('占用中（实例 '+a.owner+'）'):(cooling?'冷却至 '+new Date(a.cooldownUntil).toLocaleString():'<span class="status-ok">可用</span>');return '<span class="label" style="padding-left:20px;">账号 #'+a.id+'</span>: '+esc(a.name)+'  <span class="'+(a.owner?"status-warn":(cooling?"status-error":"status-ok"))+'">'+state+'</span>\\n';};
el.innerHTML='<span class="label">服务状态</span>: <span class="'+(d.halted?"status-error":"status-ok")+'">'+(d.halted?'Halted':'Running')+'</span>\\n<span class="label">请求队列</span>: '+d.queue+'\\n<span class="label">流模式</span>: '+esc(d.streamingMode||'unknown')+' (仅启用流式传输时生效)\\n--- 实例状态 ---\\n'+row('A',(d.slots||{}).A||{})+row('B',(d.slots||{}).B||{})+'--- 账号列表 ---\\n'+(d.accounts||[]).map(accLine).join('');
}catch{}}
refresh();setInterval(refresh,3000);
</script></body></html>`));
 dashboard.get('/api/status',(req,res)=>{
  const upstream=http.get({hostname:'127.0.0.1',port:8890,path:'/internal/coordinator-status',headers:{Authorization:'Bearer '+system.config.apiKeys[0]},agent:false},reply=>{
   let body='',size=0;
   reply.on('data',chunk=>{size+=chunk.length;if(size>16384)upstream.destroy();else body+=chunk;});
   reply.on('end',()=>{
    if(res.writableEnded)return;
    try{if(reply.statusCode!==200)throw Error();res.json(JSON.parse(body));}
    catch{res.status(503).json({error:'Coordinator status unavailable'});}
   });
   reply.on('error',()=>{if(!res.writableEnded)res.status(503).json({error:'Coordinator status unavailable'});});
  });
  upstream.setTimeout(5000,()=>upstream.destroy());
  upstream.on('error',()=>{if(!res.writableEnded)res.status(503).json({error:'Coordinator status unavailable'});});
 });
 const call=(method,actionPath,body)=>new Promise((resolve)=>{
  const payload=body?JSON.stringify(body):'';
  const upstream=http.request({hostname:'127.0.0.1',port:8890,path:actionPath,method,headers:{Authorization:'Bearer '+system.config.apiKeys[0],'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)},agent:false,timeout:60000},reply=>{
   let data='';let size=0;
   reply.on('data',chunk=>{size+=chunk.length;if(size>16384)return upstream.destroy();data+=chunk;});
   reply.on('end',()=>{try{resolve({status:reply.statusCode,body:JSON.parse(data)});}catch{resolve({status:reply.statusCode,body:{error:String(data).slice(0,200)}});}});
   reply.on('error',()=>resolve({status:503,body:{error:'Coordinator unavailable'}}));
  });
  upstream.on('timeout',()=>upstream.destroy(Error('timeout')));
  upstream.on('error',()=>resolve({status:503,body:{error:'Coordinator unavailable'}}));
  upstream.end(payload);
 });
 dashboard.post('/api/set-mode',async(req,res)=>{
  const mode=req.body?.mode;
  if(mode!=='fake'&&mode!=='real')return res.status(400).json({error:'mode must be fake or real'});
  const r=await call('POST','/internal/set-mode',{mode});
  res.status(r.status).json(r.body);
 });
 dashboard.post('/api/rotate',async(req,res)=>{
  const slot=req.body?.slot;
  const target=req.body?.targetAccount;
  if(slot!==undefined&&slot!==null&&['A','B'].includes(slot)===false)return res.status(400).json({error:'slot must be A or B'});
  if(target!==undefined&&target!==null&&Number.isSafeInteger(target)===false)return res.status(400).json({error:'targetAccount must be an integer'});
  const payload={};
  if(slot)payload.slot=slot;
  if(target!==undefined&&target!==null)payload.targetAccount=target;
  const r=await call('POST','/internal/rotate',payload);
  res.status(r.status).json(r.body);
 });
 dashboard.post('/api/sync-accounts',async(req,res)=>{
  const r=await call('POST','/internal/sync-accounts',{});
  res.status(r.status).json(r.body);
 });
 const holder=express();holder.use(dashboard);
 router.stack.splice(index,0,holder._router.stack[holder._router.stack.length-1]);
 outer.use(app);
 const server=http.createServer(outer);
 server.requestTimeout=30000;server.headersTimeout=15000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8893,'127.0.0.1',resolve);});
 console.log('[Management] loopback 8893; no browser; account switching disabled');
 process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}
main().catch(()=>{console.error('[Management] startup failed; details suppressed');process.exitCode=1;});
