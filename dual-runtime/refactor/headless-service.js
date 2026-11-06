'use strict';
// HTTP client for the local no-browser service (AIStudio2API + dual-runtime patch, 127.0.0.1:2048).
// Every call is pinned to one account (X-Pin-Account, loopback + X-Build-Raw-Key only).
const http=require('http'),fs=require('fs');
const H=require('./build-headless');
class HeadlessService{
 constructor({host='127.0.0.1',port=2048,key,rawKey}){
  if(typeof key!=='string'||!key||typeof rawKey!=='string'||rawKey.length<16)throw Error('headless keys required');
  Object.assign(this,{host,port,key,rawKey});
  this.raw=H.createRaw({host,port,key,rawKey});
 }
 static fromFiles(dir='/opt/as2a-nb'){
  const env=fs.readFileSync(dir+'/.env','utf8');
  const key=(env.match(/^PROXY_API_KEY=(.*)$/m)||[])[1]?.trim().split(',')[0];
  const rawKey=fs.readFileSync(dir+'/build-raw.key','utf8').trim();
  return new HeadlessService({key,rawKey});
 }
 headers(account,len){
  const h={'Content-Type':'application/json','Authorization':'Bearer '+this.key};
  if(account){h['X-Pin-Account']=account;h['X-Build-Raw-Key']=this.rawKey;}
  if(len!==undefined)h['Content-Length']=len;
  return h;
 }
 // Raw request; resolves with the IncomingMessage (caller consumes it). signal aborts the socket.
 request(account,method,path,body,{signal}={}){
  return new Promise((resolve,reject)=>{
   const req=http.request({host:this.host,port:this.port,method,path,agent:false,headers:this.headers(account,body?body.length:undefined)},resolve);
   const abort=()=>req.destroy(Object.assign(Error('cancelled'),{status:499}));
   if(signal){if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});req.on('close',()=>signal.removeEventListener('abort',abort));}
   req.on('error',reject);
   req.end(body);
  });
 }
 // JSON call: {status, headers, text, json}.
 async call(account,method,path,obj,opts={}){
  const res=await this.request(account,method,path,obj===undefined?undefined:Buffer.from(JSON.stringify(obj)),opts);
  const chunks=[];let size=0;
  await new Promise((resolve,reject)=>{
   res.on('data',c=>{size+=c.length;if(size>64*1024*1024){res.destroy(Error('reply too large'));return;}chunks.push(c);});
   res.on('end',resolve);res.on('error',reject);res.on('aborted',()=>reject(Object.assign(Error('aborted'),{status:499})));
  });
  const text=Buffer.concat(chunks).toString('utf8');let json=null;try{json=JSON.parse(text);}catch{}
  return {status:res.statusCode,headers:res.headers,text,json};
 }
 async health(){try{return (await this.call(null,'GET','/v1/models')).status===200;}catch{return false;}}
}
module.exports={HeadlessService};
