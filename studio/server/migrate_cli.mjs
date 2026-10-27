/* CLI entry for migrations: `node server/migrate.mjs` style, wired as
   `npm run migrate` / `npm run migrate:status`.

   Builds a transaction-capable adapter over the active backend (Postgres when
   DATABASE_URL is set, else SQLite) and runs the shared migration runner. The
   adapter normalizes placeholder style (`?` → `$n` for Postgres) so one set of
   migration SQL works on both.
*/
import { runMigrations, migrationStatus } from "./migrate.mjs";
import { MIGRATIONS } from "./migrations.mjs";

function qmarkToDollar(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function pgAdapter(url) {
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return {
    dialect: "postgres",
    run: (sql, params = []) => client.query(qmarkToDollar(sql), params),
    get: async (sql, params = []) => (await client.query(qmarkToDollar(sql), params)).rows[0] || null,
    all: async (sql, params = []) => (await client.query(qmarkToDollar(sql), params)).rows,
    begin: () => client.query("BEGIN"),
    commit: () => client.query("COMMIT"),
    rollback: () => client.query("ROLLBACK"),
    close: () => client.end(),
  };
}

async function sqliteAdapter(path) {
  let db;
  try {
    const Database = (await import("better-sqlite3")).default;
    db = new Database(path);
  } catch {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(path);
  }
  const run = (sql, params = []) => { db.prepare(sql).run(...params); return Promise.resolve(); };
  return {
    dialect: "sqlite",
    run,
    get: (sql, params = []) => Promise.resolve(db.prepare(sql).get(...params) || null),
    all: (sql, params = []) => Promise.resolve(db.prepare(sql).all(...params)),
    begin: () => run("BEGIN"),
    commit: () => run("COMMIT"),
    rollback: () => run("ROLLBACK"),
    close: () => Promise.resolve(db.close?.()),
  };
}

export async function makeAdapter() {
  const url = process.env.DATABASE_URL;
  if (url && /^postgres(ql)?:\/\//.test(url)) return pgAdapter(url);
  const path = process.env.ERGON_DB || "ergon.db";
  return sqliteAdapter(path);
}

export async function main(argv = process.argv.slice(2)) {
  const adapter = await makeAdapter();
  try {
    if (argv.includes("--status")) {
      const rows = await migrationStatus(adapter, MIGRATIONS);
      for (const r of rows) console.log(`  [${r.applied ? "x" : " "}] ${r.id}  ${r.name}`);
      const pending = rows.filter((r) => !r.applied).length;
      console.log(pending ? `\n${pending} pending` : "\nup to date");
    } else {
      await runMigrations(adapter, MIGRATIONS);
    }
  } finally {
    await adapter.close?.();
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("[migrate] failed:", e.message || e); process.exit(1); });
}
