import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {BulbManager,exchange,closeConnections} from './src/bulbs.mjs';
import {QUERY,validatePatch} from './src/protocol.mjs';
import {validateDevice,localUrls} from './src/config.mjs';
import {createDemoTransport,demoDevices} from './src/demo.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const KEYS=['power','mode','brightness','temperature','hue','saturation'];
const defaults=()=>[
 {id:'warm-white',name:'Warm white',description:'2700 K · soft & warm',color:'#edbd79',icon:'sunset',state:{power:true,mode:'white',temperature:2700,brightness:100}},
 {id:'cool-white',name:'Cool white',description:'6500 K · crisp & clear',color:'#94bde9',icon:'sun',state:{power:true,mode:'white',temperature:6500,brightness:100}},
 {id:'relax',name:'Unwind',description:'Warm & easy',color:'#eab578',icon:'sunset',state:{power:true,mode:'white',temperature:2700,brightness:45}},
 {id:'focus',name:'Focus',description:'A clear head',color:'#cce7df',icon:'focus',state:{power:true,mode:'white',temperature:5200,brightness:90}},
 {id:'sunset',name:'Golden hour',description:'A little warmth',color:'#e9a47e',icon:'sun',state:{power:true,mode:'color',hue:24,saturation:72,brightness:60}},
 {id:'night',name:'Good night',description:'Soft landing',color:'#ad9bc8',icon:'moon',state:{power:true,mode:'white',temperature:2700,brightness:8}},
 {id:'ocean',name:'Blue hour',description:'Cool & quiet',color:'#83b4d5',icon:'wave',state:{power:true,mode:'color',hue:208,saturation:65,brightness:45}}
];
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function readBody(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>32768)throw Error('Request too large');}try{return JSON.parse(text);}catch{throw Error('Invalid JSON');}}

