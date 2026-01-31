import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("tiny"));
app.use(express.json());

fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
const db = new Database(path.join(__dirname, "data", "netzno.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                 -- YYYY-MM-DD
    kind TEXT NOT NULL,                 -- 'strom' | 'gas'
    reading_int INTEGER NOT NULL,       -- scaled integer (strom *100, gas *1000)
    annual INTEGER NOT NULL DEFAULT 0,  -- 0/1
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_entries_kind_date ON entries(kind, date, id);
`);

function ensureAnnualColumn() {
  const cols = db.prepare(`PRAGMA table_info(entries)`).all();
  const hasAnnual = cols.some((c) => String(c.name).toLowerCase() === "annual");
  if (!hasAnnual) {
    db.exec(`ALTER TABLE entries ADD COLUMN annual INTEGER NOT NULL DEFAULT 0;`);
  }
}
ensureAnnualColumn();

function kindToScale(kind) {
  return kind === "gas" ? 1000 : 100;
}

function normalizeReading(kind, s) {
  const scale = kindToScale(kind);
  const wholeLen = kind === "gas" ? 5 : 6;
  const fracLen = kind === "gas" ? 3 : 2;

  let raw = String(s ?? "").trim();
  raw = raw.replace(/\s+/g, "");
  raw = raw.replace(".", ",");
  raw = raw.replace(/[^0-9,]/g, "");

  const parts = raw.split(",");
  const wholeDigits = (parts[0] ?? "").replace(/\D/g, "");
  const fracDigits = (parts[1] ?? "").replace(/\D/g, "");

  const wholePadded = wholeDigits.padStart(wholeLen, "0").slice(-wholeLen);
  const fracPadded = fracDigits.padEnd(fracLen, "0").slice(0, fracLen);

  const wholeNum = Number(wholePadded);
  const fracNum = Number(fracPadded);
  if (!Number.isFinite(wholeNum) || !Number.isFinite(fracNum)) return null;

  const readingInt = wholeNum * scale + fracNum;
  const formatted = `${wholePadded},${fracPadded}`;
  return { readingInt, formatted };
}

function formatReading(kind, readingInt) {
  const scale = kindToScale(kind);
  const wholeLen = kind === "gas" ? 5 : 6;
  const fracLen = kind === "gas" ? 3 : 2;

  const n = Number(readingInt);
  if (!Number.isFinite(n)) return "";
  const whole = Math.floor(n / scale);
  const frac = n % scale;

  const wholeStr = String(whole).padStart(wholeLen, "0");
  const fracStr = String(frac).padStart(fracLen, "0");
  return `${wholeStr},${fracStr}`;
}

function formatConsumption(kind, consumptionInt) {
  if (consumptionInt === null || consumptionInt === undefined) return "";
  const scale = kindToScale(kind);
  const v = Number(consumptionInt) / scale;
  const decimals = kind === "gas" ? 3 : 2;
  return v.toFixed(decimals).replace(".", ",");
}

function computeConsumptionRows(kind, rowsAsc) {
  let prev = null;
  return rowsAsc.map((r) => {
    const cons = prev === null ? null : (r.reading_int - prev);
    prev = r.reading_int;
    return {
      id: r.id,
      date: r.date,
      kind: r.kind,
      annual: Number(r.annual) ? 1 : 0,
      reading_int: r.reading_int,
      reading: formatReading(kind, r.reading_int),
      consumption_int: cons,
      consumption: formatConsumption(kind, cons),
    };
  });
}

function parseAnnual(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  if (v === 1 || v === "1") return 1;
  if (v === 0 || v === "0") return 0;
  const s = String(v ?? "").toLowerCase().trim();
  if (s === "ja" || s === "yes" || s === "true" || s === "on") return 1;
  return 0;
}

// Static
app.use("/", express.static(path.join(__dirname, "public")));

// Summary: consumption since last annual reading (per kind) + date of last annual reading
app.get("/api/summary", (req, res) => {
  const kinds = ["strom", "gas"];
  const out = {};

  for (const k of kinds) {
    const rowsAsc = db.prepare(`
      SELECT id, date, kind, reading_int, annual
      FROM entries
      WHERE kind=?
      ORDER BY date ASC, id ASC
    `).all(k);

    const unit = (k === "gas" ? "m³" : "kWh");

    if (!rowsAsc.length) {
      out[k] = { ok: true, value: "", unit, since_date: "" };
      continue;
    }

    let lastAnnualReading = null;
    let lastAnnualDate = "";
    for (const r of rowsAsc) {
      if (Number(r.annual) === 1) {
        lastAnnualReading = Number(r.reading_int);
        lastAnnualDate = r.date || "";
      }
    }

    const latest = Number(rowsAsc[rowsAsc.length - 1].reading_int);
    if (lastAnnualReading === null) {
      out[k] = { ok: true, value: "", unit, since_date: "" };
      continue;
    }

    const diff = latest - lastAnnualReading;
    out[k] = {
      ok: true,
      value: formatConsumption(k, diff),
      unit,
      since_date: lastAnnualDate,
    };
  }

  res.json(out);
});

// Create
app.post("/api/entries", (req, res) => {
  const { date, kind, reading, annual } = req.body || {};
  const k = String(kind || "").toLowerCase();
  if (!date || (k !== "strom" && k !== "gas") || reading === undefined) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const norm = normalizeReading(k, reading);
  if (!norm) return res.status(400).json({ error: "Invalid reading" });

  const annualVal = parseAnnual(annual);

  const stmt = db.prepare(`
    INSERT INTO entries(date, kind, reading_int, annual, created_at)
    VALUES(?,?,?,?,datetime('now'))
  `);
  const info = stmt.run(date, k, norm.readingInt, annualVal);
  res.json({ ok: true, id: info.lastInsertRowid });
});

// List
app.get("/api/entries", (req, res) => {
  const kind = String(req.query.kind || "strom").toLowerCase();
  const k = (kind === "gas") ? "gas" : "strom";

  const limitReq = Number(req.query.limit || 10);
  const allowed = [10, 25, 50, 100, 250];
  const limit = allowed.includes(limitReq) ? limitReq : 10;

  const total = db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE kind=?`).get(k).c;

  const rowsAsc = db.prepare(`
    SELECT id, date, kind, reading_int, annual
    FROM entries
    WHERE kind=?
    ORDER BY date ASC, id ASC
  `).all(k);

  const computedAsc = computeConsumptionRows(k, rowsAsc);
  const slicedNewest = computedAsc.slice(-limit).reverse();
  res.json({ kind: k, total, limit, rows: slicedNewest });
});

