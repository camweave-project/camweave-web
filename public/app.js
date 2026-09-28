const $ = id => document.getElementById(id);
let cameras = [], page = 0, focused = null, streams = [], state = null, isoEdited = false, pending = false;
async function api(path, method = 'GET', data) {
  const response = await fetch('/api/' + path, {method, headers: {'Content-Type':'application/json', 'X-Camweave-Control':'1'}, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15000)});
  const result = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== 'login') signedOut(); throw Error(result.error || 'Request failed.'); }
  return result;
}
function signedOut() { stopStreams(); cameras=[]; focused=null; document.querySelectorAll('dialog[open]').forEach(d=>d.close()); $('library').hidden=true; $('login').hidden=false; $('logout').hidden=true; }
async function load() {
  cameras = await api('cameras'); $('login').hidden=true; $('library').hidden=false; $('logout').hidden=false;
  page=Math.min(page,Math.max(0,Math.ceil(cameras.length/4)-1)); render();
}
function stopStreams() { streams.forEach(s=>{clearTimeout(s.timer); s.image.removeAttribute('src'); s.image.remove();}); streams=[]; }
function feed(camera, element) {
  const image=document.createElement('img'); image.alt=camera.name+' live view';
  const overlay=document.createElement('span'); overlay.className='overlay'; overlay.textContent='Connecting…'; element.append(image,overlay);
  const record={image,timer:null}; streams.push(record);
  const start=()=>{
    if(document.hidden || !streams.includes(record)) return;
    overlay.hidden=false; overlay.textContent='Connecting…';
    image.src=`/api/cameras/${camera.id}/stream?t=${Date.now()}`;
    clearTimeout(record.timer); record.timer=setTimeout(start,55000);
  };
  image.onload=()=>{overlay.hidden=true;};
  image.onerror=()=>{overlay.hidden=false;overlay.textContent='Reconnecting — check the camera and server network';clearTimeout(record.timer);record.timer=setTimeout(start,4000);};
  start();
}
function render() {
  stopStreams(); $('grid').replaceChildren(); $('pages').replaceChildren();
  $('empty').hidden=!!cameras.length; $('summary').textContent=`${cameras.length} saved ${cameras.length===1?'camera':'cameras'} · Up to four live views at a time`;
  for(const camera of cameras.slice(page*4,page*4+4)) {
    const card=document.createElement('button');card.className='camera';card.setAttribute('aria-label','Open '+camera.name);
    const picture=document.createElement('div');picture.className='feed';const info=document.createElement('div');info.className='info';
    const name=document.createElement('strong');name.textContent=camera.name;const host=document.createElement('span');host.textContent=camera.host+' ↗';info.append(name,host);card.append(picture,info);card.onclick=()=>openCamera(camera);$('grid').append(card);if(!document.hidden)feed(camera,picture);
  }
  if(cameras.length>4) {
    for(const [text,step] of [['← Previous',-1],['Next →',1]]) {const b=document.createElement('button');b.className='quiet';b.textContent=text;b.disabled=page+step<0||(page+step)*4>=cameras.length;b.onclick=()=>{page+=step;render();};$('pages').append(b);}
  }
}
function validExposure(e) {return e && [e.iso,e.selectedISO,e.minimum,e.maximum,e.seconds].every(Number.isFinite)&&e.minimum>=1&&e.maximum>=e.minimum&&e.maximum<=10000000&&e.iso>0&&e.iso<=10000000;}
function selectedISO() {const e=state.exposure;return Math.min(e.maximum,Math.max(e.minimum,Math.round(e.minimum*Math.pow(e.maximum/e.minimum,Number($('iso').value)))));}
function isoUI() {$('iso-label').hidden=$('mode').value==='auto';if(state&&validExposure(state.exposure))$('iso-value').textContent=selectedISO();}
function showState(data, initialize) {
  state=data;if(initialize){$('quality').value=data.quality;$('fps').value=data.fps;isoEdited=false;}
  const valid=validExposure(data.exposure);$('iso-controls').hidden=!valid;$('iso-unavailable').hidden=!!valid;
  if(valid){const e=data.exposure;$('mode').options[1].disabled=!e.supported;
    if(initialize){$('mode').value=e.automatic?'auto':'manual';const iso=e.automatic?e.iso:e.selectedISO;$('iso').value=e.maximum===e.minimum?0:Math.log(Math.min(e.maximum,Math.max(e.minimum,iso))/e.minimum)/Math.log(e.maximum/e.minimum);}
    $('iso').disabled=!e.supported||e.minimum===e.maximum;$('exposure-reading').textContent=`Actual ISO ${Math.round(e.iso)} · ${(e.seconds*1000).toFixed(1)} ms · Range ${Math.round(e.minimum)}–${Math.round(e.maximum)}`;isoUI();}
}
async function openCamera(camera) {
  focused=camera;state=null;isoEdited=false;stopStreams();$('detail-name').textContent=camera.name;$('detail-feed').replaceChildren();$('apply-result').textContent='';$('detail-status').textContent='Connecting…';$('settings').hidden=true;$('detail').showModal();feed(camera,$('detail-feed'));
  try{const data=await api(`cameras/${camera.id}/status`);if(focused?.id!==camera.id)return;showState(data,true);$('settings').hidden=false;$('detail-status').textContent=camera.host;}catch(e){$('detail-status').textContent=e.message;}
}
async function confirmSettings(id, matches) {
  for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,750));const data=await api(`cameras/${id}/status`);if(matches(data))return data;}
  throw Error('Not confirmed. Your choices are kept — check the camera and try again.');
}
$('settings').onsubmit=async event=>{
  event.preventDefault();if(pending||!state||!focused)return;const id=focused.id;
  const quality=Number($('quality').value),fps=Number($('fps').value),exposure=isoEdited?{mode:$('mode').value,iso:selectedISO()}:null;
  pending=true;Array.from($('settings').elements).forEach(e=>e.disabled=true);$('apply-result').textContent='Applying settings…';
  try {
    let data=state;
    if(data.quality!==quality||data.fps!==fps){await api(`cameras/${id}/settings`,'POST',{quality,fps});data=await confirmSettings(id,d=>d.quality===quality&&d.fps===fps);}
    if(exposure){if(!validExposure(data.exposure))throw Error('ISO is currently unavailable.');exposure.iso=Math.min(data.exposure.maximum,Math.max(data.exposure.minimum,exposure.iso));await api(`cameras/${id}/exposure`,'POST',exposure);data=await confirmSettings(id,d=>validExposure(d.exposure)&&d.exposure.automatic===(exposure.mode==='auto')&&(exposure.mode==='auto'||Math.abs(d.exposure.iso-exposure.iso)<=Math.max(2,exposure.iso*.02)));}
    if(focused?.id===id){showState(data,true);$('apply-result').textContent='Settings applied.';}
  }catch(e){$('apply-result').textContent=e.message;}finally{pending=false;Array.from($('settings').elements).forEach(e=>e.disabled=false);if(state)isoUI();}
};
$('mode').onchange=()=>{isoEdited=true;if($('mode').value==='manual'&&state?.exposure?.automatic){const e=state.exposure;$('iso').value=e.maximum===e.minimum?0:Math.log(Math.min(e.maximum,Math.max(e.minimum,e.iso))/e.minimum)/Math.log(e.maximum/e.minimum);}isoUI();};
$('iso').oninput=()=>{isoEdited=true;isoUI();};
$('login-form').onsubmit=async event=>{event.preventDefault();$('login-error').textContent='';try{await api('login','POST',{password:$('password').value});$('password').value='';await load();}catch(e){$('login-error').textContent=e.message;}};
$('logout').onclick=async()=>{try{await api('logout','POST',{});signedOut();}catch(e){$('notice').textContent=e.message;}};
$('add-button').onclick=()=>{$('add-error').textContent='';$('add-form').reset();$('add-dialog').showModal();};
$('add-form').onsubmit=async event=>{event.preventDefault();try{await api('cameras','POST',{name:$('camera-name').value,url:$('camera-url').value});$('camera-url').value='';$('add-dialog').close();await load();}catch(e){$('add-error').textContent=e.message;}};
$('remove').onclick=async()=>{if(pending||!focused||!confirm(`Remove “${focused.name}” from this server? You can add it again using its viewing link.`))return;try{await api(`cameras/${focused.id}`,'DELETE');$('detail').close();await load();}catch(e){$('apply-result').textContent=e.message;}};
$('detail').addEventListener('cancel',e=>{if(pending)e.preventDefault();});
$('detail').addEventListener('close',()=>{focused=null;stopStreams();if(!$('library').hidden)render();});
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{if(b.dataset.close==='detail'&&pending)return;$(b.dataset.close).close();});
$('help-button').onclick=()=>$('help').showModal();
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopStreams();else if(focused){$('detail-feed').replaceChildren();feed(focused,$('detail-feed'));}else if(!$('library').hidden)render();});
setInterval(async()=>{if(!focused||pending||document.hidden)return;const id=focused.id;try{const data=await api(`cameras/${id}/status`);if(focused?.id===id)showState(data,false);}catch(e){$('detail-status').textContent=e.message;}},5000);
load().catch(()=>{});
