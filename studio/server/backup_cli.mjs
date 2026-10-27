/* CLI for backup & restore — `npm run backup`, `npm run restore`, `npm run backup:list`.

   Dispatches on the active backend (DATABASE_URL → Postgres, else SQLite via
   ERGON_DB). For Postgres it shells out to pg_dump/pg_restore (must be on PATH);
   for SQLite it uses the dependency-free snapshot in backup.mjs.

   Usage:
     node server/backup_cli.mjs                 # take a backup → backups/
     node server/backup_cli.mjs --out /snaps    # backup to a chosen dir
     node server/backup_cli.mjs --list          # list known backups
     node server/backup_cli.mjs --restore FILE  # restore from a backup file
*/
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  backupSqlite, restoreSqlite, listBackups, backupName, writeManifest,
  pgDumpCommand, pgRestoreCommand,
} from "./backup.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function backend() {
  const url = process.env.DATABASE_URL;
  return (url && /^postgres(ql)?:\/\//.test(url)) ? "postgres" : "sqlite";
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
    p.on("error", reject);
    p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${cmd[0]} exited ${code}`)));
  });
}

async function doBackup(outDir) {
  if (backend() === "postgres") {
    const { mkdirSync, statSync } = await import("node:fs");
    mkdirSync(outDir, { recursive: true });
    const when = new Date();
    const name = backupName("postgres", when);
    const file = path.join(outDir, name);
    const cmd = pgDumpCommand(process.env.DATABASE_URL, file);
    console.log(`[backup] ${cmd.join(" ").replace(process.env.DATABASE_URL, "<DATABASE_URL>")}`);
    await run(cmd);
    const entry = { backend: "postgres", file: name, created_at: when.toISOString(),
                    size_bytes: statSync(file).size };
    writeManifest(outDir, entry);
    console.log(`[backup] wrote ${file}`);
    return entry;
  }
  const dbPath = process.env.ERGON_DB || path.join(ROOT, "ergon.db");
  const res = await backupSqlite(dbPath, outDir);
  console.log(`[backup] wrote ${res.path} (schema ${res.schema_version || "unknown"}, ${res.size_bytes} bytes)`);
  return res;
}

async function doRestore(file) {
  if (backend() === "postgres") {
    const cmd = pgRestoreCommand(process.env.DATABASE_URL, file);
    console.log(`[restore] ${cmd.join(" ").replace(process.env.DATABASE_URL, "<DATABASE_URL>")}`);
    await run(cmd);
    console.log("[restore] done");
    return;
  }
  const dbPath = process.env.ERGON_DB || path.join(ROOT, "ergon.db");
  const res = await restoreSqlite(file, dbPath);
  console.log(`[restore] restored ${res.restored} from ${path.basename(file)}` +
              (res.pre_restore ? ` (previous DB saved to ${path.basename(res.pre_restore)})` : ""));
}

export async function main(argv = process.argv.slice(2)) {
  const outIdx = argv.indexOf("--out");
  const outDir = outIdx >= 0 ? argv[outIdx + 1] : path.join(ROOT, "backups");
  const restoreIdx = argv.indexOf("--restore");

  if (argv.includes("--list")) {
    const rows = listBackups(outDir);
    if (!rows.length) { console.log("(no backups found in " + outDir + ")"); return; }
    for (const r of rows) {
      console.log(`  ${r.file}  [${r.backend || "?"}]  ${r.created_at || ""}` +
                  (r.schema_version ? `  schema ${r.schema_version}` : ""));
    }
    return;
  }
  if (restoreIdx >= 0) {
    const file = argv[restoreIdx + 1];
    if (!file) throw new Error("--restore needs a backup file path");
    await doRestore(file);
    return;
  }
  await doBackup(outDir);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("[backup] failed:", e.message || e); process.exit(1); });
}
