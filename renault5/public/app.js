const $ = (id) => document.getElementById(id);
const token = localStorage.getItem('APP_TOKEN') || '';

const CAR_IMG_URL =
  'https://3dv.renault.com/ImageFromBookmark?configuration=PAVEH%2FX1316%2FHTB%2FEA3%2FLHDG%2FACC02%2FACD02%2FWFTRP%2FCLK00%2FRVX09%2FRAL18%2FCLS02%2FFSE02%2FBIXUI%2FPRROP%2FSLSW0%2FRVIAT%2FTRSV0%2FNHTS0%2FRIM03%2FFXCCA%2FBDPRO%2FABCXL%2F02ANT%2FNODUP%2FNOWAP%2FSBCAL%2FAMLT0%2FMET05%2FNOBSD%2FITP17%2FPXA03%2FPXB00%2FPXF00%2FSSPXJ%2FNHTSW%2FWICH0%2FNOLIE%2FNOLII%2FRRCAM&databaseId=4d5421a4-3dfd-4a89-a915-4ea855f24b3a&bookmarkSet=RSITE&bookmark=EXT_34_DESSUS&profile=HELIOS_OWNERSERVICES_SMALL_V2';

const REFRESH_INTERVAL_MS = 2 * 60 * 1000;          // ✅ auto refresh 2 min
const MANUAL_REFRESH_COOLDOWN_MS = 1 * 60 * 1000;    // ✅ manual refresh 1 min

const HVAC_DURATION_MS = 15 * 60 * 1000;
const LS_HVAC_UNTIL = 'R5_HVAC_RUN_UNTIL_MS';
const LS_HVAC_TEMP  = 'R5_HVAC_TEMP';
const LS_LAST_MANUAL_REFRESH = 'R5_LAST_MANUAL_REFRESH_MS';

const FULL_BATTERY_KWH = 52;

let lastMapKey = null;
let selectedTemp = readSelectedTemp();
let mapGuardUnlockTimer = null;

function setStatus(msg) { const el = $('statusLine'); if (el) el.textContent = msg; }
function setText(id, text) { const el = $(id); if (el) el.textContent = text; }
function setWidth(id, widthPct) { const el = $(id); if (el) el.style.width = widthPct; }

window.addEventListener('error', (e) => setStatus(`JS Fehler: ${e.message || 'unknown'}`));
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e && e.reason && e.reason.message) ? e.reason.message : String(e.reason || 'unknown');
  setStatus(`Promise Fehler: ${msg}`);
});

async function api(path, opts = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (token) headers['X-App-Token'] = token;

  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!res.ok) throw new Error(`${path}: ${json?.error || json?.message || `HTTP ${res.status}`}`);
  if (json && json.ok === false) throw new Error(`${path}: ${json.error || json.message || 'ok=false'}`);
  return json?.data ?? json;
}

function clampPct(n) { return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0; }

function minutesLabel(min) {
  if (!Number.isFinite(min) || min <= 0) return '—';
  const h = Math.floor(min / 60);
  const m = Math.floor(min % 60);
  if (h <= 0) return `${m} Min.`;
  return `${h} Std. ${String(m).padStart(2,'0')} Min.`;
}

function parseCoord(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function getAny(obj, paths) {
  for (const p of paths) {
    const parts = p.split('.');
    let cur = obj;
    let ok = true;
    for (const key of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, key)) cur = cur[key];
      else { ok = false; break; }
    }
    if (ok && cur !== undefined && cur !== null) return cur;
  }
  return undefined;
}

/* -------------------- Car image (fade-in) -------------------- */
function setCarImageRemote() {
  const img = $('carImg');
  const fb = $('carFallback');
  if (!img || !fb) return;

  img.classList.remove('is-loaded');
  img.style.display = 'block';
  fb.style.display = 'none';

  img.onload = () => {
    img.style.display = 'block';
    fb.style.display = 'none';
    requestAnimationFrame(() => img.classList.add('is-loaded'));
  };

  img.onerror = () => {
    img.classList.remove('is-loaded');
    img.style.display = 'none';
    fb.style.display = 'flex';
  };

  const u = new URL(CAR_IMG_URL);
  u.searchParams.set('_t', String(Math.floor(Date.now() / 600000)));
  img.src = u.toString();
}

