'use strict';
// Isolated console UI smoke/regression verification. Fixtures also exercise real ledger/history schemas.
// No credentials or upstream generation requests are used; non-fixture network access is blocked.
// Run: node dual-runtime/refactor/verify-console-ui.js
// Optional: AIS_BROWSER_EXECUTABLE=/path/to/chromium AIS_UI_SCREENSHOTS=/tmp/ais-console-preview
const {chromium}=require('playwright');const http=require('http'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {ModelQuotaLedger}=require('./model-quota-ledger'),{RequestHistory}=require('./request-history');
const ui=path.join(__dirname,'ui');
const out=process.env.AIS_UI_SCREENSHOTS||path.join(require('os').tmpdir(),'ais-console-preview');
fs.mkdirSync(out,{recursive:true});
const now=Date.now();let delayHistory=false,delayUsage=false,statusFailure=false,syncFailure=false,failAfterSync=false,realHistory=false;
const historyDir=fs.mkdtempSync(path.join(require('os').tmpdir(),'ais-ui-history-'));
const history=new RequestHistory(historyDir);
const names=['演示账号','开发测试','Demo Alpha','Demo Beta','沙盒实例','测试账号','Demo Gamma','Demo Delta'];
const quota=i=>{
 const ledger=new ModelQuotaLedger(undefined,()=>now),policies={};
 for(const [n,model] of ['gemini-3.7-flash','gemini-3.1-pro','gemini-3.6-flash'].entries()){
  const family=n===1?'pro':'flash';policies[model]={quotaFamily:family};
  for(let used=0;used<(n===1?i%9:i*3%95);used++)ledger.charge(i+1,model,family);
  if(i===3&&n===1)ledger.defer(i+1,model,family,now+60000);
 }
 return ledger.summary(i+1,policies);
};
const accounts=Array.from({length:28},(_,i)=>({id:i+1,name:(names[i%names.length])+' '+(i+1),owner:i===0?'A':i===1?'B':null,cooldownUntil:i===3||i===5?now+60000:0,quota:quota(i)}));
const slots=Object.fromEntries(['A','B'].map((slot,i)=>[slot,{ready:true,active:i,account:i+1,quota:quota(i),workerEpoch:'epoch-'+slot,workerHealth:{account:i+1,workerEpoch:'epoch-'+slot,observedAt:now,pendingCompletions:0}}]));
const cleanupStatus=new (require('./retired-resource-cleanup').RetiredResourceCleanup)({dispatch:{},driver:{root:'/unused'},root:'/unused'}).status();
const status={halted:false,queue:2,accounts,slots,retiredCleanup:cleanupStatus};
const makeHistory=(model='gemini-3.7-flash',count=20)=>Array.from({length:count},(_,i)=>({id:'example-request-'+i,createdAt:now-i*75000,requestedModel:model,model,account:i%8+1,slot:i%2?'B':'A',stream:true,outcome:i===1?'http_error':'success',httpStatus:i===1?429:200,metrics:{durationMs:4534+i*342,firstContentMs:1940,usage:{input:26350+i*21,output:497,cached:25000,reasoning:783,source:'response-reported-unverified'},usageComplete:i!==1},cost:{amount:i===1?null:0.0749,reason:'usage_incomplete'}}));
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://local');const send=(data,code=200,delay=0)=>setTimeout(()=>{if(!res.destroyed){res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}},delay);
 if(url.pathname==='/api/status')return send(statusFailure?{error:'fixture offline'}:status,statusFailure?503:200);
 if(url.pathname==='/api/sync-accounts'){if(failAfterSync)statusFailure=true;return send(syncFailure?{error:'sync outcome unavailable'}:{added:[29]},syncFailure?503:200);}
 if(realHistory&&url.pathname==='/api/usage')return send(history.summary());
 if(realHistory&&url.pathname==='/api/requests')return send(history.list());
 if(url.pathname==='/api/usage'){const all=!url.searchParams.has('from');return send({requests:all?401:303,success:302,errors:1,tokenKnownRequests:302,tokenUnknownRequests:1,knownTokenTotal:28100000,pricedRequests:302,unpricedRequests:1,estimatedCostKnownSubtotal:53.91,averageDurationMs:22065,rpm:2,tpmKnown:57500,tpmUnknownRequests:0,errorRate:1/303,models:[{model:'gemini-3.7-flash',requests:all?380:297,knownTokenTotal:27400000,tokenUnknownRequests:1},{model:'gemini-3.1-pro',requests:all?21:6,knownTokenTotal:710000,tokenUnknownRequests:0}]},200,delayUsage&&!all?300:0);}
 if(url.pathname==='/api/requests'){const filtered=url.searchParams.get('model');return send({items:makeHistory(filtered||'gemini-3.7-flash',filtered?1:20),total:filtered?1:43},200,delayHistory&&!filtered?350:0);}
 if(url.pathname.startsWith('/api/'))return send({slots:{},workers:{},models:[],prices:{},revision:0});
 const filename=url.pathname.startsWith('/console-assets/')?path.basename(url.pathname):'index.html';if(!/^[\w.-]+$/.test(filename))return res.end();
 const types={'.html':'text/html','.js':'application/javascript','.css':'text/css'};try{res.writeHead(200,{'Content-Type':types[path.extname(filename)]||'text/plain'});res.end(fs.readFileSync(path.join(ui,filename)));}catch{res.writeHead(404);res.end();}
});
(async()=>{
 await history.init();
 for(let i=0;i<3;i++){
  const id=require('crypto').randomUUID();await history.begin({id,model:i===2?'gemini-real-pro':'gemini-real-flash',account:1,slot:'A'});
  if(i<2)await history.finish(id,{outcome:i?'http_error':'success',httpStatus:i?429:200,metrics:{durationMs:2000,transportComplete:true,usageComplete:i===0,usage:i?null:{format:'openai',input:1000,output:500,total:1500,cached:100,reasoning:30}}});
 }
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const address='http://127.0.0.1:'+server.address().port;
 let browser;
 try{browser=await chromium.launch({headless:true,...(process.env.AIS_BROWSER_EXECUTABLE?{executablePath:process.env.AIS_BROWSER_EXECUTABLE}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});}
 catch(error){server.close();throw Error('无法启动 Chromium。请安装 Playwright 浏览器，或设置 AIS_BROWSER_EXECUTABLE 指向本地 Chromium。'+error.message);}
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1,colorScheme:'light'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===address?route.continue():route.abort());
  await page.goto(address+'/#usage');await page.locator('#usage-cards .stat').first().waitFor();assert.equal(await page.locator('#usage-cards .stat').count(),6);await page.screenshot({path:out+'/desktop-usage.png',fullPage:true});
  await page.setViewportSize({width:430,height:932});await page.screenshot({path:out+'/mobile-usage.png',fullPage:true});
  for(const width of [360,390,430,760,1100]){await page.setViewportSize({width,height:932});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'page overflow at '+width);}
  await page.setViewportSize({width:430,height:932});await page.locator('.mobile-nav [data-page="accounts"]').click();await page.locator('#account-rows tr').first().waitFor();assert.equal(await page.locator('#account-rows tr').count(),20);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'accounts page must not overflow');await page.screenshot({path:out+'/mobile-accounts.png',fullPage:false});
  await page.locator('#account-next').click();assert.equal(await page.locator('#account-rows tr').count(),8);
  await page.locator('#quota-search').fill('27');assert.equal(await page.locator('#account-rows tr').count(),1);assert.match(await page.locator('#account-rows').textContent(),/27/);
  await page.locator('.account-name-button').click();assert.equal(await page.locator('#account-dialog').evaluate(e=>e.open),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'account dialog must not overflow');await page.screenshot({path:out+'/mobile-account-detail.png',fullPage:true});await page.keyboard.press('Escape');assert.equal(await page.locator('#account-dialog').evaluate(e=>e.open),false);
  await page.locator('#quota-search').fill('');await page.locator('#account-status').selectOption('cooling');assert.equal(await page.locator('#account-rows tr').count(),2);
  delayHistory=true;await page.locator('.mobile-nav [data-page="history"]').click();await page.locator('#history-model').fill('latest-model');await page.locator('#history-filter button[type=submit]').click();await page.waitForTimeout(500);assert.equal(await page.locator('.request-card').count(),1);assert.equal(await page.locator('.request-model').textContent(),'latest-model');
  await page.locator('#history-model').fill('');delayHistory=false;await page.locator('#history-filter button[type=submit]').click();await page.locator('.request-card').nth(1).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'history page must not overflow');await page.screenshot({path:out+'/mobile-history.png',fullPage:false});
  const box=await page.locator('.request-card').first().boundingBox();assert.ok(box.height<270,'compact history card '+box.height);await page.locator('.request-card').first().locator('summary').click();assert.equal(await page.locator('.request-card').first().locator('details').evaluate(e=>e.open),true);
  await page.locator('#history-refresh').click();await page.waitForTimeout(100);assert.equal(await page.locator('.request-card').first().locator('details').evaluate(e=>e.open),true);
  delayUsage=true;await page.locator('.mobile-nav [data-page="usage"]').click();await page.locator('#usage-range').selectOption('all');await page.waitForTimeout(450);assert.equal(await page.locator('#usage-cards .stat').first().locator('strong').textContent(),'401');
  await page.locator('.mobile-nav [data-page="overview"]').click();await page.screenshot({path:out+'/mobile-overview.png',fullPage:true});
  assert.match(await page.locator('#cleanup-status').textContent(),/保留 7 天，每实例至少 2 份/);
  status.retiredCleanup.slots.A.error='cleanup_candidate_retained';await page.locator('#refresh').click();
  await page.waitForFunction(()=>document.getElementById('cleanup-status').textContent.includes('部分资源未清理'));
  assert.match(await page.locator('#cleanup-status').textContent(),/原始凭据与运行数据保留/);
  status.retiredCleanup.slots.A.error=null;
  statusFailure=true;await page.locator('#refresh').click();await page.waitForTimeout(150);assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('stale')),true);assert.equal(await page.locator('#sync').isDisabled(),true);
  statusFailure=false;await page.locator('#refresh').click();await page.waitForTimeout(150);assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('stale')),false);assert.equal(await page.locator('#notice').isHidden(),true);
  await page.locator('.mobile-nav [data-page="accounts"]').click();
  failAfterSync=true;page.once('dialog',dialog=>dialog.accept());await page.locator('#sync').click();await page.waitForFunction(()=>document.getElementById('updated').textContent==='状态已过期');
  assert.match(await page.locator('#notice').textContent(),/状态读取失败/);assert.doesNotMatch(await page.locator('#notice').textContent(),/新增/);assert.equal(await page.locator('#sync').isDisabled(),true);
  failAfterSync=false;statusFailure=false;await page.locator('#refresh').click();await page.waitForFunction(()=>!document.getElementById('sync').disabled);
  syncFailure=true;page.once('dialog',dialog=>dialog.accept());await page.locator('#sync').click();await page.waitForFunction(()=>document.getElementById('updated').textContent==='操作后状态待核实');
  assert.match(await page.locator('#notice').textContent(),/请刷新状态后再操作/);assert.equal(await page.locator('#sync').isDisabled(),true);
  syncFailure=false;await page.locator('#refresh').click();await page.waitForFunction(()=>!document.getElementById('sync').disabled);
  realHistory=true;await page.locator('.mobile-nav [data-page="usage"]').click();await page.waitForFunction(()=>document.querySelector('#usage-cards .stat strong')?.textContent==='3');
  assert.equal(await page.locator('#usage-cards .stat-tokens strong').textContent(),'1.5K');assert.equal(await page.locator('.distribution-row').count(),2);assert.match(await page.locator('#usage-models').textContent(),/gemini-real-flash/);
  await page.locator('.mobile-nav [data-page="history"]').click();await page.waitForFunction(()=>document.querySelectorAll('.request-card').length===3);assert.match(await page.locator('#history-list').textContent(),/等待完成/);assert.match(await page.locator('#history-list').textContent(),/1K \/ 500/);
  await page.locator('#theme').click();await page.screenshot({path:out+'/mobile-dark.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('PASS: responsive 360–1440px, real quota/history schemas, 6 stats, accounts pagination/search/status/dialog, filter race, usage range race, disclosure preservation, cleanup retention/error notice, mutation failure/stale recovery controls, dark theme, zero runtime errors.');
 }finally{await browser.close();server.close();fs.rmSync(historyDir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);server.close();fs.rmSync(historyDir,{recursive:true,force:true});process.exitCode=1});
