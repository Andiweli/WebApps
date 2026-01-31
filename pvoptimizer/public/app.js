function $(id) { return document.getElementById(id); }

const FIX_PLZ = "2230";
const FIX_COORDS = "48.333333, 16.716667";

let coordsManuallyEdited = false;
let programmaticCoordsSet = false;

function setCoordsProgrammatically(value) {
  programmaticCoordsSet = true;
  $("coords").value = value;
  setTimeout(() => { programmaticCoordsSet = false; }, 0);
}

$("coords").addEventListener("input", () => {
  if (programmaticCoordsSet) return;
  coordsManuallyEdited = true;
});

function getPlzDigits() {
  const raw = String($("plz").value ?? "").trim();
  return raw.replace(/\D/g, "");
}

function setupPeakpowerSelector() {
  const sel = $("peakpower");
  if (!sel) return;

  sel.innerHTML = "";
  for (let i = 1; i <= 100; i++) {
    const v = (i / 10);
    const opt = document.createElement("option");
    opt.value = v.toFixed(1);
    opt.textContent = `${v.toFixed(1)} kWp`;
    sel.appendChild(opt);
  }
  sel.value = "0.8";
}

function getPeakpower() {
  const v = Number($("peakpower").value);
  if (!Number.isFinite(v) || v < 0.1 || v > 10.0) throw new Error("Modulleistung muss zwischen 0,1 und 10,0 kWp liegen.");
  return v;
}

function setupToggleGroup(groupName, hiddenInputId) {
  const wrap = document.querySelector(`.toggle[data-toggle="${groupName}"]`);
  const hidden = $(hiddenInputId);
  if (!wrap || !hidden) return;

  const buttons = Array.from(wrap.querySelectorAll(".tbtn"));

  function setValue(v) {
    hidden.value = String(v);
    buttons.forEach(b => b.classList.toggle("active", b.dataset.value === String(v)));
  }

  // init
  setValue(hidden.value);

  buttons.forEach(b => {
    b.addEventListener("click", () => setValue(b.dataset.value));
  });
}

function getSeason() {
  return String($("seasonValue")?.value || "summer");
}

function getStepDeg() {
  const v = Number($("stepValue")?.value || 1);
  return Number.isFinite(v) ? v : 1;
}

function seasonLabel(v) {
  switch (v) {
    case "summer": return "Sommerhalbjahr (April–September)";
    case "winter": return "Winterhalbjahr (Oktober–März)";
    case "year": return "Ganzjährig";
    default: return v;
  }
}

function parseCoords(s) {
  const t = String(s || "").trim();
  const m = t.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) throw new Error("Koordinatenformat: 'lat, lon' (z.B. 48.26, 16.63)");
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Koordinaten sind ungültig.");
  return { lat, lon };
}