/* -------------------- MAP guard -------------------- */
function buildOsmEmbed(lat, lng) {
  const d = 0.01;
  const left = lng - d;
  const right = lng + d;
  const top = lat + d;
  const bottom = lat - d;
  const bbox = `${left},${bottom},${right},${top}`;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(lat + ',' + lng)}`;
}

function setMap(lat, lng) {
  const frame = $('mapFrame');
  const empty = $('mapEmpty');
  if (!frame || !empty) return;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    frame.src = 'about:blank';
    frame.style.visibility = 'hidden';
    empty.style.display = 'flex';
    lastMapKey = null;
    return;
  }

  const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  if (key !== lastMapKey) {
    lastMapKey = key;
    empty.style.display = 'none';
    frame.style.visibility = 'visible';
    frame.src = buildOsmEmbed(lat, lng);
  }
}

function unlockMapInteraction(ms = 1500) {
  const guard = $('mapGuard');
  const frame = $('mapFrame');
  if (!guard || !frame) return;

  guard.classList.add('unlocked');
  frame.classList.add('interactive');

  if (mapGuardUnlockTimer) clearTimeout(mapGuardUnlockTimer);
  mapGuardUnlockTimer = setTimeout(() => {
    guard.classList.remove('unlocked');
    frame.classList.remove('interactive');
  }, ms);
}

function initMapGuard() {
  const guard = $('mapGuard');
  const frame = $('mapFrame');
  if (!guard || !frame) return;

  guard.addEventListener('wheel', (e) => {
    if (e.altKey) { e.preventDefault(); unlockMapInteraction(1200); }
  }, { passive: false });

  guard.addEventListener('mousedown', (e) => { if (e.altKey) unlockMapInteraction(2000); });

  guard.addEventListener('touchstart', (e) => { if (e.touches && e.touches.length >= 2) unlockMapInteraction(2500); }, { passive: true });
  guard.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length >= 2) unlockMapInteraction(2500); }, { passive: true });

  frame.addEventListener('load', () => {
    guard.classList.remove('unlocked');
    frame.classList.remove('interactive');
  });
}

/* -------------------- HVAC state + UI -------------------- */
function readSelectedTemp() {
  const v = Number(localStorage.getItem(LS_HVAC_TEMP) || '20');
  return Number.isFinite(v) ? v : 20;
}
function writeSelectedTemp(t) { localStorage.setItem(LS_HVAC_TEMP, String(t)); }

function readLocalUntil() {
  const v = Number(localStorage.getItem(LS_HVAC_UNTIL) || '0');
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function writeLocalUntil(tsMs) {
  if (!tsMs) localStorage.removeItem(LS_HVAC_UNTIL);
  else localStorage.setItem(LS_HVAC_UNTIL, String(tsMs));
}

function formatMMSS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss} Min.`;
}

function setTempButtonsUi(active, lockedTemp) {
  const selTemp = Number(lockedTemp ?? selectedTemp);

  document.querySelectorAll('.seg-btn').forEach(b => {
    const t = Number(b.dataset.temp);
    const isSel = (t === selTemp);

    b.disabled = !!active;
    b.classList.toggle('is-active', isSel);
    b.classList.toggle('is-hvac-red', !!active && isSel);
  });
}

async function getSharedHvacState() {
  const now = Date.now();

  const localUntil = readLocalUntil();
  if (localUntil && localUntil > now) return { hvacUntilMs: localUntil, hvacTemp: readSelectedTemp() };

  try {
    const st = await api('/api/hvac/state');
    const until = Number(st?.hvacUntilMs || 0);
    const temp  = Number(st?.hvacTemp || 0) || readSelectedTemp();

    if (Number.isFinite(until) && until > now) {
      writeLocalUntil(until);
      writeSelectedTemp(temp);
      return { hvacUntilMs: until, hvacTemp: temp };
    }

    writeLocalUntil(0);
    return { hvacUntilMs: 0, hvacTemp: readSelectedTemp() };
  } catch {
    return { hvacUntilMs: localUntil || 0, hvacTemp: readSelectedTemp() };
  }
}

