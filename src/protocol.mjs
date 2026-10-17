export const QUERY=Buffer.from('818a8b96','hex');
export function checksum(bytes){return bytes.reduce((sum,n)=>(sum+n)&255,0);}
const sumFrame=body=>Buffer.from([...body,checksum(body)]);
export function powerFrame(on){return sumFrame([0x71,on?0x23:0x24,0x0f]);}
export function rgbFrame(r,g,b){return sumFrame([0x31,r,g,b,0,0,0xf0,0x0f]);}
export function whiteFrame(warm,cool){return sumFrame([0x31,0,0,0,warm,cool,0x0f,0x0f]);}
export function hsvToRgb(h,s,v){
 s/=100;v/=100;const k=n=>(n+h/60)%6;const f=n=>v-v*s*Math.max(0,Math.min(k(n),4-k(n),1));
 return [f(5),f(3),f(1)].map(x=>Math.floor(x*255));
}
export function rgbToHsv(r,g,b){
 r/=255;g/=255;b/=255;let max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min,h=0;
 if(d){if(max===r)h=((g-b)/d)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;}
 return {hue:Math.round((h+360)%360),saturation:Math.round(max?d/max*100:0),brightness:Math.round(max*100)};
}
export function levelFrame(state){
 if(state.mode==='color')return rgbFrame(...hsvToRgb(state.hue,state.saturation,state.brightness));
 const ratio=Math.max(0,Math.min(1,(state.temperature-2700)/3800));const level=Math.floor(255*state.brightness/100);
 return whiteFrame(Math.floor(level*(1-ratio)),Math.floor(level*ratio));
}
export function findState(data){
 for(let i=0;i+14<=data.length;i++){
  const f=data.subarray(i,i+14);
  if(f[0]!==0x81||f[12]!==0x0f||checksum(f.subarray(0,13))!==f[13]||![0x23,0x24].includes(f[2]))continue;
  const rgb=[f[6],f[7],f[8]],warm=f[9],cool=f[11];
  const color=rgb.some(x=>x>0)&&!(warm+cool);const hsv=rgbToHsv(...rgb);
  return {power:f[2]===0x23,deviceType:f[1],stateVersion:f[10],raw:f.toString('hex'),
   mode:color?'color':'white',rgb,warm,cool,
   brightness:color?hsv.brightness:Math.min(100,Math.round((warm+cool)/255*100)),
   hue:hsv.hue,saturation:color?hsv.saturation:100,
   temperature:warm+cool?Math.round((2700+3800*cool/(warm+cool))/50)*50:2700};
 }
 return null;
}
export function validatePatch(input){
 if(!input||Array.isArray(input)||typeof input!=='object')throw Error('Expected a control object');
 const out={};const ranges={brightness:[0,100],temperature:[2700,6500],hue:[0,360],saturation:[0,100]};
 for(const [key,value] of Object.entries(input)){
  if(key==='power'){if(typeof value!=='boolean')throw Error('Power must be true or false');}
  else if(key==='mode'){if(!['white','color'].includes(value))throw Error('Choose white or color');}
  else if(key in ranges){const [lo,hi]=ranges[key];if(typeof value!=='number'||!Number.isFinite(value)||value<lo||value>hi)throw Error(`${key} must be ${lo}–${hi}`);}
  else throw Error(`Unknown control: ${key}`);
  out[key]=value;
 }
 if(!Object.keys(out).length)throw Error('No controls supplied');return out;
}
