'use strict';
const {StringDecoder}=require('string_decoder');
const {normalizeUsage}=require('./usage-metrics');
// Bounded, passive observer. It must never replace the forwarded byte stream.
class ResponseMetrics {
 constructor({stream=false,maxBytes=1048576,clock=Date.now}={}) {
  this.stream=stream;this.maxBytes=maxBytes;this.clock=clock;
  this.startedAt=clock();this.firstByteMs=null;this.firstContentMs=null;
  this.decoder=new StringDecoder('utf8');this.buffer='';this.event=[];
  this.eventBytes=0;this.discardEvent=false;this.discardLine=false;
  this.usage=null;this.complete=false;this.limited=false;this.malformed=false;
  this.done=false;this.applicationError=false;this.closed=false;
 }
 acceptObject(obj) {
  if(Array.isArray(obj)){for(const v of obj)this.acceptObject(v);return;}
  if(!obj||typeof obj!=='object')return;
  const usage=normalizeUsage(obj);
  // Usage chunks are normally cumulative: never sum cumulative snapshots.
  if(usage)this.usage=usage;
  if(obj.error)this.applicationError=true;
  const text=(obj.choices||[]).some(c=>
   typeof c?.delta?.content==='string' && c.delta.content.length>0 ||
   typeof c?.message?.content==='string' && c.message.content.length>0) ||
   (obj.candidates||[]).some(c=>(c?.content?.parts||[]).some(p=>
    typeof p.text==='string' && p.text.length>0 && p.thought!==true));
  if(text && !Number.isFinite(this.firstContentMs))this.firstContentMs=this.clock()-this.startedAt;
 }
 parse(text) {
  if(!text.trim())return;
  if(text.trim()==='[DONE]'){this.done=true;return;}
  try{this.acceptObject(JSON.parse(text));}catch{this.malformed=true;}
 }
 line(line) {
  if(line.endsWith('\r'))line=line.slice(0,-1);
  if(line===''){
   if(!this.discardEvent && this.event.length)this.parse(this.event.join('\n'));
   this.event=[];this.eventBytes=0;this.discardEvent=false;return;
  }
  if(this.discardEvent||!line.startsWith('data:'))return;
  let data=line.slice(5);if(data.startsWith(' '))data=data.slice(1);
  this.eventBytes+=Buffer.byteLength(data)+1;
  if(this.eventBytes>this.maxBytes){
   this.limited=true;this.discardEvent=true;this.event=[];return;
  }
  this.event.push(data);
 }
 feed(text) {
  if(!this.stream){
   if(this.limited)return;
   if(Buffer.byteLength(this.buffer)+Buffer.byteLength(text)>this.maxBytes){
    this.limited=true;this.buffer='';return;
   }
   this.buffer+=text;return;
  }
  // Process line segments without retaining unbounded SSE events.
  let offset=0;
  while(offset<text.length){
   const newline=text.indexOf('\n',offset);
   const end=newline===-1?text.length:newline;
   const part=text.slice(offset,end);
   if(!this.discardLine){
    if(Buffer.byteLength(this.buffer)+Buffer.byteLength(part)>this.maxBytes){
     this.buffer='';this.discardLine=true;this.discardEvent=true;
     this.event=[];this.limited=true;
    }else this.buffer+=part;
   }
   if(newline===-1)break;
   if(!this.discardLine)this.line(this.buffer);
   this.buffer='';this.discardLine=false;offset=newline+1;
  }
 }
 write(chunk) {
  if(this.closed)return;
  try{
   if(chunk.length && !Number.isFinite(this.firstByteMs))this.firstByteMs=this.clock()-this.startedAt;
   this.feed(this.decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)));
  }catch{this.malformed=true;}
 }
 finish({complete=true}={}) {
  if(!this.closed){
   try{
    this.feed(this.decoder.end());
    if(this.stream){
     if(this.buffer && !this.discardLine)this.line(this.buffer);
     if(complete)this.line('');
    }else if(complete && !this.limited)this.parse(this.buffer);
   }catch{this.malformed=true;}
   this.closed=true;this.complete=complete;this.durationMs=this.clock()-this.startedAt;
   this.buffer='';this.event=[];
  }
  return {
   usage:this.usage,usageComplete:!!this.usage && this.complete && !this.limited && !this.malformed && !this.applicationError,
   firstByteMs:this.firstByteMs,firstContentMs:this.firstContentMs,durationMs:this.durationMs,
   timingSource:'coordinator-response-observer',transportComplete:this.complete,
   streamDoneSeen:this.done,applicationError:this.applicationError,
   captureLimited:this.limited,malformed:this.malformed
  };
 }
}
module.exports={ResponseMetrics};
