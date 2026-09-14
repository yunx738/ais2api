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
 const allowed=new Set(['GET /login','POST /login','GET /import','POST /api/import-account','GET /','GET /api/status','GET /favicon.ico']);
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
 dashboard.get('/',(req,res)=>res.type('html').send(`<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>双实例状态</title><h1>双实例代理管理</h1><p><a href=\"/import\">Cookie 转换与账号导入</a></p><p>每实例并发 1，每 80 次按顺序轮换并跳过占用账号。新导入账号尚未自动加入调度池。</p><pre id=\"status\">正在读取状态…</pre><script>async function refresh(){try{const r=await fetch('/api/status');document.getElementById('status').textContent=JSON.stringify(await r.json(),undefined,2);}catch{document.getElementById('status').textContent='状态暂不可用';}}refresh();setInterval(refresh,3000);</script></html>`));
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