export async function createApp({dataDir=process.env.LUMA_DATA_DIR||path.join(ROOT,'data'),demo=false,transport}={}){
 const filename=path.join(dataDir,'settings.json');let saved={};
 if(!demo){try{saved=JSON.parse(await fs.readFile(filename,'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('Could not load data/settings.json');}}
 const devices=demo?demoDevices:(saved.devices||[]).map(d=>{if(!/^[a-z0-9-]+$/.test(d.id)||d.id==='all')throw Error('Invalid saved bulb identifier');return {id:d.id,...validateDevice(d)};});
 if(devices.length>32)throw Error('Maximum 32 bulbs');
 const send=transport||(demo?createDemoTransport():exchange);
 const bulbs=new BulbManager({devices,send,initial:demo?{}:saved.desired});
 const scenes=demo?defaults():saved.scenes||defaults();
 const clients=new Set(),timers=new Map();let saving=Promise.resolve(),broadcast;
 const persist=()=>{
  if(demo)return Promise.resolve();
  const value=JSON.stringify({devices:bulbs.registrations(),scenes,desired:Object.fromEntries(bulbs.snapshot().map(d=>[d.id,Object.fromEntries(KEYS.filter(k=>k!=='power').map(k=>[k,d[k]]))]))},null,2);
  saving=saving.catch(()=>{}).then(async()=>{await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(filename+'.tmp',value);await fs.rename(filename+'.tmp',filename);});return saving;
 };
 const state=()=>{
  const address=server.address(),port=address?.port||Number(process.env.LUMA_PORT||3777);
  return {devices:bulbs.snapshot(),scenes,timers:[...timers.values()].map(t=>({id:t.id,targets:t.targets,endsAt:t.endsAt})),demo,serverTime:Date.now(),localUrls:address?.address==='127.0.0.1'?[]:localUrls(port)};
 };
 bulbs.on('change',()=>{clearTimeout(broadcast);broadcast=setTimeout(()=>{const packet=`data: ${JSON.stringify(state())}\n\n`;for(const client of clients)client.write(packet);},20);});
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   if(['POST','DELETE'].includes(req.method)){
    if(req.headers['x-luma']!=='1'||!req.headers['content-type']?.startsWith('application/json'))return json(res,403,{error:'Use the Luma app'});
    if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return json(res,403,{error:'Origin not allowed'});
   }
   if(url.pathname==='/api/health'&&req.method==='GET')return json(res,200,{app:'luma',version:'1.0.0'});
   if(url.pathname==='/api/state'&&req.method==='GET')return json(res,200,state());
   if(url.pathname==='/api/events'&&req.method==='GET'){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(`data: ${JSON.stringify(state())}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));bulbs.refresh().catch(()=>{});return;
   }
   let match;
   if(url.pathname==='/api/devices'&&req.method==='POST'){
    const input=validateDevice(await readBody(req));
    if(bulbs.registrations().some(d=>d.ip===input.ip))throw Error('That IP address is already registered');
    if(bulbs.devices.size>=32)throw Error('Maximum 32 bulbs');
    const response=await send(input.ip,QUERY,{reply:true,timeout:1800});
    if(response.state?.deviceType!==53)throw Error('This bulb does not match the supported type-53 profile');
    const device={id:randomUUID(),...input};bulbs.add(device);
    const entry=bulbs.devices.get(device.id);entry.observed=response.state;entry.lastSeen=Date.now();entry.verification='confirmed';Object.assign(entry.desired,Object.fromEntries(KEYS.map(k=>[k,response.state[k]])));
    await persist();bulbs.emit('change');return json(res,201,state());
   }
   if((match=url.pathname.match(/^\/api\/devices\/([a-z0-9-]+)$/))&&req.method==='DELETE'){
    await readBody(req);bulbs.remove(match[1]);
    for(const [id,timer]of timers)if(timer.targets.includes(match[1])){clearTimeout(timer.handle);timers.delete(id);}
    for(const scene of scenes)if(scene.states)delete scene.states[match[1]];
    await persist();return json(res,200,state());
   }
   if((match=url.pathname.match(/^\/api\/lights\/([a-z0-9-]+)$/))&&req.method==='POST'){
    const result=await bulbs.control(match[1],await readBody(req));await persist();return json(res,200,{ok:true,result});
   }
   if(url.pathname==='/api/refresh'&&req.method==='POST'){await readBody(req);await bulbs.refresh('all',{force:true});return json(res,200,state());}
   if(url.pathname==='/api/scenes'&&req.method==='POST'){
    const {name}=await readBody(req);if(typeof name!=='string'||!name.trim()||name.length>32)throw Error('Use a scene name of 1–32 characters');
    if(!bulbs.devices.size)throw Error('Add a bulb first');if(scenes.length>=32)throw Error('Maximum 32 scenes');
    const states=Object.fromEntries(bulbs.snapshot().map(d=>[d.id,validatePatch(Object.fromEntries(KEYS.map(k=>[k,d[k]])))]));
    scenes.push({id:randomUUID(),name:name.trim(),description:'Your scene',color:'#b9bacb',icon:'scenes',custom:true,states});await persist();bulbs.emit('change');return json(res,201,state());
   }
   if((match=url.pathname.match(/^\/api\/scenes\/([a-z0-9-]+)$/))&&req.method==='DELETE'){
    await readBody(req);const index=scenes.findIndex(s=>s.id===match[1]&&s.custom);if(index<0)throw Error('Custom scene not found');scenes.splice(index,1);await persist();bulbs.emit('change');return json(res,200,state());
   }
   if((match=url.pathname.match(/^\/api\/names\/([a-z0-9-]+)$/))&&req.method==='POST'){const {name}=await readBody(req);bulbs.rename(match[1],name);await persist();return json(res,200,state());}
   if(url.pathname==='/api/timer'&&req.method==='POST'){
    const input=await readBody(req);
    if(input.minutes===0){const old=timers.get(input.id);if(old)clearTimeout(old.handle);timers.delete(input.id);bulbs.emit('change');return json(res,200,state());}
    if(!Number.isFinite(input.minutes)||input.minutes<1||input.minutes>720)throw Error('Timer must be 1–720 minutes');
    const targets=bulbs.ids(input.targets);if(!targets.length)throw Error('Select a bulb first');
    const id=randomUUID(),endsAt=Date.now()+input.minutes*60000;
    timers.set(id,{id,targets,endsAt,handle:setTimeout(()=>{timers.delete(id);bulbs.control(targets,{power:false}).catch(()=>{});bulbs.emit('change');},input.minutes*60000)});
    bulbs.emit('change');return json(res,200,state());
   }
   if(req.method!=='GET')return json(res,404,{error:'Not found'});
   const name=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname).replace(/^\//,'');
   const resolved=path.resolve(ROOT,'public',name);if(!resolved.startsWith(path.join(ROOT,'public')+path.sep))return json(res,403,{error:'Not allowed'});
   let file;try{file=await fs.readFile(resolved);}catch{return json(res,404,{error:'Not found'});}
   res.writeHead(200,{'Content-Type':types[path.extname(resolved)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'"});res.end(file);
  }catch(error){json(res,400,{error:error.message});}
 });
 const polling=setInterval(()=>{if(clients.size)bulbs.refresh().catch(()=>{});},2500);
 const heartbeat=setInterval(()=>{for(const client of clients)client.write(': keepalive\n\n');},15000);polling.unref();heartbeat.unref();
 return {server,bulbs,state,close:async()=>{clearInterval(polling);clearInterval(heartbeat);clearTimeout(broadcast);for(const timer of timers.values())clearTimeout(timer.handle);for(const client of clients)client.end();closeConnections();await new Promise(resolve=>server.close(resolve));await saving;}};
}
export async function start({demo=false}={}){
 const app=await createApp({demo}),host=process.env.LUMA_HOST||'127.0.0.1',port=Number(process.env.LUMA_PORT||3777);
 await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(port,host,resolve);});
 console.log(`Luma${demo?' demo':''}: http://localhost:${port}`);
 if(host!=='127.0.0.1')for(const url of localUrls(port))console.log(`LAN: ${url}`);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().then(()=>process.exit(0)));
 return app;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await start();
