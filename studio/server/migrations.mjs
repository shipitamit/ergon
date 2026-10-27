/* Ordered schema migrations for the Studio accounts tier.

   Each entry: { id, name, up(exec) }, applied in id order exactly once. `exec`
   runs one statement against the active backend. Use plain, portable SQL where
   possible; where SQLite and Postgres differ, branch on the dialect via the
   adapter (see migrate_cli.mjs, which passes the dialect through).

   Forward-only: never edit an applied migration's `up` — add a new one. The
   baseline (0001) matches the tables the app has shipped, so an existing DB can
   adopt the migration system without a destructive rebuild (CREATE IF NOT
   EXISTS makes re-running the baseline a no-op on an already-populated DB).
*/

export const MIGRATIONS = [
  {
    id: "0001",
    name: "baseline schema (users, sessions, harnesses, shares, kv)",
    async up(exec) {
      await exec(
        "CREATE TABLE IF NOT EXISTS users (" +
        "id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL, created_at BIGINT NOT NULL)");
      await exec(
        "CREATE TABLE IF NOT EXISTS sessions (" +
        "token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at BIGINT NOT NULL)");
      await exec(
        "CREATE TABLE IF NOT EXISTS harnesses (" +
        "id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, " +
        "graph_json TEXT NOT NULL, updated_at BIGINT NOT NULL)");
      await exec(
        "CREATE TABLE IF NOT EXISTS shares (" +
        "harness_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, " +
        "PRIMARY KEY (harness_id, user_id))");
      await exec(
        "CREATE TABLE IF NOT EXISTS kv (" +
        "owner_id TEXT NOT NULL, harness_id TEXT, key TEXT NOT NULL, value TEXT NOT NULL, " +
        "PRIMARY KEY (owner_id, key))");
    },
  },
  {
    id: "0002",
    name: "index harnesses by owner for faster listing",
    async up(exec) {
      await exec("CREATE INDEX IF NOT EXISTS idx_harnesses_owner ON harnesses (owner_id)");
      await exec("CREATE INDEX IF NOT EXISTS idx_shares_user ON shares (user_id)");
    },
  },
  {
    id: "0003",
    name: "index sessions by user for cascade cleanup",
    async up(exec) {
      await exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)");
    },
  },
  {
    id: "0004",
    name: "organizations overlay (orgs, org_members, harnesses.org_id)",
    async up(exec) {
      await exec(
        "CREATE TABLE IF NOT EXISTS orgs (" +
        "id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at BIGINT NOT NULL, " +
        "personal INTEGER NOT NULL DEFAULT 0)");
      await exec(
        "CREATE TABLE IF NOT EXISTS org_members (" +
        "org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, " +
        "PRIMARY KEY (org_id, user_id))");
      // add org_id to harnesses (baseline 0001 has no such column; runs once)
      await exec("ALTER TABLE harnesses ADD COLUMN org_id TEXT");
      await exec("CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members (user_id)");
      await exec("CREATE INDEX IF NOT EXISTS idx_harnesses_org ON harnesses (org_id)");
    },
  },
  {
    id: "0005",
    name: "audit log (append-only, per org)",
    async up(exec) {
      await exec(
        "CREATE TABLE IF NOT EXISTS audit_log (" +
        "id TEXT PRIMARY KEY, org_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, " +
        "target_type TEXT, target_id TEXT, detail TEXT, ts BIGINT NOT NULL)");
      await exec("CREATE INDEX IF NOT EXISTS idx_audit_org_ts ON audit_log (org_id, ts)");
    },
  },
  {
    id: "0006",
    name: "SSO identities (OIDC subject → user)",
    async up(exec) {
      await exec(
        "CREATE TABLE IF NOT EXISTS identities (" +
        "provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, " +
        "created_at BIGINT NOT NULL, PRIMARY KEY (provider, subject))");
      await exec("CREATE INDEX IF NOT EXISTS idx_identities_user ON identities (user_id)");
    },
  },
  {
    id: "0007",
    name: "service accounts / API keys",
    async up(exec) {
      await exec(
        "CREATE TABLE IF NOT EXISTS api_keys (" +
        "id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, " +
        "role TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL, created_by TEXT, " +
        "created_at BIGINT NOT NULL, last_used_at BIGINT, revoked_at BIGINT)");
      await exec("CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys (org_id)");
    },
  },
  {
    id: "0008",
    name: "run history",
    async up(exec) {
      await exec(
        "CREATE TABLE IF NOT EXISTS runs (" +
        "id TEXT PRIMARY KEY, org_id TEXT NOT NULL, harness_id TEXT, harness_name TEXT, " +
        "input TEXT, output TEXT, status TEXT NOT NULL DEFAULT 'ok', started_at BIGINT, " +
        "finished_at BIGINT, latency_ms BIGINT, tokens_in BIGINT DEFAULT 0, tokens_out BIGINT DEFAULT 0, " +
        "cost REAL DEFAULT 0, steps TEXT, created_by TEXT, created_at BIGINT NOT NULL)");
      await exec("CREATE INDEX IF NOT EXISTS idx_runs_org_created ON runs (org_id, created_at)");
      await exec("CREATE INDEX IF NOT EXISTS idx_runs_harness ON runs (harness_id)");
    },
  },
  {
    id: "0009",
    name: "budgets & quotas",
    async up(exec) {
      await exec(
        "CREATE TABLE IF NOT EXISTS budgets (" +
        "id TEXT PRIMARY KEY, org_id TEXT NOT NULL, period TEXT NOT NULL, max_cost REAL, " +
        "max_requests BIGINT, created_by TEXT, created_at BIGINT NOT NULL, UNIQUE (org_id, period))");
      await exec("CREATE INDEX IF NOT EXISTS idx_budgets_org ON budgets (org_id)");
    },
  },
  {
    id: "0010",
    name: "deployments (hosted control plane)",
    async up(exec) {
      await exec(
        "CREATE TABLE IF NOT EXISTS deployments (" +
        "id TEXT PRIMARY KEY, org_id TEXT NOT NULL, harness_id TEXT, slug TEXT NOT NULL UNIQUE, " +
        "target_url TEXT, status TEXT NOT NULL DEFAULT 'active', created_by TEXT, created_at BIGINT NOT NULL)");
      await exec("CREATE INDEX IF NOT EXISTS idx_deployments_org ON deployments (org_id)");
    },
  },
  {
    id: "0011",
    name: "node-anchored comments (collaboration)",
    async up(exec) {
      await exec(
        "CREATE TABLE IF NOT EXISTS comments (" +
        "id TEXT PRIMARY KEY, harness_id TEXT NOT NULL, org_id TEXT, node_id TEXT, " +
        "author_id TEXT, body TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)");
      await exec("CREATE INDEX IF NOT EXISTS idx_comments_harness ON comments (harness_id)");
    },
  },
];
