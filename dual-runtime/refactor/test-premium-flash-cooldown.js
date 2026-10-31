'use strict';
// Pro/Ultra accounts must not rotate for flash/pro cooling; only gemini-4-argon (ultra family) exhaustion rotates them.
const assert=require('assert');
const {CatalogRouting}=require('./catalog-routing');
const path=require('path');
const {install}=require(path.join(__dirname,'..','code','stability.js'));
const policies={'gemini-3.8-flash':{quotaFamily:'flash',antiTruncation:false},'gemini-3.1-pro-preview':{quotaFamily:'pro',antiTruncation:false},'gemini-4-argon':{quotaFamily:'ultra',antiTruncation:true}};
function setup(blocked,premium){
 const now=Date.now();
 const pool={ids:[1,2],cursor:0,owners:new Map([[1,'B']]),cooldowns:new Map(),slots:new Map([['B',{current:1,pending:false}]])};
 const dispatch={pool,accountFlags:{},operations:new Map(),slots:new Map([['B',{active:0,ready:true,workerEpoch:'e'}]]),slotAllows:()=>true,
  quotas:{view:(id,model)=>({allowed:!(id===1&&blocked.has(model))})}};
 const models=Object.keys(policies).map(id=>({id,methods:['generateContent']}));
 const catalogs={cache:new Map([['B',{account:1,workerEpoch:'e',observedAt:now,snapshot:{account:1,stale:false,models,updatedAt:now-1}}]])};
 const r=new CatalogRouting(dispatch,catalogs,policies);r.isPremium=id=>premium;return r;
}
// premium: flash exhausted -> stay
let r=setup(new Set(['gemini-3.8-flash']),true);
assert.equal(r.rotationPlan('B',[{model:'gemini-3.8-flash',quotaFamily:'flash'}]),undefined);
assert.equal(r.rotationPlan('B',[]),undefined);
// premium: everything except argon exhausted -> stay
r=setup(new Set(['gemini-3.8-flash','gemini-3.1-pro-preview']),true);
assert.equal(r.exhausted('B'),false);
assert.equal(r.rotationPlan('B',[{model:'gemini-3.1-pro-preview',quotaFamily:'pro'}]),undefined);
// premium: argon exhausted -> rotate
r=setup(new Set(['gemini-4-argon']),true);
assert.equal(r.exhausted('B'),true);
assert.equal(r.rotationPlan('B',[]).target,2);
assert.equal(r.rotationPlan('B',[{model:'gemini-4-argon',quotaFamily:'ultra'}]).target,2);
// standard account: flash exhaustion still rotates (unchanged behaviour)
r=setup(new Set(['gemini-3.8-flash']),false);
assert.equal(r.rotationPlan('B',[{model:'gemini-3.8-flash',quotaFamily:'flash'}]).target,2);
// worker stability: flash 429/403 is per-model, does not set account cooldown
(async()=>{
 const logs=[];const h={currentAuthIndex:7,logger:{info(){},warn:m=>logs.push(m)},
  _switchToSpecificAuth(){},_switchToNextAuth(){},connectionRegistry:{messageQueues:new Map()},
  sent:[],_sendErrorResponse(res,code){this.sent.push(code);},
  async processRequest(req,res){this.reached=(this.reached||0)+1;if(req.fail)await this._handleRequestFailureAndSwitch({status:req.fail,message:req.msg||'x'});},
  async processOpenAIRequest(req,res){this.reached=(this.reached||0)+1;if(req.fail)await this._handleRequestFailureAndSwitch({status:req.fail,message:req.msg||'x'});}};
 install(h);
 const res=()=>({destroyed:false,writableEnded:true,on(){},removeListener(){},setHeader(){}});
 await h.processOpenAIRequest({body:{model:'gemini-3.8-flash'},path:'/v1/chat/completions',fail:429},res());
 assert.equal(h.accountCooldowns.size,0);assert.equal(h.globalCooldownUntil||0,0);
 assert.ok(h.modelCooldowns.get('7|gemini-3.8-flash').until>Date.now());
 // same flash again: gated with 429 by the model cooldown, handler not run
 await h.processOpenAIRequest({body:{model:'gemini-3.8-flash'},path:'/v1/chat/completions',fail:0},res());
 assert.deepEqual(h.sent,[429]);
 // argon on the same account still runs (handler reached, nothing sent)
 let ran=0;const orig=h._handleRequestFailureAndSwitch;h._handleRequestFailureAndSwitch=async e=>{ran++;return orig.call(h,e);};
 await h.processRequest({path:'/v1beta/models/gemini-4-argon:generateContent',fail:0},res());
 assert.equal(ran,0);assert.equal(h.reached,2);assert.deepEqual(h.sent,[429]);
 // random signature 403 cools nothing
 await h.processRequest({path:'/v1beta/models/gemini-3.9-flash:generateContent',fail:403,msg:'Google API返回错误: 403 Forbidden [,[7,"The caller does not have permission"]]'},res());
 assert.equal(h.accountCooldowns.size,0);assert.equal(h.modelCooldowns.has('7|gemini-3.9-flash'),false);
 // a 403 on pro is per-model too
 await h.processRequest({path:'/v1beta/models/gemini-3.1-pro-preview:generateContent',fail:403},res());
 assert.equal(h.accountCooldowns.size,0);assert.ok(h.modelCooldowns.get('7|gemini-3.1-pro-preview').status===403);
 // 401 is account-wide
 await h.processOpenAIRequest({body:{model:'gemini-4-argon'},path:'/v1/chat/completions',fail:401},res());
 assert.ok(h.accountCooldowns.get(7).until>Date.now());
 console.log('PASS premium flash cooldown');
})().catch(e=>{console.error(e);process.exit(1);});
