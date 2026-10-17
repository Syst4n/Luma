import net from 'node:net';
import {performance} from 'node:perf_hooks';
import {EventEmitter} from 'node:events';
import {QUERY,findState,powerFrame,levelFrame,validatePatch} from './protocol.mjs';
import {isPrivateIPv4} from './config.mjs';

const DEFAULT={power:false,brightness:60,mode:'white',temperature:2700,hue:30,saturation:100};
const connections=new Map();
class Connection{
 constructor(ip){this.ip=ip;this.socket=null;this.connecting=null;this.pending=null;this.idle=null;this.chain=Promise.resolve();this.lastWrite=0;}
 close(){clearTimeout(this.idle);this.socket?.destroy();this.socket=null;}
 armIdle(){clearTimeout(this.idle);this.idle=setTimeout(()=>this.close(),3500);this.idle.unref();}
 async connect(localAddress,timeout){
  if(this.socket&&!this.socket.destroyed)return this.socket;
  if(this.connecting)return this.connecting;
  this.connecting=new Promise((resolve,reject)=>{
   const sock=new net.Socket();sock.setNoDelay(true);sock.setKeepAlive(true,10000);
   const timer=setTimeout(()=>{sock.destroy();reject(Error('Connection timed out'));},timeout);
   let connected=false;
   sock.on('error',error=>{clearTimeout(timer);if(!connected)reject(error);else if(this.socket===sock)this.pending?.(error);});
   sock.on('close',()=>{clearTimeout(timer);if(!connected)reject(Error('Connection closed'));if(this.socket===sock){this.socket=null;this.pending?.(Error('Connection closed'));}});
   sock.on('data',chunk=>{if(this.socket===sock)this.onData?.(chunk);});
   sock.connect({host:this.ip,port:5577,localAddress,family:4},()=>{connected=true;clearTimeout(timer);this.socket=sock;resolve(sock);});
  });
  try{return await this.connecting;}finally{this.connecting=null;}
 }
 request(payload,{reply,timeout,localAddress}){
  const job=this.chain.catch(()=>{}).then(async()=>{
   clearTimeout(this.idle);const start=performance.now();const sock=await this.connect(localAddress,timeout);
   // Keep adjacent application frames distinct on these modules; no stale slider backlog.
   const gap=40-(performance.now()-this.lastWrite);if(gap>0)await new Promise(resolve=>setTimeout(resolve,gap));
   return new Promise((resolve,reject)=>{
    let received=Buffer.alloc(0),done=false;const timer=setTimeout(()=>finish(Error(reply?'State query timed out':'Write timed out')),timeout);
    this.kind=reply?'query':'write';
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);this.pending=null;this.onData=null;this.kind=null;
     if(error){this.close();reject(error);}else{this.armIdle();resolve({...result,latencyMs:Math.round((performance.now()-start)*10)/10});}};
    this.pending=error=>finish(error);
    this.onData=chunk=>{if(!reply)return;received=Buffer.concat([received,chunk]);if(received.length>4096)return finish(Error('Unexpected response size'));const state=findState(received);if(state)finish(null,{state,raw:received.toString('hex'),verification:'device-response'});};
    sock.write(payload,error=>{this.lastWrite=performance.now();if(error)finish(error);else if(!reply)finish(null,{verification:'socket-write'});});
   });
  });this.chain=job;return job;
 }
}
export function closeConnections(){for(const c of connections.values())c.close();connections.clear();}
export function exchange(ip,payload,{reply=false,timeout=1200,localAddress=process.env.LUMA_SOURCE_IP||undefined}={}){
 if(!isPrivateIPv4(ip))return Promise.reject(Error('Only private LAN IPv4 addresses are supported'));
 if(!connections.has(ip))connections.set(ip,new Connection(ip));
 return connections.get(ip).request(payload,{reply,timeout,localAddress});
}

