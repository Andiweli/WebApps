/* PVGIS Tilt Optimizer - Backend (Node/Express)
 *
 * - PVGIS API blocks browser AJAX/CORS, so we call it server-side.
 * - Uses PVGIS PVcalc (monthly PV output) and brute-force tilt scan.
 * - Default: peakpower=1kWp, loss=14%, pvtechchoice=crystSi, mountingplace=free, usehorizon=1
 *
 * PVGIS API docs (inputs: angle/aspect etc.):
 * https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/getting-started-pvgis/api-non-interactive-service_en
 */

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PVGIS_BASE = "https://re.jrc.ec.europa.eu/api/v5_3/PVcalc";

// small in-memory cache: key -> monthly array [{month,E_m}]
const cache = new Map();

// friendly concurrency limiter (PVGIS can return 529 when overloaded; retry recommended)
function createLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= maxConcurrent) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    job()
      .catch(() => {})
      .finally(() => {
        active--;
        runNext();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push(async () => {
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      });
      runNext();
    });
}
const limit = createLimiter(4);

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function wrapTo180(deg) {
  // maps any degrees to (-180, 180]
  let x = ((deg + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

function validateLatLon(lat, lon) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error("Latitude muss zwischen -90 und 90 liegen.");
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error("Longitude muss zwischen -180 und 180 liegen.");
  }
}

function seasonMonths(season) {
  switch (season) {
    case "spring": // Mär–Mai
      return [3, 4, 5];
    case "summer": // Apr–Sep
      return [4, 5, 6, 7, 8, 9];
    case "autumn": // Sep–Nov
      return [9, 10, 11];
    case "winter": // Okt–Mär
      return [10, 11, 12, 1, 2, 3];
    case "year": // Jan–Dez
      return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    default:
      throw new Error("Ungültige Saison. Erlaubt: spring, summer, autumn, winter, year");
  }
}

function buildPVGISUrl({
  lat,
  lon,
  angle,
  aspect,
  peakpower,
  loss,
  pvtechchoice,
  mountingplace,
  usehorizon,
  raddatabase
}) {
  const p = new URLSearchParams();
  p.set("lat", String(lat));
  p.set("lon", String(lon));
  p.set("peakpower", String(peakpower));
  p.set("loss", String(loss));
  p.set("angle", String(angle));
  p.set("aspect", String(aspect));
  p.set("pvtechchoice", pvtechchoice);
  p.set("mountingplace", mountingplace);
  p.set("usehorizon", String(usehorizon));
  if (raddatabase) p.set("raddatabase", raddatabase);
  p.set("outputformat", "json");
  return `${PVGIS_BASE}?${p.toString()}`;
}

async function fetchJsonWithRetry(url, { tries = 6 } = {}) {
  let lastErr = null;

  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" }
      });

      if (res.status === 429 || res.status === 529) {
        const backoffMs = 250 * Math.pow(2, i);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`PVGIS HTTP ${res.status}: ${text.slice(0, 250)}`);
      }

      return await res.json();
    } catch (e) {
      lastErr = e;
      const backoffMs = 150 * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  throw lastErr || new Error("PVGIS request failed.");
}

function extractMonthlyFromPVcalc(json) {
  const candidates = [];
  const o = json && json.outputs ? json.outputs : null;

  if (o) {
    if (Array.isArray(o.monthly)) candidates.push(o.monthly);
    if (o.monthly && Array.isArray(o.monthly.fixed)) candidates.push(o.monthly.fixed);
    if (o.monthly && Array.isArray(o.monthly["fixed"])) candidates.push(o.monthly["fixed"]);
  }

  function scan(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      if (
        node.length === 12 &&
        node.every((x) => x && typeof x === "object" && "month" in x && "E_m" in x)
      ) {
        candidates.push(node);
      }
      for (const it of node) scan(it);
      return;
    }
    if (typeof node === "object") {
      for (const k of Object.keys(node)) scan(node[k]);
    }
  }
  scan(json);

  const best = candidates.find(
    (arr) =>
      arr.length === 12 &&
      arr.every((r) => Number.isFinite(Number(r.month)) && Number.isFinite(Number(r.E_m)))
  );

  if (!best) {
    throw new Error("Konnte PVGIS-Monatswerte (E_m) nicht aus der Antwort lesen.");
  }

  return best.map((r) => ({ month: Number(r.month), E_m: Number(r.E_m) }));
}

