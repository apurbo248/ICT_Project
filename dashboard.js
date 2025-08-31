/* ------------------------------ GN Roof — dashboard.js (with Rain/Smoke fix + back-compat) ------------------------------ */
const $  = (sel, p=document) => p.querySelector(sel);
const $$ = (sel, p=document) => Array.from(p.querySelectorAll(sel));

async function jget(url){
  const r = await fetch(url, {credentials:'same-origin'});
  if(!r.ok) throw new Error(`${url} -> ${r.status}`);
  return await r.json();
}
async function jpost(url, data){
  const r = await fetch(url, {
    method:'POST', credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(data||{})
  });
  if(!r.ok) throw new Error(`${url} -> ${r.status}`);
  return await r.json();
}

// Robust timestamp formatter (accepts ISO or fallback)
function fmt(ts){
  if(!ts) return '—';
  const d = new Date(ts);
  if(!isNaN(d.getTime())) return d.toLocaleString();
  return String(ts);
}

/* ========== Charts ========== */
let tempChart, humChart, rainChart, smokeChart;
function newLineChart(ctx, label, yMin=null, yMax=null){
  if(!ctx) return null;
  return new Chart(ctx, {
    type:'line',
    data:{ labels:[], datasets:[{ label, data:[], tension:0.3, fill:false, pointRadius:3 }] },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      scales:{
        x:{ ticks:{ autoSkip:true, maxRotation:0 } },
        y:{ suggestedMin: yMin ?? undefined, suggestedMax: yMax ?? undefined, beginAtZero:false }
      },
      plugins:{ legend:{ display:true } }
    }
  });
}

/* ========== Global state ========== */
let demoTimer=null, weatherTimer=null;
let lastUpdateTs=null;

/* ========== Status & badges ========== */
function setBadge(el, on, onTxt, offTxt){
  if(!el) return;
  el.textContent = on ? onTxt : offTxt;
  el.className = `badge ${on ? 'bg-success' : 'bg-secondary'}`;
}
function checkAlerts(sensorData) {
  const box = $('#alertBox'); if (!box) return;
  const smoke = !!sensorData.smoke;
  const hot   = Number(sensorData.temp ?? 0) >= 35;
  const humid = Number(sensorData.hum ?? 0) >= 85;
  const msgs = [];
  if (smoke) msgs.push('🚨 Smoke detected!');
  if (hot)   msgs.push('🔥 High temperature!');
  if (humid) msgs.push('💧 High humidity!');
  if (msgs.length) {
    box.innerHTML = msgs.join('<br>');
    box.classList.remove('d-none');
  } else {
    box.classList.add('d-none');
    box.innerHTML = '';
  }
}
async function refreshStatus(){
  try{
    const s = await jget('/status');
    if($('#tempValue')) $('#tempValue').textContent = s.temp==null ? '—' : (+s.temp).toFixed(1);
    if($('#humValue'))  $('#humValue').textContent  = s.hum==null  ? '—' : (+s.hum).toFixed(1);
    setBadge($('#ventBadge'), s.vent==='OPEN', `Vent: OPEN`, `Vent: ${s.vent||'CLOSE'}`);
    setBadge($('#rainBadge'), !!s.rain, 'Rain: ON', 'Rain: OFF');
    setBadge($('#smokeBadge'), !!s.smoke, 'Smoke: ON', 'Smoke: OFF');

    // Keep any toggles in the UI synced to server state
    if ($('#rainToggle'))      $('#rainToggle').checked      = !!s.rain;
    if ($('#smokeToggle'))     $('#smokeToggle').checked     = !!s.smoke;
    if ($('#simulateRain'))    $('#simulateRain').checked    = !!s.rain;   // old IDs
    if ($('#simulateSmoke'))   $('#simulateSmoke').checked   = !!s.smoke;  // old IDs

    if($('#userName')) $('#userName').textContent = s.user || '—';
    checkAlerts(s);
    return s;
  }catch(e){ console.warn('refreshStatus', e); }
}