// Update
app.put("/api/entries/:id", (req, res) => {
  const id = Number(req.params.id);
  const { date, kind, reading, annual } = req.body || {};
  const k = String(kind || "").toLowerCase();
  if (!id || !date || (k !== "strom" && k !== "gas") || reading === undefined) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const norm = normalizeReading(k, reading);
  if (!norm) return res.status(400).json({ error: "Invalid reading" });

  const annualVal = parseAnnual(annual);

  const info = db.prepare(`
    UPDATE entries
    SET date=?, kind=?, reading_int=?, annual=?
    WHERE id=?
  `).run(date, k, norm.readingInt, annualVal, id);

  res.json({ ok: true, changed: info.changes });
});

// Delete
app.delete("/api/entries/:id", (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`DELETE FROM entries WHERE id=?`).run(id);
  res.json({ ok: true });
});

// XLS Export (two sheets: Strom + Gas, with Jahresablesung column)
app.get("/api/export.xlsx", async (req, res) => {
  try {
    const all = db.prepare(`
      SELECT id, date, kind, reading_int, annual
      FROM entries
      ORDER BY kind ASC, date ASC, id ASC
    `).all();

    const stromAsc = all.filter(r => r.kind === "strom");
    const gasAsc = all.filter(r => r.kind === "gas");

    const stromRows = computeConsumptionRows("strom", stromAsc).map(r => ({
      Datum: r.date,
      Zaehlerstand: r.reading,
      Verbrauch: r.consumption,
      Jahresablesung: r.annual ? "Ja" : ""
    }));

    const gasRows = computeConsumptionRows("gas", gasAsc).map(r => ({
      Datum: r.date,
      Zaehlerstand: r.reading,
      Verbrauch: r.consumption,
      Jahresablesung: r.annual ? "Ja" : ""
    }));

    const wb = new ExcelJS.Workbook();

    const addSheet = (name, rows) => {
      const ws = wb.addWorksheet(name);
      ws.columns = [
        { header: "Datum", key: "Datum", width: 12 },
        { header: "Zählerstand", key: "Zaehlerstand", width: 14 },
        { header: "Verbrauch", key: "Verbrauch", width: 12 },
        { header: "Jahresablesung", key: "Jahresablesung", width: 14 },
      ];
      for (const r of rows) ws.addRow(r);
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: "frozen", ySplit: 1 }];
    };

    addSheet("Strom", stromRows);
    addSheet("Gas", gasRows);

    const arrayBuffer = await wb.xlsx.writeBuffer();
    const buf = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="netzno_zaehler_export.xlsx"');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Export failed" });
  }
});

const PORT = process.env.PORT || 1234;
const HOST = process.env.HOST || "0.0.0.0";

app.listen(PORT, HOST, () => console.log(`NetzNÖ Zählerstände running on http://${HOST}:${PORT}`));