function sumSeason(monthly, monthsWanted) {
  const set = new Set(monthsWanted);
  return monthly.reduce((acc, r) => acc + (set.has(r.month) ? r.E_m : 0), 0);
}

async function pvcalcMonthlyCached(params) {
  const key = JSON.stringify(params);
  const hit = cache.get(key);
  if (hit) return hit;

  const url = buildPVGISUrl(params);
  const json = await fetchJsonWithRetry(url);
  const monthly = extractMonthlyFromPVcalc(json);

  cache.set(key, monthly);
  return monthly;
}

app.post("/api/optimize", async (req, res) => {
  try {
    const {
      lat,
      lon,
      azimuth, // user: 0..360, 0=N
      season, // spring/summer/autumn/winter/year
      stepDeg = 1,
      tiltMin = 0,
      tiltMax = 90,

      // optional PV params:
      peakpower = 1,
      loss = 14,
      pvtechchoice = "crystSi",
      mountingplace = "free",
      usehorizon = 1,
      raddatabase = null
    } = req.body || {};

    const latN = Number(lat);
    const lonN = Number(lon);
    const azN = Number(azimuth);
    const stepN = Number(stepDeg);

    validateLatLon(latN, lonN);
    if (!Number.isFinite(azN) || azN < 0 || azN > 360) throw new Error("Azimut muss zwischen 0 und 360 liegen.");
    if (!Number.isFinite(stepN) || stepN <= 0 || stepN > 10) throw new Error("stepDeg ungültig (0 < stepDeg <= 10).");

    const monthsWanted = seasonMonths(season);

    // PVGIS aspect: 0=south, 90=west, -90=east
    const aspect = wrapTo180(azN - 180);

    const tMin = clamp(Number(tiltMin), 0, 90);
    const tMax = clamp(Number(tiltMax), 0, 90);
    if (tMin > tMax) throw new Error("tiltMin darf nicht größer als tiltMax sein.");

    let best = null;
    const jobs = [];

    for (let tilt = tMin; tilt <= tMax + 1e-9; tilt += stepN) {
      const angle = Math.round(tilt * 1000) / 1000;

      jobs.push(
        limit(async () => {
          const monthly = await pvcalcMonthlyCached({
            lat: latN,
            lon: lonN,
            angle,
            aspect,
            peakpower,
            loss,
            pvtechchoice,
            mountingplace,
            usehorizon,
            raddatabase
          });

          const total = sumSeason(monthly, monthsWanted);

          if (!best || total > best.total_kwh) {
            best = { tilt: angle, total_kwh: total, monthly };
          }
        })
      );
    }

    await Promise.all(jobs);

    if (!best) throw new Error("Keine PVGIS-Ergebnisse erhalten.");

    res.json({
      inputs: {
        lat: latN,
        lon: lonN,
        azimuth_user_deg: azN,
        aspect_pvgis_deg: aspect,
        season,
        months: monthsWanted,
        stepDeg: stepN,
        peakpower,
        loss,
        pvtechchoice,
        mountingplace,
        usehorizon,
        raddatabase
      },
      best: {
        tilt_deg: best.tilt,
        total_kwh: best.total_kwh,
        monthly: best.monthly
      }
    });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// server-side geocoding (browser talks only to your Pi)
app.get("/api/geocode", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) throw new Error("Query fehlt (?q=...).");

    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q);
    const r = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "pvgis-tilt-optimizer/1.0 (raspberry-pi)"
      }
    });
    if (!r.ok) throw new Error(`Geocoding HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) throw new Error("Kein Treffer.");

    res.json({
      lat: Number(data[0].lat),
      lon: Number(data[0].lon),
      display_name: data[0].display_name
    });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// bind to LAN + port
const HOST = process.env.HOST || "0.0.0.0";
const PORT = process.env.PORT || 1234;

app.listen(PORT, HOST, () => {
  console.log(`PV Optimizer läuft auf http://${HOST}:${PORT}`);
});
