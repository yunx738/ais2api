process.env.SWITCH_ON_USES=String(80);
const {Server}=require("/relay/node_modules/proxy-chain");
(async()=>{
 try {
  const u=new URL(process.env.SOCKS_UPSTREAM_URL || process.env.PROXY_URL);
  u.protocol="socks5:";
  if(!u.hostname || !u.username || !u.password)throw Error("Missing upstream");
  const relay=new Server({
   host:"127.0.0.1",port:18992,verbose:false,
   prepareRequestFunction:()=>({upstreamProxyUrl:u.href})
  });
  relay.on("requestFailed",()=>console.warn("[Relay] upstream request failed (details redacted)"));
  await relay.listen();
  process.env.PROXY_URL="http://127.0.0.1:18992";
  console.log("[Relay] private SOCKS5 relay ready; no direct fallback");
  await require("./unified-server.js").initializeServer();
 }catch(e){
  console.error("[Startup] relay/service initialization failed; stopping (details redacted)");
  process.exit(1);
 }
})();
