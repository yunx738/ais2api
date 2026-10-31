const {AsyncLocalStorage}=require("async_hooks");
class SerialGate {
 constructor(limit=10){this.limit=limit;this.activeCount=0;this.queue=[];this.context=new AsyncLocalStorage();}
 run(fn,valid=()=>true){
  if(this.context.getStore()===this)return Promise.resolve().then(fn);
  if(this.queue.length>=10)return Promise.reject(Object.assign(Error("请求队列已满"),{status:503}));
  return new Promise((resolve,reject)=>{
   const item={fn,valid,resolve,reject};
   item.timer=setTimeout(()=>{
    const i=this.queue.indexOf(item);
    if(i>=0){this.queue.splice(i,1);reject(Object.assign(Error("排队超过120秒"),{status:503}));}
   },120000);
   this.queue.push(item);this.pump();
  });
 }
 pump(){
  while(this.activeCount<this.limit && this.queue.length){
   const item=this.queue.shift();
   clearTimeout(item.timer);this.activeCount++;
   (async()=>{
    try{if(item.valid())item.resolve(await this.context.run(this,item.fn));else item.resolve();}
    catch(e){item.reject(e);}
    finally{this.activeCount--;this.pump();}
   })();
  }
 }
}
const modelScope=new AsyncLocalStorage();
// Model of the current request (route /models/<id>:... or OpenAI body.model), anti-truncation prefix removed.
function requestModel(req){
 let m="";
 try{
  const p=/\/models\/([^:\/?]+)/.exec(req.path||req.url||"");
  m=p?decodeURIComponent(p[1]):(typeof req.body?.model==="string"?req.body.model:"");
 }catch{}
 m=String(m).replace(/^models\//,"").replace(/^anti-truncation\//,"");
 return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(m)?m:"";
}
function install(h){
 const gate=new SerialGate();h.stabilityGate=gate;
 for(const name of ["_switchToSpecificAuth","_switchToNextAuth"]){
  const old=h[name].bind(h);
  h[name]=(...args)=>gate.run(()=>old(...args));
 }
 for(const name of ["processRequest","processOpenAIRequest"]){
  const old=h[name].bind(h);
  h[name]=(req,res)=>gate.run(async()=>{
   if(res.destroyed)return;
   const account=h.currentAuthIndex;
   const model=requestModel(req);
   const state=h.accountCooldowns?.get(account);
   const mstate=h.modelCooldowns?.get(account+"|"+model);
   const until=Math.max(h.globalCooldownUntil||0,state?.until||0,mstate?.until||0);
   if(until>Date.now()){
    res.setHeader("Retry-After",String(Math.ceil((until-Date.now())/1000)));
    return h._sendErrorResponse(res,(mstate?.until>Date.now()?mstate:state)?.status===403?403:429,"账号或服务处于冷却期，请稍后重试或检查授权");
   }
    const scope=require("./operation-tracker").requestScope.getStore();
   const abort=()=>{
    if(!(scope instanceof Set))return;
    for(const id of [...h.connectionRegistry.messageQueues.keys()]){
     if(scope instanceof Set && !scope.has(id))continue;
     h._cancelBrowserRequest(id);h.connectionRegistry.removeMessageQueue(id);
    }
   };
   const close=()=>{if(!res.writableEnded)abort();};
   res.on("close",close);
   const timer=null; // no request time limit
   try{return await modelScope.run(model,()=>old(req,res));}
   finally{clearTimeout(timer);res.removeListener("close",close);}
  },()=>!res.destroyed).catch(e=>{
   if(!res.destroyed)h._sendErrorResponse(res,e.status||503,"请求未执行："+e.message);
  });
 }
 h.accountCooldowns=new Map();h.modelCooldowns=new Map();
 h._handleRequestFailureAndSwitch=async function(error){
  const status=Number(error.status)||500;
  if(/abort/i.test(error.message||""))return;
  if(/UPSTREAM_CUT|UPSTREAM_NO_RESPONSE|UPSTREAM_CONNECTION_LOST/.test(String(error.message||""))){this.logger.warn("[Stability] 上游中途断开/无响应；不冷却账号或模型");return;}
  if(/region not supported|not available in your (?:country|region)|user location is not supported/i.test(String(error.message||"")+String(error.body||""))){
   this.logger.warn("[Stability] 账号 #"+this.currentAuthIndex+" 出口地区被拒绝；不冷却账号");
   return;
  }
  if(status===403&&/caller does not have permission/i.test(String(error.message||"")+String(error.body||""))){
   this.logger.warn("[Stability] 账号 #"+this.currentAuthIndex+" 签名被拒(403 caller does not have permission)；属谷歌随机风控，不冷却账号或模型");
   return;
  }
  // 429/403/5xx belong to the model that received them: a flash limit must not block
  // gemini-4-argon, nor make the coordinator retire the account. 401 stays account-wide.
  const model=modelScope.getStore();
  const perModel=status!==401&&!!model;
  const key=perModel?this.currentAuthIndex+"|"+model:this.currentAuthIndex;
  const map=perModel?this.modelCooldowns:this.accountCooldowns;
  const previous=map.get(key);
  const strikes=(previous?.strikes||0)+1;
  let seconds=0;
  if(status===429){
   const raw=error.retry_after;
   const retry=Number(raw)||Math.ceil((Date.parse(raw)-Date.now())/1000);
   seconds=Math.max(60,Number.isFinite(retry)?retry:Math.min(3600,60*2**Math.min(strikes-1,6)));
   if(!perModel)this.globalCooldownUntil=Math.max(this.globalCooldownUntil||0,Date.now()+seconds*1000);
  }else if([401,403].includes(status)){seconds=86400;}
  else if([500,502,503,504].includes(status)){seconds=Math.min(300,15*2**Math.min(strikes-1,5));}
  if(seconds){
   map.set(key,{until:Date.now()+seconds*1000,status,strikes});
   this.needsSwitchingAfterRequest=false;
   this.logger.warn("[Stability] 账号 #"+this.currentAuthIndex+(perModel?" 模型 "+model:"")+" 状态 "+status+"；冷却 "+seconds+" 秒，不因错误换号");
  }
 };
 h.logger.info("[Stability] 并发上限"+gate.limit+"（实际并发由协调器按实例设置控制），排队上限10，等待120秒；按请求隔离取消");
}
module.exports={install,SerialGate,requestModel};