/* ========== History (temp/hum) ========== */
async function refreshHistory(){
  try{
    const arr = await jget('/history?limit=50');
    const labels = arr.map(r=>fmt(r.ts));
    const temps  = arr.map(r=>r.temp);
    const hums   = arr.map(r=>r.hum);
    if(!tempChart && $('#tempChart')) tempChart = newLineChart($('#tempChart'), '°C');
    if(!humChart  && $('#humChart'))  humChart  = newLineChart($('#humChart'),  '% RH', 0, 100);
    if(tempChart){
      tempChart.data.labels = labels;
      tempChart.data.datasets[0].data = temps;
      tempChart.update();
    }
    if(humChart){
      humChart.data.labels = labels;
      humChart.data.datasets[0].data = hums;
      humChart.update();
    }
  }catch(e){ console.warn('refreshHistory', e); }
}

/* ========== Logs table ========== */
async function refreshLog(){
  try{
    const body = $('#logBody'); if(!body) return;
    const rows = await jget('/control-log?limit=50');
    body.innerHTML='';
    if(!rows.length){ body.innerHTML = '<tr><td colspan="3" class="text-muted p-3">No data.</td></tr>'; return; }
    for(const r of rows){
      const sys = (r.by_user || '').toUpperCase()==='SYSTEM';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="text-nowrap">${fmt(r.ts)}</td>
        <td class="${sys?'text-danger fw-semibold':''}">${r.by_user}</td>
        <td class="${sys?'text-danger fw-semibold':''}">${r.command}</td>`;
      body.appendChild(tr);
    }
  }catch(e){ console.warn('refreshLog', e); }
}

/* ========== Rain/Smoke histories ========== */
async function refreshRain(){
  try{
    const arr = await jget('/rain-history?limit=50');
    const labels = arr.map(r=>fmt(r.ts));
    const data   = arr.map(r=>r.val);
    if(!rainChart && $('#rainChart')) rainChart = newLineChart($('#rainChart'), 'Rain', -0.2, 2.2);
    if(rainChart){
      rainChart.data.labels = labels;
      rainChart.data.datasets[0].data = data;
      rainChart.update();
    }
  }catch(e){ console.warn('refreshRain', e); }
}
async function refreshSmoke(){
  try{
    const arr = await jget('/smoke-history?limit=50');
    const labels = arr.map(r=>fmt(r.ts));
    const data   = arr.map(r=>r.val);
    if(!smokeChart && $('#smokeChart')) smokeChart = newLineChart($('#smokeChart'), 'Smoke', -0.2, 2.2);
    if(smokeChart){
      smokeChart.data.labels = labels;
      smokeChart.data.datasets[0].data = data;
      smokeChart.update();
    }
  }catch(e){ console.warn('refreshSmoke', e); }
}

/* ========== Sensors page table + mode badge ========== */
function paintModeBadge(){
  const b = $('#modeBadge'); if(!b) return;
  const demo   = $('#demoToggle')?.checked;
  const weather= $('#weatherToggle')?.checked;
  let txt='Mode: —', cls='badge bg-secondary';
  if(weather){ txt='Mode: Weather'; cls='badge bg-primary'; }
  else if(demo){ txt='Mode: Demo'; cls='badge bg-success'; }
  b.className = cls; b.textContent = txt;
}
async function refreshSensorTable(){
  try{
    const body = $('#sensorBody'); if(!body) return;
    const arr = await jget('/history?limit=50');
    body.innerHTML='';
    if(!arr.length){ body.innerHTML = '<tr><td colspan="3" class="text-muted p-3">No readings yet. Turn on Demo or Weather Mode.</td></tr>'; return; }
    for(const r of arr.slice().reverse()){
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="text-nowrap">${fmt(r.ts)}</td><td>${(r.temp ?? '—')}</td><td>${(r.hum ?? '—')}</td>`;
      body.appendChild(tr);
    }
    lastUpdateTs = arr[arr.length-1]?.ts || null;
    if($('#lastUpdate')) $('#lastUpdate').textContent = lastUpdateTs ? fmt(lastUpdateTs) : '—';
  }catch(e){ console.warn('refreshSensorTable', e); }
}

