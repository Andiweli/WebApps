import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { RenaultService } from "./src/renaultService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// -------------------- Shared HVAC state persisted on disk --------------------
const STATE_FILE = path.join(__dirname, "hvac_state.json");

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const j = JSON.parse(raw);
    return {
      hvacUntilMs: Number(j?.hvacUntilMs || 0),
      hvacTemp: Number(j?.hvacTemp || 20),
    };
  } catch {
    return { hvacUntilMs: 0, hvacTemp: 20 };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
function getHvacState() {
  const s = loadState();
  const now = Date.now();
  if (s.hvacUntilMs && s.hvacUntilMs <= now) {
    const cleared = { hvacUntilMs: 0, hvacTemp: s.hvacTemp || 20 };
    saveState(cleared);
    return cleared;
  }
  return s;
}
function setHvacRunning(minutes, temp) {
  const hvacUntilMs = Date.now() + minutes * 60 * 1000;
  const st = { hvacUntilMs, hvacTemp: Number(temp) || 20 };
  saveState(st);
  return st;
}
function clearHvacRunning() {
  const st = loadState();
  const cleared = { hvacUntilMs: 0, hvacTemp: st.hvacTemp || 20 };
  saveState(cleared);
  return cleared;
}

// -------------------- Load credentials / config (ENV, JSON, .env) --------------------
function parseDotEnv(filePath) {
  try {
    const txt = fs.readFileSync(filePath, "utf8");
    const out = {};
    for (const line of txt.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      // strip quotes
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

function readJsonIfExists(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function firstDefined(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

function loadConfig() {
  // 1) ENV directly
  const env = process.env || {};

  // 2) JSON candidates in project root
  const jsonCandidates = [
    path.join(__dirname, "config.json"),
    path.join(__dirname, "renault.json"),
    path.join(__dirname, "settings.json"),
  ];

  let jsonCfg = null;
  for (const p of jsonCandidates) {
    jsonCfg = readJsonIfExists(p);
    if (jsonCfg) break;
  }

  // 3) .env candidate
  const dotEnvPath = path.join(__dirname, ".env");
  const dotEnv = parseDotEnv(dotEnvPath) || {};

  // Merge priority: ENV > JSON > .env
  const merged = { ...dotEnv, ...(jsonCfg || {}), ...env };

  const email = firstDefined(merged, [
    "MYRENAULT_EMAIL",
    "RENAULT_EMAIL",
    "EMAIL",
    "email",
    "username",
    "USER",
  ]);

  const password = firstDefined(merged, [
    "MYRENAULT_PASSWORD",
    "RENAULT_PASSWORD",
    "PASSWORD",
    "password",
    "pass",
  ]);

  // Optional extras if your RenaultService supports them
  const extras = {
    locale: firstDefined(merged, ["LOCALE", "locale"]),
    country: firstDefined(merged, ["COUNTRY", "country"]),
    region: firstDefined(merged, ["REGION", "region"]),
    vin: firstDefined(merged, ["VIN", "vin"]),
  };

  // Keep any other fields from JSON (if present) but do NOT dump env secrets into logs.
  const fromJsonOnly = (jsonCfg && typeof jsonCfg === "object") ? { ...jsonCfg } : {};
  // Ensure email/password override
  fromJsonOnly.email = email ?? fromJsonOnly.email;
  fromJsonOnly.password = password ?? fromJsonOnly.password;

  return { email, password, extras, raw: fromJsonOnly };
}

// -------------------- RenaultService instancing --------------------
let svc = null;

async function getService() {
  if (svc) return svc;

  const cfg = loadConfig();

  if (!cfg.email || !cfg.password) {
    const msg =
      "RenaultService Credentials fehlen. Lege entweder ENV Variablen an (MYRENAULT_EMAIL/MYRENAULT_PASSWORD) " +
      "oder erstelle config.json / renault.json / settings.json im Projektordner mit { \"email\": \"...\", \"password\": \"...\" } " +
      "oder eine .env mit MYRENAULT_EMAIL=... und MYRENAULT_PASSWORD=...";
    console.error("[FATAL]", msg);
    throw new Error(msg);
  }

  // The constructor likely expects an object: { email, password, ... }
  // We pass what we have, but keep it minimal and compatible.
  const ctorObj = {
    ...(cfg.raw || {}),
    email: cfg.email,
    password: cfg.password,
    ...cfg.extras,
  };

  try {
    svc = new RenaultService(ctorObj);
    return svc;
  } catch (e) {
    console.error("[FATAL] RenaultService konnte nicht instanziert werden:", e?.message || e);
    throw e;
  }
}

// -------------------- helpers: pick method on instance by candidates --------------------
function pickMethod(obj, candidates) {
  for (const name of candidates) {
    if (obj && typeof obj[name] === "function") return obj[name].bind(obj);
  }
  return null;
}
function listMethods(obj) {
  if (!obj) return [];
  const set = new Set();
  let cur = obj;
  while (cur && cur !== Object.prototype) {
    Object.getOwnPropertyNames(cur).forEach((k) => set.add(k));
    cur = Object.getPrototypeOf(cur);
  }
  return [...set].filter((k) => typeof obj[k] === "function").sort();
}

// -------------------- static frontend --------------------
app.use(express.static(path.join(__dirname, "public")));

// -------------------- API --------------------
app.get("/api/summary", async (req, res) => {
  try {
    const s = await getService();

    const fn = pickMethod(s, [
      "getSummary",
      "summary",
      "fetchSummary",
      "getAll",
      "getData",
      "getDashboard",
      "getVehicleData",
      "getStatus",
    ]);

    if (!fn) {
      return res.status(500).json({
        ok: false,
        error: "RenaultService: keine Summary-Methode gefunden.",
        availableMethods: listMethods(s),
      });
    }

    const data = await fn();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/api/hvac/state", (req, res) => {
  res.json({ ok: true, data: getHvacState() });
});

app.post("/api/hvac/start", async (req, res) => {
  try {
    const temperature = Number(req.body?.temperature ?? 20) || 20;
    const s = await getService();

    const fnStart = pickMethod(s, [
      "hvacStart",
      "startHvac",
      "startClimate",
      "startAirco",
      "startPreconditioning",
      "startPrecond",
      "startAC",
    ]);

    if (!fnStart) {
      return res.status(500).json({
        ok: false,
        error: "RenaultService: keine HVAC-Start-Methode gefunden.",
        availableMethods: listMethods(s),
      });
    }

    try {
      await fnStart(temperature);
    } catch {
      await fnStart({ temperature });
    }

    const st = setHvacRunning(15, temperature);
    res.json({ ok: true, data: st });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/api/hvac/stop", async (req, res) => {
  try {
    const s = await getService();

    const fnStop = pickMethod(s, [
      "hvacStop",
      "stopHvac",
      "stopClimate",
      "stopAirco",
      "stopPreconditioning",
      "stopPrecond",
      "stopAC",
    ]);

    if (!fnStop) {
      return res.status(500).json({
        ok: false,
        error: "RenaultService: keine HVAC-Stop-Methode gefunden.",
        availableMethods: listMethods(s),
      });
    }

    try {
      await fnStop();
    } catch {
      await fnStop({});
    }

    const st = clearHvacRunning();
    res.json({ ok: true, data: st });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

const PORT = process.env.PORT || 1234;
const HOST = process.env.HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`R5 WebApp running on http://${HOST}:${PORT}`);
});