function fmt(x, d = 2) {
  const p = Math.pow(10, d);
  return (Math.round(x * p) / p).toFixed(d);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function geocode(q) {
  const url = "/api/geocode?q=" + encodeURIComponent(q);
  const res = await fetch(url);
  const js = await res.json();
  if (!res.ok) throw new Error(js?.error || "Geocoding fehlgeschlagen.");
  return js;
}

async function optimize(payload) {
  const res = await fetch("/api/optimize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const js = await res.json();
  if (!res.ok) throw new Error(js?.error || "Berechnung fehlgeschlagen.");
  return js;
}

function tryApplyPlz2282Auto() {
  const plz = getPlzDigits();
  if (plz !== FIX_PLZ) return;

  const coordsNow = $("coords").value.trim();
  if (!coordsManuallyEdited || coordsNow === "") {
    setCoordsProgrammatically(FIX_COORDS);
  }
}

$("plz").addEventListener("input", () => {
  tryApplyPlz2282Auto();
});

$("btnGeocode").addEventListener("click", async () => {
  const out = $("out");
  const q = getPlzDigits();
  if (!q) { out.textContent = "Bitte PLZ eingeben."; return; }

  if (q === FIX_PLZ) {
    if (coordsManuallyEdited && $("coords").value.trim() !== "") {
      out.innerHTML = `<div class="error">Hinweis:</div><div>PLZ ${escapeHtml(FIX_PLZ)} erkannt – Koordinaten wurden nicht überschrieben (weil du sie manuell geändert hast).</div>`;
      return;
    }
    setCoordsProgrammatically(FIX_COORDS);
    out.innerHTML = `<div>PLZ <b>${escapeHtml(FIX_PLZ)}</b> → Koordinaten gesetzt: <span class="v">${escapeHtml(FIX_COORDS)}</span></div>`;
    return;
  }

  try {
    out.textContent = "Suche Koordinaten …";
    const r = await geocode(q);

    if (coordsManuallyEdited && $("coords").value.trim() !== "") {
      out.innerHTML = `<div class="error">Hinweis:</div><div>Koordinaten wurden nicht überschrieben, weil du sie manuell geändert hast.</div>`;
      return;
    }

    setCoordsProgrammatically(`${Number(r.lat).toFixed(6)}, ${Number(r.lon).toFixed(6)}`);
    out.innerHTML = `<div>Gefunden:</div><div class="sub">${escapeHtml(r.display_name)}</div>`;
  } catch (e) {
    out.innerHTML = `<div class="error">Geocoding-Fehler:</div><div>${escapeHtml(e?.message || e)}</div>`;
  }
});

$("btnCalc").addEventListener("click", async () => {
  const out = $("out");

  try {
    const coordsStr = $("coords").value.trim();
    if (!coordsStr) throw new Error("Bitte Koordinaten eingeben (oder PLZ → Koordinaten verwenden).");
    const { lat, lon } = parseCoords(coordsStr);

    const azStr = String($("az").value ?? "").trim();
    if (!azStr) throw new Error("Bitte Azimut (0–360°) eingeben.");
    const azimuth = Number(azStr);
    if (!Number.isFinite(azimuth) || azimuth < 0 || azimuth > 360) throw new Error("Azimut muss zwischen 0 und 360 liegen.");

    const peakpower = getPeakpower();
    const season = getSeason();
    const stepDeg = getStepDeg();

    out.textContent = "Rechne … (PVGIS wird für viele Neigungen abgefragt)";

    const res = await optimize({ lat, lon, azimuth, season, stepDeg, peakpower });

    const best = res.best;
    const inp = res.inputs;

    const monthNames = {
      1: "Jan", 2: "Feb", 3: "Mär", 4: "Apr", 5: "Mai", 6: "Jun",
      7: "Jul", 8: "Aug", 9: "Sep", 10: "Okt", 11: "Nov", 12: "Dez"
    };

    const monthlyRows = best.monthly
      .map(m => `<tr><td>${monthNames[m.month] || m.month}</td><td>${fmt(m.E_m, 2)}</td></tr>`)
      .join("");

    out.innerHTML = `
      <div class="headline">
        <div>
          <div class="tilt">Optimal: ${fmt(best.tilt_deg, 1)}°</div>
          <div class="sub">${escapeHtml(seasonLabel(inp.season))}</div>
        </div>
        <div>
          <div class="tilt">Ertrag: ${fmt(best.total_kwh, 2)} kWh</div>
          <div class="sub">(bei ${fmt(inp.peakpower, 1)} kWp angenommener Leistung)</div>
        </div>
      </div>

      <div class="kv">
        <div class="k">Koordinaten</div><div class="v">${fmt(inp.lat, 6)}, ${fmt(inp.lon, 6)}</div>
        <div class="k">Azimut (du)</div><div class="v">${fmt(inp.azimuth_user_deg, 1)}°</div>
        <div class="k">PVGIS aspect</div><div class="v">${fmt(inp.aspect_pvgis_deg, 1)}°</div>
        <div class="k">Modulleistung</div><div class="v">${fmt(inp.peakpower, 1)} kWp</div>
        <div class="k">Schritt</div><div class="v">${fmt(inp.stepDeg, 2)}°</div>
        <div class="k">Loss</div><div class="v">${fmt(inp.loss, 0)}%</div>
      </div>

      <details>
        <summary>Errechnete monatliche PV-Erzeugung</summary>
        <table>
          <thead><tr><th>Monat</th><th>kWh</th></tr></thead>
          <tbody>${monthlyRows}</tbody>
        </table>
      </details>
    `;

    setTimeout(() => {
      out.scrollIntoView({ behavior: "smooth", block: "start" });
      out.focus({ preventScroll: true });
    }, 50);

  } catch (e) {
    out.innerHTML = `<div class="error">Fehler:</div><div>${escapeHtml(e?.message || e)}</div>`;
    setTimeout(() => {
      out.scrollIntoView({ behavior: "smooth", block: "start" });
      out.focus({ preventScroll: true });
    }, 50);
  }
});

/* reload button */
$("btnReload")?.addEventListener("click", () => {
  location.reload();
});

setupPeakpowerSelector();
setupToggleGroup("season", "seasonValue");
setupToggleGroup("step", "stepValue");
tryApplyPlz2282Auto();