/* ========== System notice (auto-close etc.) ========== */
let lastVentTs=null;
async function updateSysNotice(){
  const el = $('#sysNotice'); if(!el) return;
  try{
    const s = await jget('/status');
    if(s.vent_updated !== lastVentTs){
      lastVentTs = s.vent_updated;
      if(s.vent==='CLOSE' && (s.rain || s.smoke || (s.hum!=null && s.hum>=85))){
        el.classList.remove('d-none');
        el.textContent = 'System closed the vent due to hazard (Rain/Smoke/High humidity). See Logs.';
      }else{
        el.classList.add('d-none');
      }
    }
  }catch(e){ /* ignore */ }
}

/* ========== Controls (Overview) ========== */
async function sendVent(cmd){
  try{
    await jpost('/control', {cmd});
    await Promise.all([refreshStatus(), refreshHistory(), refreshLog(), updateSysNotice()]);
  }catch(e){ console.warn('sendVent', e); }
}
function bindOverviewControls(){
  if($('#btnOpen'))   $('#btnOpen').onclick = ()=>sendVent('OPEN');
  if($('#btnClose'))  $('#btnClose').onclick= ()=>sendVent('CLOSE');
  if($('#btnRefresh'))$('#btnRefresh').onclick = async ()=>{
    await Promise.all([refreshStatus(), refreshHistory(), refreshSensorTable(), refreshLog(), refreshRain(), refreshSmoke(), updateSysNotice()]);
  };

  // New-style toggles (Overview card with switches)
  const rT = $('#rainToggle');
  if(rT) rT.onchange = async ()=>{
    try{ await jpost('/set-rain', {on: rT.checked}); await Promise.all([refreshStatus(), refreshRain(), refreshLog(), updateSysNotice()]); }
    catch(e){ console.warn(e); }
  };
  const sT = $('#smokeToggle');
  if(sT) sT.onchange = async ()=>{
    try{ await jpost('/set-smoke', {on: sT.checked}); await Promise.all([refreshStatus(), refreshSmoke(), refreshLog(), updateSysNotice()]); }
    catch(e){ console.warn(e); }
  };

  // Back-compat: old Overview checkboxes (Simulate Rain/Smoke)
  const simRain = $('#simulateRain');
  if (simRain) simRain.onchange = async ()=>{
    try{ await jpost('/set-rain', {on: simRain.checked}); await Promise.all([refreshStatus(), refreshRain(), refreshLog(), updateSysNotice()]); }
    catch(e){ console.warn(e); }
  };
  const simSmoke = $('#simulateSmoke');
  if (simSmoke) simSmoke.onchange = async ()=>{
    try{ await jpost('/set-smoke', {on: simSmoke.checked}); await Promise.all([refreshStatus(), refreshSmoke(), refreshLog(), updateSysNotice()]); }
    catch(e){ console.warn(e); }
  };
}

/* ========== Demo feed ========== */
function stopDemo(){ if(demoTimer){ clearInterval(demoTimer); demoTimer=null; } }
function setDemo(on){
  stopDemo();
  if(!on){ paintModeBadge(); return; }
  const every = Math.max(2, Math.min(30, parseInt($('#demoEvery')?.value||'5')));
  demoTimer = setInterval(async ()=>{
    try{
      const t = 22 + (Math.random()*6 - 3);
      const h = 52 + (Math.random()*10 - 5);
      await jpost('/sensor', {temp:+t.toFixed(1), hum:+h.toFixed(1)});
      await Promise.all([refreshStatus(), refreshHistory(), refreshSensorTable(), refreshLog(), refreshRain(), refreshSmoke(), updateSysNotice()]);
      paintModeBadge();
    }catch(e){ console.warn('demo tick', e); }
  }, every*1000);
}

