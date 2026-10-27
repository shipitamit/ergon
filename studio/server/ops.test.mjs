/* Tests for Tier-3 ops: health checks + migration runner.

   Runs against fakes (a fake req/res, a fake DB adapter), so the health-endpoint
   logic and the migration runner (ordering, idempotency, transaction rollback)
   are verified offline. Docker build/run and a live DB are not exercised here.

   Run: node server/ops.test.mjs   (or: npm run test:ops)
*/
import assert from "node:assert";
import { handleHealth } from "./health.mjs";
import { runMigrations, migrationStatus } from "./migrate.mjs";
import { backupSqlite, restoreSqlite, listBackups, backupName, pgDumpCommand, pgRestoreCommand, _gzip, _gunzip } from "./backup.mjs";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failed++; failures.push([name, e.message]); }
}

// ── fake req/res ──
function fakeReqRes(method, url) {
  const res = { code: null, headers: null, body: null,
    writeHead(c, h) { this.code = c; this.headers = h; return this; },
    end(b) { this.body = b; } };
  return [{ method, url }, res];
}
const parse = (res) => JSON.parse(res.body);

// ── health ──

await test("GET /healthz returns 200 ok", async () => {
  const [req, res] = fakeReqRes("GET", "/healthz");
  assert.equal(await handleHealth(req, res), true);
  assert.equal(res.code, 200);
  assert.equal(parse(res).status, "ok");
});

await test("GET /readyz returns 200 when readiness passes", async () => {
  const [req, res] = fakeReqRes("GET", "/readyz");
  await handleHealth(req, res, { readinessCheck: async () => ({ detail: "db ok" }) });
  assert.equal(res.code, 200);
  assert.equal(parse(res).status, "ready");
});

await test("GET /readyz returns 503 when readiness throws", async () => {
  const [req, res] = fakeReqRes("GET", "/readyz");
  await handleHealth(req, res, { readinessCheck: async () => { throw new Error("db down"); } });
  assert.equal(res.code, 503);
  assert.equal(parse(res).status, "not_ready");
  assert.ok(parse(res).detail.includes("db down"));
});

await test("GET /readyz returns 503 on explicit false", async () => {
  const [req, res] = fakeReqRes("GET", "/readyz");
  await handleHealth(req, res, { readinessCheck: async () => false });
  assert.equal(res.code, 503);
});

await test("health ignores non-health paths and non-GET", async () => {
  const [req1, res1] = fakeReqRes("GET", "/api/model");
  assert.equal(await handleHealth(req1, res1), false);
  const [req2, res2] = fakeReqRes("POST", "/healthz");
  assert.equal(await handleHealth(req2, res2), false);
});

await test("healthz tolerates query string", async () => {
  const [req, res] = fakeReqRes("GET", "/healthz?probe=k8s");
  assert.equal(await handleHealth(req, res), true);
  assert.equal(res.code, 200);
});

// ── migrations ──

function fakeAdapter() {
  const tables = { schema_migrations: [] };
  return {
    log: [],
    tx: 0,
    async run(sql, params = []) {
      this.log.push(sql.split("(")[0].trim());
      if (/INSERT INTO schema_migrations/i.test(sql)) {
        tables.schema_migrations.push({ id: params[0], name: params[1] });
      }
      // ignore CREATE/INDEX/etc. in the fake
    },
    async all(sql) {
      if (/FROM schema_migrations/i.test(sql)) return tables.schema_migrations.map((r) => ({ id: r.id }));
      return [];
    },
    async get() { return null; },
    async begin() { this.tx++; },
    async commit() {},
    async rollback() { this._rolledBack = true; },
    _tables: tables,
  };
}

const MIGS = [
  { id: "0001", name: "base", up: async (exec) => { await exec("CREATE TABLE users (...)"); } },
  { id: "0002", name: "idx", up: async (exec) => { await exec("CREATE INDEX i ON users (x)"); } },
];

await test("runMigrations applies all pending in order", async () => {
  const a = fakeAdapter();
  const r = await runMigrations(a, MIGS, { log: { log() {} } });
  assert.deepEqual(r.applied, ["0001", "0002"]);
  assert.deepEqual(a._tables.schema_migrations.map((x) => x.id), ["0001", "0002"]);
});

await test("runMigrations is idempotent (no re-apply)", async () => {
  const a = fakeAdapter();
  await runMigrations(a, MIGS, { log: { log() {} } });
  const r2 = await runMigrations(a, MIGS, { log: { log() {} } });
  assert.deepEqual(r2.applied, []);   // nothing pending the second time
});