function applyHvacUi(st) {
  const toggleBtn = $('hvacToggleBtn');
  const statusText = $('hvacStatusText');
  const countdown = $('hvacCountdown');

  const until = Number(st?.hvacUntilMs || 0);
  const active = until > Date.now();
  const lockedTemp = active ? Number(st?.hvacTemp || selectedTemp) : null;

  setTempButtonsUi(active, lockedTemp);

  if (toggleBtn) {
    toggleBtn.classList.toggle('is-on', active);
    toggleBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  if (statusText) statusText.textContent = active ? 'Anlage läuft' : 'nicht in Betrieb';

  if (countdown) {
    if (active) {
      const remain = until - Date.now();
      countdown.textContent = ` (${formatMMSS(remain)})`;
    } else {
      countdown.textContent = '';
    }
  }
}

async function startHvac() {
  const optimisticUntil = Date.now() + HVAC_DURATION_MS;
  writeLocalUntil(optimisticUntil);
  writeSelectedTemp(selectedTemp);

  try {
    await api('/api/hvac/start', { method: 'POST', body: JSON.stringify({ temperature: selectedTemp }) });
    const hv = await getSharedHvacState();
    applyHvacUi(hv);
    setStatus('Klimaanlage aktiv (15 min).');
  } catch (e) {
    writeLocalUntil(0);
    setStatus(`Fehler: ${e.message}`);
    const hv = await getSharedHvacState();
    applyHvacUi(hv);
  }
}

function initHvacControls() {
  if (!localStorage.getItem(LS_HVAC_TEMP)) writeSelectedTemp(20);
  selectedTemp = readSelectedTemp();
  setTempButtonsUi(false, selectedTemp);

  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const st = await getSharedHvacState();
      const active = Number(st.hvacUntilMs || 0) > Date.now();
      if (active) return;

      selectedTemp = Number(btn.dataset.temp);
      writeSelectedTemp(selectedTemp);
      setTempButtonsUi(false, selectedTemp);
    });
  });

  const toggleBtn = $('hvacToggleBtn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', async () => {
      const st = await getSharedHvacState();
      const active = Number(st.hvacUntilMs || 0) > Date.now();
      if (active) {
        const remain = Number(st.hvacUntilMs) - Date.now();
        setStatus(`Klimaanlage läuft noch ${formatMMSS(remain)}`);
        return;
      }
      await startHvac();
    });
  }
}

