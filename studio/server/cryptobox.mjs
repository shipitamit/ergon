/* Sealed secrets — AES-256-GCM for credentials stored in the database
   (connection tokens, connection strings). Same scheme as the provider-key
   settings store, factored out so the DB layer can reuse it.

   The key is derived (scrypt) from ERGON_SETTINGS_SECRET / SESSION_SECRET. When
   neither is set, a machine-local key is generated once and persisted beside the
   data with 0600 perms — better than plaintext, and stable across restarts so
   sealed values stay decryptable. In production, set a real secret (and rotate
   it the usual way: re-seal with a new key).

   seal(plain)  -> "v1:<iv>:<tag>:<ct>"  (hex)
   open(sealed) -> plaintext | null (null on wrong key / tampered / malformed) */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEYFILE = (process.env.ERGON_SETTINGS_FILE || path.join(ROOT, ".ergon-settings.json")) + ".key";
const SALT = "ergon-connection-secret-v1";

let _key = null;
function _secret() {
  const s = process.env.ERGON_SETTINGS_SECRET || process.env.SESSION_SECRET;
  if (s && s !== "change-me") return s;
  try {
    if (fs.existsSync(KEYFILE)) return fs.readFileSync(KEYFILE, "utf8").trim();
    const gen = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(KEYFILE, gen, { mode: 0o600 });
    return gen;
  } catch {
    return "ergon-insecure-fallback-secret";
  }
}
function _derive() {
  if (!_key) _key = crypto.scryptSync(_secret(), SALT, 32);
  return _key;
}

export function seal(plain) {
  if (plain == null || plain === "") return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", _derive(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `v1:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
}

export function open(sealed) {
  if (!sealed || typeof sealed !== "string") return null;
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const [, iv, tag, ct] = parts;
    const decipher = crypto.createDecipheriv("aes-256-gcm", _derive(), Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// a safe display hint for a secret: last 4 chars, never the whole thing.
export function last4(plain) {
  const s = String(plain || "");
  return s.length <= 4 ? s : s.slice(-4);
}

export function _reset() { _key = null; }   // test hook