/* ========== Weather feed (OpenWeather) ========== */
function stopWeather(){ if(weatherTimer){ clearInterval(weatherTimer); weatherTimer=null; } }
function setWeather(on){
  stopWeather();
  const msg = $('#weatherMsg');
  if(!on){
    if(msg){ msg.textContent=''; msg.className='small'; }
    paintModeBadge();
    return;
  }
  const rawKey = ($('#owmKey')?.value.trim() || localStorage.getItem('owm_key') || '');
  const useEnv = rawKey === '';
  const key = rawKey;
  const dt = $('#demoToggle'); if(dt){ dt.checked=false; stopDemo(); }
  if(msg){
    msg.className = 'small text-muted';
    msg.textContent = useEnv ? 'Weather Mode running (using system key)…'
                             : 'Weather Mode running…';
  }
  const every = Math.max(2, Math.min(30, parseInt($('#demoEvery')?.value||'5')));
  weatherTimer = setInterval(async ()=>{
    try{
      const city = ($('#city')?.value.trim() || 'Sydney,AU');
      const payload = useEnv ? { city } : { key, city };
      const r = await jpost('/pull-weather', payload);
      if(r && r.ok){
        await Promise.all([
          refreshStatus(), refreshHistory(), refreshSensorTable(),
          refreshLog(), refreshRain(), refreshSmoke(), updateSysNotice()
        ]);
        if(msg){
          msg.textContent = `${r.city}: ${r.temp.toFixed(1)}°C, ${r.hum.toFixed(0)}%`;
          msg.className = 'small text-success';
        }
      }
      paintModeBadge();
    }catch(e){
      if(msg){
        msg.textContent = 'Weather fetch failed (key activation, city, or network).';
        msg.className = 'small text-danger';
      }
      console.warn('weather tick', e);
    }
  }, every*1000);
}

/* ========== Sensors controls & helpers ========== */
function bindSensorsControls(){
  const dT = $('#demoToggle'); if(dT){ dT.onchange = ()=>setDemo(dT.checked); }
  const wT = $('#weatherToggle'); if(wT){ wT.onchange = ()=>setWeather(wT.checked); }
  const ev = $('#demoEvery'); if(ev){ ev.onchange = ()=>{ if($('#demoToggle')?.checked) setDemo(true); if($('#weatherToggle')?.checked) setWeather(true); }; }
  const saveKeyBtn = $('#saveKeyBtn');
  if(saveKeyBtn) saveKeyBtn.onclick = ()=>{
    const k = $('#owmKey')?.value.trim();
    if(k){ localStorage.setItem('owm_key', k); if($('#weatherMsg')){ $('#weatherMsg').textContent='Key saved in this browser.'; $('#weatherMsg').className='small text-success'; } }
  };
  const toggleKey = $('#toggleKey');
  if(toggleKey) toggleKey.onclick = ()=>{
    const i = $('#owmKey'); if(i) i.type = (i.type==='password') ? 'text' : 'password';
  };
  if($('#owmKey')){
    const k = localStorage.getItem('owm_key');
    if(k) $('#owmKey').value = k;
  }
  paintModeBadge();
}

/* ========== Auth: logout button ========== */
function bindLogout(){
  const b = $('#logoutBtn'); if(!b) return;
  b.onclick = async (e)=>{
    e.preventDefault();
    try{ await jpost('/logout', {}); localStorage.removeItem('gnroof_user'); location.href = '/'; }
    catch(err){ console.warn(err); location.href = '/'; }
  };
}

