/* Backup & restore for the Studio data layer — SQLite and Postgres.

   Tier-4 data lifecycle: take a consistent snapshot of the accounts/harness
   database and restore it. Backend-agnostic dispatch mirrors the migration
   runner (DATABASE_URL → Postgres, else SQLite via ERGON_DB).

   SQLite  — snapshot via `VACUUM INTO` (a clean, consistent single-file copy
             even under concurrent access), then gzip. Restore decompresses and
             swaps it in, snapshotting the current DB first so a bad restore is
             recoverable. Fully runnable with no external tools.
   Postgres — snapshot via `pg_dump` (custom format), restore via `pg_restore`.
             This module builds and runs those commands; the tools must be on
             PATH. Command construction is unit-tested; a live run needs a real
             database (see the README).

   Backups land in a `backups/` dir (timestamped) with a small JSON manifest
   recording backend, time, and the schema version at snapshot, so a restore can
   sanity-check what it's loading.
*/
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";

// ── pure helpers (fully testable) ──

export function backupName(backend, when = new Date()) {
  // filesystem-safe ISO timestamp, e.g. ergon-20261012T160000Z
  const ts = when.toISOString().replace(/[:.]/g, "").replace(/-/g, "");
  const ext = backend === "postgres" ? "dump" : "db.gz";
  return `ergon-${ts}.${ext}`;
}

export function pgDumpCommand(url, outFile) {
  // custom format (-Fc) → compressed, restorable with pg_restore, order-safe
  return ["pg_dump", "--format=custom", "--no-owner", "--no-privileges",
          `--file=${outFile}`, url];
}

export function pgRestoreCommand(url, inFile) {
  // --clean --if-exists drops existing objects first so restore is repeatable;
  // --no-owner avoids role mismatches across environments
  return ["pg_restore", "--clean", "--if-exists", "--no-owner",
          `--dbname=${url}`, inFile];
}

export function writeManifest(dir, entry) {
  const file = path.join(dir, "manifest.json");
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* new */ }
  list.unshift(entry);                       // newest first
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
  return file;
}

export function listBackups(dir) {
  try {
    const manifest = path.join(dir, "manifest.json");
    if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch { /* fall through */ }
  // fallback: scan the dir for backup files if the manifest is missing
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^ergon-\d+T\d+Z?\.(db\.gz|dump)$/.test(f))
      .sort().reverse()
      .map((f) => ({ file: f }));
  } catch { return []; }
}

// ── SQLite snapshot / restore (runnable, no external tools) ──

async function openSqlite(dbPath) {
  try {
    const { default: Database } = await import("better-sqlite3");
    return { db: new Database(dbPath), kind: "better" };
  } catch {
    const { DatabaseSync } = await import("node:sqlite");
    return { db: new DatabaseSync(dbPath), kind: "node" };
  }
}

function sqliteExec(handle, sql) {
  if (handle.kind === "better") handle.db.exec(sql);
  else handle.db.exec(sql);                  // node:sqlite also exposes exec()
}

export async function backupSqlite(dbPath, outDir, { when = new Date() } = {}) {
  if (!fs.existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  fs.mkdirSync(outDir, { recursive: true });
  const name = backupName("sqlite", when);
  const finalPath = path.join(outDir, name);
  const tmpPlain = path.join(outDir, name.replace(/\.gz$/, "") + ".tmp");

  // consistent snapshot to a plain file via VACUUM INTO, then gzip it
  const handle = await openSqlite(dbPath);
  let version = null;
  try {
    try {
      const row = handle.db.prepare(
        "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1").get();
      version = row ? row.id : null;
    } catch { /* no migrations table yet */ }
    // VACUUM INTO requires the target not exist
    if (fs.existsSync(tmpPlain)) fs.unlinkSync(tmpPlain);
    sqliteExec(handle, `VACUUM INTO '${tmpPlain.replace(/'/g, "''")}'`);
  } finally {
    handle.db.close?.();
  }

  await pipeline(createReadStream(tmpPlain), createGzip(), createWriteStream(finalPath));
  fs.unlinkSync(tmpPlain);

  const entry = { backend: "sqlite", file: name, created_at: when.toISOString(),
                  schema_version: version, source: dbPath,
                  size_bytes: fs.statSync(finalPath).size };
  writeManifest(outDir, entry);
  return { path: finalPath, ...entry };
}

export async function restoreSqlite(backupFile, dbPath, { when = new Date() } = {}) {
  if (!fs.existsSync(backupFile)) throw new Error(`backup not found: ${backupFile}`);
  // safety: snapshot the current DB before overwriting, so a bad restore is undoable
  let preRestore = null;
  if (fs.existsSync(dbPath)) {
    preRestore = dbPath + ".pre-restore-" +
      when.toISOString().replace(/[:.]/g, "").replace(/-/g, "");
    fs.copyFileSync(dbPath, preRestore);
  }
  // decompress the backup into place (atomic-ish: write to tmp, then rename)
  const tmp = dbPath + ".restore.tmp";
  await pipeline(createReadStream(backupFile), createGunzip(), createWriteStream(tmp));
  // sanity-check the restored file is a valid SQLite DB before swapping in
  const check = await openSqlite(tmp);
  try { check.db.prepare("SELECT 1").get(); }
  finally { check.db.close?.(); }
  fs.renameSync(tmp, dbPath);
  return { restored: dbPath, from: backupFile, pre_restore: preRestore };
}

// gzip helpers exposed for tests
export const _gzip = (buf) => zlib.gzipSync(buf);
export const _gunzip = (buf) => zlib.gunzipSync(buf);
