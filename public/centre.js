import {toggleSelection,rangeValueAt,bulbRgb,rgbCss,contrastInk,LatestControls} from './controls.js';

const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const icon=name=>`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const keys=['power','mode','brightness','temperature','hue','saturation'];
let data={devices:[],scenes:[],timers:[]},selection=new Set(),knownIds=new Set(),activeScene=null,stream,connected=false;
let frame=0,toastTimer,errorAt=0,sceneSignature='',timerSignature='',tabsSignature='';
const dirtyUntil=new Map(),drags=new Map();
const queues=new LatestControls(async(id,patch)=>{
 try{const result=await api('/api/lights/'+id,patch);return result;}
 catch(error){const d=data.devices.find(d=>d.id===id);if(d){d.error=error.message;d.verification='error';}throw error;}
},{onSettled:()=>render()});

function toast(message){$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3000);}
function errorToast(error){if(Date.now()-errorAt>2400){toast(error.message||'Could not reach the light');errorAt=Date.now();}}
async function api(url,body={},method='POST'){
 const response=await fetch(url,{method,headers:{'Content-Type':'application/json','X-Luma':'1'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
 const result=await response.json();if(!response.ok)throw Error(result.error||'Request failed');return result;
}
function selected(){return data.devices.filter(d=>selection.has(d.id));}
function allIds(){return data.devices.map(d=>d.id);}
function values(){
 const lights=selected();if(!lights.length)return {power:false,brightness:0,mode:'white',temperature:2700,hue:0,saturation:100};
 return {...lights[0],power:lights.some(d=>d.power),brightness:Math.round(lights.reduce((sum,d)=>sum+d.brightness,0)/lights.length),temperature:Math.round(lights.reduce((sum,d)=>sum+d.temperature,0)/lights.length/50)*50};
}
function updateLocal(id,patch){const light=data.devices.find(d=>d.id===id);if(light){Object.assign(light,patch);dirtyUntil.set(id,Date.now()+1800);}activeScene=null;render();}
function send(id,patch){updateLocal(id,patch);return queues.enqueue(id,patch);}
function control(ids,patch,{autoOn=false}={}){
 if(!ids.length)return Promise.resolve([]);
 return Promise.allSettled(ids.map(id=>{
  const light=data.devices.find(d=>d.id===id);
  return send(id,{...patch,...(autoOn&&light&&!light.power?{power:true}:{})}).catch(error=>{errorToast(Error(`${light?.name||id}: ${error.message}`));throw error;});
 }));
}
function patchSelected(patch){return control(selected().map(d=>d.id),patch,{autoOn:!('power'in patch)});}
function isDragging(id){return [...drags.values()].some(d=>d.ids.has(id));}
function ingest(next){
 const available=new Set((next.devices||[]).map(d=>d.id));
 for(const id of selection)if(!available.has(id))selection.delete(id);
 for(const id of available)if(!knownIds.has(id))selection.add(id);
 knownIds=available;
 for(const light of next.devices||[]){
  const old=data.devices.find(d=>d.id===light.id);
  if(old&&(isDragging(light.id)||queues.busy(light.id)||Date.now()<(dirtyUntil.get(light.id)||0)))for(const key of keys)light[key]=old[key];
 }
 data=next;connected=true;render();
}
function connect(){
 stream?.close();stream=new EventSource('/api/events');
 stream.onmessage=event=>{try{ingest(JSON.parse(event.data));}catch(error){console.error(error);}};
 stream.onerror=()=>{connected=false;render();};
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){stream?.close();for(const input of [...drags.keys()]){if(input.id==='color-wheel')finishWheel();else finishDrag(input);}}else connect();});

function applyTheme(theme){
 document.documentElement.dataset.theme=theme;try{localStorage.setItem('luma-theme',theme);}catch{}
 const next=theme==='dark'?'light':'dark';$('#theme-toggle').setAttribute('aria-label',`Switch to ${next} mode`);$('#theme-toggle').innerHTML=icon(next==='light'?'sun':'moon');
 document.querySelector('meta[name="theme-color"]').content=theme==='dark'?'#101012':'#f5f5f7';
 render();
}
applyTheme(document.documentElement.dataset.theme||'dark');
$('#theme-toggle').addEventListener('click',()=>applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
document.addEventListener('keydown',event=>{if(event.key==='Tab')document.documentElement.classList.add('keyboard-navigation');});
document.addEventListener('pointerdown',()=>document.documentElement.classList.remove('keyboard-navigation'),true);

function finishDrag(input){
 const drag=drags.get(input);if(!drag)return;
 // Commit the released position even when the last move already set this value.
 // A last frame in flight must not leave an earlier intermediate level behind.
 const value=Number(input.value);
 const patch=input.dataset.brightness||input.id==='brightness'?{brightness:value}:input.id==='temperature'?{temperature:value,mode:'white'}:input.id==='hue'?{hue:value,mode:'color'}:{saturation:value,mode:'color'};
 control([...drag.ids],patch,{autoOn:true});
 for(const id of drag.ids)dirtyUntil.set(id,Date.now()+1800);
 drags.delete(input);input.closest('.pill').classList.remove('dragging');
 if(input.hasPointerCapture?.(drag.pointer))input.releasePointerCapture(drag.pointer);
 render();
}
function bindPill(input){
 if(input.dataset.bound)return;input.dataset.bound='true';
 const pick=event=>{
  const box=input.getBoundingClientRect();
  const value=rangeValueAt(event.clientX,box.left,box.width,Number(input.min),Number(input.max),Number(input.step)||1);
  if(Number(input.value)!==value){input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));}
 };
 input.addEventListener('pointerdown',event=>{
  if(input.disabled||(event.pointerType==='mouse'&&event.button!==0)||drags.has(input))return;
  event.preventDefault();input.focus({preventScroll:true});
  const ids=new Set(input.dataset.brightness?[input.dataset.brightness]:selected().map(d=>d.id));
  drags.set(input,{pointer:event.pointerId,ids});input.closest('.pill').classList.add('dragging');input.setPointerCapture(event.pointerId);pick(event);
 });
 input.addEventListener('pointermove',event=>{if(drags.get(input)?.pointer===event.pointerId){event.preventDefault();pick(event);}});
 input.addEventListener('pointerup',event=>{if(drags.get(input)?.pointer===event.pointerId){pick(event);finishDrag(input);}});
 input.addEventListener('pointercancel',()=>finishDrag(input));
 input.addEventListener('lostpointercapture',()=>finishDrag(input));
}
function paintPill(input,value,{colors=[],min=Number(input.min),max=Number(input.max)}={}){
 if(!drags.has(input))input.value=String(value);
 const pill=input.closest('.pill'),fraction=Math.max(0,Math.min(100,(value-min)/(max-min)*100));
 pill.style.setProperty('--value',fraction+'%');pill.dataset.full=String(fraction>82);
 if(colors.length){pill.style.setProperty('--pill-color',colors.length===1?rgbCss(colors[0]):`linear-gradient(90deg,${colors.map(rgbCss).join(',')})`);pill.style.setProperty('--fill-ink',contrastInk(colors.at(-1)));pill.style.setProperty('--icon-ink',fraction>18?(contrastInk(colors[0])==='#ffffff'?'#ffffff':'#000000'):document.documentElement.dataset.theme==='light'?'#000000':'#ffffff');}
 const text=pill.querySelector('.pill-value');if(text)text.textContent=input.id==='temperature'?value+' K':input.id==='hue'?value+'°':value+'%';
}
const bulbSvg=`<svg class="bulb" viewBox="0 0 32 44" aria-hidden="true"><path d="M16 3C8 3 4 8 4 15c0 6 3 9 6 12 2 2 2 4 2 6h8c0-2 0-4 2-6 3-3 6-6 6-12C28 8 24 3 16 3Z" fill="var(--bulb-color)" stroke="currentColor" stroke-width=".6"/><path d="M12 34h8m-8 4h8m-6 3h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
function status(light){if(queues.busy(light.id)||light.pending)return 'Sending';if(light.error)return 'Unavailable';if(light.verification==='sent')return 'Sent';return light.reachable?(light.power?'On':'Off'):'Unknown';}
function renderDevices(){
 for(const card of $$('#device-grid [data-device]'))if(!data.devices.some(d=>d.id===card.dataset.device))card.remove();
 $('#empty-state').hidden=!!data.devices.length;
 for(const light of data.devices){
  let card=$('#device-'+light.id);
  if(!card){
   card=document.createElement('article');card.id='device-'+light.id;card.className='device-card';card.dataset.device=light.id;
   card.innerHTML=`<div class="device-head"><button class="device-main" data-select="${light.id}">${bulbSvg}<span class="device-title"><strong></strong><small></small></span><span class="selection-check">${icon('check')}</span></button><button class="device-power" data-power="${light.id}">${icon('power')}</button></div><div class="pill compact-pill"><span class="pill-fill" aria-hidden="true"></span>${icon('sun')}<span class="pill-value" aria-hidden="true"></span><input class="pill-input" type="range" min="0" max="100" data-brightness="${light.id}"></div>`;
   $('#device-grid').append(card);bindPill(card.querySelector('input'));
  }
  card.classList.toggle('selected',selection.has(light.id));card.classList.toggle('off',!light.power);
  card.style.setProperty('--bulb-color',rgbCss(bulbRgb(light)));
  const select=card.querySelector('[data-select]');select.setAttribute('aria-pressed',String(selection.has(light.id)));select.setAttribute('aria-label',`${selection.has(light.id)?'Deselect':'Select'} ${light.name}`);
  card.querySelector('strong').textContent=light.name;card.querySelector('small').textContent=status(light);
  const power=card.querySelector('[data-power]');power.setAttribute('aria-label',`Turn ${light.name} ${light.power?'off':'on'}`);power.setAttribute('aria-pressed',String(light.power));
  const input=card.querySelector('input');input.setAttribute('aria-label',light.name+' brightness');paintPill(input,light.brightness,{colors:[bulbRgb(light)]});
 }
}
function renderEditor(){
 const lights=selected(),value=values(),none=!lights.length;
 $('#selection-count').textContent=lights.length+' selected';
 $('#target-name').textContent=none?'Select lights':lights.length===1?lights[0].name:lights.length===data.devices.length?'All lights':`${lights.length} lights`;
 $('#target-feedback').textContent=none?'Tap a light card to select it':lights.some(d=>d.error)?'Some lights are unavailable':lights.some(d=>queues.busy(d.id))?'Sending…':'';
 $('#target-feedback').title=$('#target-feedback').textContent;
 const signature=JSON.stringify(data.devices.map(d=>[d.id,d.name]));
 if(signature!==tabsSignature){tabsSignature=signature;$('.target-tabs').innerHTML='<button data-target="all">All</button>'+data.devices.map(d=>`<button data-target="${d.id}">${escape(d.name)}</button>`).join('');}
 $$('[data-target]').forEach(button=>{const active=button.dataset.target==='all'?!!data.devices.length&&selection.size===data.devices.length:selection.has(button.dataset.target);button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
 $$('#control-panel input,#control-panel button').forEach(el=>{if(!el.dataset.target)el.disabled=none;});
 $('#color-wheel').setAttribute('aria-disabled',String(none));
 $('#target-power').setAttribute('aria-label',`Turn selected lights ${value.power?'off':'on'}`);$('#target-power').setAttribute('aria-pressed',String(value.power));
 $('#brightness-output').textContent=value.brightness+'%';paintPill($('#brightness'),value.brightness,{colors:lights.map(bulbRgb)});
 $$('[data-mode]').forEach(b=>{const active=b.dataset.mode===value.mode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
 $('#white-controls').hidden=value.mode!=='white';$('#color-controls').hidden=value.mode!=='color';
 $('#temperature-output').textContent=value.temperature+' K';paintPill($('#temperature'),value.temperature);
 $$('[data-temp]').forEach(b=>{const active=value.mode==='white'&&Number(b.dataset.temp)===value.temperature;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
 $('#hue-output').textContent=value.hue+'°';$('#saturation-output').textContent=value.saturation+'%';paintPill($('#hue'),value.hue);paintPill($('#saturation'),value.saturation);
 $('#saturation').closest('.pill').style.setProperty('--hue-color',rgbCss(bulbRgb({...value,mode:'color',saturation:100})));
 const angle=value.hue*Math.PI/180;$('#wheel-handle').style.left=50+Math.cos(angle)*value.saturation*.44+'%';$('#wheel-handle').style.top=50-Math.sin(angle)*value.saturation*.44+'%';
 $('#current-color').style.background=rgbCss(bulbRgb({...value,mode:'color'}));
 const error=lights.some(d=>d.error);$('#command-status').textContent=none?'No lights selected':lights.some(d=>d.verification==='not-applied')?'Bulb did not confirm the requested setting':error?'State unavailable for some lights':lights.some(d=>queues.busy(d.id)||d.pending)?'Sending latest setting…':lights.some(d=>['sent','settling'].includes(d.verification))?'Waiting for bulb to settle…':'Device state';
 $('#command-status').title=$('#command-status').textContent;
 const times=lights.map(d=>d.writeMs).filter(Number.isFinite);$('#command-latency').textContent=times.length?Math.round(Math.max(...times))+' ms':'';
}
function renderScenes(){
 const signature=JSON.stringify(data.scenes);
 if(signature!==sceneSignature){sceneSignature=signature;$('#scene-grid').innerHTML=data.scenes.map(scene=>`<div class="scene-wrap"><button class="scene" data-scene="${escape(scene.id)}" style="--scene-color:${/^#[0-9a-f]{6}$/i.test(scene.color)?scene.color:'#aaaabb'}"><span class="scene-symbol">${icon(scene.icon||'scenes')}</span><span><strong>${escape(scene.name)}</strong><small>${escape(scene.description)}</small></span></button>${scene.custom?`<button class="delete-scene" data-delete="${escape(scene.id)}" aria-label="Delete scene ${escape(scene.name)}">${icon('close')}</button>`:''}</div>`).join('');}
 $$('[data-scene]').forEach(button=>{button.disabled=!selected().length;button.classList.toggle('active',button.dataset.scene===activeScene);});
}
function render(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;renderDevices();renderEditor();renderScenes();const on=data.devices.some(d=>d.power);$('#all-toggle').disabled=!data.devices.length;$('#save-scene').disabled=!data.devices.length;$('#all-toggle').setAttribute('aria-pressed',String(on));$('#all-toggle').setAttribute('aria-label',on?'Turn all lights off':'Turn all lights on');$('#all-toggle-label').textContent=on?'Turn all off':'Turn all on';$('#connection-label').textContent=connected?'Local':'Reconnecting';$('#demo-badge').hidden=!data.demo;$('#connection-dot').classList.toggle('warn',!connected);$('#lan-url').textContent=data.localUrls?.[0]||location.origin;if($('#timer-dialog').open)renderTimers();});}
function choose(id){if(drags.size)return;selection=toggleSelection(selection,id,allIds());activeScene=null;render();}
$('#device-grid').addEventListener('click',event=>{
 const power=event.target.closest('[data-power]');if(power){const d=data.devices.find(d=>d.id===power.dataset.power);control([d.id],{power:!d.power});return;}
 if(event.target.closest('.pill'))return;
 const card=event.target.closest('[data-device]');if(card)choose(card.dataset.device);
});
$('#device-grid').addEventListener('input',event=>{const id=event.target.dataset.brightness;if(id)control([id],{brightness:Number(event.target.value)},{autoOn:true});});
$('.target-tabs').addEventListener('click',event=>{const b=event.target.closest('[data-target]');if(b)choose(b.dataset.target);});
$('#all-toggle').addEventListener('click',()=>control(allIds(),{power:!data.devices.some(d=>d.power)}));
$('#target-power').addEventListener('click',()=>patchSelected({power:!values().power}));
$('#brightness').addEventListener('input',event=>patchSelected({brightness:Number(event.target.value)}));
$('#temperature').addEventListener('input',event=>patchSelected({temperature:Number(event.target.value),mode:'white'}));
$('#hue').addEventListener('input',event=>patchSelected({hue:Number(event.target.value),mode:'color'}));
$('#saturation').addEventListener('input',event=>patchSelected({saturation:Number(event.target.value),mode:'color'}));
$$('[data-temp]').forEach(b=>b.addEventListener('click',()=>patchSelected({temperature:Number(b.dataset.temp),mode:'white'})));
$$('[data-mode]').forEach(b=>b.addEventListener('click',()=>patchSelected({mode:b.dataset.mode})));
$$('.pill-input').forEach(bindPill);
const palette=[['Red',0,100],['Warm red',10,100],['Orange',25,100],['Warm orange',30,80],['Yellow',50,100],['Light yellow',55,50],['Lime',80,100],['Light green',95,45],['Green',120,100],['Teal',170,100],['Cyan',180,100],['Light blue',210,60],['Blue',240,100],['Purple',280,100],['Magenta',300,100],['Pink',330,80],['Light pink',340,40]];
$('#color-presets').innerHTML=palette.map(([name,h,s])=>`<button class="swatch" data-hue="${h}" data-sat="${s}" style="--swatch:${rgbCss(bulbRgb({mode:'color',hue:h,saturation:s}))}" aria-label="${name}"></button>`).join('');
$('#color-presets').addEventListener('click',event=>{const b=event.target.closest('[data-hue]');if(b)patchSelected({hue:Number(b.dataset.hue),saturation:Number(b.dataset.sat),mode:'color'});});
$('#custom-color').addEventListener('input',event=>{
 const [r,g,b]=event.target.value.match(/[a-f0-9]{2}/gi).map(n=>parseInt(n,16)/255),max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
 let hue=0;if(delta){hue=max===r?((g-b)/delta)%6:max===g?(b-r)/delta+2:(r-g)/delta+4;hue*=60;}
 patchSelected({mode:'color',hue:Math.round((hue+360)%360),saturation:Math.round(max?delta/max*100:0)});
});
const wheel=$('#color-wheel');let wheelPointer=null;
function pickWheel(event){const box=wheel.getBoundingClientRect(),x=event.clientX-box.left-box.width/2,y=box.height/2-(event.clientY-box.top);patchSelected({hue:Math.round((Math.atan2(y,x)*180/Math.PI+360)%360),saturation:Math.round(Math.min(100,Math.hypot(x,y)/(box.width*.44)*100)),mode:'color'});}
wheel.addEventListener('pointerdown',event=>{if(!selected().length)return;event.preventDefault();wheelPointer=event.pointerId;wheel.setPointerCapture(event.pointerId);drags.set(wheel,{pointer:event.pointerId,ids:new Set(selection)});pickWheel(event);});
wheel.addEventListener('pointermove',event=>{if(event.pointerId===wheelPointer){event.preventDefault();pickWheel(event);}});
function finishWheel(){const drag=drags.get(wheel);if(drag)for(const id of drag.ids)dirtyUntil.set(id,Date.now()+1800);drags.delete(wheel);wheelPointer=null;}
wheel.addEventListener('pointerup',finishWheel);wheel.addEventListener('pointercancel',finishWheel);wheel.addEventListener('lostpointercapture',finishWheel);

$('#scene-grid').addEventListener('click',async event=>{
 const del=event.target.closest('[data-delete]');if(del){try{ingest(await api('/api/scenes/'+del.dataset.delete,{},'DELETE'));}catch(error){errorToast(error);}return;}
 const button=event.target.closest('[data-scene]');if(!button||!selected().length)return;
 const scene=data.scenes.find(s=>s.id===button.dataset.scene),ids=selected().map(d=>d.id);
 const results=await Promise.allSettled(ids.filter(id=>scene.states?.[id]||scene.state).map(id=>send(id,scene.states?.[id]||scene.state)));
 activeScene=scene.id;render();if(results.some(r=>r.status==='rejected'))errorToast(Error('Scene could not reach every selected light'));
});
$$('[data-close]').forEach(b=>b.addEventListener('click',()=>$('#'+b.dataset.close).close()));
$$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const box=dialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)dialog.close();}}));
$('#save-scene').addEventListener('click',()=>{$('#scene-dialog').showModal();$('#scene-name').focus();});
$('#scene-form').addEventListener('submit',async event=>{event.preventDefault();try{ingest(await api('/api/scenes',{name:$('#scene-name').value}));$('#scene-dialog').close();$('#scene-name').value='';toast('Scene saved');}catch(error){errorToast(error);}});
$('#refresh').addEventListener('click',async()=>{const b=$('#refresh');b.disabled=true;try{ingest(await api('/api/refresh'));}catch(error){errorToast(error);}finally{b.disabled=false;}});
function renderSettings(){$('#device-settings').innerHTML=data.devices.map(d=>`<div class="settings-device"><label for="name-${d.id}">Bulb name</label><div class="row"><input class="text-input" id="name-${d.id}" maxlength="32" value="${escape(d.name)}"><button class="text-button" data-rename="${d.id}">Save</button></div><div class="row"><small>${escape(d.ip)}:5577</small><button class="text-button" data-remove="${d.id}" aria-label="Remove ${escape(d.name)}">Remove</button></div></div>`).join('');}
$('#info-open').addEventListener('click',()=>{renderSettings();$('#settings-dialog').showModal();});
$('#device-settings').addEventListener('click',async event=>{
 const b=event.target.closest('[data-rename],[data-remove]');if(!b)return;b.disabled=true;
 try{if(b.dataset.remove){ingest(await api('/api/devices/'+b.dataset.remove,{},'DELETE'));renderSettings();toast('Bulb removed');}else{ingest(await api('/api/names/'+b.dataset.rename,{name:$('#name-'+b.dataset.rename).value}));toast('Name saved');}}catch(error){errorToast(error);}finally{b.disabled=false;}
});
$$('[data-add-bulb]').forEach(b=>b.addEventListener('click',()=>{$('#add-error').textContent='';$('#add-dialog').showModal();$('#bulb-name').focus();}));
$('#add-form').addEventListener('submit',async event=>{
 event.preventDefault();const b=$('#add-submit');b.disabled=true;b.textContent='Checking…';$('#add-error').textContent='';
 try{ingest(await api('/api/devices',{name:$('#bulb-name').value,ip:$('#bulb-ip').value}));$('#add-dialog').close();$('#add-form').reset();toast('Bulb added');}catch(error){$('#add-error').textContent=error.message;}finally{b.disabled=false;b.textContent='Verify & add';}
});
$('#copy-url').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#lan-url').textContent);toast('Address copied');}catch{toast($('#lan-url').textContent);}});
function renderTimers(){const markup=data.timers.map(t=>`<div class="timer-item"><span>${escape(t.targets.map(id=>data.devices.find(d=>d.id===id)?.name||'Removed bulb').join(', '))} · ${Math.max(1,Math.ceil((t.endsAt-Date.now())/60000))} min</span><button type="button" class="text-button" data-cancel-timer="${escape(t.id)}">Cancel</button></div>`).join('');if(markup!==timerSignature){timerSignature=markup;$('#active-timers').innerHTML=markup;}}
$('#timer-open').addEventListener('click',()=>{renderTimers();$('#timer-dialog').showModal();});
$('#timer-form').addEventListener('submit',async event=>{event.preventDefault();if(!selection.size)return;try{ingest(await api('/api/timer',{targets:[...selection],minutes:Number($('#timer-minutes').value)}));$('#timer-dialog').close();toast('Off timer set');}catch(error){errorToast(error);}});
$('#active-timers').addEventListener('click',async event=>{const b=event.target.closest('[data-cancel-timer]');if(b)try{ingest(await api('/api/timer',{id:b.dataset.cancelTimer,minutes:0}));}catch(error){errorToast(error);}});
connect();fetch('/api/state').then(r=>r.json()).then(ingest).catch(errorToast);
