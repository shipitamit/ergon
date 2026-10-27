/* Schema migrations — versioned, forward-only, idempotent.

   A minimal migration runner so schema changes (new columns, indexes, the
   pgvector table, the harness-version scheme, etc.) ship as ordered steps
   instead of ad-hoc CREATE-IF-NOT-EXISTS. Tracks what's applied in a
   `schema_migrations` table and runs only the pending ones, in order, each in a
   transaction.

   Migrations are defined in `migrations.mjs` as an ordered list of
   { id, name, up(exec) } — `up` receives an `exec(sql, params?)` that works
   against whichever backend is active. The runner is backend-agnostic: it's
   given an adapter with run()/get()/all(), so SQLite and Postgres share it, and
   tests drive it with a fake adapter.

   Usage (wired into `npm run migrate`):
     node server/migrate.mjs            # apply all pending
     node server/migrate.mjs --status   # list applied/pending without applying
*/

export async function runMigrations(adapter, migrations, { log = console } = {}) {
  await adapter.run(
    "CREATE TABLE IF NOT EXISTS schema_migrations (" +
    "id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)");

  const appliedRows = await adapter.all("SELECT id FROM schema_migrations");
  const applied = new Set(appliedRows.map((r) => r.id));

  const ordered = [...migrations].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const pending = ordered.filter((m) => !applied.has(m.id));

  if (pending.length === 0) {
    log.log?.("[migrate] up to date — no pending migrations");
    return { applied: [], alreadyApplied: ordered.length };
  }

  const done = [];
  for (const m of pending) {
    log.log?.(`[migrate] applying ${m.id} — ${m.name}`);
    await adapter.begin();
    try {
      await m.up((sql, params) => adapter.run(sql, params));
      await adapter.run(
        "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)",
        [m.id, m.name, Date.now()]);
      await adapter.commit();
      done.push(m.id);
    } catch (e) {
      await adapter.rollback();
      throw new Error(`migration ${m.id} (${m.name}) failed: ${e && e.message || e}`);
    }
  }
  log.log?.(`[migrate] applied ${done.length} migration(s): ${done.join(", ")}`);
  return { applied: done, alreadyApplied: applied.size };
}

export async function migrationStatus(adapter, migrations) {
  // tolerate a missing table (nothing applied yet)
  let applied = new Set();
  try {
    const rows = await adapter.all("SELECT id FROM schema_migrations");
    applied = new Set(rows.map((r) => r.id));
  } catch { /* table not created yet */ }
  const ordered = [...migrations].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return ordered.map((m) => ({ id: m.id, name: m.name, applied: applied.has(m.id) }));
}
