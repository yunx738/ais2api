const fs = require("fs"), path = require("path"), crypto = require("crypto");
module.exports = function(app, system) {
  const guard = (req,res,next) => {
    res.set("Cache-Control","no-store");
    res.removeHeader("Access-Control-Allow-Origin");
    if (!req.session.isAuthenticated) return res.status(401).json({error:"请先登录"});
    next();
  };
  app.get("/import",guard,(req,res)=>{
    req.session.importToken ||= crypto.randomBytes(32).toString("hex");
    res.set("X-Frame-Options","DENY");
    res.send(fs.readFileSync(path.join(__dirname,"import-ui.html"),"utf8").replace("__CSRF_TOKEN__",req.session.importToken));
  });
  app.post("/api/import-account",guard,(req,res)=>{
    if(req.headers.origin !== "https://aisbuild.129357.xyz" || !req.session.importToken || req.get("X-Import-Token") !== req.session.importToken)
      return res.status(403).json({error:"请求校验失败，请刷新导入页面"});
    if(!req.is("application/json")) return res.status(415).json({error:"仅支持JSON"});
    if(system.authSource.authMode !== "file") return res.status(409).json({error:"非文件认证模式"});
    try {
      const d=req.body, str=x=>typeof x==="string";
      if(!d || !Array.isArray(d.cookies) || !d.cookies.length || d.cookies.length>200 || !Array.isArray(d.origins) || d.origins.length>20) throw Error("顶层结构无效：需要 cookies(1-200) 与 origins(1-20) 数组");
      const cookies=d.cookies.map(c=>{
        if(!c || !str(c.name) || !c.name || c.name.length>256 || !str(c.value) || c.value.length>16384 ||
           !str(c.domain) || !/^\.?([a-z0-9-]+\.)*google\.com$/i.test(c.domain) ||
           !str(c.path) || !c.path.startsWith("/") || c.path.length>2048 ||
           !Number.isFinite(c.expires) || c.expires<-1 || typeof c.httpOnly!=="boolean" ||
           typeof c.secure!=="boolean" || !["Lax","Strict","None"].includes(c.sameSite)) throw Error("Cookie #"+(d.cookies.indexOf(c)+1)+" 字段无效(需name/value/domain=google.com子域/path/expires秒/httpOnly/secure/sameSite)");
        return {name:c.name,value:c.value,domain:c.domain,path:c.path,expires:c.expires,httpOnly:c.httpOnly,secure:c.secure,sameSite:c.sameSite};
      });
      const origins=d.origins.map(o=>{
        if(!o || !["https://aistudio.google.com","https://ai.studio","https://accounts.google.com"].includes(o.origin) || !Array.isArray(o.localStorage) || o.localStorage.length>200) throw Error("origins.origin 只允许 aistudio.google.com / ai.studio / accounts.google.com");
        return {origin:o.origin,localStorage:o.localStorage.map(v=>{
          if(!v || !str(v.name) || !str(v.value) || v.name.length>1024 || v.value.length>65536) throw Error("localStorage 项无效");
          return {name:v.name,value:v.value};
        })};
      });
      const dir=path.join(__dirname,"auth");
      const nums=fs.readdirSync(dir).filter(n=>/^auth-\d+\.json$/.test(n)).map(n=>Number(n.match(/\d+/)[0]));
      if(nums.length>=50) return res.status(409).json({error:"账号数量已达上限"});
      const index=Math.max(0,...nums)+1;
      const content=JSON.stringify({cookies,origins,accountName:"导入账号 "+index});
      if(Buffer.byteLength(content)>262144) return res.status(413).json({error:"文件过大"});
      fs.writeFileSync(path.join(dir,"auth-"+index+".json"),content,{flag:"wx",mode:0o600});
      system.authSource.initialIndices.push(index);
      system.authSource.availableIndices.push(index);
      system.authSource.accountNameMap.set(index,"导入账号 "+index);
      system.logger.info("[Import] 新增账号 #"+index+"，尚未验证");
      res.json({index,verified:false});
    } catch(e) {res.status(400).json({error:"文件结构不符合要求，或无法安全保存",detail:e && e.message ? String(e.message).slice(0,200) : "unknown"});}
  });
};