export class BulbManager extends EventEmitter{
 constructor({devices=[],send=exchange,initial={},now=Date.now}={}){
  super();this.send=send;this.now=now;this.devices=new Map(devices.map(d=>[d.id,{...d,
   desired:{...DEFAULT,...initial[d.id]},observed:null,lastSeen:null,lastSent:null,latencyMs:null,writeMs:null,
   error:null,verification:'unknown',pending:{},revision:0,busy:false,refreshing:false,queued:false,waiters:[],intent:null}]))
 }
 snapshot(){return [...this.devices.values()].map(d=>({id:d.id,name:d.name,ip:d.ip,location:d.location,
  ...d.desired,observed:d.observed,lastSeen:d.lastSeen,lastSent:d.lastSent,latencyMs:d.latencyMs,writeMs:d.writeMs,
  reachable:!!d.lastSeen&&this.now()-d.lastSeen<20000,error:d.error,verification:d.verification,
  pending:d.busy||d.queued||Object.keys(d.pending).length>0,revision:d.revision}));}
 ids(target){
  if(target==='all')return [...this.devices.keys()];
  if(Array.isArray(target)){if(!target.length)throw Error('Select at least one bulb');return [...new Set(target.flatMap(id=>this.ids(id)))];}
  if(!this.devices.has(target))throw Error('Unknown light');return [target];
 }
 add(device){
  if(this.devices.size>=32)throw Error('Maximum 32 bulbs');
  if([...this.devices.values()].some(d=>d.ip===device.ip))throw Error('That IP address is already registered');
  const entry=new BulbManager({devices:[device],send:this.send,now:this.now}).devices.get(device.id);
  this.devices.set(device.id,entry);this.emit('change');
 }
 remove(id){
  const d=this.devices.get(id);if(!d)throw Error('Bulb not found');
  if(d.busy||d.queued||d.refreshing)throw Error('Wait for the current operation to finish');
  this.devices.delete(id);connections.get(d.ip)?.close();connections.delete(d.ip);this.emit('change');
 }
 registrations(){return [...this.devices.values()].map(d=>({id:d.id,name:d.name,ip:d.ip,location:d.location}));}
 async control(target,patch){patch=validatePatch(patch);return Promise.all(this.ids(target).map(id=>this.enqueue(id,patch)));}
 enqueue(id,patch){
  const d=this.devices.get(id);Object.assign(d.desired,patch);Object.assign(d.pending,patch);d.revision++;
  const connection=connections.get(d.ip);
  if(this.send===exchange&&d.refreshing&&connection?.kind==='query')connection.pending?.(Error('Query superseded by control'));
  this.emit('change');
  const promise=new Promise((resolve,reject)=>d.waiters.push({resolve,reject}));
  if(!d.queued&&!d.busy){d.queued=true;setTimeout(()=>{d.queued=false;this.flush(d);},25);}
  return promise;
 }
 async flush(d){
  if(d.busy||!Object.keys(d.pending).length)return;
  if(d.refreshing){d.queued=true;setTimeout(()=>{d.queued=false;this.flush(d);},40);return;}
  d.busy=true;const patch=d.pending;d.pending={};const state={...d.desired};const waiters=d.waiters;d.waiters=[];
  try{
   let result;
   if('power'in patch)result=await this.send(d.ip,powerFrame(state.power),{reply:false});
   const level=Object.keys(patch).some(k=>k!=='power');
   if(level)result=await this.send(d.ip,levelFrame(state),{reply:false});
   d.lastSent=this.now();d.writeMs=result.latencyMs;d.error=null;d.verification='sent';
   d.intent={state,level,power:'power'in patch,until:this.now()+5000};
   waiters.forEach(w=>w.resolve({id:d.id,writeMs:d.writeMs,verification:'sent',revision:d.revision}));
  }catch(error){d.error=error.message;d.verification='error';waiters.forEach(w=>w.reject(error));}
  finally{d.busy=false;this.emit('change');if(Object.keys(d.pending).length)this.flush(d);}
 }
 async refresh(target='all',{force=false}={}){
  await Promise.all(this.ids(target).map(async id=>{
   const d=this.devices.get(id);if(d.busy||d.queued||d.refreshing||(!force&&d.lastSent&&this.now()-d.lastSent<650))return;
   d.refreshing=true;const revision=d.revision;
   try{
    const {state,latencyMs}=await this.send(d.ip,QUERY,{reply:true});
    if(state?.deviceType!==53)throw Error('Bulb no longer matches the supported type-53 profile');
    d.observed=state;d.lastSeen=this.now();d.latencyMs=latencyMs;d.error=null;
    if(revision===d.revision&&!Object.keys(d.pending).length){
     // A response during a fade/processing interval is observation, not a new request.
     const intent=d.intent;
     const frame=intent?.level?levelFrame(intent.state):null;
     const channelsMatch=!frame||(intent.state.mode==='color'?[1,2,3].every((n,i)=>Math.abs(frame[n]-state.rgb[i])<=5)&&state.warm+state.cool<=5:Math.abs(frame[4]-state.warm)<=5&&Math.abs(frame[5]-state.cool)<=5&&state.rgb.every(n=>n<=5));
     const matches=!intent||((!intent.power||state.power===intent.state.power)&&channelsMatch);
     if(!matches&&this.now()<intent.until){d.verification='settling';return;}
     Object.assign(d.desired,{power:state.power,brightness:state.brightness,mode:state.mode,temperature:state.temperature});
     if(state.mode==='color')Object.assign(d.desired,{hue:state.hue,saturation:state.saturation});
     d.intent=null;d.verification=matches?'confirmed':'not-applied';
     if(!matches)d.error='Bulb did not confirm the requested setting';
    }
   }catch(error){if(error.message!=='Query superseded by control'){d.error=error.message;if(d.verification!=='sent')d.verification='unverified';}}
   finally{d.refreshing=false;this.emit('change');}
  }));
  return this.snapshot();
 }
 rename(id,name){const d=this.devices.get(id);if(!d)throw Error('Unknown light');if(typeof name!=='string'||!name.trim()||name.length>32)throw Error('Use a name of 1–32 characters');d.name=name.trim();this.emit('change');}
}
