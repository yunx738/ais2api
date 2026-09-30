'use strict';
// Runs inside a throwaway browser container. Protocol: JSON lines.
// stdin : first line {email,password,upstream?}; later lines {value} or {cancel:true}
// stdout: {type:'status'|'need'|'result', ...}
const {firefox}=require('/app/node_modules/playwright');
const readline=require('readline');
const emit=o=>process.stdout.write(JSON.stringify(o)+'\n');
const rl=readline.createInterface({input:process.stdin});
const lines=[];let waiter=null;
rl.on('line',l=>{let m;try{m=JSON.parse(l);}catch{return;}if(m.cancel){emit({type:'result',ok:false,code:'CANCELLED',message:'已取消'});process.exit(0);}if(waiter){const w=waiter;waiter=null;w(m);}else lines.push(m);});
rl.on('close',()=>{if(waiter)process.exit(0);});
const next=ms=>new Promise((res,rej)=>{if(lines.length)return res(lines.shift());const t=setTimeout(()=>{waiter=null;rej(Error('INPUT_TIMEOUT'));},ms);waiter=m=>{clearTimeout(t);res(m);};});
const KEY=/^(SID|__Secure-1PSID|__Secure-3PSID|SAPISID|HSID|SSID)$/;
async function page2(p){const url=p.url();let text='';try{text=(await p.locator('body').innerText({timeout:3000})).replace(/\s+/g,' ').trim();}catch{}let host='',path='';try{const u=new URL(url);host=u.hostname;path=u.pathname;}catch{}return {url,host,path,text};}
function classify(s){
 if(s.host==='aistudio.google.com')return 'DONE';
 if(/\/signin\/rejected/.test(s.path))return 'REJECTED';
 if(/Wrong password|Your password was changed|密码错误/i.test(s.text))return 'WRONG_PASSWORD';
 if(/Couldn.t find your Google Account|找不到您的 Google 帐号/i.test(s.text))return 'NO_ACCOUNT';
 if(/browser or app may not be secure/i.test(s.text))return 'INSECURE';
 if(/\/challenge\//.test(s.path)||/\/speedbump|gaplustos|\/signin\/v2\/challenge/.test(s.path))return 'CHALLENGE';
 return 'PENDING';
}
function heading(t){
 const cut=t.replace(/^Loading\s*/,'');
 const m=cut.match(/^(.{0,220}?)(?:Try another way|Next|Learn more|$)/);
 return (m?m[1]:cut.slice(0,220)).trim();
}
async function clickAny(p,names){for(const n of names){const b=p.getByRole('button',{name:n,exact:false});if(await b.count().catch(()=>0)){await b.first().click({timeout:5000}).catch(()=>{});return true;}}return false;}
(async()=>{
 const init=await next(30000);
 const {email,password,upstream}=init;init.password=undefined;
 let proxy;
 if(upstream){
  const {Server}=require('/relay/node_modules/proxy-chain');
  const relay=new Server({host:'127.0.0.1',port:18993,verbose:false,prepareRequestFunction:()=>({upstreamProxyUrl:upstream})});
  await relay.listen();proxy={server:'http://127.0.0.1:18993'};
 }
 const browser=await firefox.launch({headless:true,executablePath:'/app/camoufox-linux/camoufox',...(proxy?{proxy}:{})});
 const ctx=await browser.newContext({locale:'en-US'});
 const p=await ctx.newPage();
 const finish=async r=>{emit({type:'result',...r});await browser.close().catch(()=>{});process.exit(0);};
 try{
  emit({type:'status',step:'open'});
  await p.goto('https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Faistudio.google.com%2Fprompts%2Fnew_chat&hl=en',{waitUntil:'domcontentloaded',timeout:60000});
  const em=p.locator('input[type=email], input#identifierId, input[name=identifier]').first();
  await em.waitFor({state:'visible',timeout:30000});
  await em.fill(email);await p.waitForTimeout(500);await p.keyboard.press('Enter');
  emit({type:'status',step:'email'});
  const pw=p.locator('input[type=password][name=Passwd], input[type=password]:visible').first();
  const hasPw=await pw.waitFor({state:'visible',timeout:25000}).then(()=>true,()=>false);
  if(!hasPw){const s=await page2(p);const c=classify(s);
   if(c==='NO_ACCOUNT')return finish({ok:false,code:c,message:'账号不存在'});
   if(c==='REJECTED'||c==='INSECURE')return finish({ok:false,code:c,message:'Google 拒绝了本次登录'});
   return finish({ok:false,code:'NO_PASSWORD_STEP',message:heading(s.text)||'未进入密码步骤'});}
  await pw.fill(password);await p.waitForTimeout(500);await p.keyboard.press('Enter');
  emit({type:'status',step:'password'});
  let asked=0,lastUrl='';
  for(let round=0;round<40;round++){
   await p.waitForTimeout(3000);
   const s=await page2(p),c=classify(s);
   if(c==='DONE')break;
   if(c==='WRONG_PASSWORD')return finish({ok:false,code:c,message:'密码错误'});
   if(c==='REJECTED'||c==='INSECURE')return finish({ok:false,code:c,message:'Google 拒绝了本次登录，稍后再试或换号'});
   if(/\/speedbump|gaplustos/.test(s.path)){await clickAny(p,['I understand','I agree','Accept','Continue','Not now','Skip','Confirm']);continue;}
   if(c!=='CHALLENGE')continue;
   const input=p.locator('input[type=tel]:visible, input[type=text]:visible, input[type=email]:visible, input[type=number]:visible').first();
   const hasInput=await input.count().catch(()=>0);
   if(!hasInput){
    if(await clickAny(p,['Not now','Skip','Continue','Confirm','Done']))continue;
    if(s.url===lastUrl&&round>3)return finish({ok:false,code:'CHALLENGE_UNSUPPORTED',message:heading(s.text)||'需要额外验证，暂不支持'});
    lastUrl=s.url;continue;
   }
   if(asked>=5)return finish({ok:false,code:'TOO_MANY_STEPS',message:'验证步骤过多'});
   asked++;
   const kind=/phone number|电话号码|手机号/i.test(s.text)&&!/code|验证码/i.test(s.text.slice(0,200))?'phone':(/code|验证码|G-/i.test(s.text)?'code':'text');
   emit({type:'need',kind,prompt:heading(s.text).slice(0,200)});
   let m;try{m=await next(300000);}catch{return finish({ok:false,code:'INPUT_TIMEOUT',message:'等待输入超时'});}
   const v=String(m.value||'').trim().slice(0,64);
   if(!v)return finish({ok:false,code:'CANCELLED',message:'已取消'});
   await input.fill(v);await p.waitForTimeout(400);
   if(!await clickAny(p,['Next','Verify','Send','下一步']))await p.keyboard.press('Enter');
   emit({type:'status',step:'verifying'});
   await p.waitForTimeout(5000);
  }
  let s=await page2(p);
  if(classify(s)!=='DONE')return finish({ok:false,code:'TIMEOUT',message:'登录超时'});
  await p.waitForTimeout(3000);
  const st=await ctx.storageState();
  const keys=st.cookies.filter(c=>KEY.test(c.name)).length;
  if(keys<3)return finish({ok:false,code:'NO_COOKIES',message:'登录后未取得有效登录状态'});
  return finish({ok:true,storage:{cookies:st.cookies,origins:st.origins}});
 }catch(e){return finish({ok:false,code:'ERROR',message:'登录过程出错：'+String(e.message||'').split('\n')[0].slice(0,120)});}
})().catch(()=>{emit({type:'result',ok:false,code:'ERROR',message:'登录过程出错'});process.exit(0);});
setTimeout(()=>{emit({type:'result',ok:false,code:'TIMEOUT',message:'登录超时'});process.exit(0);},15*60000).unref();