/* ========== Floating Theme Switcher ========== */
function insertThemeSwitcher(){
  if($('#gn-theme-floating')) return;
  const wrap = document.createElement('div');
  wrap.id = 'gn-theme-floating';
  wrap.style.position = 'fixed';
  wrap.style.top = '12px';
  wrap.style.right = '12px';
  wrap.style.zIndex = '1100';
  wrap.style.background = 'var(--bg-card)';
  wrap.style.border = '1px solid var(--line-soft)';
  wrap.style.borderRadius = '12px';
  wrap.style.boxShadow = 'var(--shadow-1)';
  wrap.style.padding = '6px 8px';
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'center';
  wrap.style.gap = '6px';

  const label = document.createElement('span');
  label.textContent = 'Theme';
  label.style.fontSize = '12px';
  label.style.color = 'var(--text-3)';

  const sel = document.createElement('select');
  sel.id = 'themeSelect';
  sel.style.fontSize = '12px';
  sel.style.padding = '4px 6px';
  sel.style.borderRadius = '8px';
  sel.style.border = '1px solid var(--line-mid)';
  sel.innerHTML = `
    <option value="indigo">Indigo</option>
    <option value="teal">Teal</option>
    <option value="emerald">Emerald</option>
    <option value="slate">Slate</option>
    <option value="night">Night</option>
  `;

  wrap.appendChild(label);
  wrap.appendChild(sel);
  document.body.appendChild(wrap);

  function applyTheme(name){
    document.documentElement.setAttribute('data-theme', name);
    localStorage.setItem('gnroof_theme', name);
    if (name === 'night'){
      Chart.defaults.color = '#cbd5e1';
      Chart.defaults.borderColor = 'rgba(148,163,184,.25)';
    }else{
      Chart.defaults.color = '#666';
      Chart.defaults.borderColor = 'rgba(0,0,0,.1)';
    }
  }
  const saved = localStorage.getItem('gnroof_theme') || 'indigo';
  sel.value = saved; applyTheme(saved);
  sel.onchange = ()=> applyTheme(sel.value);
}

/* ========== Page bootstrap ========== */
window.addEventListener('DOMContentLoaded', async ()=>{
  insertThemeSwitcher();
  bindLogout();
  await refreshStatus();

  // Overview
  if($('#tempChart') || $('#humChart') || $('#btnOpen')){
    bindOverviewControls();
    await Promise.all([refreshHistory(), refreshLog(), refreshRain(), refreshSmoke(), updateSysNotice()]);
  }

  // Sensors
  if($('#sensorBody') || $('#rainChart') || $('#smokeChart')){
    bindSensorsControls();
    await Promise.all([refreshHistory(), refreshSensorTable(), refreshRain(), refreshSmoke()]);
    paintModeBadge();
    if($('#lastUpdate')) $('#lastUpdate').textContent = '—';
    const savedKey = localStorage.getItem('owm_key') || '';
    if (savedKey && $('#weatherToggle')) {
      $('#weatherToggle').checked = true;
      setWeather(true);
    }
  }

  // Logs
  if($('#logBody')) await refreshLog();
});
// Toast helpers
let __toastTimer = null;
function showToast(message, type="info", timeoutMs=3500){
  const el=document.getElementById("toast");
  const text=document.getElementById("toast-text");
  if(!el||!text) return;
  el.className="toast"; el.classList.add(type);
  text.textContent=message;
  requestAnimationFrame(()=>el.classList.add("show"));
  if(__toastTimer) clearTimeout(__toastTimer);
  __toastTimer=setTimeout(()=>el.classList.remove("show"), timeoutMs);
}

// Optional: soft beep
function playBeep(){
  try{
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const o=ctx.createOscillator(), g=ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type="sine"; o.frequency.value=880;
    g.gain.setValueAtTime(0.0001,ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2,ctx.currentTime+0.02);
    g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+0.6);
    o.start(); o.stop(ctx.currentTime+0.65);
  }catch(e){}
}
// Track previous state
let __prevVent=null;

// After fetching status and setting badges:
const vent = status.vent; // "OPEN"|"CLOSE"
const smoke = !!status.smoke_active;
const rain = !!status.rain_active;
const humid = typeof status.humidity==="number" ? status.humidity>=85 : false;

const hazardActive = smoke || rain || humid;
if(__prevVent==="OPEN" && vent==="CLOSE" && hazardActive){
  const cause = smoke ? "smoke" : (rain ? "rain" : "high humidity");
  showToast(`Vent closed automatically due to ${cause}.`,"warn");
  playBeep();
}
__prevVent = vent;
if (Array.isArray(data) && data.length){
  const cmd=(data[0].command||"").toLowerCase();
  if (cmd.includes("cause=smoke")) showToast("Smoke detected — vent closed automatically.","warn");
  else if (cmd.includes("cause=rain")) showToast("Rain detected — vent closed automatically.","warn");
  else if (cmd.includes("cause=humidity")) showToast("High humidity — vent closed automatically.","warn");
}


