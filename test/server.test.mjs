import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {createDemoTransport} from '../src/demo.mjs';
import {isPrivateIPv4,validateDevice} from '../src/config.mjs';

test('private address validation does not assume a /24 subnet',()=>{
 for(const ip of ['10.0.0.0','10.1.2.255','172.16.0.1','172.31.255.254','192.168.4.30'])assert.equal(isPrivateIPv4(ip),true,ip);
 for(const ip of ['127.0.0.1','8.8.8.8','172.32.0.1','169.254.1.1','localhost','::1','10.0.0.999','010.0.0.1'])assert.equal(isPrivateIPv4(ip),false,ip);
 assert.throws(()=>validateDevice({name:' ',ip:'10.0.0.1'}));
 assert.deepEqual(validateDevice({name:' Lamp ',ip:'10.0.0.20 '}),{name:'Lamp',ip:'10.0.0.20',location:'Wi-Fi bulb'});
});

test('registration, arbitrary bulb selection, controls and private persistence',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'luma-test-'));
 const sent=[],fake=createDemoTransport();let type=53;
 const transport=async(ip,packet,options)=>{sent.push({ip,hex:packet.toString('hex'),reply:options.reply});const result=await fake(ip,packet,options);if(result.state)result.state.deviceType=type;return result;};
 const app=await createApp({dataDir,transport});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await app.close();await fs.rm(dataDir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const post=async(route,body={},method='POST',extra={})=>fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Luma':'1',...extra},body:JSON.stringify(body)});
 let state=await(await fetch(base+'/api/state')).json();assert.deepEqual(state.devices,[]);assert.equal(sent.length,0);
 assert.equal((await post('/api/devices',{name:'Lamp',ip:'8.8.8.8'})).status,400);assert.equal(sent.length,0);
 type=99;assert.equal((await post('/api/devices',{name:'Unsupported',ip:'10.0.0.20'})).status,400);assert.equal(app.bulbs.devices.size,0);
 type=53;sent.length=0;
 for(let i=0;i<3;i++){
  const result=await post('/api/devices',{name:`Lamp ${i+1}`,ip:`10.0.0.${30+i}`});assert.equal(result.status,201);state=await result.json();
 }
 assert.equal(state.devices.length,3);assert.equal(sent.length,3);assert(sent.every(s=>s.hex==='818a8b96'&&s.reply));
 const ids=state.devices.map(d=>d.id);
 assert.equal((await post('/api/devices',{name:'Duplicate',ip:'10.0.0.30'})).status,400);assert.equal(sent.length,3);
 assert.equal((await post('/api/lights/missing',{power:true})).status,400);assert.equal(sent.length,3);
 assert.equal((await post('/api/lights/'+ids[2],{power:false})).status,200);assert.equal(sent.at(-1).hex,'71240fa4');assert.equal(sent.at(-1).ip,'10.0.0.32');
 assert.equal((await post('/api/lights/'+ids[0],{power:true},'POST',{Origin:'http://example.invalid'})).status,403);
 assert.equal((await post('/api/names/'+ids[0],{name:'Renamed'})).status,200);
 let timer=await(await post('/api/timer',{targets:[ids[0],ids[2]],minutes:5})).json();assert.deepEqual(timer.timers[0].targets,[ids[0],ids[2]]);
 timer=await(await post('/api/timer',{id:timer.timers[0].id,minutes:0})).json();assert.equal(timer.timers.length,0);
 assert.equal((await post('/api/scenes',{name:'Saved setting'})).status,201);
 assert.equal((await post('/api/devices/'+ids[1],{},'DELETE')).status,200);
 const saved=JSON.parse(await fs.readFile(path.join(dataDir,'settings.json'),'utf8'));
 assert.equal(saved.devices.length,2);assert.equal(saved.devices[0].name,'Renamed');assert.equal('power'in saved.desired[ids[0]],false);
 const restarted=await createApp({dataDir,transport});assert.equal(restarted.bulbs.devices.size,2);
 await new Promise(r=>restarted.server.listen(0,'127.0.0.1',r));await restarted.close();
 const html=await(await fetch(base+'/')).text();assert.match(html,/<title>Luma<\/title>/);assert.match(html,/id="add-form"/);
 assert.equal((await fetch(base+'/data/settings.json')).status,404);
});

test('demo uses simulated bulbs and never saves local registrations',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'luma-demo-test-'));
 const app=await createApp({demo:true,dataDir});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await app.close();await fs.rm(dataDir,{recursive:true,force:true});});
 await app.bulbs.refresh();assert.equal(app.state().demo,true);assert.equal(app.state().devices.length,2);
 await app.bulbs.control('all',{mode:'color',hue:240,saturation:100,brightness:100});
 await app.bulbs.refresh('all',{force:true});assert(app.state().devices.every(d=>d.observed.hue===240));
 assert.deepEqual(await fs.readdir(dataDir),[]);
});