/* -------------------- Refresh throttling -------------------- */
function readLastManualRefresh() {
  const v = Number(localStorage.getItem(LS_LAST_MANUAL_REFRESH) || '0');
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function writeLastManualRefresh(tsMs) { localStorage.setItem(LS_LAST_MANUAL_REFRESH, String(tsMs)); }

function round1(n){ return Math.round(n * 10) / 10; }

// prefer backend boolean if present
function isChargingFromBattery(batteryObj) {
  if (!batteryObj || batteryObj.error) return false;
  if (typeof batteryObj.isCharging === 'boolean') return batteryObj.isCharging;

  const stRaw = batteryObj.chargingStatus;
  const stNum = (typeof stRaw === 'number') ? stRaw : Number(stRaw);
  const stStr = String(stRaw ?? '').toLowerCase();

  const powerRaw = batteryObj.chargingInstantaneousPower;
  const pNum = (typeof powerRaw === 'number') ? powerRaw : Number(powerRaw);
  const powerPositive = Number.isFinite(pNum) && pNum > 0;

  if (powerPositive) return true;
  if (Number.isFinite(stNum)) return stNum === 1;
  return stStr.includes('charging') || stStr.includes('progress') || stStr.includes('in_progress');
}

function isPluggedFromBattery(batteryObj) {
  if (!batteryObj || batteryObj.error) return false;
  if (typeof batteryObj.isPlugged === 'boolean') return batteryObj.isPlugged;

  const psRaw = batteryObj.plugStatus;
  const psNum = (typeof psRaw === 'number') ? psRaw : Number(psRaw);
  const psStr = String(psRaw ?? '').toLowerCase();

  if (Number.isFinite(psNum)) return psNum === 1;
  return psStr.includes('plug') || psStr.includes('connect') || psStr === 'true';
}

async function refresh(isManual = false) {
  if (isManual) {
    const last = readLastManualRefresh();
    const now = Date.now();
    const diff = now - last;
    if (diff < MANUAL_REFRESH_COOLDOWN_MS) {
      const left = MANUAL_REFRESH_COOLDOWN_MS - diff;
      setStatus(`Manuell nur 1×/5 Min. – noch ${formatMMSS(left)}`);
      return;
    }
    writeLastManualRefresh(now);
  }

  setStatus('Hole Daten…');

  try {
    const s = await api('/api/summary');

    const vin = getAny(s, ['vehicle.vin', 'vin', 'car.vin', 'userVehicle.vin']) || '—';
    setText('brandSub', `VIN: ${vin}`);

    setCarImageRemote();

    const batteryObj = getAny(s, ['battery', 'batteryData', 'ev.battery', 'evBattery']) || {};
    if (batteryObj?.error) {
      setText('soc', '—');
      setText('range', '—');
      setWidth('socBar', '0%');
      setText('chargeSub', String(batteryObj.error));
      setText('powerSub', '—');

      const titleEl = $('batteryTitle');
      if (titleEl) titleEl.textContent = 'Batterie';
      const socFill = $('socBar');
      if (socFill) socFill.classList.remove('is-charging');
    } else {
      const pct = Number(getAny(batteryObj, ['batteryLevel', 'soc', 'stateOfCharge', 'data.attributes.batteryLevel']));
      const rangeKm = Number(getAny(batteryObj, ['batteryAutonomyKm', 'rangeKm', 'range', 'data.attributes.batteryAutonomy']));
      const remainMin = Number(getAny(batteryObj, ['chargingRemainingTimeMin', 'remainingTimeMin', 'timeToFullMin', 'data.attributes.chargingRemainingTime']));

      const power = getAny(batteryObj, ['chargingInstantaneousPower', 'power', 'data.attributes.chargingInstantaneousPower']);
      const energyKwh = Number.isFinite(pct) ? round1(FULL_BATTERY_KWH * (pct / 100)) : null;

      setText('soc', Number.isFinite(pct) ? String(pct) : '—');
      setText('range', Number.isFinite(rangeKm) ? String(rangeKm) : '—');
      setWidth('socBar', `${clampPct(pct)}%`);

      const chargingNow = isChargingFromBattery(batteryObj);
      const pluggedNow = isPluggedFromBattery(batteryObj);

      // ✅ exactly as requested:
      // - not plugged or not charging -> "Restzeit: wird nicht geladen"
      // - plugged but not charging -> "Restzeit: Ladekabel verbunden"
      // - plugged + charging -> "Restzeit: <time>"
      if (pluggedNow && chargingNow) {
        setText('chargeSub', `Restzeit: ${minutesLabel(remainMin)}`);
      } else if (pluggedNow && !chargingNow) {
        setText('chargeSub', 'Restzeit: Ladekabel verbunden');
      } else {
        setText('chargeSub', 'Restzeit: wird nicht geladen');
      }

      if (power !== undefined && power !== null && String(power).trim() !== '') {
        setText('powerSub', `Leistung: ${String(power)}`);
      } else if (energyKwh !== null) {
        setText('powerSub', `Energie: ${energyKwh} / ${FULL_BATTERY_KWH} kWh`);
      } else {
        setText('powerSub', '—');
      }

      const titleEl = $('batteryTitle');
      if (titleEl) titleEl.textContent = (pluggedNow && chargingNow) ? 'Batterie wird geladen' : 'Batterie';

      const socBarEl = document.getElementById('socBar');
      if (socBarEl) socBarEl.classList.toggle('is-charging', (pluggedNow && chargingNow));
    }

    const cockpitObj = getAny(s, ['cockpit', 'cockpitData', 'vehicleData', 'odo']) || {};
    if (cockpitObj?.error) {
      setText('odo', '—');
      setText('odoSub', String(cockpitObj.error));
    } else {
      const odo = Number(getAny(cockpitObj, ['totalMileageKm', 'odometer', 'mileageKm', 'data.attributes.totalMileage']));
      setText('odo', Number.isFinite(odo) ? String(odo) : '—');

      const tsRaw = getAny(cockpitObj, ['timestamp', 'lastUpdate', 'data.attributes.timestamp']) || getAny(s, ['cockpitTimestamp']);
      if (tsRaw) {
        const d = new Date(tsRaw);
        const ok = !Number.isNaN(d.getTime());
        const date = ok ? d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' }) : String(tsRaw);
        const time = ok ? d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }) : '';
        setText('odoSub', ok ? `${date} ${time}` : date);
      } else {
        setText('odoSub', '—');
      }
    }

    const locObj = getAny(s, ['location', 'gps', 'position', 'vehicleLocation', 'locationData']) || {};
    if (locObj?.error) {
      setMap(NaN, NaN);
    } else {
      const rawLat = getAny(locObj, ['latitude','lat','gpsLatitude','gps_lat','gps_latitude','data.attributes.gpsLatitude']);
      const rawLng = getAny(locObj, ['longitude','lng','lon','gpsLongitude','gps_lng','gps_longitude','data.attributes.gpsLongitude']);
      const lat = parseCoord(rawLat);
      const lng = parseCoord(rawLng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) setMap(lat, lng);
      else setMap(NaN, NaN);
    }

    const hv = await getSharedHvacState();
    applyHvacUi(hv);

    setStatus('Aktuell.');
  } catch (e) {
    setStatus(`Fehler: ${e.message}`);
  }
}

/* -------------------- Boot -------------------- */
function initRefreshControls() {
  const btn = $('btnRefresh');
  if (!btn) return;
  btn.addEventListener('click', () => refresh(true));
}

async function tickEverySecond() {
  const hv = await getSharedHvacState();
  applyHvacUi(hv);

  const until = readLocalUntil();
  if (until && until <= Date.now()) writeLocalUntil(0);
}

initMapGuard();
initHvacControls();
initRefreshControls();

if (!token) setStatus('Hinweis: APP_TOKEN fehlt (LocalStorage).');

setCarImageRemote();

refresh(false);
setInterval(() => refresh(false), REFRESH_INTERVAL_MS);
setInterval(() => { tickEverySecond().catch(() => {}); }, 1000);
