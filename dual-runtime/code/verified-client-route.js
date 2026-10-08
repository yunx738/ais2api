const crypto=require('crypto');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const ORIGINAL='e166c3c9475c0a6f0b60b7a1cd445e6f302ae0a86218161a2dea2a5665224385';
const REPLACEMENT='2871d17d7c63509e41787f61117a91b1ced6a6f34393186d3bd00273f6e695e0';
const PREVIEW='3e1ed4e84cf3bbb02a3cc1026c98137c39c1218c169229e2496cc158e45b979d';
// Only AI Studio app hosts; the script body hash decides whether it is replaced.
const APP_HOST=/^ais-(dev|pre)-[a-z0-9]+-\d+\.[a-z0-9-]+\.run\.app$/;
const expectedFor=host=>{const m=APP_HOST.exec(host);return m?(m[1]==='dev'?ORIGINAL:PREVIEW):null;};
function select(body,replacement,expected=ORIGINAL){
 if(hash(replacement)!==REPLACEMENT)throw Error('Replacement integrity failure');
 return hash(body)===expected?replacement:null;
}
async function install(context,replacement,report){
 if(hash(replacement)!==REPLACEMENT)throw Error('Replacement integrity failure');
 await context.route('**/*',async route=>{
  const req=route.request();
  if(req.resourceType()!=='script')return route.continue();
  const u=new URL(req.url());
  const expected=u.protocol==='https:'?expectedFor(u.hostname):null;
  if(!expected)return route.continue();
  try{
   const response=await route.fetch({timeout:30000,maxRetries:0});
   const body=await response.body();
   const chosen=response.status()===200?select(body,replacement,expected):void 0;
   if(chosen == void 0)return route.fulfill({response});
   const headers={...response.headers()};
   for(const key of ['content-length','content-encoding','etag','last-modified'])delete headers[key];
   headers['content-type']='application/javascript; charset=utf-8';
   headers['cache-control']='no-store';
   await route.fulfill({response,headers,body:chosen});
   report({replaced:true,original:expected,replacement:REPLACEMENT});
  }catch{
   report({replacementFailed:true});
   await route.abort();
  }
 });
}
module.exports={install,select,ORIGINAL,PREVIEW,REPLACEMENT};
