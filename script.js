
const mapConfig = { center: [20, -90], zoom: 3, minZoom: 2, maxZoom: 10 };
const iconBaseUrl = 'https://raw.githubusercontent.com/Handhule90/Hurricane-Visualizer/main';
const ICON_SIZE = [1420, 1420]; // Matches 1420x1420 rotation-safe container
const SIM_MS_PER_DAY = 86400000;
const REAL_MS_PER_DAY = 1000;
const SPEED_FACTOR = SIM_MS_PER_DAY / REAL_MS_PER_DAY;


const SVG_PATHS = {
    td: `${iconBaseUrl}/td-tagged.svg`,
    ts: `${iconBaseUrl}/ts-tagged.svg`,
    c1: `${iconBaseUrl}/cat1-tagged.svg`,
    c2: `${iconBaseUrl}/cat2-tagged.svg`,
    c3: `${iconBaseUrl}/cat3-tagged.svg`,
    c4: `${iconBaseUrl}/cat4-tagged.svg`,
    c5: `${iconBaseUrl}/cat5-tagged.svg`
};

const ROTATION_DURATION_MS = 6000;  // 6s per full rotation
const ROTATION_DEG = -360;          // Counter-clockwise


const svgCache = {};
async function preloadSVGs() {
    const keys = Object.keys(SVG_PATHS);
    await Promise.all(keys.map(async key => {
        try {
            const res = await fetch(SVG_PATHS[key]);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, "image/svg+xml");
            const svg = doc.documentElement;

            // Normalize to exact SVG dimensions
            svg.removeAttribute("width");
            svg.removeAttribute("height");
            svg.setAttribute("viewBox", "0 0 1053 1073");
            svg.style.width = "100%";
            svg.style.height = "100%";

            svgCache[key] = { svg };
        } catch (err) {
            console.warn(`Failed to preload ${key}:`, err.message);
            svgCache[key] = null;
        }
    }));
}


let map, stormsData = [], startTime = 0, endTime = 0, currentTime = 0, isPlaying = false, lastFrameTime = 0;
const stormLayers = {};
let currentlyTrackedStorm = null;
let previouslyActiveStorms = new Set();
let autoFocusEnabled = false;
let parLayer = null;
const PAR_BOUNDS = [[5.0,115.0],[15.0,115.0],[21.0,120.0],[25.0,120.0],[25.0,135.0],[5.0,135.0],[5.0,115.0]];

let syncStartTime = null;
let activeSVGElements = [];


