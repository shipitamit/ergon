/* Ergon Studio proxy — zero dependencies, plain Node (>=18).

   Dev:        node server/proxy.mjs          (Vite forwards /api → here)
   Production: npm run build && npm start     (serves dist/ AND proxies /api)

   The browser posts to /api/claude; this process attaches your
   ANTHROPIC_API_KEY server-side so the key never reaches the client.
*/
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8787);
// read lazily so secrets loaded at startup (env or cloud) are picked up
const anthropicKey = () => process.env.ANTHROPIC_API_KEY;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const PROD = process.env.NODE_ENV === "production";

if (!anthropicKey()) console.warn("[proxy] WARNING: ANTHROPIC_API_KEY is not set — /api/claude will return 500.");

import { handleHealth } from "./health.mjs";
import { providerList, resolveProvider, modelsRequest, parseModelList, getProvider, OPENAI_DEFAULT_BASE } from "./providers.mjs";
import { getSetting, setSetting, clearSetting, statusFor } from "./settings.mjs";

// Optional collaboration tier: load auth/data routes only if the data deps
// (better-sqlite3, bcryptjs) are installed. Absent → pure model proxy.
let handleApiRoutes = null;
let _dbPing = null;
try {
  ({ handleApiRoutes } = await import("./routes.mjs"));
  const dbmod = await import("./db.index.mjs");
  _dbPing = dbmod.ping;
  console.log("[proxy] accounts & server-side sessions enabled.");
  // schedule-trigger scheduler: fire due schedule triggers (in-process; a single
  // instance owns it — in a multi-instance deploy, gate this to one worker).
  if (process.env.ERGON_SCHEDULER !== "off") {
    try {
      const { startScheduler } = await import("./triggers.mjs");
      startScheduler(dbmod, { intervalMs: Number(process.env.ERGON_SCHEDULER_MS || 30_000) });
      console.log("[proxy] schedule-trigger scheduler running.");
    } catch (e) { console.warn(`[proxy] scheduler not started: ${e.message}`); }
  }
  // alert evaluator: periodically check alert rules and emit events on transitions
  if (process.env.ERGON_ALERTS !== "off") {
    try {
      const { startAlertEvaluator } = await import("./alerts.mjs");
      startAlertEvaluator(dbmod, { intervalMs: Number(process.env.ERGON_ALERTS_MS || 60_000) });
      console.log("[proxy] alert evaluator running.");
    } catch (e) { console.warn(`[proxy] alert evaluator not started: ${e.message}`); }
  }
  // runner reconciler: liveness-check managed runners (promote healthy, flag crashed)
  if (process.env.ERGON_HOSTING_DRIVER && process.env.ERGON_RECONCILE !== "off") {
    try {
      const { startRunnerReconciler } = await import("./hosting.mjs");
      const { makeMachinesDriver } = await import("./hosting-driver.mjs");
      const driver = makeMachinesDriver(process.env.ERGON_HOSTING_DRIVER,
        { app: process.env.FLY_APP, token: process.env.FLY_API_TOKEN, defaultRegion: process.env.FLY_REGION });
      startRunnerReconciler(dbmod, { driver, intervalMs: Number(process.env.ERGON_RECONCILE_MS || 60_000), autoRestart: process.env.ERGON_RUNNER_AUTORESTART === "on" });
      console.log("[proxy] runner reconciler running.");
    } catch (e) { console.warn(`[proxy] runner reconciler not started: ${e.message}`); }
  }
} catch (e) {
  console.log("[proxy] running as pure model proxy (no accounts). To enable them: npm install better-sqlite3 bcryptjs");
}

// readiness: when the accounts tier is on, the DB must answer; otherwise the
// pure proxy is ready as soon as the process is up.
async function _readiness() {
  if (!_dbPing) return { detail: "proxy-only (no data layer)" };
  await _dbPing();
  return { detail: "db ok" };
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2" };

async function forward(res, url, headers, body) {
  try {
    const upstream = await fetch(url, { method: "POST", headers, body });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "application/json" }).end(text);
  } catch (e) {
    res.writeHead(502).end(JSON.stringify({ error: String(e) }));
  }
}

const sendJson = (res, code, obj) =>
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));

