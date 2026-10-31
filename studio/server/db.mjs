/* Data layer — SQLite.

   Tables:
     users     (id, email, pw_hash, created_at)
     sessions  (token, user_id, created_at)          ← auth cookies
     harnesses (id, owner_id, name, graph_json, updated_at)
     shares    (harness_id, user_id, role)            ← 'view' | 'edit'
     kv        (owner_id, harness_id, key, value)     ← run-sessions/timeline
                                                          (the storage.js keyspace)

   Driver: better-sqlite3 in production. If it isn't installed, falls back to
   Node's built-in node:sqlite (Node ≥ 22) so the data layer and its tests can
   run with zero external deps. Both expose the same prepare().get/run/all API,
   so the query logic below is identical either way. Swap this module for a
   Postgres-backed one with the same exports to scale; the SQL is portable.
*/
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextFireAfter, isValidCron } from "./cron.mjs";
import { seal, open as unseal, last4 as _last4 } from "./cryptobox.mjs";
import { getConnector, validateConnection, materialize } from "./connectors.mjs";
import { oauthConfigFor, refreshTokens, isExpired } from "./oauth-connections.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.ERGON_DB || path.join(ROOT, "ergon.db");

// ── driver: prefer better-sqlite3, else node:sqlite (built-in) ──
async function openDatabase() {
  try {
    const { default: Database } = await import("better-sqlite3");
    const d = new Database(DB_PATH);
    d.pragma("journal_mode = WAL");
    d.pragma("foreign_keys = ON");
    return d;
  } catch (e) {
    // built-in fallback — same prepare().get/run/all surface
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(DB_PATH);
    d.exec("PRAGMA journal_mode = WAL");
    d.exec("PRAGMA foreign_keys = ON");
    return d;
  }
}

// ── password hashing: prefer bcryptjs, else a salted scrypt via node:crypto ──
async function loadHasher() {
  try {
    const bcrypt = (await import("bcryptjs")).default;
    return {
      hashSync: (pw) => bcrypt.hashSync(pw, 10),
      compareSync: (pw, h) => {
        // a DB seeded under the scrypt fallback may hold scrypt hashes; verify those too
        if (String(h).startsWith("scrypt$")) return scryptCompare(pw, h);
        return bcrypt.compareSync(pw, h);
      },
    };
  } catch {
    return {
      hashSync: (pw) => {
        const salt = crypto.randomBytes(16);
        const dk = crypto.scryptSync(String(pw), salt, 32);
        return "scrypt$" + salt.toString("hex") + "$" + dk.toString("hex");
      },
      compareSync: scryptCompare,
    };
  }
}

function scryptCompare(pw, stored) {
  const [scheme, saltHex, dkHex] = String(stored).split("$");
  if (scheme !== "scrypt") return false;
  const dk = crypto.scryptSync(String(pw), Buffer.from(saltHex, "hex"), 32);
  const want = Buffer.from(dkHex, "hex");
  return dk.length === want.length && crypto.timingSafeEqual(dk, want);
}

