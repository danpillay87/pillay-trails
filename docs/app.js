/* ============================================================
   Guildford Trails — virtual geocache player
   Pure static, no backend. Loads a trail JSON, uses the browser
   Geolocation API for geofencing, saves progress to localStorage.
   ============================================================ */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const DEFAULT_GEOFENCE_M = 30;

  const state = {
    trail: null,
    found: new Set(),
    pos: null,          // {lat,lng,acc}
    openStopId: null,
    overridden: new Set(),
    eli: new Set(),
    allTrails: [],
    currentFile: null,
    map: null,
    markers: {},
    youMarker: null,
  };

  /* ---------- helpers ---------- */
  function haversine(a, b) {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function fmtDist(m) {
    if (m == null) return "—";
    if (m < 1000) return Math.round(m) + " m";
    return (m / 1000).toFixed(1) + " km";
  }
  const NUMWORDS = { zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
    eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20 };
  function normalize(s) {
    let t = (s || "").toString().toLowerCase().trim()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ").trim();
    t = t.split(" ").map((w) => (w in NUMWORDS ? String(NUMWORDS[w]) : w)).join(" ");
    return t;
  }
  function digitsOf(s){ const m = (s||"").toString().match(/\d+/g); return m ? m.join("") : ""; }
  function answerMatches(input, accepted) {
    const ui = normalize(input);
    if (!ui) return false;
    return (accepted || []).some((a) => {
      const na = normalize(a);
      if (na && ui === na) return true;
      if (na && ui.includes(na) && na.length >= 3) return true;
      const da = digitsOf(a), du = digitsOf(input);
      if (da && da === du) return true;
      return false;
    });
  }
  function storeKey(){ return "gt:" + (state.trail ? state.trail.id : "x"); }
  function eliKey(){ return "gt:eli:" + (state.trail ? state.trail.id : "x"); }
  function saveProgress(){ try{ localStorage.setItem(storeKey(), JSON.stringify([...state.found])); }catch(e){} }
  function saveEli(){ try{ localStorage.setItem(eliKey(), JSON.stringify([...state.eli])); }catch(e){} }
  function loadProgress(){
    try{ state.found = new Set(JSON.parse(localStorage.getItem(storeKey())||"[]")); }catch(e){ state.found = new Set(); }
    try{ state.eli = new Set(JSON.parse(localStorage.getItem(eliKey())||"[]")); }catch(e){ state.eli = new Set(); }
  }

  function showScreen(id){
    document.querySelectorAll(".screen").forEach((s)=>s.classList.remove("active"));
    $(id).classList.add("active");
    window.scrollTo(0,0);
  }

  /* ---------- load trail ---------- */
  async function boot(){
    const want = new URLSearchParams(location.search).get("trail");
    try{
      let trails = [];
      const idx = await fetch("trails/index.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).catch(()=>null);
      if(idx && Array.isArray(idx.trails)) trails = idx.trails;
      state.allTrails = trails;
      const file = want || (trails[0] && trails[0].file);
      if(!file) throw new Error("No trail configured yet.");
      state.currentFile = file;
      const trail = await fetch("trails/"+file,{cache:"no-store"}).then(r=>{ if(!r.ok) throw new Error("Couldn't load trail ("+r.status+")."); return r.json(); });
      state.trail = trail;
      loadProgress();
      renderIntro();
      renderSwitcher();
    }catch(err){
      const e = $("intro-error"); e.hidden=false; e.textContent = "Trail not available yet: "+err.message;
      $("intro-title").textContent = "No trail loaded";
      $("intro-theme").textContent = "—";
    }
  }
  function renderSwitcher(){
    const el=$("trail-switcher"); if(!el) return;
    if(!state.allTrails || state.allTrails.length<2){ el.hidden=true; return; }
    el.hidden=false;
    el.innerHTML='<div class="switch-label">Choose a trail</div>'+
      state.allTrails.map(t=>'<button class="switch-btn'+(t.file===state.currentFile?' cur':'')+'" data-file="'+escapeHtml(t.file)+'"'+(t.file===state.currentFile?' disabled':'')+'>'+escapeHtml(t.title||t.file)+(t.file===state.currentFile?' ✓':'')+'</button>').join("");
    el.querySelectorAll('.switch-btn').forEach(b=>{ if(b.dataset.file!==state.currentFile){ b.onclick=()=>{ location.search="?trail="+encodeURIComponent(b.dataset.file); }; } });
  }

  function renderIntro(){
    const t = state.trail;
    $("intro-theme").textContent = t.theme || "Trail";
    $("intro-title").textContent = t.title || "Untitled trail";
    $("intro-blurb").textContent = t.blurb || "";
    const meta = $("intro-meta"); meta.innerHTML = "";
    const bits = [];
    if(t.stops) bits.push("📍 "+t.stops.length+" stops");
    if(t.duration_min) bits.push("⏱️ ~"+t.duration_min+" min");
    if(t.distance_km) bits.push("🥾 ~"+t.distance_km+" km");
    if(t.difficulty) bits.push("🎯 "+t.difficulty);
    bits.forEach((b)=>{ const li=document.createElement("li"); li.textContent=b; meta.appendChild(li); });
    if(t.start){ $("intro-start").textContent = t.start.name || ""; $("intro-directions").textContent = t.start.directions || ""; }
    $("intro-credits").innerHTML = t.credits || "Map data © OpenStreetMap contributors";
    const btn = $("btn-start"); btn.disabled=false;
    btn.textContent = state.found.size>0 ? ("Continue ("+state.found.size+"/"+t.stops.length+" found)") : "Start the trail";
  }

  /* ---------- map + trail screen ---------- */
  function startTrail(){
    showScreen("screen-trail");
    $("trail-title").textContent = state.trail.title || "Trail";
    if(!state.map) initMap();
    setTimeout(()=>state.map.invalidateSize(), 80);
    renderStops();
    updateProgress();
    startGeo();
    if(state.found.size === state.trail.stops.length) finale();
  }

  function initMap(){
    const t = state.trail;
    state.map = L.map("map",{zoomControl:true});
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{
      maxZoom:19, attribution:'© OpenStreetMap'
    }).addTo(state.map);
    const pts = t.stops.map(s=>[s.lat,s.lng]);
    if(t.start) pts.push([t.start.lat,t.start.lng]);
    state.map.fitBounds(pts,{padding:[40,40]});
    t.stops.forEach((s)=>{
      const m = L.marker([s.lat,s.lng],{icon:numIcon(s.id, state.found.has(s.id))}).addTo(state.map);
      m.on("click",()=>openStop(s.id));
      state.markers[s.id]=m;
    });
    if(t.start){
      L.circleMarker([t.start.lat,t.start.lng],{radius:7,color:"#2b5c3f",fillColor:"#2b5c3f",fillOpacity:1})
        .addTo(state.map).bindTooltip("Start");
    }
  }
  function numIcon(n, found){
    return L.divIcon({className:"", html:
      `<div style="width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);
        background:${found?"#2f8a4e":"#c2622d"};border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);
        display:flex;align-items:center;justify-content:center;">
        <span style="transform:rotate(45deg);color:#fff;font-weight:800;font-size:13px;font-family:sans-serif">${found?"✓":n}</span>
      </div>`, iconSize:[30,30], iconAnchor:[15,28]});
  }

  function renderStops(){
    const list = $("stops-list"); list.innerHTML="";
    const ordered = !!state.trail.ordered;
    state.trail.stops.forEach((s, i)=>{
      const found = state.found.has(s.id);
      const lockedByOrder = ordered && !found && i>0 && !state.found.has(state.trail.stops[i-1].id);
      const card = document.createElement("button");
      card.className = "stop-card"+(found?" found":"")+(lockedByOrder?" disabled-look":"");
      const dist = state.pos ? fmtDist(haversine(state.pos,s)) : "";
      card.innerHTML =
        `<span class="stop-num">${found?"✓":s.id}</span>
         <span class="sc-body"><span class="sc-name">${escapeHtml(s.name)}</span>
         <span class="sc-sub">${found?"Found ✓":(escapeHtml(typeLabel(s))+(dist?" · "+dist+" away":""))}</span></span>
         <span class="sc-tick">${found?"":"›"}</span>`;
      if(!lockedByOrder) card.onclick=()=>openStop(s.id);
      else card.onclick=()=>toast("Do the earlier stops first on this trail.");
      list.appendChild(card);
    });
    $("stops-hint").textContent = ordered ? "Do these in order." : "Tap a stop to see its clue. Any order.";
  }
  function typeLabel(s){
    if(s.clue_type==="arrival") return "Just get there";
    if(s.clue_type==="virtual") return "Virtual clue";
    return "Clue on-site";
  }
  function escapeHtml(s){ return (s||"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

  function updateProgress(){
    const n = state.trail.stops.length;
    $("progress-pill").textContent = state.found.size+"/"+n;
  }

  /* ---------- geolocation ---------- */
  function startGeo(){
    if(!("geolocation" in navigator)){ $("gps-banner").hidden=false; $("gps-banner").textContent="📡 This device has no location support — use the “I'm here” buttons."; return; }
    $("gps-banner").hidden=false;
    navigator.geolocation.watchPosition(
      (p)=>{
        state.pos={lat:p.coords.latitude,lng:p.coords.longitude,acc:p.coords.accuracy};
        $("gps-banner").hidden=true;
        drawYou();
        if(state.openStopId!=null) refreshSheetStatus();
        refreshDistances();
      },
      (err)=>{
        $("gps-banner").hidden=false;
        $("gps-banner").textContent = err.code===1
          ? "📡 Location blocked — allow it in your browser, or use “GPS playing up? I'm here.”"
          : "📡 Can't get a fix right now — you can still tap “I'm here”.";
      },
      {enableHighAccuracy:true, maximumAge:5000, timeout:20000}
    );
  }
  function drawYou(){
    if(!state.map||!state.pos) return;
    const ll=[state.pos.lat,state.pos.lng];
    if(!state.youMarker){
      state.youMarker = L.circleMarker(ll,{radius:8,color:"#1769d6",fillColor:"#3b8bff",fillOpacity:1,weight:3}).addTo(state.map);
      state.youMarker.bindTooltip("You");
    } else state.youMarker.setLatLng(ll);
  }
  function refreshDistances(){
    // update only the subtitles cheaply by re-rendering the list
    if($("screen-trail").classList.contains("active")) renderStops();
  }

  /* ---------- stop sheet ---------- */
  function stopById(id){ return state.trail.stops.find(s=>s.id===id); }
  function isNear(s){
    if(state.overridden.has(s.id)) return true;
    if(!state.pos) return false;
    const r = s.geofence_m || DEFAULT_GEOFENCE_M;
    return haversine(state.pos,s) <= r + (state.pos.acc?Math.min(state.pos.acc,40):0);
  }
  function openStop(id){
    const s = stopById(id); if(!s) return;
    state.openStopId=id;
    const found = state.found.has(id);
    $("sheet-num").textContent = found?"✓":s.id;
    $("sheet-name").textContent = s.name;
    const badge=$("sheet-type"); badge.className="badge "+(s.clue_type||"durable");
    badge.textContent = (s.clue_type||"durable");
    $("sheet-clue").textContent = s.clue || "";
    // reset blocks
    $("answer-feedback").hidden=true; $("sheet-hint").hidden=true;
    const answerBlock=$("answer-block"), reveal=$("sheet-reveal");
    const isArrival = s.clue_type==="arrival" || !(s.answer&&s.answer.length);
    $("sheet-answer").value="";
    $("sheet-answer").parentElement.style.display = isArrival?"none":"flex";
    $("btn-hint").style.display = (s.answer_hint && !isArrival)?"":"none";
    $("btn-submit").textContent = isArrival?"Check in here":"Check";
    const eliBlock=$("eli-mission");
    if(s.little_ones){ eliBlock.hidden=false; $("eli-task").textContent=s.little_ones; $("eli-done").hidden=!state.eli.has(s.id); }
    else eliBlock.hidden=true;
    if(found){
      answerBlock.hidden=true; reveal.hidden=false;
      $("sheet-story").textContent=s.story||""; setSource(s); setGrownup(s);
    }else{
      answerBlock.hidden=false; reveal.hidden=true; $("grownup-bonus").hidden=true;
    }
    refreshSheetStatus();
    openSheet();
  }
  function setSource(s){
    const a=$("sheet-source");
    if(s.source){ a.hidden=false; a.href=s.source; } else a.hidden=true;
  }
  function setGrownup(s){
    const g=$("grownup-bonus");
    if(s.grownup){ g.hidden=false; g.textContent="🧠 Grown-up bonus: "+s.grownup; } else g.hidden=true;
  }
  function refreshSheetStatus(){
    const s=stopById(state.openStopId); if(!s) return;
    const st=$("sheet-status");
    if(state.found.has(s.id)){ st.className="status near"; st.textContent="✅ Found"; return; }
    const near=isNear(s);
    if(near){ st.className="status near"; st.textContent="✅ You're here — go for it!"; }
    else if(state.pos){ st.className="status far"; st.textContent="📍 "+fmtDist(haversine(state.pos,s))+" away — head over to unlock this one"; }
    else { st.className="status far"; st.textContent="📍 Finding your location…"; }
  }
  function openSheet(){ $("sheet-backdrop").hidden=false; const sh=$("stop-sheet"); sh.setAttribute("aria-hidden","false"); requestAnimationFrame(()=>sh.classList.add("open")); }
  function closeSheet(){ const sh=$("stop-sheet"); sh.classList.remove("open"); sh.setAttribute("aria-hidden","true"); $("sheet-backdrop").hidden=true; state.openStopId=null; }

  function submitAnswer(){
    const s=stopById(state.openStopId); if(!s) return;
    const isArrival = s.clue_type==="arrival" || !(s.answer&&s.answer.length);
    if(!isNear(s)){
      const fb=$("answer-feedback"); fb.hidden=false; fb.className="feedback bad";
      fb.textContent="You need to be at the spot first. (If your GPS is rubbish, tap “I'm here”.)";
      return;
    }
    if(isArrival){ markFound(s); return; }
    const val=$("sheet-answer").value;
    if(answerMatches(val, s.answer)){ markFound(s); }
    else{
      const fb=$("answer-feedback"); fb.hidden=false; fb.className="feedback bad";
      fb.textContent="Not quite — look again, or try a hint.";
    }
  }
  function markFound(s){
    state.found.add(s.id); saveProgress();
    if(state.markers[s.id]) state.markers[s.id].setIcon(numIcon(s.id,true));
    $("answer-block").hidden=true;
    const reveal=$("sheet-reveal"); reveal.hidden=false;
    $("sheet-story").textContent=s.story||"Nice one."; setSource(s); setGrownup(s);
    $("sheet-num").textContent="✓";
    refreshSheetStatus(); updateProgress(); renderStops();
  }
  function nextStop(){
    closeSheet();
    if(state.found.size===state.trail.stops.length){ finale(); return; }
    // suggest nearest unfound
    const remaining = state.trail.stops.filter(s=>!state.found.has(s.id));
    if(state.pos && remaining.length){
      remaining.sort((a,b)=>haversine(state.pos,a)-haversine(state.pos,b));
      if(state.map) state.map.panTo([remaining[0].lat,remaining[0].lng]);
    }
  }

  /* ---------- finale ---------- */
  function finale(){
    const t=state.trail;
    showScreen("screen-finale");
    $("finale-title").textContent = (t.finale&&t.finale.title) || "You made it! 🎉";
    let msg = (t.finale&&t.finale.message) || ("You found all "+t.stops.length+" stops on the "+t.title+".");
    if(state.eli.size) msg += "  Eli spotted "+state.eli.size+(state.eli.size===1?" thing":" things")+" along the way! ⭐";
    $("finale-msg").textContent = msg;
    const strip=$("sticker-strip");
    if(strip) strip.innerHTML = t.stops.filter(s=>state.found.has(s.id)).map(s=>'<span class="sticker">'+(s.sticker||"⭐")+'</span>').join("");
    const r=$("finale-reward");
    if(t.finale&&t.finale.reward_idea){ r.hidden=false; r.innerHTML="<strong>🏁 Your reward</strong><br>"+escapeHtml(t.finale.reward_idea); }
    else r.hidden=true;
  }
  function restart(){
    state.found=new Set(); state.overridden=new Set(); state.eli=new Set(); saveProgress(); saveEli();
    Object.values(state.markers).forEach((m,i)=>{}); // icons refreshed on start
    state.trail.stops.forEach(s=>{ if(state.markers[s.id]) state.markers[s.id].setIcon(numIcon(s.id,false)); });
    startTrail();
  }

  /* ---------- misc UI ---------- */
  let toastT=null;
  function toast(msg){
    let el=$("__toast");
    if(!el){ el=document.createElement("div"); el.id="__toast"; el.style.cssText="position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#23271f;color:#fff;padding:11px 16px;border-radius:12px;z-index:2000;font-size:.9rem;box-shadow:0 6px 20px rgba(0,0,0,.3);max-width:90%"; document.body.appendChild(el); }
    el.textContent=msg; el.style.opacity="1";
    clearTimeout(toastT); toastT=setTimeout(()=>{el.style.opacity="0";},2600);
  }

  /* ---------- wire up ---------- */
  function wire(){
    $("btn-start").onclick=startTrail;
    $("btn-back").onclick=()=>{ showScreen("screen-intro"); renderIntro(); };
    $("btn-sheet-close").onclick=closeSheet;
    $("sheet-backdrop").onclick=closeSheet;
    $("btn-submit").onclick=submitAnswer;
    $("sheet-answer").addEventListener("keydown",(e)=>{ if(e.key==="Enter") submitAnswer(); });
    $("btn-hint").onclick=()=>{ const s=stopById(state.openStopId); const h=$("sheet-hint"); h.hidden=false; h.textContent="💡 "+(s&&s.answer_hint?s.answer_hint:"No hint for this one — trust your eyes."); };
    $("btn-override").onclick=()=>{ const s=stopById(state.openStopId); if(s){ state.overridden.add(s.id); refreshSheetStatus(); toast("OK — marked you as here."); } };
    $("btn-next").onclick=nextStop;
    $("btn-eli").onclick=()=>{ const s=stopById(state.openStopId); if(!s) return; state.eli.add(s.id); saveEli(); $("eli-done").hidden=false; toast("⭐ Yay Eli! Well spotted!"); };
    $("btn-restart").onclick=restart;
  }

  wire();
  boot();
})();