// GET an upstream provider endpoint (model listing / connectivity test), capped + timed out.
async function fetchUpstreamJson(url, headers) {
  const r = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15000) });
  const text = (await r.text()).slice(0, 2_000_000);
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, ok: r.ok, json, text };
}

// Resolve the kind/base/key for a model call: a chosen provider prefix (UI picker,
// saved keys) takes precedence; otherwise fall back to the legacy env-only path.
function resolveForModel(provider, providerPrefix) {
  if (providerPrefix) {
    const r = resolveProvider(providerPrefix, getSetting(providerPrefix));
    if (r.error) return { err: r.error };
    return { kind: r.kind, base: r.baseUrl, key: r.key, spec: r.spec, prefix: providerPrefix };
  }
  if (provider === "openai")
    return { kind: "openai", base: (process.env.OPENAI_BASE_URL || OPENAI_DEFAULT_BASE), key: process.env.OPENAI_API_KEY };
  if (provider === "gemini")
    return { kind: "gemini", base: null, key: process.env.GEMINI_API_KEY };
  return { kind: "anthropic", base: null, key: anthropicKey() };
}

// ── read a request body with a hard size cap (prevents memory-exhaustion DoS) ──
const MAX_BODY = 8_000_000;   // 8 MB, matches routes.mjs
async function readCapped(req, res) {
  let body = "", size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) { res.writeHead(413).end(JSON.stringify({ error: "payload too large" })); req.destroy(); return null; }
    body += chunk;
  }
  return body;
}

// ── tiny in-memory per-IP rate limiter (best-effort; single-process) ──
function makeLimiter({ windowMs, max }) {
  const hits = new Map();   // ip -> [timestamps]
  return (ip) => {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(ip, arr);
    if (hits.size > 5000) { for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k); }
    return arr.length <= max;
  };
}
// Redis-backed if REDIS_URL is set (shared across instances), else the
// in-memory makeLimiter below. makeLimiter stays exported for the proxy tests.
import { makeLimiterFactory } from "./ratelimit.mjs";
const { limiter: modelLimiter, backend: _rlBackend } =
  await makeLimiterFactory({ windowMs: 60_000, max: 120, prefix: "rl:model:" });   // 120 model calls/min/IP
if (_rlBackend === "redis") console.log("[proxy] model rate-limit using Redis");
const clientIp = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";

// ── SSRF guard: block non-http(s) and internal/loopback/link-local hosts ──
function isBlockedUrl(u) {
  let t; try { t = new URL(u); } catch { return "invalid URL"; }
  if (!/^https?:$/.test(t.protocol)) return `blocked protocol '${t.protocol}'`;
  const host = t.hostname.toLowerCase();
  const blocked = host === "localhost" || host === "0.0.0.0" || host.endsWith(".local") ||
    /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "[::1]" || host === "::1";
  return blocked ? `blocked host '${host}' (internal/loopback addresses are not allowed)` : null;
}

// ── baseline security headers on every response ──
function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
}

// ── browser preview: drive a real headless Chromium via Playwright (optional dep) ──
// One page per preview session id; sessions auto-expire so a Chromium can't leak.
const browserSessions = new Map();   // sid -> { page, browser, ctx, last }
let _playwright = null, _pwTried = false;
async function getPlaywright() {
  if (_pwTried) return _playwright;
  _pwTried = true;
  try { _playwright = (await import("playwright")).chromium; }
  catch { _playwright = null; }   // not installed → route reports it cleanly
  return _playwright;
}
const BROWSER_TTL = 5 * 60_000;     // idle sessions close after 5 min
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of browserSessions) {
    if (now - s.last > BROWSER_TTL) { try { s.browser.close(); } catch {} browserSessions.delete(sid); }
  }
}, 60_000).unref?.();

