'use strict';
// Add-account tools and system settings, moved from the old /import page. Same APIs, same CSRF token.
(()=>{
let token="",tokenTask=null;const limit=262144;
// The import page injects the per-session CSRF token; read it from there (same login session, no backend change).
async function getToken(force){
 if(token&&!force)return token;
 if(!tokenTask)tokenTask=(async()=>{const r=await fetch("/import",{credentials:"same-origin",redirect:"error",cache:"no-store"});const t=await r.text();const m=/name="import-token" content="([0-9a-f]{64})"/.exec(t)||/const token="([0-9a-f]{64})"/.exec(t);if(!m)throw Error("无法取得请求校验码，请刷新页面");token=m[1];return token;})().finally(()=>{tokenTask=null;});
 return tokenTask;
}
async function tpost(url,body,headers={}){
 for(let attempt=0;attempt<2;attempt++){
  const r=await fetch(url,{method:"POST",credentials:"same-origin",redirect:"error",headers:{"Content-Type":"application/json","X-Import-Token":await getToken(attempt>0),...headers},body:JSON.stringify(body)});
  if(r.status===403&&attempt===0)continue;
  return r;
 }
}
const $=id=>document.getElementById(id);
let prepared=null,busy=false;
function reset(){prepared=null;$("send").disabled=true;}
function convertCookies(text){
 if(new TextEncoder().encode(text).length>limit)throw Error("输入超过256 KiB");
 let d;try{d=JSON.parse(text);}catch{throw Error("JSON格式无效；请粘贴完整JSON，不是Cookie请求头");}
 const arr=Array.isArray(d)?d:d&&d.cookies;
 if(!Array.isArray(arr)||!arr.length||arr.length>200)throw Error("需要包含1至200个Cookie的数组");
 let sessions=0,defaults=0;const seen=new Set();
 const cookies=arr.map((c,i)=>{
  const fail=msg=>{throw Error("第"+(i+1)+"个Cookie："+msg);};
  if(!c||typeof c!=="object")fail("结构无效");
  if(typeof c.name!=="string"||!c.name||c.name.length>256||typeof c.value!=="string"||c.value.length>16384)fail("名称或值类型/长度无效");
  if(typeof c.domain!=="string"||!/^\.?([a-z0-9-]+\.)*google\.com$/i.test(c.domain))fail("缺少或不支持的域名，仅支持google.com及其子域");
  if(typeof c.path!=="string"||!c.path.startsWith("/")||c.path.length>2048)fail("缺少有效path");
  if(typeof c.httpOnly!=="boolean"||typeof c.secure!=="boolean")fail("缺少httpOnly或secure布尔属性");
  if(c.partitionKey != null ||c.partitioned===true)fail("暂不支持分区Cookie，避免转换时丢失属性");
  let expires=c.session===true?-1:(c.expires??c.expirationDate??-1);
  if(!Number.isFinite(expires)||expires< -1||expires>253402300799)fail("有效期必须是Unix秒时间戳或-1");
  if(expires===-1)sessions++;
  else if(expires<=Date.now()/1000)fail("Cookie已过期，请重新导出");
  const ss=c.sameSite == null ?"unspecified":String(c.sameSite).toLowerCase();
  const map={lax:"Lax",strict:"Strict",none:"None",no_restriction:"None",unspecified:"Lax"};
  if(!Object.hasOwn(map,ss))fail("无法识别SameSite");
  if(ss==="unspecified")defaults++;
  const sameSite=map[ss];
  if(sameSite==="None"&&!c.secure)fail("SameSite=None但secure=false，请检查原始导出");
  const key=JSON.stringify([c.name,c.domain,c.path]);
  if(seen.has(key))fail("名称、域名和路径重复");seen.add(key);
  return {name:c.name,value:c.value,domain:c.domain,path:c.path,expires,httpOnly:c.httpOnly,secure:c.secure,sameSite};
 });
 const origins=Array.isArray(d)?[]:(d.origins??[]);
 if(!Array.isArray(origins)||origins.length>20)throw Error("origins结构无效");
 const cleanOrigins=origins.map(o=>{
  if(!o||!["https://aistudio.google.com","https://ai.studio","https://accounts.google.com"].includes(o.origin)||!Array.isArray(o.localStorage)||o.localStorage.length>200)throw Error("不支持的origin或localStorage结构");
  if(o.indexedDB != null)throw Error("暂不支持含IndexedDB的认证文件，避免丢失状态");
  return {origin:o.origin,localStorage:o.localStorage.map(v=>{
   if(!v||typeof v.name!=="string"||typeof v.value!=="string"||v.name.length>1024||v.value.length>65536)throw Error("localStorage字段无效");
   return {name:v.name,value:v.value};
  })};
 });
 const data={cookies,origins:cleanOrigins};
 if(new TextEncoder().encode(JSON.stringify(data)).length>limit)throw Error("转换结果超过256 KiB");
 return {data,summary:"本地校验通过："+cookies.length+"个Cookie，"+cleanOrigins.length+"个origin。\n会话Cookie："+sessions+"个。"+(defaults?"\n注意："+defaults+"个未指定SameSite，按Lax转换。":"")+""};
}
$("raw").oninput=()=>{reset();$("file").value="";$("result").textContent="输入已更改，请重新转换。";};
$("file").onchange=()=>{reset();$("raw").value="";$("result").textContent="已选择文件，请点击本地转换。";};
$("convert").onclick=async()=>{
 if(busy)return;reset();const f=$("file").files[0];
 try{
  if(f&&f.size>limit)throw Error("文件超过256 KiB");
  const text=f?await f.text():$("raw").value;
  const result=convertCookies(text);prepared=result.data;
  $("result").textContent=result.summary;$("send").disabled=false;
 }catch(e){$("result").textContent=e.message;}
};
$("clear").onclick=()=>{reset();$("raw").value="";$("file").value="";$("result").textContent="已清空";};
$("send").onclick=async()=>{
 if(!prepared||busy)return;busy=true;
 for(const id of ["send","convert","raw","file","clear"])$(id).disabled=true;
 try{
  const r=await tpost("/api/import-account",prepared,{"X-Account-Tier":$("ctier").value,"X-Account-Alias":encodeURIComponent($("cname").value.trim())});
  const d=await r.json();
  if(r.ok){$("raw").value="";$("file").value="";$("cname").value="";$("result").textContent="导入成功：账号 #"+d.index+(d.alias?" · "+d.alias:"")+(d.tier==="ultra20"?"（Ultra 20x）":d.tier==="ultra"?"（Ultra 5x）":d.tier==="pro"?"（Pro）":"");uload();document.getElementById("refresh")?.click();}
  else $("result").textContent=d.error||"服务器拒绝导入";
 }catch{$("result").textContent="未能确认导入结果。请先检查首页账号列表，避免重复导入。";}
 finally{busy=false;reset();for(const id of ["convert","raw","file","clear"])$(id).disabled=false;}
};
window.addEventListener("pagehide",()=>{reset();$("raw").value="";$("file").value="";});
let job=null,timer=null;
const STEP={pausing_worker:"正在暂停一个实例",starting:"正在启动",open:"正在打开登录页",email:"已提交邮箱",password:"已提交密码，等待结果",verifying:"正在验证"};
function lbusy(on){$("lgo").disabled=on;$("le").disabled=on;$("lp").disabled=on;$("lcancel").disabled=!on;}
async function lpost(url,body){const r=await tpost(url,body);return {ok:r.ok,d:await r.json().catch(()=>({}))};}
function lshow(j){
 if(j.status==="need"){$("lneed").hidden=false;$("lprompt").textContent=(j.need.kind==="phone"?"需要手机号：":j.need.kind==="code"?"需要验证码：":"需要输入：")+(j.need.prompt||"");$("lv").type=j.need.kind==="phone"?"tel":"text";$("lres").textContent="等待输入";$("lv").focus();return;}
 $("lneed").hidden=true;
 if(j.status==="done"){$("lres").textContent="添加成功：账号 "+j.account+(j.message?"\n"+j.message:"");stop();return;}
 if(j.status==="failed"){$("lres").textContent="失败："+(j.message||"登录失败");stop();return;}
 $("lres").textContent=STEP[j.step]||"处理中";
}
function stop(){clearInterval(timer);timer=null;job=null;lbusy(false);$("lp").value="";}
async function poll(){if(!job)return;try{const r=await fetch("/api/login/job?id="+job,{credentials:"same-origin",redirect:"error"});const d=await r.json();if(!r.ok){$("lres").textContent=d.error||"查询失败";stop();return;}lshow(d);}catch{$("lres").textContent="连接中断，稍后刷新账号列表确认结果";}}
$("lgo").onclick=async()=>{
 const email=$("le").value.trim(),password=$("lp").value;
 if(!email||!password){$("lres").textContent="请填写邮箱和密码";return;}
 lbusy(true);$("lres").textContent="正在启动";
 try{const {ok,d}=await lpost("/api/login/start",{email,password,remember:$("lrem").checked,tier:$("ltier").value,alias:$("lname").value.trim()});$("lp").value="";
  if(!ok){$("lres").textContent=d.error||"无法开始登录";lbusy(false);return;}
  job=d.id;lshow(d);timer=setInterval(poll,2500);}
 catch{$("lres").textContent="无法开始登录";lbusy(false);}
};
$("lsend").onclick=async()=>{const v=$("lv").value.trim();if(!v||!job)return;$("lsend").disabled=true;
 try{const {ok,d}=await lpost("/api/login/job",{id:job,action:"input",value:v});$("lv").value="";if(!ok)$("lres").textContent=d.error||"提交失败";else lshow(d);}
 finally{$("lsend").disabled=false;}};
$("lcancel").onclick=async()=>{if(!job)return;await lpost("/api/login/job",{id:job,action:"cancel"}).catch(()=>{});$("lres").textContent="已取消";stop();};
window.addEventListener("pagehide",()=>{$("lp").value="";$("lv").value="";});
// ---- login proxy + workspace ----
const WSTEP={pausing_worker:"正在暂停一个实例",starting:"正在启动",running:"执行中"};
let wjob=null,wtimer=null;
function pxShow(p){$("pxs").textContent=p&&p.host?((p.enabled?"使用中：":"已停用：")+p.type+" "+p.host+":"+p.port+(p.username?"（"+p.username+"）":"")):(p&&p.source==="default"?"使用默认登录代理":"直连");
 if(p&&p.host){$("pxt").value=p.type;$("pxh").value=p.host;$("pxp").value=p.port;$("pxu").value=p.username||"";$("pxe").checked=p.enabled;}}
function wproviderShow(){const temp=$("wprovider").value==="tempmail";$("wtempfields").hidden=!temp;$("wgraphfields").hidden=temp;$("wauth").hidden=temp;}
$("wprovider").onchange=wproviderShow;
async function wload(){try{const r=await fetch("/api/ws/config",{credentials:"same-origin",redirect:"error"});const d=await r.json();if(!r.ok){$("wstat").textContent=d.error||"读取失败";return;}
 const c=d.config;$("wdom").value=c.domain||"";$("wmail").value=c.mailbox||c.tempmail_address||"";$("wapi").value=c.tempmail_api||"";$("wprovider").value=c.mail_provider||"tempmail";$("wcid").value=c.graph_client_id||"";$("wrec").value=c.recovery_email||"";$("wkey").value=(c.mail_subject_keywords||[]).join(",");
 $("wsecret").textContent=c.has_tempmail_admin?"密码已设置":"尚未设置密码";wproviderShow();
 const temp=$("wprovider").value==="tempmail",ready=c.domain&&$("wmail").value&&c.recovery_email&&(temp?c.tempmail_api&&c.has_tempmail_admin:c.graph_client_id);
 $("wstat").textContent=ready?(temp?"API 已配置":d.mailAuthorized?"邮箱已授权":"邮箱未授权"):"设置未完成";pxShow(d.proxy);
 }catch{$("wstat").textContent="读取失败";}}
$("pxsave").onclick=async()=>{const {ok,d}=await lpost("/api/login-proxy",{type:$("pxt").value,host:$("pxh").value.trim(),port:Number($("pxp").value),username:$("pxu").value.trim(),password:$("pxw").value,enabled:$("pxe").checked}).catch(()=>({ok:false,d:{}}));$("pxw").value="";
 if(!ok){$("pxs").textContent=d.error||"保存失败";return;}pxShow(d.proxy);};
$("pxclear").onclick=async()=>{const {ok,d}=await lpost("/api/login-proxy",{clear:true}).catch(()=>({ok:false,d:{}}));if(ok){["pxh","pxp","pxu","pxw"].forEach(k=>$(k).value="");pxShow(d.proxy);}};
function wsettings(){
 const p={domain:$("wdom").value.trim(),mailbox:$("wmail").value.trim(),mail_provider:$("wprovider").value,recovery_email:$("wrec").value.trim(),mail_subject_keywords:$("wkey").value.split(/[,，]/).map(x=>x.trim()).filter(Boolean)};
 if(!p.domain||!p.mailbox||!p.recovery_email)throw Error("请填写账号域名、完整收信邮箱和辅助邮箱");
 if(p.mail_provider==="tempmail"){
  let u;try{u=new URL($("wapi").value.trim());}catch{throw Error("请填写有效的邮箱 API 地址");}
  if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw Error("API 地址应为 HTTPS 根地址，不是收件箱页面或带 JWT 的链接");
  p.tempmail_api=u.origin;p.tempmail_admin=$("wta").value;
 }else{p.graph_client_id=$("wcid").value.trim();if(!p.graph_client_id)throw Error("请填写 Azure 应用 ID");}
 return p;
}
$("wsave").onclick=async()=>{const out=$("wcfgres");let payload;try{payload=wsettings();}catch(e){out.textContent=e.message;return;}
 $("wsave").disabled=true;out.textContent="正在保存";
 try{const {ok,d}=await lpost("/api/ws/config",payload);if(!ok){out.textContent=d.error||"保存失败";return;}
  $("wta").value="";$("witems").textContent="";out.textContent="已保存 · "+payload.mailbox;await wload();
 }catch{out.textContent="保存结果未确认，请刷新后检查";}finally{$("wsave").disabled=false;}
};
function wbusy(b){["wauth","wlist"].forEach(k=>$(k).disabled=b);$("wcancel").disabled=!b;document.querySelectorAll(".wrun").forEach(x=>x.disabled=b);}
function wstop(){clearInterval(wtimer);wtimer=null;wjob=null;wbusy(false);$("wneed").hidden=true;}
function witems(list){const box=$("witems");box.textContent="";if(!list.length){box.innerHTML='<p class="sub">没有待激活的账号</p>';return;}
 for(const it of list){const row=document.createElement("div");row.className="item";
  const info=document.createElement("div"),t=document.createElement("b"),m=document.createElement("span");t.textContent=it.alias||"(未知收件人)";m.className="sub";m.textContent=it.time||"";info.append(t,m);
  const b=document.createElement("button");b.className="wrun p";b.type="button";b.textContent="激活";b.onclick=()=>wstart("run",it.id);
  row.append(info,b);box.append(row);}}
function wshow(j){
 if(j.status==="need"&&j.need&&j.need.kind==="device"){$("wneed").hidden=false;$("wuri").href=j.need.uri;$("wuri").textContent=j.need.uri;$("wcode").textContent=j.need.code;$("wres").textContent="等待授权";return;}
 $("wneed").hidden=true;const log=(j.log||[]).join("\n");
 const resume=j.resume==="failed"?"\n实例恢复未确认，请查看管理页面":"";
 if(j.status==="done"){
  if(j.kind==="list"){witems(j.items||[]);$("wres").textContent="";}
  else if(j.kind==="mail-auth"){$("wres").textContent="邮箱授权成功";wload();}
  else $("wres").textContent="添加成功：账号 "+j.account+(j.email?"（"+j.email+"）":"")+(j.message?"\n"+j.message:"")+resume;
  if(j.resume!=="resuming")wstop();return;}
 if(j.status==="failed"){$("wres").textContent="失败："+(j.message||"")+resume+(log?"\n\n"+log:"");if(j.resume!=="resuming")wstop();return;}
 $("wres").textContent=(WSTEP[j.step]||"处理中")+(log?"\n\n"+log:"");}
async function wpoll(){if(!wjob)return;try{const r=await fetch("/api/ws/job?id="+wjob,{credentials:"same-origin",redirect:"error"});const d=await r.json();if(!r.ok){$("wres").textContent=d.error||"查询失败";wstop();return;}wshow(d);}catch{}}
async function wstart(kind,mailId){if(kind==="run"&&!confirm("将为这个账号改密、绑定两步验证和辅助邮箱，并"+pauseText()+"。继续？"))return;
 wbusy(true);$("wres").textContent="正在启动";
 const {ok,d}=await lpost("/api/ws/start",{kind,mailId}).catch(()=>({ok:false,d:{}}));
 if(!ok){$("wres").textContent=d.error||"无法开始";wbusy(false);return;}wjob=d.id;wshow(d);wtimer=setInterval(wpoll,3000);}
$("wauth").onclick=()=>wstart("mail-auth");$("wlist").onclick=()=>wstart("list");
$("wcancel").onclick=async()=>{if(!wjob)return;await lpost("/api/ws/cancel",{id:wjob}).catch(()=>{});$("wres").textContent="正在取消并恢复实例";};
window.addEventListener("pagehide",()=>{$("pxw").value="";$("wta").value="";});
// ---- tabs + run mode ----
// Account sub-tabs: #accounts = list, #add = add account.
function subtab(){const add=location.hash==="#add";$("accounts-list").hidden=add;$("accounts-add").hidden=!add;$("account-list-tools").hidden=add;
 document.querySelectorAll("[data-subtab]").forEach(a=>{const on=a.dataset.subtab===(add?"add":"list");a.classList.toggle("selected",on);a.setAttribute("aria-selected",String(on));});}
addEventListener("hashchange",subtab);subtab();
if($("script-origin"))$("script-origin").textContent=location.origin;
let mode=null,mtimer=null;
function pauseText(){return mode&&mode.single?"暂停唯一实例，期间无法处理请求":"暂时停用一个实例";}
function mshow(m){mode=m;const busy=["parking","resuming","pending"].includes(m.phase);
 $("msingle").checked=m.single;$("msingle").disabled=busy||m.leaseActive;
 const txt={dual:"双实例",parked:"单实例",parking:"切换中",pending:"切换中",resuming:"恢复中"}[m.phase]||m.phase;
 $("mtext").textContent=m.leaseActive?txt+" · 登录中":txt;
 $("mchip").className="chip "+(m.error?"bad":busy||m.leaseActive?"warn":"ok");
 $("msub").textContent=m.single?("仅实例 "+m.serving):"";
 $("mres").textContent=m.error||"";
 clearTimeout(mtimer);mtimer=setTimeout(mload,busy||m.leaseActive?3000:15000);}
async function mload(){try{const r=await fetch("/api/run-mode",{credentials:"same-origin",redirect:"error"});const d=await r.json();if(r.ok)mshow(d);else{$("mtext").textContent="未知";mtimer=setTimeout(mload,15000);}}catch{mtimer=setTimeout(mload,15000);}}
$("msingle").onchange=async()=>{const single=$("msingle").checked;
 if(single&&!confirm("停用一个实例，只保留一个处理请求。继续？")){$("msingle").checked=false;return;}
 $("msingle").disabled=true;const {ok,d}=await lpost("/api/run-mode",{single}).catch(()=>({ok:false,d:{}}));
 if(!ok){$("mres").textContent=d.error||"切换失败";$("msingle").checked=!single;$("msingle").disabled=false;return;}mshow(d);};
// ---- per-instance concurrency ----
async function ccload(){try{const r=await fetch("/api/concurrency",{credentials:"same-origin",redirect:"error"});const d=await r.json();if(r.ok){$("ccA").value=d.A;$("ccB").value=d.B;}}catch{}}
$("ccsave").onclick=async()=>{const A=Number($("ccA").value),B=Number($("ccB").value);
 if(![A,B].every(n=>Number.isInteger(n)&&n>=1&&n<=10)){$("ccres").textContent="并发数只能是 1 到 10 的整数";return;}
 $("ccsave").disabled=true;const {ok,d}=await lpost("/api/concurrency",{A,B}).catch(()=>({ok:false,d:{}}));$("ccsave").disabled=false;
 if(ok){$("ccA").value=d.A;$("ccB").value=d.B;$("ccres").textContent="已保存：实例 A "+d.A+"，实例 B "+d.B;}else{$("ccres").textContent=d.error||"保存失败";ccload();}};
ccload();
// ---- anti-truncation prompt preset ----
let atpList=[],atpCustom=null;
function atpShow(){const k=$("atp").value,p=atpList.find(x=>x.key===k);$("atpnote").textContent=p?p.note:"";
 const src=k==="custom"?(atpCustom||{desc:"",hint:"",cont:""}):(p||{});const ro=k!=="custom";
 for(const f of ["desc","hint","cont"]){const el=$("atp"+f);el.value=src[f]||"";el.readOnly=ro;el.style.opacity=ro?".75":"1";}
 $("atpcopy").hidden=k==="custom";}
async function atpload(){try{const r=await fetch("/api/at-prompt",{credentials:"same-origin",redirect:"error"});const d=await r.json();if(!r.ok)return;
 atpList=d.presets||[];atpCustom=d.custom||null;$("atp").replaceChildren(...atpList.map(p=>{const o=document.createElement("option");o.value=p.key;o.textContent=p.label;return o;}));$("atp").value=d.preset;atpShow();}catch{}}
$("atp").onchange=atpShow;
$("atpcopy").onclick=()=>{const p=atpList.find(x=>x.key===$("atp").value);if(!p)return;atpCustom={desc:p.desc||"",hint:p.hint||"",cont:p.cont||""};$("atp").value="custom";atpShow();$("atpres").textContent="已复制到自定义，改完点保存";};
$("atpsave").onclick=async()=>{const preset=$("atp").value;const body={preset};
 if(preset==="custom")body.custom={desc:$("atpdesc").value,hint:$("atphint").value,cont:$("atpcont").value};
 $("atpsave").disabled=true;
 const {ok,d}=await lpost("/api/at-prompt",body).catch(()=>({ok:false,d:{}}));$("atpsave").disabled=false;
 if(ok){atpCustom=d.custom||atpCustom;const p=atpList.find(x=>x.key===d.preset);$("atpres").textContent="已保存："+(p?p.label:d.preset)+"，下一条请求生效";}else{$("atpres").textContent=d.error||"保存失败";}};
$("atpexport").onclick=()=>{const a=document.createElement("a");a.href="/api/at-prompt/export";a.download="";document.body.appendChild(a);a.click();a.remove();};
$("atpimport").onclick=()=>{$("atpfile").value="";$("atpfile").click();};
$("atpfile").onchange=async()=>{const f=$("atpfile").files[0];if(!f)return;if(f.size>32768){$("atpres").textContent="文件太大";return;}
 let body;try{body=JSON.parse(await f.text());}catch{$("atpres").textContent="不是有效的 JSON 文件";return;}
 const {ok,d}=await lpost("/api/at-prompt/import",body).catch(()=>({ok:false,d:{}}));
 if(ok){atpCustom=d.custom||null;$("atp").value=d.preset;atpShow();$("atpres").textContent="已导入并保存（"+d.preset+"），下一条请求生效";}else $("atpres").textContent=d.error||"导入失败";};
atpload();
// ---- Pro/Ultra dedicated instance ----
let utimer=null;
function ushow(u){
 $("uon").checked=u.enabled;$("uslot").value=u.slot;$("uon").disabled=false;$("uslot").disabled=false;
 const ul=u.ultraAccounts||[],pl=u.proAccounts||[],n=ul.length+pl.length;
 $("usub").textContent=!u.enabled?"":u.single?"单实例下不生效":"实例 "+u.slot;
 $("ulist").textContent=n?[ul.length?"Ultra 账号："+ul.map(x=>"#"+x).join("、"):"",pl.length?"Pro 账号："+pl.map(x=>"#"+x).join("、"):""].filter(Boolean).join("；"):"";
}
async function uload(){clearTimeout(utimer);try{const r=await fetch("/api/ultra-mode",{credentials:"same-origin",redirect:"error"});const d=await r.json();if(r.ok)ushow(d);}catch{}utimer=setTimeout(uload,20000);}
async function usave(){
 const enabled=$("uon").checked,slot=$("uslot").value;
 if(enabled&&!confirm("开启后实例 "+slot+" 只用 Pro/Ultra 账号；空闲时会自动换成符合分类的账号。继续？")){$("uon").checked=false;return;}
 $("uon").disabled=true;$("uslot").disabled=true;
 const {ok,d}=await lpost("/api/ultra-mode",{enabled,slot}).catch(()=>({ok:false,d:{}}));
 $("ures").textContent=ok?"已保存":(d.error||"保存失败");if(ok)ushow(d);else uload();}
$("uon").onchange=usave;$("uslot").onchange=()=>{if($("uon").checked)usave();};
uload();
// ---- AI Studio app ----
let ta=null,tatimer=null;
function tashow(t){ta=t;
 $("tastat").textContent=t.configured?(t.consistent?"已配置 · "+t.appId.slice(0,8)+"…":"两个实例配置不一致，请重新保存"):"未配置";
 if(t.url&&!$("taurl").value)$("taurl").value=t.url;
 $("taapply").disabled=!t.configured||!!t.applying;
 const r=t.lastApply&&t.lastApply.result,name={ok:"已重启",skipped:"忙碌，下次换号生效",failed:"失败"};
 $("tares").textContent=t.applying?"正在应用到实例 "+(t.applying.slot||"")+"…":r?"A "+name[r.A]+"，B "+name[r.B]:"";
 clearTimeout(tatimer);if(t.applying)tatimer=setTimeout(taload,4000);}
async function taload(){try{const r=await fetch("/api/target-app",{credentials:"same-origin",redirect:"error"});const d=await r.json();if(!r.ok)return;tashow(d);
  if(!d.configured&&location.hash==="#settings"&&!sessionStorage.getItem("tadlgShown")){sessionStorage.setItem("tadlgShown","1");taopen();}}catch{}}
function taopen(){$("taurl2").value=$("taurl").value;$("tares2").textContent="";const d=$("tadlg");if(d.showModal)d.showModal();else d.setAttribute("open","");}
function taclose(){const d=$("tadlg");if(d.close)d.close();else d.removeAttribute("open");}
async function tasave(v,out){const url=v.trim();if(!url){out.textContent="请填写应用链接";return false;}
 const {ok,d}=await lpost("/api/target-app",{url}).catch(()=>({ok:false,d:{}}));
 if(!ok){out.textContent=d.error||"保存失败";return false;}$("taurl").value=d.url;tashow(d);out.textContent="已保存，下次换号生效";return true;}
$("tahelp").onclick=taopen;document.querySelectorAll("#tadlg [data-close]").forEach(b=>b.onclick=taclose);
$("tadlg").addEventListener("click",e=>{if(e.target===$("tadlg"))taclose();});
$("tasave").onclick=()=>tasave($("taurl").value,$("tares"));
$("tasave2").onclick=async()=>{if(await tasave($("taurl2").value,$("tares2")))setTimeout(taclose,800);};
$("taapply").onclick=async()=>{if(!confirm("两个实例会依次换号重启，期间请求可能变慢。继续？"))return;
 $("taapply").disabled=true;const {ok,d}=await lpost("/api/target-app",{action:"apply"}).catch(()=>({ok:false,d:{}}));
 if(!ok){$("tares").textContent=d.error||"操作失败";$("taapply").disabled=false;return;}tashow(d);};
$("tacopy").onclick=async()=>{const b=$("tacopy");b.disabled=true;
 try{const r=await fetch("/api/client-script",{credentials:"same-origin",redirect:"error"});if(!r.ok)throw Error();const t=await r.text();
  try{await navigator.clipboard.writeText(t);b.textContent="已复制";}
  catch{const a=document.createElement("textarea");a.value=t;a.style.cssText="position:fixed;opacity:0";document.body.append(a);a.select();document.execCommand("copy");a.remove();b.textContent="已复制";}}
 catch{$("tares2").textContent="复制失败，请刷新后重试";}
 finally{b.disabled=false;setTimeout(()=>b.textContent="复制客户端脚本",2000);}};
taload();
mload();
wload();
})();
