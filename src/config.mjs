import net from 'node:net';
import os from 'node:os';

export function isPrivateIPv4(ip){
 if(typeof ip!=='string'||net.isIP(ip)!==4)return false;
 const [a,b]=ip.split('.').map(Number);
 return a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168);
}
export function validateDevice(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Enter a bulb name and IPv4 address');
 const name=typeof input.name==='string'?input.name.trim():'';
 const ip=typeof input.ip==='string'?input.ip.trim():'';
 if(!name||name.length>32)throw Error('Use a bulb name of 1–32 characters');
 if(!isPrivateIPv4(ip))throw Error('Enter the bulb’s private LAN IPv4 address');
 return {name,ip,location:'Wi-Fi bulb'};
}
export function localUrls(port){
 return Object.values(os.networkInterfaces()).flat().filter(item=>item.family==='IPv4'&&!item.internal&&isPrivateIPv4(item.address)).map(item=>`http://${item.address}:${port}`);
}