function startSVGSync() {
    function tick(now) {
        if (!syncStartTime) syncStartTime = now;
        const angle = ((now - syncStartTime) % ROTATION_DURATION_MS) / ROTATION_DURATION_MS * ROTATION_DEG;
        const transform = `rotate(${angle}deg)`;

        for (const layerEl of activeSVGElements) {
            if (!layerEl.isConnected) continue;
            const animEls = layerEl.querySelectorAll('[data-anim="true"]');
            animEls.forEach(el => el.style.transform = transform);
        }
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}


function setLoading(text, percent) {
    const t = document.getElementById('loadingText');
    const p = document.getElementById('loadingPercent');
    const bar = document.getElementById('loadingProgress');
    if (t) t.textContent = text;
    if (p) p.textContent = Math.round(percent) + ' %';
    if (bar) bar.style.width = percent + '%';
}
function hideLoading() {
    const o = document.getElementById('loadingOverlay');
    if(o) o.classList.add('hidden');
}

function normalizeLng(lng) { while(lng>180)lng-=360; while(lng<-180)lng+=360; return lng; }

function getCategoryKey(knots) {
    if(typeof knots==='string') knots=parseInt(knots.replace(/[^0-9]/g,''),10);
    if(isNaN(knots)) return 'td';
    if(knots>=137) return 'c5'; if(knots>=113) return 'c4'; if(knots>=96) return 'c3';
    if(knots>=83) return 'c2'; if(knots>=64) return 'c1'; if(knots>=34) return 'ts'; return 'td';
}
function getDiscColor(key) {
    const m={td:'#60a5fa',ts:'#4ade80',c1:'#facc15',c2:'#fb923c',c3:'#f97316',c4:'#ef4444',c5:'#ec4899'};
    return m[key]||'#60a5fa';
}
function getNeededCategories(storm) {
    const k=new Set();
    for(const p of storm.path) k.add(getCategoryKey((typeof p.speed==='string')?parseInt(p.speed.replace(/[^0-9]/g,''),10)||0:p.speed));
    return Array.from(k);
}

function formatDate(ts) {
    const d = new Date(ts);
    let h = d.getUTCHours(), m = d.getUTCMinutes();
    m = (m < 15) ? 0 : (m < 45 ? 30 : 0);
    if (m === 0 && d.getUTCMinutes() >= 45) h += 1;
    const allowedHours = [2,4,6,8,12,14,16,18,20,22,24];
    let closestHour = allowedHours.reduce((prev,curr)=>Math.abs(curr-h)<Math.abs(prev-h)?curr:prev);
    if(closestHour===24){ d.setUTCDate(d.getUTCDate()+1); closestHour=0; }
    const mon=['January','February','March','April','May','June','July','August','September','October','November','December'][d.getUTCMonth()];
    return `${String(closestHour).padStart(2,'0')}:${String(m).padStart(2,'0')} UTC, ${String(d.getUTCDate()).padStart(2,'0')} ${mon} ${d.getUTCFullYear()}`;
}


function createSVGIconHtml(activeKey, neededKeys) {
    return `<div class="storm-svg-icon">${neededKeys.map(k=>`<div class="storm-svg-layer ${k===activeKey?'active':''}" data-key="${k}"></div>`).join('')}</div>`;
}
function getSVGIcon(key, neededKeys) {
    return L.divIcon({
        className: 'custom-div-icon',
        html: createSVGIconHtml(key, neededKeys),
        iconSize: ICON_SIZE,
        iconAnchor: [710, 710] 
    });
}


function injectSVGsIntoMarker(marker, neededKeys) {
    const layers = marker._icon.querySelectorAll('.storm-svg-layer');
    layers.forEach(layerEl => {
        const key = layerEl.dataset.key;
        if(svgCache[key]) {
            const svgClone = svgCache[key].svg.cloneNode(true);
            const animEls = svgClone.querySelectorAll('[data-anim="true"]');
            animEls.forEach(el => el.classList.add('svg-anim-layer'));
            layerEl.appendChild(svgClone);
        }
    });
    const activeEl = marker._icon.querySelector('.storm-svg-layer.active');
    if(activeEl) activeSVGElements.push(activeEl);
    return activeEl;
}


function switchSVGIcon(marker, newKey, layer) {
    if(!marker||!marker._icon) return;
    marker._icon.querySelectorAll('.storm-svg-layer').forEach(el=>el.classList.toggle('active',el.dataset.key===newKey));
    const activeEl = marker._icon.querySelector('.storm-svg-layer.active');
    if(activeEl){
        activeSVGElements = activeSVGElements.filter(e=>e!==layer.cachedSVGEl);
        layer.cachedSVGEl = activeEl;
        activeSVGElements.push(activeEl);
    }
    const iconEl = marker._icon; iconEl.classList.remove('flash'); void iconEl.offsetWidth; iconEl.classList.add('flash');
    layer.lastKey = newKey;
}


function fadeInSection(seg, target=0.8, dur=600) {
    const start=performance.now(), sOp=parseFloat(seg.options.opacity)||0;
    const step=now=>{const p=Math.min((now-start)/dur,1), e=1-Math.pow(1-p,3); seg.setStyle({opacity:sOp+(target-sOp)*e}); if(p<1)requestAnimationFrame(step)};
    requestAnimationFrame(step);
}


function makeDraggable(id, handleSel=null) {
    const el=document.getElementById(id), h=handleSel?el.querySelector(handleSel):el;
    let drag=false,x=0,y=0,ix=0,iy=0,xo=0,yo=0;
    const start=e=>{e=e.touches?e.touches[0]:e;const m=new DOMMatrixReadOnly(getComputedStyle(el).transform);xo=m.m41;yo=m.m42;ix=e.clientX-xo;iy=e.clientY-yo;drag=true;el.style.cursor='grabbing'};
    const move=e=>{if(!drag)return;e=e.touches?e.touches[0]:e;el.style.transform=`translate3d(${e.clientX-ix}px,${e.clientY-iy}px,0)`};
    const end=()=>{drag=false;el.style.cursor='move'};
    h.addEventListener('mousedown',start);document.addEventListener('mousemove',move);document.addEventListener('mouseup',end);
    h.addEventListener('touchstart',start,{passive:false});document.addEventListener('touchmove',move,{passive:false});document.addEventListener('touchend',end);
}


function initMap() {
    setLoading('Loading Leaflet', 0);


    map = L.map('map', {
        center: mapConfig.center,
        zoom: mapConfig.zoom,
        minZoom: mapConfig.minZoom,
        maxZoom: mapConfig.maxZoom,
        worldCopyJump: true,
        attributionControl: false,
        zoomControl: false
    });


    L.control.zoom({ position: 'topright' }).addTo(map);


    L.tileLayer(
        'https://gibs-a.earthdata.nasa.gov/wmts/epsg3857/std/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg',
        { attribution: 'NASA', maxZoom: 8 }
    ).addTo(map);


    map.on('dragstart', () => {
        if (currentlyTrackedStorm) stopTracking();
    });


    document.getElementById('parToggle').addEventListener('change', e => {
        if (e.target.checked) parLayer = L.polygon(PAR_BOUNDS, { className: 'par-highlight' }).addTo(map);
        else if (parLayer) { map.removeLayer(parLayer); parLayer = null; }
    });

    setLoading('Ready', 100);
    setTimeout(hideLoading, 300);
}


function processData(data) {
    Object.values(stormLayers).forEach(l=>{
        if(l.marker?._map)map.removeLayer(l.marker);l.segments?.forEach(s=>map.removeLayer(s));if(l.liveTip?._map)map.removeLayer(l.liveTip)
    });
    Object.keys(stormLayers).forEach(k=>delete stormLayers[k]); activeSVGElements=[];
    stormsData=data; let minT=Infinity,maxT=-Infinity;
    stormsData.forEach(s=>{s.path.forEach(p=>{p.timestamp=new Date(p.time.replace(' ','T')+':00Z').getTime();if(p.timestamp<minT)minT=p.timestamp;if(p.timestamp>maxT)maxT=p.timestamp;p.speedVal=(typeof p.speed==='string')?parseInt(p.speed.replace(/[^0-9]/g,''),10)||0:p.speed});s.path.sort((a,b)=>a.timestamp-b.timestamp)});
    if(minT===Infinity){flashError('No valid time data');return}
    startTime=minT;endTime=maxT;currentTime=startTime;
    const tl=document.getElementById('timeline');tl.min=startTime;tl.max=endTime;tl.value=startTime;tl.disabled=false;
    stopTracking();previouslyActiveStorms.clear();updateDisplay();
}
function flashError(msg){const b=document.createElement('div');b.className='fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-red-700 text-white p-6 rounded-lg shadow-2xl z-[9999]';b.innerHTML=`<strong>${msg}</strong>`;document.body.appendChild(b);setTimeout(()=>b.remove(),3000)}
function startTracking(n){currentlyTrackedStorm=n;const e=document.getElementById('trackingStatus');if(e){e.textContent=`Tracking: ${n}`;e.classList.remove('hidden')}}
function stopTracking(){currentlyTrackedStorm=null;const e=document.getElementById('trackingStatus');if(e){e.textContent='Tracking: None';e.classList.add('hidden')}}

function updateDisplay() {
    const dateEl = document.getElementById('dateDisplay');
    const timelineEl = document.getElementById('timeline');
    if(dateEl) dateEl.textContent=formatDate(currentTime);
    if(timelineEl) timelineEl.value=currentTime;

    let ac=0, ca=new Set(), tp=null;
    stormsData.forEach(s=>{
        if(currentTime>=s.path[0].timestamp){
            const r=renderStorm(s);
            if(r.active){ac++;ca.add(s.name);if(autoFocusEnabled&&!previouslyActiveStorms.has(s.name)){startTracking(s.name);if(r.pos)map.flyTo(r.pos,6,{duration:1.5})}if(currentlyTrackedStorm===s.name&&r.pos)tp=r.pos}
            else{if(currentlyTrackedStorm===s.name)stopTracking()}
        }else{if(stormLayers[s.name]){const l=stormLayers[s.name];if(l.marker?._map)map.removeLayer(l.marker);l.segments?.forEach(x=>map.removeLayer(x));if(l.liveTip?._map)map.removeLayer(l.liveTip);delete stormLayers[s.name]}if(currentlyTrackedStorm===s.name)stopTracking()}
    });
    previouslyActiveStorms=ca;document.getElementById('stormCount').textContent=`Active Storms: ${ac}`;
    if(tp)map.panTo(tp,{animate:false});
}

function renderStorm(s) {
    let idx=-1;for(let i=0;i<s.path.length-1;i++){if(currentTime>=s.path[i].timestamp&&currentTime<=s.path[i+1].timestamp){idx=i;break}}
    if(idx===-1&&currentTime>s.path[s.path.length-1].timestamp)idx=s.path.length-2;
    if(idx===-1||idx<0)return{active:false,pos:null};

    const p1=s.path[idx],p2=s.path[idx+1],rng=p2.timestamp-p1.timestamp;
    let prog=(currentTime-p1.timestamp)/rng;if(prog>1)prog=1;if(prog<0)prog=0;
    let l1=normalizeLng(p1.long),l2=normalizeLng(p2.long);if(Math.abs(l2-l1)>180){if(l2>l1)l1+=360;else l2+=360}

    const lat=p1.lat+(p2.lat-p1.lat)*prog, lng=l1+(l2-l1)*prog, spd=p1.speedVal+(p2.speedVal-p1.speedVal)*prog, key=getCategoryKey(spd), ll=[lat,normalizeLng(lng)], alive=currentTime<=s.path[s.path.length-1].timestamp;

    if(!stormLayers[s.name]){
        const nk=getNeededCategories(s), sk=getCategoryKey(p1.speedVal||p1.speed);
        const marker=L.marker(ll,{icon:getSVGIcon(sk,nk)}).addTo(map);
        injectSVGsIntoMarker(marker, nk);
        marker.bindTooltip(s.name,{permanent:true,direction:'right',className:'storm-label',offset:[8,-20]});
        marker.on('click',()=>{startTracking(s.name);map.flyTo(ll,6)});
        stormLayers[s.name]={marker,segments:[],liveTip:null,lastKey:sk,lastProcessedIdx:-1,cachedSVGEl:marker._icon.querySelector('.storm-svg-layer.active'),hasDissipated:false,lastIsAlive:true};
    }else{
        const l=stormLayers[s.name];
        if(alive){l.marker.setLatLng(ll);if(l.lastKey!==key)switchSVGIcon(l.marker,key,l);if(!l.marker._map)l.marker.addTo(map)}
        else{if(l.marker._map)map.removeLayer(l.marker)}

        const mx=alive?idx:s.path.length-2;
        for(let i=l.lastProcessedIdx+1;i<=mx;i++){
            if(i>=s.path.length-1)break;
            const a=s.path[i],b=s.path[i+1],sp=(typeof a.speed==='string')?parseInt(a.speed.replace(/[^0-9]/g,''),10)||0:a.speed, col=getDiscColor(getCategoryKey(sp));
            let al=normalizeLng(a.long),bl=normalizeLng(b.long);if(Math.abs(bl-al)>180){if(bl>al)al+=360;else bl+=360}
            const seg=L.polyline([[a.lat,al],[b.lat,bl]],{color:col,weight:2,opacity:0}).addTo(map);
            l.segments.push(seg); if(!alive&&!l.hasDissipated)fadeInSection(seg);
        }
        l.lastProcessedIdx=Math.max(l.lastProcessedIdx,mx);

        if(l.liveTip&&l.liveTip._map)map.removeLayer(l.liveTip);l.liveTip=null;
        if(alive){const lf=s.path[mx];let fl=normalizeLng(lf.long),cl=normalizeLng(lng);if(Math.abs(cl-fl)>180){if(cl>fl)fl+=360;else cl+=360};l.liveTip=L.polyline([[lf.lat,fl],[lat,cl]],{color:getDiscColor(key),weight:2,opacity:0.8,dashArray:'5,5'}).addTo(map)}

        const was=l.lastIsAlive!==false; l.lastIsAlive=alive;
        if(was&&!alive&&!l.hasDissipated){
            l.hasDissipated=true; l.segments.forEach(x=>fadeInSection(x));
            if(l.liveTip&&l.liveTip._map){fadeInSection(l.liveTip,0,300);setTimeout(()=>{if(l.liveTip&&l.liveTip._map){map.removeLayer(l.liveTip);l.liveTip=null}},300)}
        }
    }
    return{active:alive,pos:ll};
}


document.getElementById('autoFocusToggle').addEventListener('change',e=>autoFocusEnabled=e.target.checked);
document.getElementById('hideControlsBtn').addEventListener('click',()=>{const p=document.getElementById('controlsPanel');p.classList.toggle('controls-hidden');if(p.classList.contains('controls-hidden')&&isPlaying){isPlaying=false;document.getElementById('playPauseBtn').textContent='â–¶'}});
const playBtn=document.getElementById('playPauseBtn'), tlIn=document.getElementById('timeline');
if(playBtn)playBtn.addEventListener('click',()=>{isPlaying=!isPlaying;playBtn.textContent=isPlaying?'âšâš':'â–¶';if(isPlaying){lastFrameTime=performance.now();requestAnimationFrame(animate)}});
if(tlIn){tlIn.addEventListener('input',e=>{currentTime=parseInt(e.target.value);if(!isPlaying)updateDisplay()});tlIn.addEventListener('mousedown',()=>{if(isPlaying)isPlaying=false});tlIn.addEventListener('mouseup',()=>{if(playBtn&&playBtn.textContent==='âšâš'){isPlaying=true;lastFrameTime=performance.now();requestAnimationFrame(animate)}})}

function animate(now){if(!isPlaying)return;const dt=now-lastFrameTime;lastFrameTime=now;currentTime+=dt*SPEED_FACTOR;if(currentTime>=endTime){currentTime=endTime;isPlaying=false;if(playBtn)playBtn.textContent='â–¶'}updateDisplay();requestAnimationFrame(animate)}

window.onload = async () => {
    initMap(); makeDraggable('datePanel'); makeDraggable('controlsPanel','.drag-handle');
    const fi = document.getElementById('fileInput');
    if(fi) fi.addEventListener('change', e=>{const f=e.target.files[0];if(!f)return;const n=document.getElementById('fileNameDisplay');if(n)n.textContent=f.name;const r=new FileReader();r.onload=ev=>{try{processData(JSON.parse(ev.target.result))}catch(err){flashError('Error Parsing JSON: '+err.message)}};r.readAsText(f)});

    await preloadSVGs();
    startSVGSync();
};
