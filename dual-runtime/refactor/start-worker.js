'use strict';
const {Server}=require('/relay/node_modules/proxy-chain');
const {ProxyServerSystem}=require('./unified-server');
const {createWorker}=require('./worker-system');
const {install}=require('./worker-operations');
async function main(){
 const account=Number(process.env.WORKER_ACCOUNT);
 if(!Number.isSafeInteger(account)||account<1)throw Error('Invalid assignment');
 const upstream=new URL(process.env.SOCKS_UPSTREAM_URL);
 if(upstream.protocol!=='socks5:'||!upstream.username||!upstream.password)throw Error('Invalid upstream configuration');
 const relay=new Server({
  host:'127.0.0.1',port:18992,verbose:false,
  prepareRequestFunction:()=>({upstreamProxyUrl:upstream.href})
 });
 relay.on('requestFailed',()=>console.warn('[WorkerRelay] upstream failure'));
 await relay.listen();
 process.env.PROXY_URL='http://127.0.0.1:18992';
 const worker=createWorker(ProxyServerSystem,account,require('path').join(__dirname,'auth'));
 require('./worker-protocol').install(worker.system.connectionRegistry);
 const tracker=install(worker.system);
 worker.system.workerStatus=()=>({
  ...worker.status(),
  quarantined:tracker.quarantined,
  hardQuarantine:tracker.hardQuarantine,
  pendingCompletions:tracker.unconfirmed.size,
  browserOperations:tracker.active.size,
  cooldownUntil:Math.max(
   worker.system.requestHandler.globalCooldownUntil||0,
   worker.system.requestHandler.accountCooldowns?.get(account)?.until||0
  )
 });
const slot=process.env.WORKER_SLOT;
 require('./worker-executions').install({
  system:worker.system,tracker,account,slot
 });
require('./worker-catalog-service').install({
 system:worker.system,tracker,
 requestScope:require('./operation-tracker').requestScope,account
});
require(`./worker-http`).install(worker.system,process.env.WORKER_CONTROL_KEY);
 await worker.system.start(account);
 console.log('[Worker] assigned account #'+account+' started; readiness must be checked separately');
}
main().catch(()=>{
 console.error('[Worker] startup failed; stopping without direct-network fallback');
 process.exit(1);
});
