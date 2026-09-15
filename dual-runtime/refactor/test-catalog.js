'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {ModelCatalog} = require('./model-catalog');
const model = id => ({name:'models/'+id,supportedGenerationMethods:['generateContent']});
test('paged refresh publishes only complete snapshots and keeps accounts separate',async () => {
  let fail = false;
  const c = new ModelCatalog({fetchPage:async ({account,pageToken}) => {
    if (fail && pageToken) throw Error('private upstream details');
    return pageToken ? {models:[model('second-'+account)]} :
      {models:[model('first-'+account)],nextPageToken:'next'};
  }});
  await c.refresh(4); await c.refresh(5);
  assert.equal(c.snapshot(4).models.length,2);
  assert.equal(c.snapshot(5).models[0].id,'first-5');
  fail = true;
  await assert.rejects(c.refresh(4),/^Error: Catalog refresh failed$/);
  assert.equal(c.snapshot(4).models.length,2);
  assert.equal(c.snapshot(4).stale,true);
  assert.equal(c.snapshot(5).stale,false);
});
test('request resolution shares catalog and never guesses a quota category',async () => {
  const c = new ModelCatalog({
    fetchPage:async () => ({models:[model('known'),model('new-model')]}),
    policies:{known:{quotaBucket:'pro',antiTruncation:true}}
  });
  await c.refresh(4);
  assert.equal(c.resolve(4,'/v1beta/models/known:generateContent',{}).quotaBucket,'pro');
  assert.equal(c.resolve(4,'/v1/chat/completions',{model:'anti-truncation/known'}).upstreamId,'known');
  assert.throws(() => c.resolve(4,'/v1/chat/completions',{model:'new-model'}),/quota policy/);
  assert.throws(() => c.resolve(5,'/v1/chat/completions',{model:'known'}),/unavailable/);
});
test('duplicate refresh joins one operation and consumers cannot mutate snapshots',async () => {
  let calls = 0;
  const c = new ModelCatalog({fetchPage:async () => {calls++; return {models:[model('one')]};}});
  const a = c.refresh(4), b = c.refresh(4);
  assert.equal(a,b); await a; assert.equal(calls,1);
  c.snapshot(4).models[0].id='bad';
  assert.equal(c.snapshot(4).models[0].id,'one');
});
test('cyclic pagination fails without publishing partial results',async () => {
  const c = new ModelCatalog({fetchPage:async () => ({models:[model('one')],nextPageToken:'loop'})});
  await assert.rejects(c.refresh(4),/refresh failed/);
  assert.equal(c.snapshot(4), null);
});
test('successful refresh removes delisted models',async () => {
  let models = [model('one'),model('two')];
  const c = new ModelCatalog({fetchPage:async () => ({models})});
  await c.refresh(4); models = [model('two')]; await c.refresh(4);
  assert.deepEqual(c.snapshot(4).models.map(x => x.id),['two']);
});
