/* Minimal, dependency-free cron for schedule triggers.

   Supports the standard 5 fields — minute hour day-of-month month day-of-week —
   each of which may be: a star (all), a star-slash-n step, "a" (value),
   "a-b" (range), "a,b,c" (list), and combinations like "0,30" or "9-17". The
   step form uses a star, a slash, then n. Day-of-week is 0–6
   with 0 = Sunday (7 also accepted as Sunday). Times are evaluated in UTC — the
   UI labels schedules as UTC so there's no hidden timezone surprise.

   nextFireAfter() walks forward minute-by-minute from the given instant to the
   next matching minute. That's a few hundred thousand cheap integer checks in
   the worst case, run once per fire (not per scheduler tick), so simplicity wins
   over clever date math; an impossible expression (e.g. Feb 31) returns null
   rather than looping forever. */

const RANGES = { minute: [0, 59], hour: [0, 23], dom: [1, 31], month: [1, 12], dow: [0, 6] };
const ORDER = ["minute", "hour", "dom", "month", "dow"];

function parseField(spec, field) {
  const [lo, hi] = RANGES[field];
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const token = part.trim();
    if (token === "") throw new Error(`empty term in ${field}`);
    let m;
    if (token === "*") { for (let v = lo; v <= hi; v++) out.add(v); continue; }
    if ((m = token.match(/^\*\/(\d+)$/))) {
      const step = Number(m[1]); if (!step) throw new Error(`bad step in ${field}`);
      for (let v = lo; v <= hi; v += step) out.add(v); continue;
    }
    if ((m = token.match(/^(\d+)-(\d+)(?:\/(\d+))?$/))) {
      let a = Number(m[1]), b = Number(m[2]); const step = m[3] ? Number(m[3]) : 1;
      if (a > b) throw new Error(`reversed range in ${field}`);
      for (let v = a; v <= b; v += step) out.add(v); continue;
    }
    if ((m = token.match(/^\d+$/))) { out.add(Number(token)); continue; }
    throw new Error(`unrecognized term "${token}" in ${field}`);
  }
  // normalize day-of-week 7 → 0 (Sunday)
  if (field === "dow" && out.has(7)) { out.delete(7); out.add(0); }
  for (const v of out) if (v < lo || v > hi) throw new Error(`${field} value ${v} out of range ${lo}-${hi}`);
  if (!out.size) throw new Error(`no values for ${field}`);
  return out;
}

export function parseCron(expr) {
  const fields = String(expr || "").trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("a cron expression needs exactly 5 fields (minute hour day month weekday)");
  const parsed = {};
  ORDER.forEach((f, i) => { parsed[f] = parseField(fields[i], f); });
  return parsed;
}

export function isValidCron(expr) {
  try { parseCron(expr); return true; } catch { return false; }
}

export function cronMatches(expr, date) {
  const p = typeof expr === "string" ? parseCron(expr) : expr;
  const d = date instanceof Date ? date : new Date(date);
  // both day-of-month and day-of-week restricted → cron's OR semantics
  const domRestricted = !(p.dom.size === 31), dowRestricted = !(p.dow.size === 7);
  const dayOk = (domRestricted && dowRestricted)
    ? (p.dom.has(d.getUTCDate()) || p.dow.has(d.getUTCDay()))
    : (p.dom.has(d.getUTCDate()) && p.dow.has(d.getUTCDay()));
  return p.minute.has(d.getUTCMinutes()) && p.hour.has(d.getUTCHours()) && p.month.has(d.getUTCMonth() + 1) && dayOk;
}

// The next instant strictly after `fromMs` that matches, or null if none within
// the search horizon (~2 years → an impossible expression).
export function nextFireAfter(expr, fromMs = Date.now()) {
  const p = parseCron(expr);
  let t = new Date(Math.floor(fromMs / 60000) * 60000 + 60000);   // next whole minute
  const limit = fromMs + 2 * 366 * 24 * 60 * 60_000;
  while (t.getTime() <= limit) {
    if (cronMatches(p, t)) return t.getTime();
    t = new Date(t.getTime() + 60000);
  }
  return null;
}

// Common presets for the UI (value → human label). UTC.
export const CRON_PRESETS = [
  { cron: "*/5 * * * *", label: "Every 5 minutes" },
  { cron: "*/15 * * * *", label: "Every 15 minutes" },
  { cron: "0 * * * *", label: "Hourly (on the hour)" },
  { cron: "0 */6 * * *", label: "Every 6 hours" },
  { cron: "0 9 * * *", label: "Daily at 09:00 UTC" },
  { cron: "0 9 * * 1-5", label: "Weekdays at 09:00 UTC" },
  { cron: "0 0 * * 0", label: "Weekly (Sun 00:00 UTC)" },
  { cron: "0 0 1 * *", label: "Monthly (1st 00:00 UTC)" },
];
