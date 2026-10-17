import {levelFrame,rgbToHsv} from './protocol.mjs';

export const demoDevices=[
 {id:'studio',name:'Studio',ip:'10.0.0.51',location:'Wi-Fi bulb'},
 {id:'reading',name:'Reading',ip:'10.0.0.52',location:'Wi-Fi bulb'}
];
export function createDemoTransport(){
 const states=new Map();
 return async(ip,packet,{reply=false}={})=>{
  const state=states.get(ip)||{power:true,mode:'white',brightness:65,temperature:3200,hue:210,saturation:75};
  if(!reply){
   if(packet[0]===0x71)state.power=packet[1]===0x23;
   if(packet[0]===0x31){
    const rgb=[packet[1],packet[2],packet[3]],warm=packet[4],cool=packet[5];
    Object.assign(state,warm+cool?{mode:'white',brightness:Math.round((warm+cool)/255*100),temperature:Math.round((2700+3800*cool/(warm+cool))/50)*50}:{mode:'color',...rgbToHsv(...rgb)});
   }
   states.set(ip,state);return {latencyMs:1};
  }
  const frame=levelFrame(state);return {latencyMs:1,state:{...state,deviceType:53,stateVersion:10,rgb:state.mode==='color'?[...frame.subarray(1,4)]:[0,0,0],warm:frame[4],cool:frame[5]}};
 };
}
