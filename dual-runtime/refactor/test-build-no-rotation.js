'use strict';
// Build failures must never cool an account or a model count, so they can never trigger a rotation.
const assert=require('assert');
const {RequestScheduler}=require('./request-scheduler');
const calls=[];
const fake={applyRejection:RequestScheduler.prototype.applyRejection,
 dispatch:{pool:{cooldown:(...a)=>calls.push(['account',...a])},quotas:{defer:(...a)=>calls.push(['model',...a])},checkpoint:()=>{}}};
const apply=(ticket,result)=>fake.applyRejection.call(fake,ticket,result);
const rej=status=>({status,rejection:{body:Buffer.from('{"error":"x"}')}});
for(const s of [401,403,429])apply({slot:'B',account:32,model:'build-gemini-3.8-flash',kind:'ultra'},rej(s));
assert.deepStrictEqual(calls,[],'Build rejections must not cool anything');
// regular models keep the old behaviour
apply({slot:'B',account:32,model:'gemini-3.8-flash',kind:'flash'},rej(429));
assert.strictEqual(calls.length,1);assert.strictEqual(calls[0][0],'model');
apply({slot:'B',account:32,model:'gemini-3.8-flash',kind:'flash'},rej(401));
assert.strictEqual(calls[1][0],'account');
console.log('build-no-rotation: all tests passed');
