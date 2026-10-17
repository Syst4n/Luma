import test from 'node:test';import assert from 'node:assert/strict';
import {toggleSelection,rangeValueAt,bulbRgb,contrastInk,LatestControls} from '../public/controls.js';
test('cards independently toggle through none, one and both selected',()=>{
 let selected=new Set();selected=toggleSelection(selected,'studio',['studio','reading']);assert.deepEqual([...selected],['studio']);
 selected=toggleSelection(selected,'reading',['studio','reading']);assert.deepEqual([...selected],['studio','reading']);
 selected=toggleSelection(selected,'studio',['studio','reading']);assert.deepEqual([...selected],['reading']);
 selected=toggleSelection(selected,'reading',['studio','reading']);assert.equal(selected.size,0);
 selected=toggleSelection(selected,'all',['studio','reading']);assert.equal(selected.size,2);
 selected=toggleSelection(selected,'all',['studio','reading']);assert.equal(selected.size,0);
 selected=toggleSelection(selected,'all',['one','two','three']);assert.equal(selected.size,3);
 selected=toggleSelection(selected,'two',['one','two','three']);assert.deepEqual([...selected],['one','three']);
});
test('finger positions clamp at pill ends and quantize temperature steps',()=>{
 assert.equal(rangeValueAt(-20,10,200,0,100),0);assert.equal(rangeValueAt(400,10,200,0,100),100);
 assert.equal(rangeValueAt(110,10,200,0,100),50);
 assert.equal(rangeValueAt(110,10,200,2700,6500,50),4600);
});
test('brightness fill represents RGB and warm/cool channels with readable ink',()=>{
 assert.deepEqual(bulbRgb({mode:'color',hue:0,saturation:100}),[255,0,0]);
 assert.deepEqual(bulbRgb({mode:'color',hue:240,saturation:100}),[0,0,255]);
 assert.deepEqual(bulbRgb({mode:'white',temperature:2700}),[255,210,144]);
 assert.deepEqual(bulbRgb({mode:'white',temperature:6500}),[204,229,255]);
 assert.equal(contrastInk([0,0,255]),'#ffffff');assert.equal(contrastInk([255,255,255]),'#161619');
});
test('offline Reading cannot block Studio; pending slider positions collapse to the latest',async()=>{
 let releaseReading;const readingGate=new Promise(r=>releaseReading=r);const sent=[];
 const queue=new LatestControls(async(id,patch)=>{sent.push({id,...patch});if(id==='reading')await readingGate;return id;},{delay:0});
 const reading=queue.enqueue('reading',{brightness:20});await new Promise(r=>setTimeout(r,5));
 const studio=queue.enqueue('studio',{brightness:40});assert.equal(await studio,'studio');
 const changes=Array.from({length:30},(_,i)=>queue.enqueue('reading',{brightness:i+1}));
 releaseReading();await Promise.all([reading,...changes]);
 assert.equal(sent.filter(s=>s.id==='reading').length,2);assert.equal(sent.at(-1).brightness,30);
});
test('a release commit is sent after an in-flight final slider move',async()=>{
 let release;const gate=new Promise(r=>release=r),sent=[];
 const queue=new LatestControls(async(id,patch)=>{sent.push(patch.brightness);if(sent.length===1)await gate;},{delay:0});
 const move=queue.enqueue('studio',{brightness:100});await new Promise(r=>setTimeout(r,5));
 const released=queue.enqueue('studio',{brightness:100});release();await Promise.all([move,released]);
 assert.deepEqual(sent,[100,100]);
});
