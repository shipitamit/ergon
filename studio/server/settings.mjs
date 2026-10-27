/* Provider settings store — persists UI-entered API keys + base URLs so users
   never touch a terminal or restart the server to add a provider.

   Keys are encrypted at rest (AES-256-GCM). The encryption key comes from
   ERGON_SETTINGS_SECRET or SESSION_SECRET; if neither is set, a random secret is
   generated once and stored beside the settings file with 0600 perms. Saved
   keys take precedence over env vars (resolveProvider in providers.mjs); env /
   the cloud secrets manager remain the way to inject keys in production.

   Secret-free by contract: statusFor()/status() never return the plaintext key
   — only { configured, baseUrl, last4, source }.
*/
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = process.env.ERGON_SETTINGS_FILE || path.join(ROOT, ".ergon-settings.json");
const KEYFILE = FILE + ".key";

let _cache = null;   // { v, salt, items: { prefix: { iv, tag, ct, baseUrl } } }

function _secret() {
  const s = process.env.ERGON_SETTINGS_SECRET || process.env.SESSION_SECRET;
  if (s && s !== "change-me") return s;
  // no configured secret → generate+persist a machine-local one (better than plaintext)
  try {
    if (fs.existsSync(KEYFILE)) return fs.readFileSync(KEYFILE, "utf8").trim();
    const gen = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(KEYFILE, gen, { mode: 0o600 });
    return gen;
  } catch {
    return "ergon-insecure-fallback-secret";   // last resort (e.g. read-only FS)
  }
}

function _load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!_cache.items) _cache.items = {};
  } catch {
    _cache = { v: 1, salt: crypto.randomBytes(16).toString("hex"), items: {} };
  }
  return _cache;
}

function _save() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(_cache), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function _derive() {
  const c = _load();
  return crypto.scryptSync(_secret(), Buffer.from(c.salt, "hex"), 32);
}

function _encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", _derive(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ct: ct.toString("hex") };
}

function _decrypt(rec) {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", _derive(), Buffer.from(rec.iv, "hex"));
    decipher.setAuthTag(Buffer.from(rec.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(rec.ct, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return null;   // wrong secret / corrupt → treat as no saved key
  }
}

/** { apiKey, baseUrl } for a prefix, or null if nothing saved. Decrypts the key. */
export function getSetting(prefix) {
  const rec = _load().items[prefix];
  if (!rec) return null;
  const out = {};
  if (rec.baseUrl) out.baseUrl = rec.baseUrl;
  if (rec.ct) { const k = _decrypt(rec); if (k) out.apiKey = k; }
  return Object.keys(out).length ? out : null;
}

/** Save/merge a provider's key and/or base URL. Passing apiKey:"" clears the key. */
export function setSetting(prefix, { apiKey, baseUrl } = {}) {
  const c = _load();
  const rec = c.items[prefix] || {};
  if (apiKey !== undefined) {
    if (apiKey === null || apiKey === "") { delete rec.iv; delete rec.tag; delete rec.ct; }
    else Object.assign(rec, _encrypt(apiKey));
  }
  if (baseUrl !== undefined) {
    if (baseUrl) rec.baseUrl = baseUrl; else delete rec.baseUrl;
  }
  c.items[prefix] = rec;
  _save();
  return statusFor(prefix);
}

/** Remove a provider's saved settings entirely. */
export function clearSetting(prefix) {
  const c = _load();
  delete c.items[prefix];
  _save();
  return { prefix, saved: false };
}

/** Secret-free status for one prefix (never returns the key itself). */
export function statusFor(prefix) {
  const rec = _load().items[prefix];
  if (!rec) return { prefix, saved: false, baseUrl: null, last4: null };
  const key = rec.ct ? _decrypt(rec) : null;
  return {
    prefix,
    saved: !!rec.ct,
    baseUrl: rec.baseUrl || null,
    last4: key ? key.slice(-4) : null,
  };
}

/** Reset the in-memory cache (tests). */
export function _reset() { _cache = null; }
