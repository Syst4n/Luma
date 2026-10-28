export function toggleSelection(selection,id,available){
 const next=new Set(selection);
 if(id==='all')return available.every(value=>next.has(value))?new Set():new Set(available);
 if(!available.includes(id))return next;
 if(next.has(id))next.delete(id);else next.add(id);
 return next;
}
export function chooseTarget(current,id,available){
 return id==='all'||available.includes(id)?id:current;
}
export function targetIds(target,available){
 return target==='all'?[...available]:available.includes(target)?[target]:[];
}
export function dispatchTargets(ids,send){
 return Promise.allSettled(ids.map(id=>Promise.resolve().then(()=>send(id))));
}
export function rangeValueAt(clientX,left,width,min,max,step=1){
 if(width<=0)return min;
 const fraction=Math.max(0,Math.min(1,(clientX-left)/width));
 return Math.max(min,Math.min(max,min+Math.round(fraction*(max-min)/step)*step));
}
export function bulbRgb(state){
 if(state.mode==='color'){
  const hue=((state.hue%360)+360)%360,s=state.saturation/100;
  const k=n=>(n+hue/60)%6;
  return [5,3,1].map(n=>Math.round(255*(1-s*Math.max(0,Math.min(k(n),4-k(n),1)))));
 }
 const ratio=Math.max(0,Math.min(1,(state.temperature-2700)/3800));
 return [255,210,144].map((n,i)=>Math.round(n+([204,229,255][i]-n)*ratio));
}
export const rgbCss=rgb=>`rgb(${rgb.join(' ')})`;
export function contrastInk(rgb){
 const linear=rgb.map(n=>{const s=n/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;});
 return linear[0]*.2126+linear[1]*.7152+linear[2]*.0722>.179?'#161619':'#ffffff';
}
// Each bulb owns its request queue; an unavailable bulb never stalls its peer.
export class LatestControls{
 constructor(send,{delay=24,onSettled=()=>{}}={}){this.send=send;this.delay=delay;this.onSettled=onSettled;this.queues=new Map();}
 busy(id){const q=this.queues.get(id);return !!q&&(q.busy||q.timer!==null||Object.keys(q.patch).length>0);}
 enqueue(id,patch){
  if(typeof id!=='string'||!/^[a-z0-9-]+$/.test(id)||id==='all')return Promise.reject(Error('Unknown light'));
  let q=this.queues.get(id);if(!q){q={patch:{},waiters:[],busy:false,timer:null};this.queues.set(id,q);}
  Object.assign(q.patch,patch);
  const promise=new Promise((resolve,reject)=>q.waiters.push({resolve,reject}));
  if(!q.busy&&q.timer===null)q.timer=setTimeout(()=>{q.timer=null;this.flush(id);},this.delay);
  return promise;
 }
 async flush(id){
  const q=this.queues.get(id);if(q.busy||!Object.keys(q.patch).length)return;
  q.busy=true;const patch=q.patch,waiters=q.waiters;q.patch={};q.waiters=[];
  try{const result=await this.send(id,patch);waiters.forEach(w=>w.resolve(result));}
  catch(error){waiters.forEach(w=>w.reject(error));}
  finally{q.busy=false;this.onSettled(id);if(Object.keys(q.patch).length)this.flush(id);}
 }
}