async function browserAction({ session, action, url, selector, text, key, maxChars = 12000 }) {
  const chromium = await getPlaywright();
  if (!chromium) {
    return { error: "Browser preview needs Playwright on the proxy: `npm i playwright && npx playwright install chromium`. The exported Python still runs browser agents via the SDK." };
  }
  const sid = session || "default";
  let s = browserSessions.get(sid);
  if (!s) {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    s = { browser, ctx, page, last: Date.now() };
    browserSessions.set(sid, s);
  }
  s.last = Date.now();
  const page = s.page;
  try {
    switch (action) {
      case "navigate": {
        const blocked = isBlockedUrl(url);
        if (blocked) return { result: `[navigation blocked] ${blocked}` };
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return { result: `Loaded ${page.url()} — title: ${JSON.stringify(await page.title())}` };
      }
      case "read": {
        let t = await page.innerText("body");
        t = t.replace(/\n{3,}/g, "\n\n").trim();
        if (t.length > maxChars) t = t.slice(0, maxChars) + "\n[…truncated…]";
        return { result: `URL: ${page.url()}\n\n${t}` };
      }
      case "find": {
        const hits = await page.evaluate((q) => {
          const out = [];
          for (const el of Array.from(document.querySelectorAll("a,button,input,[role=button]"))) {
            const label = (el.innerText || el.placeholder || el.name || "").trim().slice(0, 60);
            if (label && label.toLowerCase().includes(q.toLowerCase())) {
              out.push(`- <${el.tagName.toLowerCase()}> ${JSON.stringify(label)} (hint: ${JSON.stringify(el.id || el.name || label)})`);
            }
            if (out.length >= 20) break;
          }
          return out;
        }, text || selector || "");
        return { result: hits.length ? hits.join("\n") : "No matching elements." };
      }
      case "click":  await page.click(selector); return { result: `Clicked ${JSON.stringify(selector)}. Now at ${page.url()}` };
      case "type":   await page.fill(selector, text); return { result: `Typed into ${JSON.stringify(selector)}.` };
      case "press":  await page.keyboard.press(key || "Enter"); return { result: `Pressed ${JSON.stringify(key)}. Now at ${page.url()}` };
      case "submit": {
        const el = await page.$(selector || "form");
        if (el) await el.evaluate((f) => (f.requestSubmit ? f.requestSubmit() : f.submit()));
        else await page.keyboard.press("Enter");
        await page.waitForLoadState("domcontentloaded");
        return { result: `Submitted. Now at ${page.url()}` };
      }
      case "close": { try { s.browser.close(); } catch {} browserSessions.delete(sid); return { result: "closed" }; }
      default: return { error: `unknown action '${action}'` };
    }
  } catch (e) {
    return { result: `[browser error] ${e.message}` };
  }
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);

  // ── health checks (before everything: always reachable, never rate-limited) ──
  if (await handleHealth(req, res, { readinessCheck: _readiness })) return;

  // ── collaboration tier: accounts, harnesses, sharing, server-side sessions ──
  if (handleApiRoutes) {
    try { if (await handleApiRoutes(req, res)) return; }
    catch (e) { res.writeHead(500).end(JSON.stringify({ error: String(e) })); return; }
  }

  // ── provider-routing API proxy ──
  if (req.method === "POST" && req.url === "/api/model") {
    if (!(await modelLimiter(clientIp(req)))) { res.writeHead(429).end(JSON.stringify({ error: "rate limit exceeded, slow down" })); return; }
    const raw = await readCapped(req, res);
    if (raw === null) return;   // 413 already sent
    let provider, payload, providerPrefix;
    try { ({ provider, payload, providerPrefix } = JSON.parse(raw)); }
    catch { res.writeHead(400).end("bad request body"); return; }

    const r = resolveForModel(provider, providerPrefix);
    if (r.err) { res.writeHead(400).end(r.err); return; }
    // a friendly, actionable missing-key message (names the provider + where to fix it)
    const noKey = () => {
      const who = providerPrefix || provider || "anthropic";
      res.writeHead(500).end(`No API key for '${who}'. Add one in Settings → Keys, or set its environment variable on the proxy.`);
    };

    if (r.kind === "openai") {
      if (!r.key && !(r.spec && r.spec.local)) return noKey();
      const base = (r.base || "https://api.openai.com/v1").replace(/\/$/, "");
      await forward(res, `${base}/chat/completions`,
        { "content-type": "application/json", authorization: `Bearer ${r.key || ""}` },
        JSON.stringify(payload));
      return;
    }
    if (r.kind === "gemini") {
      if (!r.key) return noKey();
      const model = encodeURIComponent(payload.model || "gemini-2.0-flash");
      await forward(res, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { "content-type": "application/json", "x-goog-api-key": r.key },
        JSON.stringify(payload.body));
      return;
    }
    // note: bedrock is not proxied — it requires AWS SigV4 request signing;
    // the Studio previews bedrock agents on Claude, and the exported Python
    // runs them natively through boto3.

    // default: anthropic
    if (!r.key) return noKey();
    await forward(res, "https://api.anthropic.com/v1/messages",
      { "content-type": "application/json", "x-api-key": r.key, "anthropic-version": "2023-06-01" },
      JSON.stringify(payload));
    return;
  }

  // ── provider registry, live model lists, key management (minimum-effort UI) ──
  if (req.url === "/api/providers" && req.method === "GET") {
    sendJson(res, 200, { providers: providerList(getSetting) });
    return;
  }

  if (req.url.startsWith("/api/models") && req.method === "GET") {
    if (!(await modelLimiter(clientIp(req)))) { sendJson(res, 429, { error: "rate limit exceeded, slow down" }); return; }
    const prefix = new URL(req.url, "http://x").searchParams.get("provider");
    const spec = getProvider(prefix);
    if (!spec) { sendJson(res, 400, { error: `unknown provider '${prefix}'` }); return; }
    const resolved = resolveProvider(prefix, getSetting(prefix));
    if (!resolved.key && !spec.local) { sendJson(res, 400, { error: `No API key for '${prefix}' — add one in Settings → Keys.` }); return; }
    const { url, headers } = modelsRequest(prefix, resolved);
    try {
      const up = await fetchUpstreamJson(url, headers);
      if (!up.ok) { sendJson(res, 502, { error: `upstream ${up.status}`, detail: up.text.slice(0, 300) }); return; }
      sendJson(res, 200, { provider: prefix, models: parseModelList(resolved.kind, up.json || {}) });
    } catch (e) { sendJson(res, 502, { error: String(e.message || e) }); }
    return;
  }

  if (req.url === "/api/provider/test" && req.method === "POST") {
    if (!(await modelLimiter(clientIp(req)))) { sendJson(res, 429, { error: "rate limit exceeded" }); return; }
    const raw = await readCapped(req, res); if (raw === null) return;
    let prefix; try { ({ provider: prefix } = JSON.parse(raw || "{}")); } catch { sendJson(res, 400, { error: "bad body" }); return; }
    const spec = getProvider(prefix);
    if (!spec) { sendJson(res, 400, { ok: false, detail: `unknown provider '${prefix}'` }); return; }
    const resolved = resolveProvider(prefix, getSetting(prefix));
    if (!resolved.key && !spec.local) { sendJson(res, 200, { ok: false, detail: "no API key configured" }); return; }
    const { url, headers } = modelsRequest(prefix, resolved);
    try {
      const up = await fetchUpstreamJson(url, headers);
      if (!up.ok) { sendJson(res, 200, { ok: false, detail: `upstream ${up.status}: ${up.text.slice(0, 160)}` }); return; }
      sendJson(res, 200, { ok: true, modelCount: parseModelList(resolved.kind, up.json || {}).length, keySource: resolved.keySource });
    } catch (e) { sendJson(res, 200, { ok: false, detail: String(e.message || e) }); }
    return;
  }

  if (req.url === "/api/provider/settings" && req.method === "GET") {
    const out = {};
    for (const { prefix } of providerList(() => null)) out[prefix] = statusFor(prefix);
    sendJson(res, 200, { settings: out });
    return;
  }

  if (req.url === "/api/provider/settings" && (req.method === "POST" || req.method === "DELETE")) {
    const raw = await readCapped(req, res); if (raw === null) return;
    let body; try { body = JSON.parse(raw || "{}"); } catch { sendJson(res, 400, { error: "bad body" }); return; }
    const prefix = body.provider;
    if (!getProvider(prefix)) { sendJson(res, 400, { error: `unknown provider '${prefix}'` }); return; }
    if (req.method === "DELETE" || body.clear) { sendJson(res, 200, clearSetting(prefix)); return; }
    const patch = {};
    if (body.apiKey !== undefined) patch.apiKey = body.apiKey;
    if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl;
    sendJson(res, 200, setSetting(prefix, patch));
    return;
  }

  // ── legacy endpoint (pre-provider builds) ──
  if (req.method === "POST" && req.url === "/api/claude") {
    if (!anthropicKey()) { res.writeHead(500).end("ANTHROPIC_API_KEY not set on the proxy"); return; }
    const body = await readCapped(req, res);
    if (body === null) return;
    try {
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": anthropicKey(),
          "anthropic-version": "2023-06-01",
        },
        body,
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json" }).end(text);
    } catch (e) {
      res.writeHead(502).end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // ── custom HTTP tools: server-side fetch so previews avoid browser CORS ──
  // ── browser preview: one action against a real headless Chromium ──
  if (req.method === "POST" && req.url === "/api/browser") {
    const body = await readCapped(req, res);
    if (body === null) return;
    try {
      const out = await browserAction(JSON.parse(body || "{}"));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(502).end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/tool-fetch") {
    const body = await readCapped(req, res);
    if (body === null) return;
    try {
      const { url, method = "POST", headers = {}, input = "" } = JSON.parse(body || "{}");
      const blockReason = isBlockedUrl(url);
      if (blockReason) { res.writeHead(403).end(JSON.stringify({ error: blockReason })); return; }
      const isGet = String(method).toUpperCase() === "GET";
      const finalUrl = isGet ? `${url}${url.includes("?") ? "&" : "?"}input=${encodeURIComponent(input)}` : url;
      const upstream = await fetch(finalUrl, {
        method: isGet ? "GET" : "POST",
        headers: { "content-type": "application/json", ...headers },
        body: isGet ? undefined : JSON.stringify({ input }),
        signal: AbortSignal.timeout(15000),
        redirect: "manual",   // don't auto-follow: a redirect to an internal host would bypass the guard
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        res.writeHead(502).end(JSON.stringify({ error: "endpoint redirected; redirects are not followed for safety" }));
        return;
      }
      // cap the response we read back (prevent a hostile endpoint from streaming gigabytes)
      const reader = upstream.body?.getReader?.();
      let text = "", total = 0;
      const MAX_RESP = 1_000_000;   // 1 MB
      if (reader) {
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > MAX_RESP) { text += "\n[truncated: response exceeded 1 MB]"; try { await reader.cancel(); } catch {} break; }
          text += dec.decode(value, { stream: true });
        }
      } else {
        text = (await upstream.text()).slice(0, MAX_RESP);
      }
      res.writeHead(upstream.status, { "content-type": "text/plain" }).end(text);
    } catch (e) {
      res.writeHead(502).end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  // ── static files (production only; in dev Vite serves the app) ──
  if (PROD && existsSync(DIST)) {
    const urlPath = req.url.split("?")[0];
    let file = path.join(DIST, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
    if (!existsSync(file)) file = path.join(DIST, "index.html"); // SPA fallback
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" }).end(data);
    } catch {
      res.writeHead(404).end("not found");
    }
    return;
  }

  res.writeHead(404).end("proxy: POST /api/model (or legacy /api/claude) in dev mode");
});

// Only start listening when run directly (not when imported by a test).
import { fileURLToPath as _fileURLToPath } from "node:url";
import { loadSecrets, ERGON_SECRETS, providerName as _secretsProvider } from "./secrets.mjs";
if (process.argv[1] === _fileURLToPath(import.meta.url)) {
  // resolve secrets first (from process.env by default, or a cloud manager when
  // SECRETS_PROVIDER is set), overlaying them into process.env so the reads
  // below and in the routes just work.
  await loadSecrets(ERGON_SECRETS);
  if (!anthropicKey()) console.warn("[proxy] WARNING: ANTHROPIC_API_KEY is not set — /api/claude will return 500.");
  server.listen(PORT, () =>
    console.log(`[proxy] listening on http://localhost:${PORT}${PROD ? " (serving dist/ + API)" : " (API only — run vite for the UI)"}`)
  );

  // ── graceful shutdown: stop accepting connections, let in-flight finish,
  //    then exit. Containers send SIGTERM on stop/rollout; without this, live
  //    requests get cut off. A hard timeout guarantees we don't hang forever.
  let shuttingDown = false;
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[proxy] ${sig} received — draining connections…`);
      const hard = setTimeout(() => { console.error("[proxy] drain timeout — forcing exit"); process.exit(1); }, 10_000);
      hard.unref?.();
      server.close((err) => {
        clearTimeout(hard);
        if (err) { console.error("[proxy] error during shutdown:", err); process.exit(1); }
        console.log("[proxy] closed cleanly");
        process.exit(0);
      });
    });
  }
}

export { isBlockedUrl, makeLimiter };