await test("runMigrations applies only new ones after a prior run", async () => {
  const a = fakeAdapter();
  await runMigrations(a, [MIGS[0]], { log: { log() {} } });     // apply 0001
  const r = await runMigrations(a, MIGS, { log: { log() {} } }); // now 0002 is new
  assert.deepEqual(r.applied, ["0002"]);
});

await test("runMigrations rolls back a failing migration", async () => {
  const a = fakeAdapter();
  const bad = [{ id: "0001", name: "boom", up: async () => { throw new Error("bad sql"); } }];
  await assert.rejects(() => runMigrations(a, bad, { log: { log() {} } }), /migration 0001 .* failed/);
  assert.equal(a._rolledBack, true);
  assert.equal(a._tables.schema_migrations.length, 0);   // not recorded
});

await test("migrations apply in id order regardless of list order", async () => {
  const a = fakeAdapter();
  const unordered = [MIGS[1], MIGS[0]];
  const r = await runMigrations(a, unordered, { log: { log() {} } });
  assert.deepEqual(r.applied, ["0001", "0002"]);
});

await test("migrationStatus reports applied + pending", async () => {
  const a = fakeAdapter();
  await runMigrations(a, [MIGS[0]], { log: { log() {} } });
  const status = await migrationStatus(a, MIGS);
  assert.deepEqual(status, [
    { id: "0001", name: "base", applied: true },
    { id: "0002", name: "idx", applied: false },
  ]);
});


// ── backup / restore ──

await test("backupName is filesystem-safe and backend-tagged", async () => {
  const when = new Date("2026-10-12T16:00:00.000Z");
  assert.equal(backupName("sqlite", when), "ergon-20261012T160000000Z.db.gz");
  assert.equal(backupName("postgres", when), "ergon-20261012T160000000Z.dump");
});

await test("pg_dump / pg_restore commands are well-formed", async () => {
  const d = pgDumpCommand("postgres://u:p@h/db", "/out/x.dump");
  assert.equal(d[0], "pg_dump");
  assert.ok(d.includes("--format=custom") && d.includes("--file=/out/x.dump"));
  assert.ok(d.includes("postgres://u:p@h/db"));
  const r = pgRestoreCommand("postgres://u:p@h/db", "/out/x.dump");
  assert.equal(r[0], "pg_restore");
  assert.ok(r.includes("--clean") && r.includes("--if-exists"));
  assert.ok(r.includes("--dbname=postgres://u:p@h/db"));
});

await test("gzip round-trips", async () => {
  const buf = Buffer.from("ergon backup payload");
  assert.equal(_gunzip(_gzip(buf)).toString(), "ergon backup payload");
});

await test("sqlite backup → mutate → restore recovers data", async () => {
  const dir = fs.mkdtempSync("/tmp/ergon-bk-");
  const db = dir + "/app.db", out = dir + "/backups";
  let d = new DatabaseSync(db);
  d.exec("CREATE TABLE users(id TEXT, email TEXT)");
  d.exec("INSERT INTO users VALUES('u1','alice@example.com')");
  d.close();
  const b = await backupSqlite(db, out);
  assert.ok(fs.existsSync(b.path));
  // mutate (simulate loss)
  d = new DatabaseSync(db); d.exec("DELETE FROM users"); d.close();
  // restore
  const r = await restoreSqlite(b.path, db);
  assert.ok(r.pre_restore && fs.existsSync(r.pre_restore));
  d = new DatabaseSync(db);
  const rows = d.prepare("SELECT email FROM users").all();
  d.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "alice@example.com");
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("sqlite backup captures schema version + manifest lists it", async () => {
  const dir = fs.mkdtempSync("/tmp/ergon-bk-");
  const db = dir + "/app.db", out = dir + "/backups";
  const d = new DatabaseSync(db);
  d.exec("CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, name TEXT, applied_at INTEGER)");
  d.exec("INSERT INTO schema_migrations VALUES('0003','x',1)");
  d.close();
  const b = await backupSqlite(db, out);
  assert.equal(b.schema_version, "0003");
  const rows = listBackups(out);
  assert.ok(rows.length >= 1 && rows[0].backend === "sqlite" && rows[0].schema_version === "0003");
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("restoring a nonexistent backup throws", async () => {
  await assert.rejects(() => restoreSqlite("/no/such/file.db.gz", "/tmp/x.db"), /not found/);
});

await test("backing up a nonexistent database throws", async () => {
  await assert.rejects(() => backupSqlite("/no/such/app.db", "/tmp/out"), /not found/);
});

console.log(`\nops.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  ✗ ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
