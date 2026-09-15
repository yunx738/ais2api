'use strict';
(()=>{
 const $=id=>document.getElementById(id);
 const fields={inputPerMillion:'price-input',outputPerMillion:'price-output',cachedPerMillion:'price-cached',reasoningPerMillion:'price-reasoning'};
 let snapshot,reading=false,saving=false,valid=false;
 const message=text=>{$('price-message').textContent=text;};
 function controls(){
  $('price-save').disabled=!valid||reading||saving||snapshot?.blocked||!$('price-model').value;
  $('price-read').disabled=reading||saving;
  for(const e of $('price-form').elements)if(e.id!=='price-save')e.disabled=reading||saving;
 }
 async function call(body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const options={credentials:'same-origin',redirect:'error',signal:controller.signal,headers:{Accept:'application/json'}};
   if(body!==undefined){options.method='POST';options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
   const res=await fetch('/api/prices',options);
   if(!(res.headers.get('content-type')||'').includes('application/json'))throw Error('登录已失效或接口不可用');
   const data=await res.json();
   if(!res.ok)throw Error(res.status===409?'价格版本发生变化，请重新读取后核对再保存':res.status===503?'保存未确认，请重新读取；不要直接重复提交':typeof data.error==='string'?data.error:'价格操作失败');
   if(!Number.isSafeInteger(data.revision)||!Array.isArray(data.models)||!data.prices)throw Error('价格数据格式不完整');
   return data;
  }finally{clearTimeout(timer);}
 }
 function fill(){
  const price=snapshot?.prices?.[$('price-model').value];
  for(const [key,id] of Object.entries(fields))$(id).value=Number.isFinite(price?.[key])?String(price[key]):'';
  $('price-reasoning-mode').value=price?.reasoningMode||'unknown';controls();
 }
 function render(data){
  snapshot=data;
  const selected=$('price-model').value;
  $('price-model').replaceChildren(new Option('请选择原模型',''));
  for(const model of data.models)$('price-model').add(new Option(model,model));
  if(data.models.includes(selected))$('price-model').value=selected;
  valid=!data.blocked;fill();
 }
 async function load(){
  if(reading||saving)return;
  reading=true;controls();
  try{
   render(await call());
   message(snapshot.blocked?'价格写入已阻止，需要检查持久化状态':'当前价格版本 '+snapshot.revision+'；未配置的模型费用显示未知');
  }catch(e){valid=false;message('读取失败：'+e.message);}
  finally{reading=false;controls();}
 }
 $('price-form').addEventListener('submit',async event=>{
  event.preventDefault();
  if(!valid||reading||saving||!$('price-model').value)return;
  const price={currency:'USD',reasoningMode:$('price-reasoning-mode').value};
  for(const [key,id] of Object.entries(fields)){
   const text=$(id).value.trim();
   price[key]=text===''?null:Number(text);
   if(text!==''&&(!Number.isFinite(price[key])||price[key]<0||price[key]>1000000)){
    message('单价必须为非负有限数值，或留空表示未知');return;
   }
  }
  if(!confirm('保存 '+$('price-model').value+' 的参考单价？只影响之后请求，不修改历史费用和次数额度。'))return;
  const body={model:$('price-model').value,revision:snapshot.revision,price};
  saving=true;controls();
  try{render(await call(body));message('已保存价格版本 '+snapshot.revision+'；历史请求费用保持原价格。');}
  catch(e){valid=false;message('保存未完成或未确认：'+e.message+'。请点击重新读取。');}
  finally{saving=false;controls();}
 });
 $('price-model').addEventListener('change',fill);
 $('price-read').addEventListener('click',load);
 addEventListener('hashchange',()=>{if(location.hash==='#settings'&&!snapshot)load();});
 if(location.hash==='#settings')load();
 controls();
})();
