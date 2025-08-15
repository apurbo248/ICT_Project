// helpers
const $ = s => document.querySelector(s);
const fmt = ts => ts ? new Date(ts.replace(' ','T')).toLocaleString() : '—';

// state
let tempChart, humChart, rainChart, demoTimer = null;


// charts
function buildCharts(){
  const tctx = $('#tempChart').getContext('2d');
  const hctx = $('#humChart').getContext('2d');
  tempChart = new Chart(tctx, { type:'line',
    data:{ labels:[], datasets:[{ label:'°C', data:[], tension:.25 }]},
    options:{ responsive:true, scales:{ x:{ display:false } } }});
    const rctx = document.getElementById('rainChart').getContext('2d');
  rainChart = new Chart(rctx, {
    type: 'line',
    data: { labels: [], datasets: [{ label: 'Rain', data: [], stepped: true, tension: 0 }]},
    options: {
      responsive: true,
      scales: {
        x: { display: false },
        y: { suggestedMin: -0.1, suggestedMax: 1.1, ticks: { stepSize: 1 } }
      }
    }
  });

  humChart = new Chart(hctx, { type:'line',
    data:{ labels:[], datasets:[{ label:'% RH', data:[], tension:.25 }]},
    options:{ responsive:true, scales:{ x:{ display:false }, y:{ min:0, max:100 }}}});
}


// API helpers
async function jget(u){ const r=await fetch(u,{cache:'no-store'}); if(!r.ok) throw new Error(u); return r.json(); }
async function jpost(u,b){ const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}); if(!r.ok) throw new Error(u); return r.json(); }

// UI updaters
async function refreshStatus(){
  try{
    const s = await jget('/status');
    $('#tempValue').textContent = (typeof s.temp==='number') ? s.temp.toFixed(1) : '—';
    $('#humValue').textContent  = (typeof s.hum ==='number') ? s.hum.toFixed(1)  : '—';
    $('#ventBadge').textContent = 'Vent: ' + (s.vent || '—');
    $('#ventBadge').className = 'badge ' + (s.vent==='OPEN' ? 'bg-success' : (s.vent==='CLOSE' ? 'bg-danger':'bg-secondary'));
    $('#rainBadge').textContent = 'Rain: ' + (s.rain ? 'ON':'OFF');
    $('#rainBadge').className = 'badge ' + (s.rain ? 'bg-info' : 'bg-secondary');
  }catch(e){ console.warn(e); }
}

async function refreshHistory(){
  try{
    const arr = await jget('/history?limit=50');
    const labels = arr.map(x=>x.ts.slice(11,19));
    const temps  = arr.map(x=>x.temp);
    const hums   = arr.map(x=>x.hum);
    tempChart.data.labels=labels; tempChart.data.datasets[0].data=temps; tempChart.update();
    humChart.data.labels=labels;  humChart.data.datasets[0].data=hums;  humChart.update();
  }catch(e){ console.warn(e); }
}

async function refreshLog(){
  try{
    const arr = await jget('/control-log?limit=50');
    const body = $('#logBody'); body.innerHTML='';
    if(!arr.length){ body.innerHTML = '<tr><td colspan="3" class="text-muted p-3">No data yet.</td></tr>'; return; }
    for(const r of arr){
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="text-nowrap">${fmt(r.ts)}</td><td class="text-nowrap">${r.by_user}</td><td>${r.command}</td>`;
      body.appendChild(tr);
    }
  }catch(e){ console.warn(e); }
}
async function refreshRain(){
  try{
    const arr = await jget('/rain-history?limit=50');
    const labels = arr.map(x => x.ts.slice(11,19));
    const values = arr.map(x => x.rain);  // 0 or 1
    rainChart.data.labels = labels;
    rainChart.data.datasets[0].data = values;
    rainChart.update();
  }catch(e){ console.warn(e); }
}


// === Control Buttons ===
$('#btnOpen').onclick  = async () => {
  $('#btnOpen').disabled = true;
  try {
    await jpost('/control-vent', { command: 'OPEN' });
    await Promise.all([refreshStatus(), refreshHistory(), refreshLog()]);
  } finally { $('#btnOpen').disabled = false; }
};

$('#btnClose').onclick = async () => {
  $('#btnClose').disabled = true;
  try {
    await jpost('/control-vent', { command: 'CLOSE' });
    await Promise.all([refreshStatus(), refreshHistory(), refreshLog()]);
  } finally { $('#btnClose').disabled = false; }
};

$('#btnRefresh').onclick = async () => {
  await Promise.all([refreshStatus(), refreshHistory(), refreshLog()]);
};
$('#demoToggle').onchange = e => setDemo(e.target.checked);
$('#demoEvery').onchange  = ()=> setDemo($('#demoToggle').checked);

// boot
document.addEventListener('DOMContentLoaded', async ()=>{
  buildCharts();
  await Promise.all([refreshStatus(), refreshHistory(), refreshLog(), refreshRain()]);
  setInterval(refreshStatus, 4000);
  setInterval(refreshLog, 8000);
  setInterval(refreshHistory, 10000);
  setInterval(refreshRain, 12000);
  setDemo(true);
});
const rainToggle = document.getElementById('rainToggle');
if (rainToggle) {
    rainToggle.addEventListener('change', async (e) => {
        try {
            await jpost('/rain', { on: e.target.checked });  // Send change to backend
            await Promise.all([refreshStatus(), refreshRain(), refreshLog()]); // Update status + rain chart
        } catch (err) {
            console.warn(err);
        }
    });
}