const db = await openDatabase();
const bcrypt = await loadHasher();

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  pw_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orgs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  personal   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS org_members (
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE IF NOT EXISTS harnesses (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  org_id     TEXT REFERENCES orgs(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS shares (
  harness_id TEXT NOT NULL REFERENCES harnesses(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('view','edit')),
  PRIMARY KEY (harness_id, user_id)
);
CREATE TABLE IF NOT EXISTS kv (
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  harness_id TEXT,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org_ts ON audit_log (org_id, ts);
CREATE TABLE IF NOT EXISTS identities (
  provider   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities (user_id);
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin','member')),
  prefix       TEXT NOT NULL,
  hash         TEXT NOT NULL,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys (org_id);
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  harness_id   TEXT,
  harness_name TEXT,
  input        TEXT,
  output       TEXT,
  status       TEXT NOT NULL DEFAULT 'ok',
  started_at   INTEGER,
  finished_at  INTEGER,
  latency_ms   INTEGER,
  tokens_in    INTEGER DEFAULT 0,
  tokens_out   INTEGER DEFAULT 0,
  cost         REAL DEFAULT 0,
  steps        TEXT,
  created_by   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_org_created ON runs (org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_harness ON runs (harness_id);
CREATE TABLE IF NOT EXISTS alert_rules (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  metric       TEXT NOT NULL,
  comparator   TEXT NOT NULL,
  threshold    REAL NOT NULL,
  window_ms    INTEGER NOT NULL,
  harness_id   TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_state   TEXT NOT NULL DEFAULT 'ok',
  last_evaluated_at INTEGER,
  last_triggered_at INTEGER,
  created_by   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_org ON alert_rules (org_id);
CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules (enabled);
CREATE TABLE IF NOT EXISTS alert_events (
  id           TEXT PRIMARY KEY,
  rule_id      TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  org_id       TEXT NOT NULL,
  state        TEXT NOT NULL,
  value        REAL,
  threshold    REAL,
  message      TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_events_rule ON alert_events (rule_id, created_at);
CREATE INDEX IF NOT EXISTS idx_alert_events_org ON alert_events (org_id, created_at);
CREATE TABLE IF NOT EXISTS budgets (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  period       TEXT NOT NULL CHECK (period IN ('day','month','total')),
  max_cost     REAL,
  max_requests INTEGER,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE (org_id, period)
);
CREATE INDEX IF NOT EXISTS idx_budgets_org ON budgets (org_id);
CREATE TABLE IF NOT EXISTS deployments (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  harness_id  TEXT,
  slug        TEXT NOT NULL UNIQUE,
  target_url  TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deployments_org ON deployments (org_id);
CREATE TABLE IF NOT EXISTS managed_runners (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  harness_id    TEXT,
  deployment_id TEXT,
  slug          TEXT,
  driver        TEXT NOT NULL,
  machine_id    TEXT,
  region        TEXT,
  image         TEXT,
  status        TEXT NOT NULL DEFAULT 'provisioning',
  url           TEXT,
  detail        TEXT,
  api_key_id    TEXT,
  last_health_at INTEGER,
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_managed_runners_org ON managed_runners (org_id);
CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  harness_id  TEXT NOT NULL,
  org_id      TEXT,
  node_id     TEXT,
  author_id   TEXT,
  body        TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_harness ON comments (harness_id);

CREATE TABLE IF NOT EXISTS harness_versions (
  id          TEXT PRIMARY KEY,
  harness_id  TEXT NOT NULL,
  version     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  graph_json  TEXT NOT NULL,
  author_id   TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hv_harness ON harness_versions (harness_id, version);

CREATE TABLE IF NOT EXISTS triggers (
  id            TEXT PRIMARY KEY,
  harness_id    TEXT NOT NULL,
  org_id        TEXT,
  type          TEXT NOT NULL,              -- 'webhook' | 'schedule'
  token         TEXT,                       -- webhook: public ingress token (unique)
  cron          TEXT,                       -- schedule: 5-field cron (UTC)
  payload       TEXT,                       -- schedule: the input sent on each fire
  enabled       INTEGER NOT NULL DEFAULT 1,
  next_fire_at  INTEGER,                    -- schedule: next due time (ms)
  last_claimed_at INTEGER,                   -- schedule: when a worker last claimed a due slot
  last_fired_at INTEGER,
  last_status   TEXT,
  fire_count    INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_harness ON triggers (harness_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_triggers_token ON triggers (token);
CREATE INDEX IF NOT EXISTS idx_triggers_due ON triggers (type, enabled, next_fire_at);

CREATE TABLE IF NOT EXISTS trigger_fires (
  id            TEXT PRIMARY KEY,
  trigger_id    TEXT NOT NULL,
  org_id        TEXT,
  scheduled_for INTEGER,              -- the slot this fire covers (for idempotency)
  fired_at      INTEGER,
  status        TEXT NOT NULL DEFAULT 'claimed',
  run_id        TEXT,
  created_at    INTEGER NOT NULL
);
-- one durable fire record per (trigger, scheduled slot): a second worker that
-- races to the same slot hits this and does not double-fire.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_fires_occurrence ON trigger_fires (trigger_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_trigger_fires_trigger ON trigger_fires (trigger_id, created_at);

CREATE TABLE IF NOT EXISTS connections (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL,            -- catalog connector id
  name         TEXT NOT NULL,
  config       TEXT,                     -- JSON, non-secret fields
  secret       TEXT,                     -- sealed (AES-256-GCM); never returned to clients
  refresh      TEXT,                     -- sealed OAuth refresh token (if any)
  expires_at   INTEGER,                  -- OAuth access-token expiry (ms)
  last4        TEXT,                     -- display hint only
  status       TEXT NOT NULL DEFAULT 'active',
  created_by   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connections_org ON connections (org_id);
`);

// backward-compat for DBs created before the orgs overlay: add org_id if missing
try {
  const cols = db.prepare("PRAGMA table_info(harnesses)").all().map((c) => c.name);
  if (!cols.includes("org_id")) db.exec("ALTER TABLE harnesses ADD COLUMN org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL");
} catch { /* fresh DB already has the column */ }
// backward-compat: OAuth columns on connections created before the OAuth flow
try {
  const cc = db.prepare("PRAGMA table_info(connections)").all().map((c) => c.name);
  if (cc.length && !cc.includes("refresh")) db.exec("ALTER TABLE connections ADD COLUMN refresh TEXT");
  if (cc.length && !cc.includes("expires_at")) db.exec("ALTER TABLE connections ADD COLUMN expires_at INTEGER");
} catch { /* fresh DB already has them */ }
// backward-compat: the runner's scoped service key, for teardown revocation
try {
  const mr = db.prepare("PRAGMA table_info(managed_runners)").all().map((c) => c.name);
  if (mr.length && !mr.includes("api_key_id")) db.exec("ALTER TABLE managed_runners ADD COLUMN api_key_id TEXT");
} catch { /* fresh DB already has it */ }

const uid = (p) => `${p}_${crypto.randomBytes(9).toString("base64url")}`;
const now = () => Date.now();

// how an org role maps onto harness access: owner/admin edit, member views.
const _orgToHarness = (orgRole) => (orgRole === "owner" || orgRole === "admin") ? "edit" : "view";

/* ── users & auth ── */
// create the user row + their personal org (owner). Shared by password signup
// and SSO first-login so both land in the same pure org+RBAC world.
function _provisionUser(email, pwHash) {
  const id = uid("u");
  db.prepare("INSERT INTO users (id, email, pw_hash, created_at) VALUES (?,?,?,?)").run(id, email, pwHash, now());
  const oid = uid("o");
  db.prepare("INSERT INTO orgs (id, name, created_at, personal) VALUES (?,?,?,1)").run(oid, `${email}'s workspace`, now());
  db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,'owner')").run(oid, id);
  logAudit(oid, id, "user.create", { targetType: "user", targetId: id, detail: { email } });
  return { id, email, personalOrgId: oid };
}

export function createUser(email, password) {
  email = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email address.");
  if (String(password || "").length < 8) throw new Error("Password must be at least 8 characters.");
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new Error("That email is already registered.");
  const { id } = _provisionUser(email, bcrypt.hashSync(password, 10));
  return { id, email };
}

// SSO (OIDC) login: resolve the external identity to a local user, creating or
// linking as needed. `identity` = { provider, subject, email, emailVerified, name }.
//   1. known (provider, subject)  → that user
//   2. verified email matches an existing user → link the identity to it
//   3. otherwise → provision a fresh user (no password) + personal org
// A password can never be used to sign into an SSO-provisioned account (the
// stored hash is a non-verifiable sentinel).
export function findOrCreateUserByOidc(identity) {
  const { provider, subject } = identity;
  if (!provider || !subject) throw new Error("SSO identity is missing provider/subject.");
  const existing = db.prepare("SELECT u.id, u.email FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?").get(provider, subject);
  if (existing) return { id: existing.id, email: existing.email, created: false, linked: false };

  const email = identity.email ? String(identity.email).trim().toLowerCase() : null;
  let user, created = false, linked = false;
  if (email) {
    const byEmail = db.prepare("SELECT id, email FROM users WHERE email = ?").get(email);
    if (byEmail) {
      if (identity.emailVerified === false) throw new Error("This email is registered but the identity provider did not verify it.");
      user = byEmail; linked = true;
    }
  }
  if (!user) {
    if (!email) throw new Error("SSO login needs an email claim to create an account.");
    const prov = _provisionUser(email, "!sso");  // sentinel: no usable password
    user = { id: prov.id, email: prov.email }; created = true;
  }
  db.prepare("INSERT INTO identities (provider, subject, user_id, created_at) VALUES (?,?,?,?) ON CONFLICT(provider, subject) DO NOTHING")
    .run(provider, subject, user.id, now());
  // record the sign-in on the user's personal org for the audit trail
  const pid = personalOrgId(user.id);
  logAudit(pid, user.id, created ? "auth.sso_signup" : (linked ? "auth.sso_link" : "auth.sso_login"),
    { targetType: "user", targetId: user.id, detail: { provider, email } });
  return { id: user.id, email: user.email, created, linked };
}

export function verifyUser(email, password) {
  email = String(email || "").trim().toLowerCase();
  const row = db.prepare("SELECT id, email, pw_hash FROM users WHERE email = ?").get(email);
  if (!row || !bcrypt.compareSync(String(password || ""), row.pw_hash)) throw new Error("Wrong email or password.");
  return { id: row.id, email: row.email };
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)").run(token, userId, now());
  return token;
}
export function userForToken(token) {
  if (!token) return null;
  const row = db.prepare(
    "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?"
  ).get(token);
  return row || null;
}
export function destroySession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
function userByEmail(email) {
  return db.prepare("SELECT id, email FROM users WHERE email = ?").get(String(email || "").trim().toLowerCase());
}

/* ── org membership ── */
// a user's role in an org: 'owner' | 'admin' | 'member' | null
export function orgRoleFor(orgId, userId) {
  if (!orgId) return null;
  const r = db.prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?").get(orgId, userId);
  return r ? r.role : null;
}
// the user's personal org (their default workspace), created at signup
function personalOrgId(userId) {
  const r = db.prepare(`SELECT o.id FROM orgs o JOIN org_members m ON m.org_id = o.id
                        WHERE m.user_id = ? AND o.personal = 1 ORDER BY o.created_at LIMIT 1`).get(userId);
  return r ? r.id : null;
}

/* ── harness access helpers ── */
// a harness's access is purely the member's org role: owner/admin → 'edit',
// member → 'view', non-member → null. One lookup, one scope.
function roleFor(harnessId, userId) {
  const h = db.prepare("SELECT org_id FROM harnesses WHERE id = ?").get(harnessId);
  if (!h) return null;
  const orole = orgRoleFor(h.org_id, userId);
  return orole ? _orgToHarness(orole) : null;
}
const _canManage = (harnessId, userId) => {
  const h = db.prepare("SELECT org_id FROM harnesses WHERE id = ?").get(harnessId);
  return h && ["owner", "admin"].includes(orgRoleFor(h.org_id, userId));
};

/* ── harness CRUD ── */
export function listHarnesses(userId) {
  const rows = db.prepare(`
    SELECT h.id, h.name, h.updated_at, h.org_id, m.role AS org_role, o.name AS org_name
    FROM harnesses h
    JOIN org_members m ON m.org_id = h.org_id
    JOIN orgs o ON o.id = h.org_id
    WHERE m.user_id = ?`).all(userId);
  return rows.map((r) => {
    const owner = db.prepare("SELECT email FROM users u JOIN harnesses h ON h.owner_id = u.id WHERE h.id = ?").get(r.id);
    return { id: r.id, name: r.name, updated_at: r.updated_at, role: _orgToHarness(r.org_role),
             orgId: r.org_id, orgName: r.org_name, ownerEmail: owner?.email };
  }).sort((a, b) => b.updated_at - a.updated_at);
}

export function getHarness(harnessId, userId) {
  const role = roleFor(harnessId, userId);
  if (!role) throw new Error("Not found, or not in one of your organizations.");
  const h = db.prepare("SELECT id, name, graph_json, owner_id, org_id, updated_at FROM harnesses WHERE id = ?").get(harnessId);
  const owner = db.prepare("SELECT email FROM users WHERE id = ?").get(h.owner_id);
  const org = db.prepare("SELECT name FROM orgs WHERE id = ?").get(h.org_id);
  return { id: h.id, name: h.name, graph: JSON.parse(h.graph_json), role, ownerEmail: owner?.email,
           orgId: h.org_id, orgName: org?.name, updated_at: h.updated_at };
}

export class ConflictError extends Error {
  constructor(current) { super("The harness changed on the server since you opened it."); this.name = "ConflictError"; this.current = current; }
}

// keep a capped, append-only history of saves so the UI can show a timeline and
// diff/restore. Pruned to the most recent VERSION_CAP per harness.
const VERSION_CAP = 50;
function _recordVersion(harnessId, version, name, graph, authorId) {
  try {
    db.prepare("INSERT INTO harness_versions (id, harness_id, version, name, graph_json, author_id, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(uid("hv"), harnessId, version, name, JSON.stringify(graph), authorId || null, now());
    const extra = db.prepare("SELECT id FROM harness_versions WHERE harness_id = ? ORDER BY version DESC LIMIT -1 OFFSET ?").all(harnessId, VERSION_CAP);
    for (const r of extra) db.prepare("DELETE FROM harness_versions WHERE id = ?").run(r.id);
  } catch { /* history is best-effort; never block a save on it */ }
}

export function listVersions(harnessId, userId) {
  if (!roleFor(harnessId, userId)) throw new Error("You don't have access to this harness.");
  const rows = db.prepare(`SELECT v.id, v.version, v.name, v.author_id, v.created_at, v.graph_json, u.email AS author_email
    FROM harness_versions v LEFT JOIN users u ON u.id = v.author_id
    WHERE v.harness_id = ? ORDER BY v.version DESC`).all(harnessId);
  return rows.map((r) => {
    let nodeCount = 0, edgeCount = 0;
    try { const g = JSON.parse(r.graph_json); nodeCount = (g.nodes || []).length; edgeCount = (g.edges || []).length; } catch { /* ignore */ }
    return { id: r.id, version: r.version, name: r.name, authorEmail: r.author_email || null, createdAt: r.created_at, nodeCount, edgeCount };
  });
}

export function getVersion(harnessId, versionId, userId) {
  if (!roleFor(harnessId, userId)) throw new Error("You don't have access to this harness.");
  const r = db.prepare(`SELECT v.id, v.version, v.name, v.author_id, v.created_at, v.graph_json, u.email AS author_email
    FROM harness_versions v LEFT JOIN users u ON u.id = v.author_id
    WHERE v.id = ? AND v.harness_id = ?`).get(versionId, harnessId);
  if (!r) throw new Error("Version not found.");
  return { id: r.id, version: r.version, name: r.name, authorEmail: r.author_email || null, createdAt: r.created_at, graph: JSON.parse(r.graph_json) };
}

/* ── triggers: webhook + schedule entry points that start a run ── */
function _triggerRow(r) {
  if (!r) return null;
  return { id: r.id, harnessId: r.harness_id, orgId: r.org_id, type: r.type, token: r.token || null,
    cron: r.cron || null, payload: r.payload || null, enabled: !!r.enabled, nextFireAt: r.next_fire_at || null,
    lastFiredAt: r.last_fired_at || null, lastStatus: r.last_status || null, fireCount: r.fire_count || 0, createdBy: r.created_by || null, createdAt: r.created_at };
}

export function activeDeploymentForHarness(harnessId) {
  const d = db.prepare("SELECT id, org_id, slug, target_url FROM deployments WHERE harness_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(harnessId);
  return d ? { id: d.id, orgId: d.org_id, slug: d.slug, targetUrl: d.target_url } : null;
}

export function listTriggers(harnessId, userId) {
  if (!roleFor(harnessId, userId)) throw new Error("You don't have access to this harness.");
  return db.prepare("SELECT * FROM triggers WHERE harness_id = ? ORDER BY created_at DESC").all(harnessId).map(_triggerRow);
}

export function createTrigger(userId, harnessId, { type, cron = null, payload = null } = {}) {
  if (roleFor(harnessId, userId) !== "edit") throw new Error("You need edit access to add a trigger.");
  if (type !== "webhook" && type !== "schedule") throw new Error("Unknown trigger type.");
  const h = db.prepare("SELECT org_id FROM harnesses WHERE id = ?").get(harnessId);
  if (!h) throw new Error("Harness not found.");
  let token = null, nextFire = null;
  if (type === "webhook") token = crypto.randomBytes(18).toString("base64url");
  if (type === "schedule") {
    if (!isValidCron(cron)) throw new Error("Invalid cron expression (need 5 fields: minute hour day month weekday).");
    nextFire = nextFireAfter(cron, now());
  }
  const id = uid("trg");
  db.prepare(`INSERT INTO triggers (id, harness_id, org_id, type, token, cron, payload, enabled, next_fire_at, fire_count, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,1,?,0,?,?)`).run(id, harnessId, h.org_id, type, token, cron, payload, nextFire, userId, now());
  return _triggerRow(db.prepare("SELECT * FROM triggers WHERE id = ?").get(id));
}

export function updateTrigger(userId, triggerId, { enabled, cron, payload } = {}) {
  const t = db.prepare("SELECT * FROM triggers WHERE id = ?").get(triggerId);
  if (!t) throw new Error("Trigger not found.");
  if (roleFor(t.harness_id, userId) !== "edit") throw new Error("You need edit access to change a trigger.");
  let nextCron = t.cron, nextFire = t.next_fire_at, nextEnabled = t.enabled, nextPayload = t.payload;
  if (cron !== undefined && t.type === "schedule") {
    if (!isValidCron(cron)) throw new Error("Invalid cron expression.");
    nextCron = cron; nextFire = nextFireAfter(cron, now());
  }
  if (payload !== undefined) nextPayload = payload;
  if (enabled !== undefined) {
    nextEnabled = enabled ? 1 : 0;
    if (enabled && t.type === "schedule") nextFire = nextFireAfter(nextCron, now());   // re-enabling re-anchors the schedule
  }
  db.prepare("UPDATE triggers SET enabled = ?, cron = ?, payload = ?, next_fire_at = ? WHERE id = ?")
    .run(nextEnabled, nextCron, nextPayload, nextFire, triggerId);
  return _triggerRow(db.prepare("SELECT * FROM triggers WHERE id = ?").get(triggerId));
}

export function deleteTrigger(userId, triggerId) {
  const t = db.prepare("SELECT harness_id FROM triggers WHERE id = ?").get(triggerId);
  if (!t) throw new Error("Trigger not found.");
  if (roleFor(t.harness_id, userId) !== "edit") throw new Error("You need edit access to delete a trigger.");
  db.prepare("DELETE FROM triggers WHERE id = ?").run(triggerId);
  return { deleted: true };
}

// public lookup for the webhook ingress (no user context)
export function getTriggerByToken(token) {
  if (!token) return null;
  return _triggerRow(db.prepare("SELECT * FROM triggers WHERE token = ? AND type = 'webhook'").get(token));
}

// scheduler: enabled schedule triggers whose next fire is due (server-wide)
export function dueScheduleTriggers(nowMs = now(), limit = 100) {
  return db.prepare("SELECT * FROM triggers WHERE type = 'schedule' AND enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at ASC LIMIT ?")
    .all(nowMs, limit).map(_triggerRow);
}

export function markTriggerFired(triggerId, { firedAt = now(), status = "ok", nextFireAt = undefined } = {}) {
  if (nextFireAt === undefined) {
    db.prepare("UPDATE triggers SET last_fired_at = ?, last_status = ?, fire_count = fire_count + 1 WHERE id = ?").run(firedAt, status, triggerId);
  } else {
    db.prepare("UPDATE triggers SET last_fired_at = ?, last_status = ?, fire_count = fire_count + 1, next_fire_at = ? WHERE id = ?").run(firedAt, status, nextFireAt, triggerId);
  }
}

// Durable, coordinated claim: for each due schedule trigger, atomically advance
// its next_fire_at with a compare-and-swap on the exact value we read. Only the
// worker whose UPDATE changes the row has claimed that slot, so overlapping ticks
// and multiple instances never double-fire. A durable trigger_fires record is
// written per claimed slot (unique on (trigger, scheduled_for)) as the audit +
// idempotency backstop. Returns [{ trigger, fireId, scheduledFor }].
export function claimDueScheduleTriggers(nowMs = now(), limit = 100) {
  const due = db.prepare("SELECT * FROM triggers WHERE type = 'schedule' AND enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at ASC LIMIT ?").all(nowMs, limit);
  const claimed = [];
  for (const t of due) {
    const seen = t.next_fire_at;
    const next = isValidCron(t.cron) ? nextFireAfter(t.cron, nowMs) : null;
    const res = db.prepare("UPDATE triggers SET next_fire_at = ?, last_claimed_at = ? WHERE id = ? AND next_fire_at = ? AND enabled = 1").run(next, nowMs, t.id, seen);
    if (res.changes !== 1) continue;          // another worker claimed this slot
    const fireId = uid("fire");
    try {
      db.prepare("INSERT OR IGNORE INTO trigger_fires (id, trigger_id, org_id, scheduled_for, status, created_at) VALUES (?,?,?,?,?,?)")
        .run(fireId, t.id, t.org_id, seen, "claimed", nowMs);
    } catch { /* occurrence already recorded — idempotent */ }
    claimed.push({ trigger: _triggerRow(t), fireId, scheduledFor: seen });
  }
  return claimed;
}

export function recordFireResult(fireId, { status = "ok", runId = null, firedAt = now() } = {}) {
  const f = db.prepare("SELECT trigger_id FROM trigger_fires WHERE id = ?").get(fireId);
  db.prepare("UPDATE trigger_fires SET status = ?, run_id = ?, fired_at = ? WHERE id = ?").run(status, runId, firedAt, fireId);
  if (f) db.prepare("UPDATE triggers SET last_fired_at = ?, last_status = ?, fire_count = fire_count + 1 WHERE id = ?").run(firedAt, status, f.trigger_id);
}

export function listTriggerFires(triggerId, userId, limit = 50) {
  const t = db.prepare("SELECT harness_id FROM triggers WHERE id = ?").get(triggerId);
  if (!t || !roleFor(t.harness_id, userId)) throw new Error("You don't have access to this trigger.");
  return db.prepare("SELECT id, scheduled_for, fired_at, status, run_id, created_at FROM trigger_fires WHERE trigger_id = ? ORDER BY created_at DESC LIMIT ?").all(triggerId, limit);
}

/* ── managed connections: per-org, credential sealed at rest, secret-free reads ── */
function _connRow(r) {
  if (!r) return null;
  let config = {}; try { config = r.config ? JSON.parse(r.config) : {}; } catch { /* ignore */ }
  return { id: r.id, orgId: r.org_id, connectorId: r.connector_id, name: r.name, config,
    last4: r.last4 || null, configured: !!r.secret, authType: config.oauth ? "oauth" : "static",
    expiresAt: r.expires_at || null, status: r.status || "active", createdAt: r.created_at };
}
const _connManage = (orgId, userId) => { const role = orgRoleFor(orgId, userId); return role === "owner" || role === "admin"; };

export function listConnections(orgId, userId) {
  if (!orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  return db.prepare("SELECT * FROM connections WHERE org_id = ? ORDER BY created_at DESC").all(orgId).map(_connRow);
}

export function createConnection(orgId, userId, { connectorId, name, config = {}, secret = null } = {}) {
  if (!_connManage(orgId, userId)) throw new Error("Only an owner or admin can add a connection.");
  const v = validateConnection(connectorId, { name, config, secret });
  if (!v.ok) throw new Error(v.errors.join(" "));
  const id = uid("conn");
  db.prepare("INSERT INTO connections (id, org_id, connector_id, name, config, secret, last4, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, orgId, connectorId, String(name).trim(), JSON.stringify(config || {}), seal(secret), secret ? _last4(secret) : null, "active", userId, now());
  logAudit(orgId, userId, "connection.create", { targetType: "connection", targetId: id, detail: { connectorId, name } });
  return _connRow(db.prepare("SELECT * FROM connections WHERE id = ?").get(id));
}

export function updateConnection(orgId, userId, connectionId, { name, config, secret } = {}) {
  if (!_connManage(orgId, userId)) throw new Error("Only an owner or admin can change a connection.");
  const cur = db.prepare("SELECT * FROM connections WHERE id = ? AND org_id = ?").get(connectionId, orgId);
  if (!cur) throw new Error("Connection not found.");
  const nextName = name !== undefined ? String(name).trim() : cur.name;
  const nextConfig = config !== undefined ? JSON.stringify(config || {}) : cur.config;
  let nextSecret = cur.secret, nextLast4 = cur.last4;
  if (secret !== undefined && secret !== null && secret !== "") { nextSecret = seal(secret); nextLast4 = _last4(secret); }
  // re-validate against the (unchanged) connector
  const v = validateConnection(cur.connector_id, { name: nextName, config: config !== undefined ? config : JSON.parse(cur.config || "{}"), secret: nextSecret ? "set" : "" });
  if (!v.ok) throw new Error(v.errors.join(" "));
  db.prepare("UPDATE connections SET name = ?, config = ?, secret = ?, last4 = ? WHERE id = ?").run(nextName, nextConfig, nextSecret, nextLast4, connectionId);
  return _connRow(db.prepare("SELECT * FROM connections WHERE id = ?").get(connectionId));
}

export function deleteConnection(orgId, userId, connectionId) {
  if (!_connManage(orgId, userId)) throw new Error("Only an owner or admin can delete a connection.");
  db.prepare("DELETE FROM connections WHERE id = ? AND org_id = ?").run(connectionId, orgId);
  logAudit(orgId, userId, "connection.delete", { targetType: "connection", targetId: connectionId });
  return { deleted: true };
}

// server-only: resolve the decrypted secret for a runner/export. Never wired to a
// plain client route — the sealed value never leaves the server as plaintext
// except through an authorized resolution like this.
export function resolveConnectionSecret(connectionId, orgId) {
  const r = db.prepare("SELECT secret FROM connections WHERE id = ? AND org_id = ?").get(connectionId, orgId);
  return r && r.secret ? unseal(r.secret) : null;
}

// Create (or replace, per connector+name) a connection from an OAuth grant.
export function upsertOAuthConnection(orgId, userId, { connectorId, name, access, refresh = null, expiresAt = null, config = {} } = {}) {
  if (!_connManage(orgId, userId)) throw new Error("Only an owner or admin can add a connection.");
  const cfg = { ...config, oauth: true };
  const existing = db.prepare("SELECT id FROM connections WHERE org_id = ? AND connector_id = ? AND name = ?").get(orgId, connectorId, String(name).trim());
  if (existing) {
    db.prepare("UPDATE connections SET config = ?, secret = ?, refresh = ?, expires_at = ?, last4 = ? WHERE id = ?")
      .run(JSON.stringify(cfg), seal(access), refresh ? seal(refresh) : null, expiresAt, _last4(access), existing.id);
    return _connRow(db.prepare("SELECT * FROM connections WHERE id = ?").get(existing.id));
  }
  const id = uid("conn");
  db.prepare("INSERT INTO connections (id, org_id, connector_id, name, config, secret, refresh, expires_at, last4, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, orgId, connectorId, String(name).trim(), JSON.stringify(cfg), seal(access), refresh ? seal(refresh) : null, expiresAt, _last4(access), "active", userId, now());
  logAudit(orgId, userId, "connection.oauth", { targetType: "connection", targetId: id, detail: { connectorId, name } });
  return _connRow(db.prepare("SELECT * FROM connections WHERE id = ?").get(id));
}

// Runner-side resolver: decrypt (and, for OAuth, refresh if expired) the
// credential and shape it into run-time material. The one authorized path a
// plaintext credential leaves the server; callers must be in the org.
export async function resolveConnection(orgId, connectionId, { env = process.env, fetchImpl, redirectUri } = {}) {
  const r = db.prepare("SELECT * FROM connections WHERE id = ? AND org_id = ?").get(connectionId, orgId);
  if (!r) throw new Error("Connection not found.");
  let config = {}; try { config = r.config ? JSON.parse(r.config) : {}; } catch { /* ignore */ }
  let access = r.secret ? unseal(r.secret) : null;
  if (config.oauth && isExpired(r.expires_at) && r.refresh) {
    const connector = getConnector(r.connector_id);
    const oauthCfg = oauthConfigFor(connector, env);
    if (oauthCfg) {
      try {
        const t = await refreshTokens(oauthCfg, { refreshToken: unseal(r.refresh), redirectUri }, fetchImpl);
        access = t.access;
        db.prepare("UPDATE connections SET secret = ?, refresh = ?, expires_at = ?, last4 = ? WHERE id = ?")
          .run(seal(t.access), t.refresh ? seal(t.refresh) : r.refresh, t.expiresAt, _last4(t.access), r.id);
      } catch { /* refresh failed → fall back to the (possibly stale) token */ }
    }
  }
  return { id: r.id, connectorId: r.connector_id, name: r.name, authType: config.oauth ? "oauth" : "static", ...materialize(r.connector_id, { secret: access, config }) };
}

export function saveHarness(userId, { id, name, graph, orgId, expectedVersion, force }) {
  if (id) {
    if (roleFor(id, userId) !== "edit") throw new Error("You don't have edit access to this harness.");
    // optimistic concurrency: if the caller passed the version they loaded and
    // it no longer matches, refuse rather than clobber a newer edit.
    const curRow = db.prepare("SELECT updated_at FROM harnesses WHERE id = ?").get(id);
    const curVer = curRow ? Number(curRow.updated_at) : 0;
    if (!force && expectedVersion != null && curVer !== Number(expectedVersion)) {
      throw new ConflictError(getHarness(id, userId));
    }
    // strictly-monotonic version: wall-clock ms can repeat within a millisecond
    // under rapid saves, silently breaking the optimistic-concurrency check, so
    // always advance past the current version.
    const nextVer = Math.max(now(), curVer + 1);
    db.prepare("UPDATE harnesses SET name = ?, graph_json = ?, updated_at = ? WHERE id = ?")
      .run(name, JSON.stringify(graph), nextVer, id);
    _recordVersion(id, nextVer, name, graph, userId);
    const saved = getHarness(id, userId);
    logAudit(saved.orgId, userId, "harness.update", { targetType: "harness", targetId: id, detail: { name } });
    return saved;
  }
  // new harness: lands in the given org (caller must have edit there) or the
  // creator's personal org by default. owner_id records the creator.
  const targetOrg = orgId || personalOrgId(userId);
  if (!targetOrg) throw new Error("No organization to save into.");
  const orole = orgRoleFor(targetOrg, userId);
  if (!orole || orole === "member") throw new Error("You need edit access in that organization to create a harness.");
  const newId = uid("h");
  const createdVer = now();
  db.prepare("INSERT INTO harnesses (id, owner_id, name, graph_json, updated_at, org_id) VALUES (?,?,?,?,?,?)")
    .run(newId, userId, name, JSON.stringify(graph), createdVer, targetOrg);
  _recordVersion(newId, createdVer, name, graph, userId);
  logAudit(targetOrg, userId, "harness.create", { targetType: "harness", targetId: newId, detail: { name } });
  return getHarness(newId, userId);
}

export function deleteHarness(harnessId, userId) {
  if (!_canManage(harnessId, userId)) throw new Error("Only an org owner or admin can delete a harness.");
  const row = db.prepare("SELECT org_id, name FROM harnesses WHERE id = ?").get(harnessId);
  db.prepare("DELETE FROM harnesses WHERE id = ?").run(harnessId);
  if (row) logAudit(row.org_id, userId, "harness.delete", { targetType: "harness", targetId: harnessId, detail: { name: row.name } });
  return { deleted: true };
}

/* ── organizations (the RBAC overlay) ── */
export function createOrg(userId, name) {
  name = String(name || "").trim();
  if (!name) throw new Error("Organization name is required.");
  const id = uid("o");
  db.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?,?,?)").run(id, name, now());
  db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)").run(id, userId, "owner");
  logAudit(id, userId, "org.create", { detail: { name } });
  return { id, name, role: "owner" };
}

export function listOrgs(userId) {
  return db.prepare(`
    SELECT o.id, o.name, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id
    WHERE m.user_id = ? ORDER BY o.name`).all(userId);
}

export function listMembers(orgId, actorId) {
  if (!orgRoleFor(orgId, actorId)) throw new Error("Not a member of this organization.");
  // hide service-account users (API-key principals) from the human member list
  return db.prepare(`
    SELECT u.email, m.role FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? AND substr(u.id, 1, 5) <> 'svcu_' ORDER BY m.role, u.email`).all(orgId);
}

export function addMember(orgId, actorId, targetEmail, role) {
  const actorRole = orgRoleFor(orgId, actorId);
  if (actorRole !== "owner" && actorRole !== "admin") throw new Error("Only an owner or admin can add members.");
  if (!["owner", "admin", "member"].includes(role)) throw new Error("Role must be 'owner', 'admin', or 'member'.");
  if (role === "owner" && actorRole !== "owner") throw new Error("Only an owner can grant the owner role.");
  const target = userByEmail(targetEmail);
  if (!target) throw new Error(`No account for ${targetEmail}. They need to sign up first.`);
  db.prepare(`INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)
              ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role`)
    .run(orgId, target.id, role);
  logAudit(orgId, actorId, "member.add", { targetType: "user", targetId: target.id, detail: { email: targetEmail, role } });
  return listMembers(orgId, actorId);
}

export function removeMember(orgId, actorId, targetEmail) {
  const actorRole = orgRoleFor(orgId, actorId);
  if (actorRole !== "owner" && actorRole !== "admin") throw new Error("Only an owner or admin can remove members.");
  const target = userByEmail(targetEmail);
  if (!target) return listMembers(orgId, actorId);
  const targetRole = orgRoleFor(orgId, target.id);
  if (targetRole === "owner") {
    const owners = db.prepare("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role = 'owner'").get(orgId).n;
    if (owners <= 1) throw new Error("Can't remove the last owner of the organization.");
  }
  db.prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?").run(orgId, target.id);
  logAudit(orgId, actorId, "member.remove", { targetType: "user", targetId: target.id, detail: { email: targetEmail } });
  return listMembers(orgId, actorId);
}

// assign a harness to an org (or detach with orgId=null). Harness owner only;
// must be a member of the target org.
// move a harness to another org. Every harness always belongs to one org, so
// orgId is required; caller must manage the current org and have edit in the target.
export function setHarnessOrg(harnessId, userId, orgId) {
  if (!_canManage(harnessId, userId)) throw new Error("Only an org owner or admin can move this harness.");
  const orole = orgRoleFor(orgId, userId);
  if (!orole || orole === "member") throw new Error("You need edit access in the target organization.");
  const prev = db.prepare("SELECT org_id FROM harnesses WHERE id = ?").get(harnessId);
  const fromOrgId = prev ? prev.org_id : null;
  db.prepare("UPDATE harnesses SET org_id = ? WHERE id = ?").run(orgId, harnessId);
  const detail = { fromOrgId, toOrgId: orgId };
  logAudit(orgId, userId, "harness.move", { targetType: "harness", targetId: harnessId, detail });
  // also record the departure in the source org's log (when it differs)
  if (fromOrgId && fromOrgId !== orgId) logAudit(fromOrgId, userId, "harness.move", { targetType: "harness", targetId: harnessId, detail });
  return getHarness(harnessId, userId);
}

/* ── audit log (append-only, per org) ── */
export function logAudit(orgId, actorId, action, { targetType = null, targetId = null, detail = null } = {}) {
  if (!orgId) return;
  try {
    db.prepare("INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id, detail, ts) VALUES (?,?,?,?,?,?,?,?)")
      .run(uid("al"), orgId, actorId || null, action, targetType, targetId, detail ? JSON.stringify(detail) : null, now());
  } catch { /* audit is best-effort; it must never break the action it records */ }
}

export function listAudit(orgId, actorId, { limit = 100, before = null } = {}) {
  if (!["owner", "admin"].includes(orgRoleFor(orgId, actorId)))
    throw new Error("Only an org owner or admin can view the audit log.");
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = before
    ? db.prepare("SELECT a.*, u.email AS actor_email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.org_id = ? AND a.ts < ? ORDER BY a.ts DESC LIMIT ?").all(orgId, Number(before), lim)
    : db.prepare("SELECT a.*, u.email AS actor_email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.org_id = ? ORDER BY a.ts DESC LIMIT ?").all(orgId, lim);
  return rows.map((r) => ({ id: r.id, ts: r.ts, actorId: r.actor_id, actorEmail: r.actor_email || null,
    action: r.action, targetType: r.target_type, targetId: r.target_id, detail: r.detail ? JSON.parse(r.detail) : null }));
}

/* ── service accounts / API keys (programmatic org access) ──
   Each key is backed by a service-account user (id "svcu_…", no password) that
   is a member of the key's org with the key's role — so all the existing org
   RBAC and audit logic applies unchanged. The plaintext secret is shown exactly
   once; only its SHA-256 is stored. Keys carry at most 'admin' (edit) or
   'member' (view) — never 'owner'. listMembers hides the backing svc users. */
export function createApiKey(orgId, actorId, name, role = "member") {
  const arole = orgRoleFor(orgId, actorId);
  if (arole !== "owner" && arole !== "admin") throw new Error("Only an owner or admin can create API keys.");
  role = role === "admin" ? "admin" : "member";
  name = String(name || "").trim() || "API key";
  const keyId = uid("esk");
  const secret = `${keyId}.${crypto.randomBytes(24).toString("base64url")}`;
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  const prefix = secret.slice(0, 14) + "…";
  const svc = `svcu_${crypto.randomBytes(9).toString("base64url")}`;
  db.prepare("INSERT INTO users (id, email, pw_hash, created_at) VALUES (?,?,?,?)").run(svc, `${keyId}@keys.ergon.local`, "!key", now());
  db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)").run(orgId, svc, role);
  db.prepare("INSERT INTO api_keys (id, org_id, user_id, name, role, prefix, hash, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(keyId, orgId, svc, name, role, prefix, hash, actorId, now());
  logAudit(orgId, actorId, "apikey.create", { targetType: "apikey", targetId: keyId, detail: { name, role } });
  return { id: keyId, name, role, prefix, secret };   // secret shown once; never retrievable again
}

export function listApiKeys(orgId, actorId) {
  const arole = orgRoleFor(orgId, actorId);
  if (arole !== "owner" && arole !== "admin") throw new Error("Only an owner or admin can view API keys.");
  const rows = db.prepare(`SELECT k.id, k.name, k.role, k.prefix, k.created_at, k.last_used_at, k.revoked_at, u.email AS created_by
    FROM api_keys k LEFT JOIN users u ON u.id = k.created_by WHERE k.org_id = ? ORDER BY k.created_at DESC`).all(orgId);
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, prefix: r.prefix, createdAt: r.created_at,
    lastUsedAt: r.last_used_at, revokedAt: r.revoked_at, createdBy: r.created_by || null }));
}

export function revokeApiKey(orgId, actorId, keyId) {
  const arole = orgRoleFor(orgId, actorId);
  if (arole !== "owner" && arole !== "admin") throw new Error("Only an owner or admin can revoke API keys.");
  const row = db.prepare("SELECT user_id, revoked_at FROM api_keys WHERE id = ? AND org_id = ?").get(keyId, orgId);
  if (!row) throw new Error("API key not found.");
  if (!row.revoked_at) {
    db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(now(), keyId);
    db.prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?").run(orgId, row.user_id);  // cut access now
    logAudit(orgId, actorId, "apikey.revoke", { targetType: "apikey", targetId: keyId });
  }
  return { revoked: true };
}

// resolve a bearer secret to a principal usable as `me`, or null. Constant-time.
export function verifyApiKey(secret) {
  const s = String(secret || "");
  const dot = s.indexOf(".");
  if (dot < 1 || !s.startsWith("esk_")) return null;
  const keyId = s.slice(0, dot);
  const row = db.prepare("SELECT id, org_id, user_id, revoked_at, hash FROM api_keys WHERE id = ?").get(keyId);
  if (!row || row.revoked_at) return null;
  const want = Buffer.from(row.hash, "hex");
  const got = crypto.createHash("sha256").update(s).digest();
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), keyId);
  const u = db.prepare("SELECT id, email FROM users WHERE id = ?").get(row.user_id);
  if (!u) return null;
  return { id: u.id, email: u.email, orgId: row.org_id, keyId: row.id, apiKey: true };
}

/* ── run history (per org; a persisted record of each harness run) ──
   Access = org membership (running is not privileged): any member of the run's
   org can record and view. Retention keeps the newest ERGON_RUNS_KEEP per org. */
const RUNS_KEEP = Math.max(1, Number(process.env.ERGON_RUNS_KEEP) || 500);

function _orgForRun(userId, { harnessId, orgId }) {
  if (harnessId) {
    const h = db.prepare("SELECT org_id FROM harnesses WHERE id = ?").get(harnessId);
    if (h) return h.org_id;
  }
  return orgId || null;
}

export function recordRun(userId, rec = {}) {
  const org = _orgForRun(userId, rec);
  if (!org) throw new Error("A run needs a harnessId or orgId.");
  if (!orgRoleFor(org, userId)) throw new Error("Not a member of this organization.");
  const gate = checkBudget(org);
  if (!gate.allowed) { const e = new Error(`Organization budget exceeded: ${gate.reason}`); e.code = "budget"; throw e; }
  const u = rec.usage || {};
  const id = uid("run");
  db.prepare(`INSERT INTO runs (id, org_id, harness_id, harness_name, input, output, status,
      started_at, finished_at, latency_ms, tokens_in, tokens_out, cost, steps, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, org, rec.harnessId || null, rec.harnessName || null,
    rec.input || "", rec.output || "", rec.status || "ok",
    rec.startedAt || null, rec.finishedAt || null, rec.latencyMs || null,
    u.input_tokens || 0, u.output_tokens || 0, u.cost || 0,
    rec.steps ? JSON.stringify(rec.steps) : null, userId, now());
  _pruneRuns(org);
  return { id, orgId: org };
}

function _pruneRuns(org) {
  // keep the newest RUNS_KEEP for the org; delete the rest
  try {
    db.prepare(`DELETE FROM runs WHERE org_id = ? AND id NOT IN (
      SELECT id FROM runs WHERE org_id = ? ORDER BY created_at DESC LIMIT ?)`).run(org, org, RUNS_KEEP);
  } catch { /* best-effort */ }
}

export function listRuns(userId, { orgId, harnessId = null, limit = 50, before = null } = {}) {
  if (!orgId) throw new Error("orgId is required.");
  if (!orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const clauses = ["org_id = ?"]; const args = [orgId];
  if (harnessId) { clauses.push("harness_id = ?"); args.push(harnessId); }
  if (before) { clauses.push("created_at < ?"); args.push(Number(before)); }
  const rows = db.prepare(`SELECT id, harness_id, harness_name, status, started_at, finished_at,
      latency_ms, tokens_in, tokens_out, cost, created_at, created_by, substr(input,1,200) AS input_preview
    FROM runs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...args, lim);
  return rows.map(_runSummary);
}

/* Trace search: richer filtering over runs than listRuns — status / failures,
   a text query across input+output, latency/cost floors, and a time window.
   Org-scoped; newest-first; cursor via `before`. */
export function searchRuns(userId, { orgId, q = null, status = null, failed = false,
    harnessId = null, from = null, to = null, minLatencyMs = null, minCost = null,
    limit = 50, before = null } = {}) {
  if (!orgId) throw new Error("orgId is required.");
  if (!orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const clauses = ["org_id = ?"]; const args = [orgId];
  if (status) { clauses.push("status = ?"); args.push(status); }
  if (failed) { clauses.push("status != 'ok'"); }
  if (harnessId) { clauses.push("harness_id = ?"); args.push(harnessId); }
  if (from != null) { clauses.push("created_at >= ?"); args.push(Number(from)); }
  if (to != null) { clauses.push("created_at < ?"); args.push(Number(to)); }
  if (minLatencyMs != null) { clauses.push("latency_ms >= ?"); args.push(Number(minLatencyMs)); }
  if (minCost != null) { clauses.push("cost >= ?"); args.push(Number(minCost)); }
  if (before != null) { clauses.push("created_at < ?"); args.push(Number(before)); }
  if (q) {
    clauses.push("(lower(input) LIKE ? OR lower(output) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`; args.push(like, like);
  }
  const rows = db.prepare(`SELECT id, harness_id, harness_name, status, started_at, finished_at,
      latency_ms, tokens_in, tokens_out, cost, created_at, created_by, substr(input,1,200) AS input_preview
    FROM runs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...args, lim);
  return rows.map(_runSummary);
}

export function getRun(userId, runId) {
  const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  if (!r) throw new Error("Run not found.");
  if (!orgRoleFor(r.org_id, userId)) throw new Error("Not a member of this organization.");
  return {
    ..._runSummary(r),
    orgId: r.org_id, input: r.input, output: r.output,
    steps: r.steps ? JSON.parse(r.steps) : [],
  };
}

function _runSummary(r) {
  return {
    id: r.id, harnessId: r.harness_id, harnessName: r.harness_name, status: r.status,
    startedAt: r.started_at, finishedAt: r.finished_at, latencyMs: r.latency_ms,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out, cost: r.cost,
    createdAt: r.created_at, createdBy: r.created_by,
    inputPreview: r.input_preview !== undefined ? r.input_preview : (r.input || "").slice(0, 200),
  };
}

/* ── observability: aggregate metrics over the runs store ──
   Powers the analytics dashboard (volume, success/error rate, latency
   percentiles, token/cost over time) on top of the same per-run records the
   trace viewer uses. Org-scoped (any member may read); runs are retention-
   capped per org, so the percentile pass over latencies is bounded. */
function _percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function metricsSummary(userId, { orgId, from = null, to = null, bucket = "day", harnessId = null } = {}) {
  if (!orgId) throw new Error("orgId is required.");
  if (!orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  const toMs = Number(to) || now();
  const fromMs = Number(from) || (toMs - 7 * 86400_000);
  const bucketMs = bucket === "hour" ? 3600_000 : 86400_000;
  const clauses = ["org_id = ?", "created_at >= ?", "created_at < ?"];
  const args = [orgId, fromMs, toMs];
  if (harnessId) { clauses.push("harness_id = ?"); args.push(harnessId); }
  const where = clauses.join(" AND ");

  const t = db.prepare(`SELECT COUNT(*) AS runs,
      COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors,
      COALESCE(SUM(tokens_in),0) AS tokens_in, COALESCE(SUM(tokens_out),0) AS tokens_out,
      COALESCE(SUM(cost),0) AS cost, AVG(latency_ms) AS avg_latency
    FROM runs WHERE ${where}`).get(...args);

  const lats = db.prepare(`SELECT latency_ms FROM runs WHERE ${where}
      AND latency_ms IS NOT NULL ORDER BY latency_ms`).all(...args).map((r) => r.latency_ms);

  const series = db.prepare(`SELECT CAST(created_at / ? AS INTEGER) * ? AS t, COUNT(*) AS runs,
      COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors,
      COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(tokens_in),0) AS tokens_in,
      COALESCE(SUM(tokens_out),0) AS tokens_out, AVG(latency_ms) AS avg_latency
    FROM runs WHERE ${where} GROUP BY t ORDER BY t`).all(bucketMs, bucketMs, ...args);

  const byHarness = db.prepare(`SELECT harness_id, harness_name, COUNT(*) AS runs,
      COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors,
      COALESCE(SUM(cost),0) AS cost
    FROM runs WHERE ${where} GROUP BY harness_id, harness_name ORDER BY runs DESC LIMIT 10`).all(...args);

  const runs = t.runs || 0;
  return {
    range: { from: fromMs, to: toMs, bucket },
    totals: {
      runs, errors: t.errors || 0,
      successRate: runs ? (runs - (t.errors || 0)) / runs : null,
      tokensIn: t.tokens_in || 0, tokensOut: t.tokens_out || 0, cost: t.cost || 0,
      latencyAvg: t.avg_latency != null ? Math.round(t.avg_latency) : null,
      latencyP50: _percentile(lats, 0.5), latencyP95: _percentile(lats, 0.95),
    },
    series: series.map((s) => ({
      t: s.t, runs: s.runs, errors: s.errors, cost: s.cost,
      tokensIn: s.tokens_in, tokensOut: s.tokens_out,
      avgLatency: s.avg_latency != null ? Math.round(s.avg_latency) : null,
    })),
    byHarness: byHarness.map((h) => ({
      harnessId: h.harness_id, harnessName: h.harness_name,
      runs: h.runs, errors: h.errors, cost: h.cost,
    })),
  };
}

/* ── alerting: rules over the metrics, and the events they emit ──
   A rule watches one metric over a lookback window and fires when it crosses a
   threshold. Evaluation is server-side (no user) and records an event on each
   state transition (ok→firing, firing→ok). Owner/admin manage rules; any member
   may read rules + events. The evaluator (alerts.mjs) drives the no-user
   helpers below. */
const ALERT_METRICS = ["error_rate", "spend", "latency_p95", "run_count"];

function _alertRule(r) {
  return {
    id: r.id, orgId: r.org_id, name: r.name, metric: r.metric, comparator: r.comparator,
    threshold: r.threshold, windowMs: r.window_ms, harnessId: r.harness_id,
    enabled: !!r.enabled, lastState: r.last_state,
    lastEvaluatedAt: r.last_evaluated_at, lastTriggeredAt: r.last_triggered_at,
    createdBy: r.created_by, createdAt: r.created_at,
  };
}

export function createAlertRule(orgId, userId, { name, metric, comparator, threshold, windowMs, harnessId = null } = {}) {
  const role = orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can manage alerts.");
  if (!name) throw new Error("An alert needs a name.");
  if (!ALERT_METRICS.includes(metric)) throw new Error(`metric must be one of ${ALERT_METRICS.join(", ")}.`);
  if (comparator !== ">" && comparator !== "<") throw new Error("comparator must be '>' or '<'.");
  if (threshold == null || isNaN(Number(threshold))) throw new Error("threshold must be a number.");
  if (!windowMs || Number(windowMs) <= 0) throw new Error("windowMs must be a positive number.");
  const id = uid("alr");
  db.prepare(`INSERT INTO alert_rules (id, org_id, name, metric, comparator, threshold, window_ms,
      harness_id, enabled, last_state, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,1,'ok',?,?)`).run(
    id, orgId, name, metric, comparator, Number(threshold), Number(windowMs),
    harnessId || null, userId, now());
  return _alertRule(db.prepare("SELECT * FROM alert_rules WHERE id = ?").get(id));
}

export function listAlertRules(orgId, userId) {
  if (!orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  return db.prepare("SELECT * FROM alert_rules WHERE org_id = ? ORDER BY created_at DESC").all(orgId).map(_alertRule);
}

export function updateAlertRule(userId, ruleId, patch = {}) {
  const r = db.prepare("SELECT * FROM alert_rules WHERE id = ?").get(ruleId);
  if (!r) throw new Error("Alert rule not found.");
  const role = orgRoleFor(r.org_id, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can manage alerts.");
  const next = {
    name: patch.name ?? r.name,
    comparator: patch.comparator ?? r.comparator,
    threshold: patch.threshold != null ? Number(patch.threshold) : r.threshold,
    window_ms: patch.windowMs != null ? Number(patch.windowMs) : r.window_ms,
    harness_id: patch.harnessId !== undefined ? (patch.harnessId || null) : r.harness_id,
    enabled: patch.enabled != null ? (patch.enabled ? 1 : 0) : r.enabled,
  };
  if (next.comparator !== ">" && next.comparator !== "<") throw new Error("comparator must be '>' or '<'.");
  db.prepare(`UPDATE alert_rules SET name=?, comparator=?, threshold=?, window_ms=?, harness_id=?, enabled=?
    WHERE id=?`).run(next.name, next.comparator, next.threshold, next.window_ms, next.harness_id, next.enabled, ruleId);
  return _alertRule(db.prepare("SELECT * FROM alert_rules WHERE id = ?").get(ruleId));
}

export function deleteAlertRule(userId, ruleId) {
  const r = db.prepare("SELECT * FROM alert_rules WHERE id = ?").get(ruleId);
  if (!r) throw new Error("Alert rule not found.");
  const role = orgRoleFor(r.org_id, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can manage alerts.");
  db.prepare("DELETE FROM alert_rules WHERE id = ?").run(ruleId);
  return { ok: true };
}

export function listAlertEvents(orgId, userId, { limit = 50 } = {}) {
  if (!orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db.prepare(`SELECT id, rule_id, org_id, state, value, threshold, message, created_at
    FROM alert_events WHERE org_id = ? ORDER BY created_at DESC LIMIT ?`).all(orgId, lim)
    .map((e) => ({ id: e.id, ruleId: e.rule_id, orgId: e.org_id, state: e.state,
      value: e.value, threshold: e.threshold, message: e.message, createdAt: e.created_at }));
}

// ── server-side evaluator helpers (no user; driven by alerts.mjs) ──
export function allEnabledAlertRules() {
  return db.prepare("SELECT * FROM alert_rules WHERE enabled = 1").all().map(_alertRule);
}

export function alertAggregate(orgId, { windowMs, harnessId = null, now: nowMs = now() } = {}) {
  const fromMs = nowMs - Number(windowMs || 0);
  // the window ends inclusively at `now` so a run recorded in the same ms as
  // evaluation is counted (a strict upper bound drops it, breaking fast ticks).
  const clauses = ["org_id = ?", "created_at >= ?", "created_at <= ?"]; const args = [orgId, fromMs, nowMs];
  if (harnessId) { clauses.push("harness_id = ?"); args.push(harnessId); }
  const where = clauses.join(" AND ");
  const t = db.prepare(`SELECT COUNT(*) AS runs,
      COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors,
      COALESCE(SUM(cost),0) AS spend FROM runs WHERE ${where}`).get(...args);
  const lats = db.prepare(`SELECT latency_ms FROM runs WHERE ${where}
      AND latency_ms IS NOT NULL ORDER BY latency_ms`).all(...args).map((r) => r.latency_ms);
  const runs = t.runs || 0;
  return { runs, errors: t.errors || 0, errorRate: runs ? (t.errors || 0) / runs : 0,
           spend: t.spend || 0, latencyP95: _percentile(lats, 0.95) };
}

export function recordAlertEvent(ruleId, orgId, { state, value = null, threshold = null, message = null } = {}) {
  const id = uid("ale");
  db.prepare(`INSERT INTO alert_events (id, rule_id, org_id, state, value, threshold, message, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, ruleId, orgId, state, value, threshold, message, now());
  return { id };
}

export function setAlertRuleState(ruleId, { state, evaluatedAt = now(), triggeredAt = undefined } = {}) {
  if (triggeredAt !== undefined) {
    db.prepare("UPDATE alert_rules SET last_state=?, last_evaluated_at=?, last_triggered_at=? WHERE id=?")
      .run(state, evaluatedAt, triggeredAt, ruleId);
  } else {
    db.prepare("UPDATE alert_rules SET last_state=?, last_evaluated_at=? WHERE id=?")
      .run(state, evaluatedAt, ruleId);
  }
}

/* ── budgets & quotas (per org; spend caps + request quotas) ──
   Enforced at run admission: budgets are computed from recorded run spend, so
   once recorded spend/requests in the period reach a cap, further runs are
   refused. Owner/admin manage caps; any member can read status. */
function _windowStart(period, nowMs = now()) {
  if (period === "total") return 0;
  const d = new Date(nowMs);
  if (period === "day") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);   // 'month'
}

function _spendSince(org, startMs) {
  const r = db.prepare("SELECT COALESCE(SUM(cost),0) AS cost, COUNT(*) AS n FROM runs WHERE org_id = ? AND created_at >= ?").get(org, startMs);
  return { cost: r.cost || 0, requests: r.n || 0 };
}

export function setBudget(orgId, userId, { period, maxCost = null, maxRequests = null }) {
  const role = orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can set budgets.");
  if (!["day", "month", "total"].includes(period)) throw new Error("period must be 'day', 'month', or 'total'.");
  if (maxCost == null && maxRequests == null) throw new Error("Set at least one of maxCost or maxRequests.");
  db.prepare(`INSERT INTO budgets (id, org_id, period, max_cost, max_requests, created_by, created_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(org_id, period) DO UPDATE SET max_cost = excluded.max_cost,
        max_requests = excluded.max_requests, created_by = excluded.created_by`)
    .run(uid("bud"), orgId, period, maxCost, maxRequests, userId, now());
  logAudit(orgId, userId, "budget.set", { targetType: "budget", detail: { period, maxCost, maxRequests } });
  return listBudgets(orgId, userId);
}

export function listBudgets(orgId, userId) {
  const role = orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can view budgets.");
  return db.prepare("SELECT id, period, max_cost, max_requests FROM budgets WHERE org_id = ? ORDER BY period").all(orgId)
    .map((b) => ({ id: b.id, period: b.period, maxCost: b.max_cost, maxRequests: b.max_requests }));
}

export function deleteBudget(orgId, userId, budgetId) {
  const role = orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can delete budgets.");
  db.prepare("DELETE FROM budgets WHERE id = ? AND org_id = ?").run(budgetId, orgId);
  logAudit(orgId, userId, "budget.delete", { targetType: "budget", targetId: budgetId });
  return { deleted: true };
}

export function budgetStatus(orgId, userId) {
  if (!orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  const rows = db.prepare("SELECT period, max_cost, max_requests FROM budgets WHERE org_id = ? ORDER BY period").all(orgId);
  return rows.map((b) => {
    const { cost, requests } = _spendSince(orgId, _windowStart(b.period));
    return {
      period: b.period, maxCost: b.max_cost, maxRequests: b.max_requests,
      spend: Math.round(cost * 1e6) / 1e6, requests,
      costExceeded: b.max_cost != null && cost >= b.max_cost,
      requestsExceeded: b.max_requests != null && requests >= b.max_requests,
    };
  });
}

// internal gate: is the org clear to admit another run? (no RBAC — server-side)
export function checkBudget(orgId) {
  if (!orgId) return { allowed: true };
  const rows = db.prepare("SELECT period, max_cost, max_requests FROM budgets WHERE org_id = ?").all(orgId);
  for (const b of rows) {
    const { cost, requests } = _spendSince(orgId, _windowStart(b.period));
    if (b.max_cost != null && cost >= b.max_cost)
      return { allowed: false, reason: `spend cap reached ($${b.max_cost} / ${b.period})` };
    if (b.max_requests != null && requests >= b.max_requests)
      return { allowed: false, reason: `request quota reached (${b.max_requests} / ${b.period})` };
  }
  return { allowed: true };
}

/* ── deployments (hosted control plane) ──
   A harness published under an org as a named endpoint. The public gateway
   resolves a slug → deployment, authenticates with the org's API key, enforces
   budget + limits, records the run, and forwards to the registered runner
   (`target_url`, an `ergon serve` instance). Owner/admin manage; the gateway
   resolves without RBAC (it key-authenticates the caller itself). */
const _slugOk = (s) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(String(s || ""));

export function createDeployment(orgId, userId, { slug, harnessId = null, targetUrl = null }) {
  const role = orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can create deployments.");
  slug = String(slug || "").trim().toLowerCase();
  if (!_slugOk(slug)) throw new Error("slug must be 2–63 chars: lowercase letters, digits, hyphens.");
  if (targetUrl != null && !/^https?:\/\//.test(targetUrl)) throw new Error("targetUrl must be an http(s) URL.");
  if (db.prepare("SELECT 1 FROM deployments WHERE slug = ?").get(slug)) throw new Error(`The slug '${slug}' is already taken.`);
  const id = uid("dep");
  db.prepare(`INSERT INTO deployments (id, org_id, harness_id, slug, target_url, status, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, orgId, harnessId, slug, targetUrl, "active", userId, now());
  logAudit(orgId, userId, "deployment.create", { targetType: "deployment", targetId: id, detail: { slug, harnessId } });
  return { id, slug, harnessId, targetUrl, status: "active" };
}

export function listDeployments(orgId, userId) {
  if (!orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  return db.prepare("SELECT id, harness_id, slug, target_url, status, created_at, created_by FROM deployments WHERE org_id = ? ORDER BY created_at DESC").all(orgId)
    .map((d) => ({ id: d.id, harnessId: d.harness_id, slug: d.slug, targetUrl: d.target_url, status: d.status, createdAt: d.created_at, createdBy: d.created_by }));
}

export function deleteDeployment(orgId, userId, depId) {
  const role = orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can delete deployments.");
  db.prepare("DELETE FROM deployments WHERE id = ? AND org_id = ?").run(depId, orgId);
  logAudit(orgId, userId, "deployment.delete", { targetType: "deployment", targetId: depId });
  return { deleted: true };
}

/* ── managed runners: Ergon-operated runner instances for a harness ──
   A managed runner is a runner process Ergon launches and operates (via a
   machines driver), as opposed to a deployment whose target_url the operator
   runs themselves. The lifecycle service (hosting.mjs) drives these; once a
   runner is ready it registers a deployment so the existing gateway routes to
   it unchanged. Owner/admin provision + mutate; any member may read. */
function _managedRunner(r) {
  return {
    id: r.id, orgId: r.org_id, harnessId: r.harness_id, deploymentId: r.deployment_id,
    slug: r.slug, driver: r.driver, machineId: r.machine_id, region: r.region, image: r.image,
    status: r.status, url: r.url, detail: r.detail, apiKeyId: r.api_key_id, lastHealthAt: r.last_health_at,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function createManagedRunner(orgId, userId, { harnessId = null, slug = null, driver, region = null, image = null } = {}) {
  const role = orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can provision runners.");
  if (!driver) throw new Error("A machines driver is required.");
  const id = uid("run");
  const t = now();
  db.prepare(`INSERT INTO managed_runners (id, org_id, harness_id, slug, driver, region, image, status, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,'provisioning',?,?,?)`).run(id, orgId, harnessId, slug, driver, region, image, userId, t, t);
  logAudit(orgId, userId, "runner.provision", { targetType: "runner", targetId: id, detail: { harnessId, slug, driver } });
  return _managedRunner(db.prepare("SELECT * FROM managed_runners WHERE id = ?").get(id));
}

export function getManagedRunner(userId, runnerId) {
  const r = db.prepare("SELECT * FROM managed_runners WHERE id = ?").get(runnerId);
  if (!r) throw new Error("Runner not found.");
  if (!orgRoleFor(r.org_id, userId)) throw new Error("Not a member of this organization.");
  return _managedRunner(r);
}

export function listManagedRunners(orgId, userId) {
  if (!orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  return db.prepare("SELECT * FROM managed_runners WHERE org_id = ? ORDER BY created_at DESC").all(orgId).map(_managedRunner);
}

// internal: the lifecycle service updates runner state (RBAC already enforced on entry)
export function updateManagedRunner(runnerId, patch = {}) {
  const r = db.prepare("SELECT * FROM managed_runners WHERE id = ?").get(runnerId);
  if (!r) throw new Error("Runner not found.");
  const f = {
    deployment_id: patch.deploymentId !== undefined ? patch.deploymentId : r.deployment_id,
    slug: patch.slug !== undefined ? patch.slug : r.slug,
    machine_id: patch.machineId !== undefined ? patch.machineId : r.machine_id,
    region: patch.region !== undefined ? patch.region : r.region,
    image: patch.image !== undefined ? patch.image : r.image,
    status: patch.status !== undefined ? patch.status : r.status,
    url: patch.url !== undefined ? patch.url : r.url,
    detail: patch.detail !== undefined ? patch.detail : r.detail,
    api_key_id: patch.apiKeyId !== undefined ? patch.apiKeyId : r.api_key_id,
    last_health_at: patch.lastHealthAt !== undefined ? patch.lastHealthAt : r.last_health_at,
  };
  db.prepare(`UPDATE managed_runners SET deployment_id=?, slug=?, machine_id=?, region=?, image=?, status=?, url=?, detail=?, api_key_id=?, last_health_at=?, updated_at=? WHERE id=?`)
    .run(f.deployment_id, f.slug, f.machine_id, f.region, f.image, f.status, f.url, f.detail, f.api_key_id, f.last_health_at, now(), runnerId);
  return _managedRunner(db.prepare("SELECT * FROM managed_runners WHERE id = ?").get(runnerId));
}

export function deleteManagedRunner(orgId, userId, runnerId) {
  const role = orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can remove runners.");
  db.prepare("DELETE FROM managed_runners WHERE id = ? AND org_id = ?").run(runnerId, orgId);
  logAudit(orgId, userId, "runner.delete", { targetType: "runner", targetId: runnerId });
  return { deleted: true };
}

// internal: point a deployment at a (new) target + status — used on runner ready/restart/stop
export function setDeploymentTarget(depId, { targetUrl, status } = {}) {
  const d = db.prepare("SELECT * FROM deployments WHERE id = ?").get(depId);
  if (!d) return null;
  db.prepare("UPDATE deployments SET target_url = ?, status = ? WHERE id = ?")
    .run(targetUrl !== undefined ? targetUrl : d.target_url, status !== undefined ? status : d.status, depId);
  return { id: depId };
}

// internal: the gateway resolves a slug to a deployment (no RBAC — it key-auths)
export function resolveDeployment(slug) {
  const d = db.prepare("SELECT id, org_id, harness_id, slug, target_url, status FROM deployments WHERE slug = ?").get(String(slug || "").toLowerCase());
  if (!d) return null;
  return { id: d.id, orgId: d.org_id, harnessId: d.harness_id, slug: d.slug, targetUrl: d.target_url, status: d.status };
}

/* ── node-anchored comments (collaboration) ──
   Threads pinned to a node (or the canvas, node_id NULL). Anyone with harness
   access can read and post; an editor or the author can resolve or delete. */
export function listComments(harnessId, userId) {
  if (!roleFor(harnessId, userId)) throw new Error("Not found, or not in one of your organizations.");
  return db.prepare(`SELECT c.id, c.node_id, c.body, c.resolved, c.created_at, c.author_id, u.email AS author_email
    FROM comments c LEFT JOIN users u ON u.id = c.author_id
    WHERE c.harness_id = ? ORDER BY c.created_at ASC`).all(harnessId)
    .map((c) => ({ id: c.id, nodeId: c.node_id, body: c.body, resolved: !!c.resolved, createdAt: Number(c.created_at), authorId: c.author_id, authorEmail: c.author_email }));
}

export function createComment(harnessId, userId, { nodeId = null, body }) {
  if (!roleFor(harnessId, userId)) throw new Error("Not found, or not in one of your organizations.");
  body = String(body || "").trim();
  if (!body) throw new Error("A comment can't be empty.");
  if (body.length > 4000) throw new Error("Comment too long (max 4000 characters).");
  const h = db.prepare("SELECT org_id FROM harnesses WHERE id = ?").get(harnessId);
  const id = uid("cm"), ts = now();
  db.prepare("INSERT INTO comments (id, harness_id, org_id, node_id, author_id, body, resolved, created_at) VALUES (?,?,?,?,?,?,0,?)")
    .run(id, harnessId, h?.org_id || null, nodeId, userId, body, ts);
  const email = db.prepare("SELECT email FROM users WHERE id = ?").get(userId)?.email;
  return { id, nodeId, body, resolved: false, createdAt: ts, authorId: userId, authorEmail: email };
}

const _commentRow = (id) => db.prepare("SELECT id, harness_id, author_id FROM comments WHERE id = ?").get(id);

export function resolveComment(commentId, userId, resolved = true) {
  const c = _commentRow(commentId);
  if (!c) throw new Error("Comment not found.");
  if (roleFor(c.harness_id, userId) !== "edit" && c.author_id !== userId) throw new Error("Only an editor or the author can resolve this comment.");
  db.prepare("UPDATE comments SET resolved = ? WHERE id = ?").run(resolved ? 1 : 0, commentId);
  return { id: commentId, resolved: !!resolved };
}

export function deleteComment(commentId, userId) {
  const c = _commentRow(commentId);
  if (!c) return { id: commentId, deleted: true };
  if (roleFor(c.harness_id, userId) !== "edit" && c.author_id !== userId) throw new Error("Only an editor or the author can delete this comment.");
  db.prepare("DELETE FROM comments WHERE id = ?").run(commentId);
  return { id: commentId, deleted: true };
}

/* ── data governance: export & right-to-erasure (per org) ──
   export: a portable JSON bundle of the org's data, secrets excluded.
   erase: delete every org-scoped row (and the service-account users the org's
   keys created), then the org itself — explicit and ordered, so it is correct
   regardless of FK cascade settings or the harness ON DELETE SET NULL. */
export function exportOrg(orgId, userId) {
  const role = orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can export organization data.");
  const org = db.prepare("SELECT id, name, created_at, personal FROM orgs WHERE id = ?").get(orgId);
  if (!org) throw new Error("Organization not found.");
  const members = db.prepare(`SELECT u.email, m.role FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? AND substr(u.id,1,5) <> 'svcu_' ORDER BY m.role, u.email`).all(orgId);
  const harnesses = db.prepare("SELECT id, name, graph_json, updated_at FROM harnesses WHERE org_id = ?").all(orgId)
    .map((h) => ({ id: h.id, name: h.name, graph: JSON.parse(h.graph_json), updatedAt: h.updated_at }));
  const runs = db.prepare(`SELECT id, harness_id, status, latency_ms, tokens_in, tokens_out, cost, created_at
    FROM runs WHERE org_id = ? ORDER BY created_at DESC LIMIT 1000`).all(orgId);
  const audit = listAudit(orgId, userId, { limit: 500 });
  const budgets = db.prepare("SELECT period, max_cost, max_requests FROM budgets WHERE org_id = ?").all(orgId);
  const deployments = db.prepare("SELECT slug, harness_id, target_url, status FROM deployments WHERE org_id = ?").all(orgId);
  const apiKeys = db.prepare(`SELECT name, role, prefix, created_at, last_used_at, revoked_at
    FROM api_keys WHERE org_id = ?`).all(orgId);   // metadata only — never the hash
  logAudit(orgId, userId, "org.export", { detail: { harnesses: harnesses.length, runs: runs.length } });
  return { exportedAt: now(), org: { id: org.id, name: org.name, createdAt: org.created_at, personal: !!org.personal },
           members, harnesses, runs, audit, budgets, deployments, apiKeys };
}

export function eraseOrg(orgId, userId) {
  if (orgRoleFor(orgId, userId) !== "owner") throw new Error("Only an owner can erase an organization.");
  const svc = db.prepare("SELECT user_id FROM api_keys WHERE org_id = ?").all(orgId).map((r) => r.user_id);
  // BEGIN/COMMIT works on both better-sqlite3 and node:sqlite (no .transaction()).
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM deployments WHERE org_id = ?").run(orgId);
    db.prepare("DELETE FROM budgets WHERE org_id = ?").run(orgId);
    db.prepare("DELETE FROM runs WHERE org_id = ?").run(orgId);
    db.prepare("DELETE FROM comments WHERE org_id = ?").run(orgId);
    db.prepare("DELETE FROM audit_log WHERE org_id = ?").run(orgId);
    db.prepare("DELETE FROM api_keys WHERE org_id = ?").run(orgId);
    db.prepare("DELETE FROM harnesses WHERE org_id = ?").run(orgId);   // SET NULL would orphan; delete outright
    db.prepare("DELETE FROM org_members WHERE org_id = ?").run(orgId);
    for (const uid_ of svc) db.prepare("DELETE FROM users WHERE id = ? AND substr(id,1,5) = 'svcu_'").run(uid_);
    db.prepare("DELETE FROM orgs WHERE id = ?").run(orgId);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  }
  return { erased: true, orgId };
}

/* ── per-user key/value (run-sessions & timeline; the storage.js keyspace) ── */
export function kvGet(userId, key) {
  const r = db.prepare("SELECT value FROM kv WHERE owner_id = ? AND key = ?").get(userId, key);
  if (!r) return null;
  return r.value;
}
export function kvSet(userId, key, value, harnessId = null) {
  db.prepare(`INSERT INTO kv (owner_id, harness_id, key, value) VALUES (?,?,?,?)
              ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value, harness_id = excluded.harness_id`)
    .run(userId, harnessId, key, value);
  return { key };
}
export function kvDelete(userId, key) {
  db.prepare("DELETE FROM kv WHERE owner_id = ? AND key = ?").run(userId, key);
  return { key, deleted: true };
}
export function kvList(userId, prefix = "") {
  const rows = db.prepare("SELECT key FROM kv WHERE owner_id = ? AND key LIKE ? ORDER BY key")
    .all(userId, prefix.replace(/[%_]/g, "\\$&") + "%");
  return rows.map((r) => r.key);
}

export default db;

// readiness probe: trivial query to confirm the DB file/handle is live
export function ping() {
  try { db.prepare("SELECT 1").get(); return true; }
  catch (e) { throw new Error("sqlite not ready: " + (e.message || e)); }
}
