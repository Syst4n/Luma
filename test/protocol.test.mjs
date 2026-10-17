import test from 'node:test';import assert from 'node:assert/strict';
import {checksum,powerFrame,rgbFrame,whiteFrame,levelFrame,findState,validatePatch} from '../src/protocol.mjs';
import {BulbManager} from '../src/bulbs.mjs';
const devices=[{id:'studio',name:'Studio',ip:'10.1.0.10'},{id:'reading',name:'Reading',ip:'10.1.0.11'}];
const whiteState=brightness=>({power:true,deviceType:53,stateVersion:10,mode:'white',brightness,temperature:2700,hue:0,saturation:100,rgb:[0,0,0],warm:Math.round(brightness*2.55),cool:0});
test('source-compatible commands and synthetic warm/cool state',()=>{
 assert.equal(powerFrame(true).toString('hex'),'71230fa3');assert.equal(powerFrame(false).toString('hex'),'71240fa4');
 assert.equal(rgbFrame(255,0,0).toString('hex'),'31ff00000000f00f2f');
 assert.equal(whiteFrame(127,0).toString('hex'),'310000007f000f0fce');
 const body=[0x81,0x35,0x24,0x61,0x30,0x50,0,0,0,80,10,175,0x0f];
 const frame=Buffer.from([...body,checksum(body)]),s=findState(frame);
 assert.equal(s.warm,80);assert.equal(s.cool,175);assert.equal(s.stateVersion,10);assert.equal(s.brightness,100);
 assert.equal(findState(frame.subarray(0,8)),null);
 assert.equal(findState(Buffer.concat([Buffer.from([0x12,0x34]),frame,frame])).deviceType,53);
 frame[13]^=1;assert.equal(findState(frame),null);
 body[12]=0;assert.equal(findState(Buffer.from([...body,checksum(body)])),null);
});
test('white brightness is a mix with bounded total and input validation',()=>{
 const b=levelFrame({mode:'white',temperature:4600,brightness:50});assert.equal(b[4]+b[5],126);
 assert.throws(()=>validatePatch({brightness:101}));assert.throws(()=>validatePatch({ip:'x'}));
 assert.throws(()=>validatePatch({power:'yes'}));
});
test('rapid pending slider commands coalesce and keep the newest level',async()=>{
 const sent=[];const m=new BulbManager({devices,send:async(ip,bytes)=>{sent.push(bytes);return {latencyMs:1};}});
 await Promise.all(Array.from({length:30},(_,i)=>m.control('studio',{brightness:i+1})));
 assert.equal(sent.length,1);assert.equal(m.snapshot()[0].brightness,30);
});
test('busy queue keeps final revision and surfaces write failures',async()=>{
 let release;const gate=new Promise(r=>release=r);let n=0;const sent=[];
 const m=new BulbManager({devices,send:async(_,b)=>{sent.push(b);if(n++===0)await gate;return {latencyMs:1};}});
 const first=m.control('studio',{brightness:10});await new Promise(r=>setTimeout(r,40));
 const last=m.control('studio',{brightness:85});release();await Promise.all([first,last]);
 assert.equal(sent.length,2);assert.equal(m.snapshot()[0].brightness,85);
 const broken=new BulbManager({devices,send:async()=>{throw Error('offline');}});
 await assert.rejects(broken.control('reading',{power:true}));assert.equal(broken.snapshot()[1].verification,'error');
});
test('an intermediate 70% read cannot replace the latest 100% request',async()=>{
 let at=10000,reported=70;
 const manager=new BulbManager({devices,now:()=>at,send:async(_ip,_bytes,options)=>options.reply?{state:whiteState(reported),latencyMs:1}:{latencyMs:1}});
 await manager.control('studio',{brightness:100});at+=1000;
 await manager.refresh('studio',{force:true});
 let light=manager.snapshot()[0];assert.equal(light.brightness,100);assert.equal(light.observed.brightness,70);assert.equal(light.verification,'settling');
 reported=100;at+=1000;await manager.refresh('studio',{force:true});
 light=manager.snapshot()[0];assert.equal(light.brightness,100);assert.equal(light.verification,'confirmed');
});
test('a permanently mismatched read is surfaced after the bounded settling window',async()=>{
 let at=10000;
 const manager=new BulbManager({devices,now:()=>at,send:async(_ip,_bytes,options)=>options.reply?{state:whiteState(70),latencyMs:1}:{latencyMs:1}});
 await manager.control('studio',{brightness:100});at+=6000;await manager.refresh('studio',{force:true});
 const light=manager.snapshot()[0];assert.equal(light.brightness,70);assert.equal(light.verification,'not-applied');assert.match(light.error,/did not confirm/);
});
