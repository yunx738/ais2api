'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const vm=require('vm'),fs=require('fs'),path=require('path');
function setup(){
 const nodes=new Map(),posts=[],globalEvents={},errors=[];
 function element(id){
  return {id,value:'',disabled:false,textContent:'',listeners:{},children:[],
   addEventListener(event,fn){this.listeners[event]=fn;},
   replaceChildren(...items){this.children=items;this.value=items[0]?.value||'';},
   add(item){this.children.push(item);}
  };
 }
 const ids=['price-form','price-message','price-read','price-save','price-model','price-input','price-output','price-cached','price-reasoning','price-reasoning-mode'];
 for(const id of ids)nodes.set(id,element(id));
 nodes.get('price-form').elements=ids.filter(id=>!['price-form','price-message','price-read'].includes(id)).map(id=>nodes.get(id));
 let revision=0,nextError=0;
 const payload=()=>({revision,models:['gemini-test'],prices:{},blocked:false});
 const sandbox={
 document:{getElementById:id=>{if(!nodes.has(id))throw Error('Missing node '+id);return nodes.get(id);}},
 location:{hash:''},AbortController,setTimeout,clearTimeout,
 Option:function(text,value){this.text=text;this.value=value;},
 confirm:()=>true,
 addEventListener:(event,fn)=>{globalEvents[event]=fn;},
 fetch:async(url,options)=>{
  assert.equal(url,'/api/prices');
  assert.equal(options.credentials,'same-origin');
  assert.equal(options.redirect,'error');
  let status=200,data;
  if(options.method==='POST'){
   posts.push(JSON.parse(options.body));
   if(nextError){status=nextError;data={error:'mock conflict'};}
   else{revision++;data=payload();}
  }else data=payload();
  return {ok:status===200,status,headers:{get:()=> 'application/json'},json:async()=>data};
 }
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'ui/prices.js'),'utf8'),sandbox);
 const get=id=>nodes.get(id);
 async function event(id,type){
  try{await get(id).listeners[type]({preventDefault(){}});}catch(e){errors.push(e);throw e;}
 }
 async function load(){
  await event('price-read','click');
  get('price-model').value='gemini-test';await event('price-model','change');
 }
 return {get,event,load,posts,errors,setError:code=>{nextError=code;}};
}
test('price UI blank fields submit explicit unknown values, not zero',async()=>{
 const f=setup();await f.load();
 await f.event('price-form','submit');
 assert.equal(f.posts.length,1);
 const p=f.posts[0].price;
 for(const k of ['inputPerMillion','outputPerMillion','cachedPerMillion','reasoningPerMillion'])
  assert.equal(p[k],null);
 assert.equal(f.posts[0].revision,0);
 assert.match(f.get('price-message').textContent,/已保存/);
 assert.equal(f.errors.length,0);
});
test('price UI preserves explicit zero and prevents negative input',async()=>{
 const f=setup();await f.load();
 f.get('price-input').value='0';f.get('price-output').value='8';
 await f.event('price-form','submit');
 assert.equal(f.posts[0].price.inputPerMillion,0);
 assert.equal(f.posts[0].price.outputPerMillion,8);
 f.get('price-model').value='gemini-test';await f.event('price-model','change');
 f.get('price-input').value='-1';
 await f.event('price-form','submit');
 assert.equal(f.posts.length,1);assert.match(f.get('price-message').textContent,/非负/);
});
test('price UI conflict requires reread and does not automatically retry',async()=>{
 const f=setup();await f.load();f.setError(409);
 await f.event('price-form','submit');
 assert.equal(f.posts.length,1);assert.equal(f.get('price-save').disabled,true);
 assert.match(f.get('price-message').textContent,/版本发生变化/);
 await f.event('price-form','submit');assert.equal(f.posts.length,1);
 f.setError(0);await f.load();
 assert.equal(f.get('price-save').disabled,false);
});
test('price UI missing session disables saving until refreshed',async()=>{
 const f=setup();
 assert.equal(f.get('price-save').disabled,true);
 await f.event('price-form','submit');assert.equal(f.posts.length,0);
});
