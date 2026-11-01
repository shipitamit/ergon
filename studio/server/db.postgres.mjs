/* Data layer — Postgres backend.

   A drop-in alternative to the SQLite db.mjs for real multi-instance
   deployment. Exposes the SAME function names, so routes.mjs is unchanged; the
   selector in db.mjs delegates here when DATABASE_URL is set and `pg` is
   installed. Everything is async (pg is async-only), so the exported functions
   return promises — routes await them, which is a no-op on the sync SQLite path.

   Enable:
     npm i pg
     export DATABASE_URL=postgres://user:pass@host:5432/ergon
     npm start

   Tables mirror the SQLite schema exactly (see db.mjs). All queries are
   parameterized ($1,$2,…) — no string interpolation into SQL.
*/
import crypto from "node:crypto";
import { nextFireAfter, isValidCron } from "./cron.mjs";
import { seal, open as unseal, last4 as _last4 } from "./cryptobox.mjs";
import { getConnector, validateConnection, materialize } from "./connectors.mjs";
import { oauthConfigFor, refreshTokens, isExpired } from "./oauth-connections.mjs";
import { scoreDataset } from "./eval-score.mjs";

const uid = (p) => `${p}_${crypto.randomBytes(9).toString("base64url")}`;
const now = () => Date.now();

let pool = null;

// ── password hashing: bcryptjs if present, else salted scrypt (same as SQLite path) ──
async function loadHasher() {
  try {
    const bcrypt = (await import("bcryptjs")).default;
    return {
      hash: (pw) => bcrypt.hashSync(pw, 10),
      compare: (pw, h) => {
        if (String(h).startsWith("scrypt$")) return scryptCompare(pw, h);
        return bcrypt.compareSync(pw, h);
      },
    };
  } catch {
    return {
      hash: (pw) => {
        const salt = crypto.randomBytes(16);
        const dk = crypto.scryptSync(String(pw), salt, 32);
        return "scrypt$" + salt.toString("hex") + "$" + dk.toString("hex");
      },
      compare: (pw, h) => scryptCompare(pw, h),
    };
  }
}
function scryptCompare(pw, stored) {
  const [tag, saltHex, hashHex] = String(stored).split("$");
  if (tag !== "scrypt" || !saltHex || !hashHex) return false;
  const dk = crypto.scryptSync(String(pw), Buffer.from(saltHex, "hex"), 32);
  const a = Buffer.from(hashHex, "hex");
  return a.length === dk.length && crypto.timingSafeEqual(a, dk);
}

let hasher = null;

// ── init: create the pool + schema ──
// `injectedPool` is for tests; production passes only the URL.
export async function init(databaseUrl, injectedPool = null) {
  if (injectedPool) {
    pool = injectedPool;
  } else {
    const { default: pg } = await import("pg");
    pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  }
  hasher = await loadHasher();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      pw_hash    TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orgs (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at BIGINT NOT NULL,
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
      updated_at BIGINT NOT NULL,
      org_id     TEXT REFERENCES orgs(id) ON DELETE SET NULL
    );
    ALTER TABLE harnesses ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL;
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
      org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
      action      TEXT NOT NULL,
      target_type TEXT,
      target_id   TEXT,
      detail      TEXT,
      ts          BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_org_ts ON audit_log (org_id, ts);
    CREATE TABLE IF NOT EXISTS identities (
      provider   TEXT NOT NULL,
      subject    TEXT NOT NULL,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
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
      created_at   BIGINT NOT NULL,
      last_used_at BIGINT,
      revoked_at   BIGINT
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
      started_at   BIGINT,
      finished_at  BIGINT,
      latency_ms   BIGINT,
      tokens_in    BIGINT DEFAULT 0,
      tokens_out   BIGINT DEFAULT 0,
      cost         REAL DEFAULT 0,
      steps        TEXT,
      created_by   TEXT,
      created_at   BIGINT NOT NULL
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
      window_ms    BIGINT NOT NULL,
      harness_id   TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      last_state   TEXT NOT NULL DEFAULT 'ok',
      last_evaluated_at BIGINT,
      last_triggered_at BIGINT,
      created_by   TEXT,
      created_at   BIGINT NOT NULL
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
      created_at   BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_events_rule ON alert_events (rule_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_alert_events_org ON alert_events (org_id, created_at);
    CREATE TABLE IF NOT EXISTS alert_channels (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      type         TEXT NOT NULL,
      target       TEXT NOT NULL,
      config       TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_by   TEXT,
      created_at   BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_channels_org ON alert_channels (org_id);
    CREATE TABLE IF NOT EXISTS approval_requests (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      harness_id   TEXT,
      run_id       TEXT,
      title        TEXT NOT NULL,
      detail       TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT,
      decided_by   TEXT,
      decision_note TEXT,
      expires_at   BIGINT,
      created_at   BIGINT NOT NULL,
      decided_at   BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_org_status ON approval_requests (org_id, status, created_at);
    CREATE TABLE IF NOT EXISTS eval_datasets (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      harness_id  TEXT,
      name        TEXT NOT NULL,
      cases       TEXT,
      created_by  TEXT,
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eval_datasets_org ON eval_datasets (org_id);
    CREATE TABLE IF NOT EXISTS eval_runs (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      dataset_id  TEXT,
      harness_id  TEXT,
      label       TEXT,
      total       INTEGER NOT NULL DEFAULT 0,
      passed      INTEGER NOT NULL DEFAULT 0,
      score_avg   REAL NOT NULL DEFAULT 0,
      results     TEXT,
      created_by  TEXT,
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eval_runs_org ON eval_runs (org_id, dataset_id, created_at);
    CREATE TABLE IF NOT EXISTS budgets (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      period       TEXT NOT NULL CHECK (period IN ('day','month','total')),
      max_cost     REAL,
      max_requests BIGINT,
      created_by   TEXT,
      created_at   BIGINT NOT NULL,
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
      created_at  BIGINT NOT NULL
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
      last_health_at BIGINT,
      created_by    TEXT,
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT NOT NULL
    );
    ALTER TABLE managed_runners ADD COLUMN IF NOT EXISTS api_key_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_managed_runners_org ON managed_runners (org_id);
    CREATE TABLE IF NOT EXISTS comments (
      id         TEXT PRIMARY KEY,
      harness_id TEXT NOT NULL REFERENCES harnesses(id) ON DELETE CASCADE,
      org_id     TEXT,
      node_id    TEXT,
      author_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
      body       TEXT NOT NULL,
      resolved   INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_harness ON comments (harness_id);

    CREATE TABLE IF NOT EXISTS harness_versions (
      id         TEXT PRIMARY KEY,
      harness_id TEXT NOT NULL REFERENCES harnesses(id) ON DELETE CASCADE,
      version    BIGINT NOT NULL,
      name       TEXT NOT NULL,
      graph_json TEXT NOT NULL,
      author_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hv_harness ON harness_versions (harness_id, version);

    CREATE TABLE IF NOT EXISTS triggers (
      id            TEXT PRIMARY KEY,
      harness_id    TEXT NOT NULL REFERENCES harnesses(id) ON DELETE CASCADE,
      org_id        TEXT,
      type          TEXT NOT NULL,
      token         TEXT UNIQUE,
      cron          TEXT,
      payload       TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      next_fire_at  BIGINT,
      last_claimed_at BIGINT,
      last_fired_at BIGINT,
      last_status   TEXT,
      fire_count    INTEGER NOT NULL DEFAULT 0,
      created_by    TEXT,
      created_at    BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_triggers_harness ON triggers (harness_id);
    CREATE INDEX IF NOT EXISTS idx_triggers_due ON triggers (type, enabled, next_fire_at);

    CREATE TABLE IF NOT EXISTS trigger_fires (
      id            TEXT PRIMARY KEY,
      trigger_id    TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
      org_id        TEXT,
      scheduled_for BIGINT,
      fired_at      BIGINT,
      status        TEXT NOT NULL DEFAULT 'claimed',
      run_id        TEXT,
      created_at    BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_fires_occurrence ON trigger_fires (trigger_id, scheduled_for);
    CREATE INDEX IF NOT EXISTS idx_trigger_fires_trigger ON trigger_fires (trigger_id, created_at);

    CREATE TABLE IF NOT EXISTS connections (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      connector_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      config       TEXT,
      secret       TEXT,
      refresh      TEXT,
      expires_at   BIGINT,
      last4        TEXT,
      status       TEXT NOT NULL DEFAULT 'active',
      created_by   TEXT,
      created_at   BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_connections_org ON connections (org_id);
    ALTER TABLE connections ADD COLUMN IF NOT EXISTS refresh TEXT;
    ALTER TABLE connections ADD COLUMN IF NOT EXISTS expires_at BIGINT;
  `);
  return true;
}

// tiny query helpers
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || null;
const many = async (sql, params = []) => (await pool.query(sql, params)).rows;
const exec = async (sql, params = []) => { await pool.query(sql, params); };

// ── auth ──
// create the user row + personal org (owner). Shared by password signup and SSO.
async function _provisionUser(email, pwHash) {
  const id = uid("u");
  await exec("INSERT INTO users (id, email, pw_hash, created_at) VALUES ($1,$2,$3,$4)", [id, email, pwHash, now()]);
  const oid = uid("o");
  await exec("INSERT INTO orgs (id, name, created_at, personal) VALUES ($1,$2,$3,1)", [oid, `${email}'s workspace`, now()]);
  await exec("INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,'owner')", [oid, id]);
  await logAudit(oid, id, "user.create", { targetType: "user", targetId: id, detail: { email } });
  return { id, email, personalOrgId: oid };
}

export async function createUser(email, password) {
  email = String(email || "").trim().toLowerCase();
  if (!email || !password) throw new Error("Email and password are required.");
  if (await one("SELECT 1 FROM users WHERE email = $1", [email]))
    throw new Error("That email is already registered.");
  const { id } = await _provisionUser(email, hasher.hash(password));
  return { id, email };
}

// SSO (OIDC) login: resolve the external identity to a local user — see db.mjs
// for the full contract. `identity` = { provider, subject, email, emailVerified, name }.
export async function findOrCreateUserByOidc(identity) {
  const { provider, subject } = identity;
  if (!provider || !subject) throw new Error("SSO identity is missing provider/subject.");
  const existing = await one(
    "SELECT u.id, u.email FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = $1 AND i.subject = $2",
    [provider, subject]);
  if (existing) return { id: existing.id, email: existing.email, created: false, linked: false };

  const email = identity.email ? String(identity.email).trim().toLowerCase() : null;
  let user, created = false, linked = false;
  if (email) {
    const byEmail = await one("SELECT id, email FROM users WHERE email = $1", [email]);
    if (byEmail) {
      if (identity.emailVerified === false) throw new Error("This email is registered but the identity provider did not verify it.");
      user = byEmail; linked = true;
    }
  }
  if (!user) {
    if (!email) throw new Error("SSO login needs an email claim to create an account.");
    const prov = await _provisionUser(email, "!sso");
    user = { id: prov.id, email: prov.email }; created = true;
  }
  await exec("INSERT INTO identities (provider, subject, user_id, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (provider, subject) DO NOTHING",
    [provider, subject, user.id, now()]);
  const pid = await personalOrgId(user.id);
  await logAudit(pid, user.id, created ? "auth.sso_signup" : (linked ? "auth.sso_link" : "auth.sso_login"),
    { targetType: "user", targetId: user.id, detail: { provider, email } });
  return { id: user.id, email: user.email, created, linked };
}

export async function verifyUser(email, password) {
  email = String(email || "").trim().toLowerCase();
  const row = await one("SELECT id, email, pw_hash FROM users WHERE email = $1", [email]);
  if (!row || !hasher.compare(password, row.pw_hash)) throw new Error("Invalid email or password.");
  return { id: row.id, email: row.email };
}

export async function createSession(userId) {
  const token = crypto.randomBytes(24).toString("base64url");
  await exec("INSERT INTO sessions (token, user_id, created_at) VALUES ($1,$2,$3)", [token, userId, now()]);
  return token;
}

export async function userForToken(token) {
  if (!token) return null;
  return await one(
    "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1",
    [token]);
}

export async function destroySession(token) {
  await exec("DELETE FROM sessions WHERE token = $1", [token]);
  return { ok: true };
}

// ── access control ──
async function userByEmail(email) {
  return await one("SELECT id, email FROM users WHERE email = $1",
    [String(email || "").trim().toLowerCase()]);
}
// how an org role maps onto harness access: owner/admin edit, member views.
const _orgToHarness = (orgRole) => (orgRole === "owner" || orgRole === "admin") ? "edit" : "view";

export async function orgRoleFor(orgId, userId) {
  if (!orgId) return null;
  const r = await one("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
  return r ? r.role : null;
}
async function personalOrgId(userId) {
  const r = await one(`SELECT o.id FROM orgs o JOIN org_members m ON m.org_id = o.id
                       WHERE m.user_id = $1 AND o.personal = 1 ORDER BY o.created_at LIMIT 1`, [userId]);
  return r ? r.id : null;
}

// a harness's access is purely the member's org role (one lookup, one scope)
async function roleFor(harnessId, userId) {
  const h = await one("SELECT org_id FROM harnesses WHERE id = $1", [harnessId]);
  if (!h) return null;
  const orole = await orgRoleFor(h.org_id, userId);
  return orole ? _orgToHarness(orole) : null;
}
async function canManage(harnessId, userId) {
  const h = await one("SELECT org_id FROM harnesses WHERE id = $1", [harnessId]);
  if (!h) return false;
  return ["owner", "admin"].includes(await orgRoleFor(h.org_id, userId));
}

// ── harnesses ──
export async function listHarnesses(userId) {
  const rows = await many(`
    SELECT h.id, h.name, h.updated_at, h.org_id, m.role AS org_role, o.name AS org_name
    FROM harnesses h
    JOIN org_members m ON m.org_id = h.org_id
    JOIN orgs o ON o.id = h.org_id
    WHERE m.user_id = $1`, [userId]);
  const out = [];
  for (const r of rows) {
    const owner = await one(
      "SELECT email FROM users u JOIN harnesses h ON h.owner_id = u.id WHERE h.id = $1", [r.id]);
    out.push({ id: r.id, name: r.name, updated_at: r.updated_at, role: _orgToHarness(r.org_role),
               orgId: r.org_id, orgName: r.org_name, ownerEmail: owner ? owner.email : null });
  }
  return out.sort((a, b) => Number(b.updated_at) - Number(a.updated_at));
}

export async function getHarness(harnessId, userId) {
  const h = await one(
    "SELECT id, name, graph_json, owner_id, org_id, updated_at FROM harnesses WHERE id = $1", [harnessId]);
  if (!h) throw new Error("Harness not found.");
  const role = await roleFor(harnessId, userId);
  if (!role) throw new Error("Not found, or not in one of your organizations.");
  const owner = await one("SELECT email FROM users WHERE id = $1", [h.owner_id]);
  const org = await one("SELECT name FROM orgs WHERE id = $1", [h.org_id]);
  return { id: h.id, name: h.name, graph: JSON.parse(h.graph_json), version: Number(h.updated_at), role,
           ownerEmail: owner ? owner.email : null, orgId: h.org_id, orgName: org ? org.name : null };
}

export class ConflictError extends Error {
  constructor(current) {
    super("The harness changed on the server since you opened it.");
    this.name = "ConflictError";
    this.current = current;
  }
}

// capped append-only save history (mirrors db.mjs) for the version-history UI.
const VERSION_CAP = 50;
async function _recordVersion(harnessId, version, name, graph, authorId) {
  try {
    await exec("INSERT INTO harness_versions (id, harness_id, version, name, graph_json, author_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [uid("hv"), harnessId, version, name, JSON.stringify(graph), authorId || null, now()]);
    await exec(`DELETE FROM harness_versions WHERE id IN (
      SELECT id FROM harness_versions WHERE harness_id = $1 ORDER BY version DESC OFFSET $2)`, [harnessId, VERSION_CAP]);
  } catch { /* history is best-effort; never block a save on it */ }
}

export async function listVersions(harnessId, userId) {
  if (!await roleFor(harnessId, userId)) throw new Error("You don't have access to this harness.");
  const rows = await many(`SELECT v.id, v.version, v.name, v.author_id, v.created_at, v.graph_json, u.email AS author_email
    FROM harness_versions v LEFT JOIN users u ON u.id = v.author_id
    WHERE v.harness_id = $1 ORDER BY v.version DESC`, [harnessId]);
  return rows.map((r) => {
    let nodeCount = 0, edgeCount = 0;
    try { const g = JSON.parse(r.graph_json); nodeCount = (g.nodes || []).length; edgeCount = (g.edges || []).length; } catch { /* ignore */ }
    return { id: r.id, version: Number(r.version), name: r.name, authorEmail: r.author_email || null, createdAt: Number(r.created_at), nodeCount, edgeCount };
  });
}

export async function getVersion(harnessId, versionId, userId) {
  if (!await roleFor(harnessId, userId)) throw new Error("You don't have access to this harness.");
  const r = await one(`SELECT v.id, v.version, v.name, v.author_id, v.created_at, v.graph_json, u.email AS author_email
    FROM harness_versions v LEFT JOIN users u ON u.id = v.author_id
    WHERE v.id = $1 AND v.harness_id = $2`, [versionId, harnessId]);
  if (!r) throw new Error("Version not found.");
  return { id: r.id, version: Number(r.version), name: r.name, authorEmail: r.author_email || null, createdAt: Number(r.created_at), graph: JSON.parse(r.graph_json) };
}

/* ── triggers (mirrors db.mjs) ── */
function _triggerRow(r) {
  if (!r) return null;
  return { id: r.id, harnessId: r.harness_id, orgId: r.org_id, type: r.type, token: r.token || null,
    cron: r.cron || null, payload: r.payload || null, enabled: !!r.enabled, nextFireAt: r.next_fire_at != null ? Number(r.next_fire_at) : null,
    lastFiredAt: r.last_fired_at != null ? Number(r.last_fired_at) : null, lastStatus: r.last_status || null, fireCount: Number(r.fire_count || 0), createdBy: r.created_by || null, createdAt: Number(r.created_at) };
}

export async function activeDeploymentForHarness(harnessId) {
  const d = await one("SELECT id, org_id, slug, target_url FROM deployments WHERE harness_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1", [harnessId]);
  return d ? { id: d.id, orgId: d.org_id, slug: d.slug, targetUrl: d.target_url } : null;
}

export async function listTriggers(harnessId, userId) {
  if (!await roleFor(harnessId, userId)) throw new Error("You don't have access to this harness.");
  return (await many("SELECT * FROM triggers WHERE harness_id = $1 ORDER BY created_at DESC", [harnessId])).map(_triggerRow);
}

export async function createTrigger(userId, harnessId, { type, cron = null, payload = null } = {}) {
  if (await roleFor(harnessId, userId) !== "edit") throw new Error("You need edit access to add a trigger.");
  if (type !== "webhook" && type !== "schedule") throw new Error("Unknown trigger type.");
  const h = await one("SELECT org_id FROM harnesses WHERE id = $1", [harnessId]);
  if (!h) throw new Error("Harness not found.");
  let token = null, nextFire = null;
  if (type === "webhook") token = crypto.randomBytes(18).toString("base64url");
  if (type === "schedule") { if (!isValidCron(cron)) throw new Error("Invalid cron expression (need 5 fields)."); nextFire = nextFireAfter(cron, now()); }
  const id = uid("trg");
  await exec(`INSERT INTO triggers (id, harness_id, org_id, type, token, cron, payload, enabled, next_fire_at, fire_count, created_by, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,0,$9,$10)`, [id, harnessId, h.org_id, type, token, cron, payload, nextFire, userId, now()]);
  return _triggerRow(await one("SELECT * FROM triggers WHERE id = $1", [id]));
}

export async function updateTrigger(userId, triggerId, { enabled, cron, payload } = {}) {
  const t = await one("SELECT * FROM triggers WHERE id = $1", [triggerId]);
  if (!t) throw new Error("Trigger not found.");
  if (await roleFor(t.harness_id, userId) !== "edit") throw new Error("You need edit access to change a trigger.");
  let nextCron = t.cron, nextFire = t.next_fire_at, nextEnabled = t.enabled, nextPayload = t.payload;
  if (cron !== undefined && t.type === "schedule") { if (!isValidCron(cron)) throw new Error("Invalid cron expression."); nextCron = cron; nextFire = nextFireAfter(cron, now()); }
  if (payload !== undefined) nextPayload = payload;
  if (enabled !== undefined) { nextEnabled = enabled ? 1 : 0; if (enabled && t.type === "schedule") nextFire = nextFireAfter(nextCron, now()); }
  await exec("UPDATE triggers SET enabled = $1, cron = $2, payload = $3, next_fire_at = $4 WHERE id = $5", [nextEnabled, nextCron, nextPayload, nextFire, triggerId]);
  return _triggerRow(await one("SELECT * FROM triggers WHERE id = $1", [triggerId]));
}

export async function deleteTrigger(userId, triggerId) {
  const t = await one("SELECT harness_id FROM triggers WHERE id = $1", [triggerId]);
  if (!t) throw new Error("Trigger not found.");
  if (await roleFor(t.harness_id, userId) !== "edit") throw new Error("You need edit access to delete a trigger.");
  await exec("DELETE FROM triggers WHERE id = $1", [triggerId]);
  return { deleted: true };
}

export async function getTriggerByToken(token) {
  if (!token) return null;
  return _triggerRow(await one("SELECT * FROM triggers WHERE token = $1 AND type = 'webhook'", [token]));
}

export async function dueScheduleTriggers(nowMs = now(), limit = 100) {
  return (await many("SELECT * FROM triggers WHERE type = 'schedule' AND enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= $1 ORDER BY next_fire_at ASC LIMIT $2", [nowMs, limit])).map(_triggerRow);
}

export async function markTriggerFired(triggerId, { firedAt = now(), status = "ok", nextFireAt = undefined } = {}) {
  if (nextFireAt === undefined) await exec("UPDATE triggers SET last_fired_at = $1, last_status = $2, fire_count = fire_count + 1 WHERE id = $3", [firedAt, status, triggerId]);
  else await exec("UPDATE triggers SET last_fired_at = $1, last_status = $2, fire_count = fire_count + 1, next_fire_at = $4 WHERE id = $3", [firedAt, status, triggerId, nextFireAt]);
}

// Durable, coordinated claim (mirrors db.mjs): compare-and-swap on next_fire_at so
// exactly one worker claims each due slot; a durable trigger_fires record backs it.
export async function claimDueScheduleTriggers(nowMs = now(), limit = 100) {
  const due = await many("SELECT * FROM triggers WHERE type = 'schedule' AND enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= $1 ORDER BY next_fire_at ASC LIMIT $2", [nowMs, limit]);
  const claimed = [];
  for (const t of due) {
    const seen = t.next_fire_at;
    const next = isValidCron(t.cron) ? nextFireAfter(t.cron, nowMs) : null;
    const won = await one("UPDATE triggers SET next_fire_at = $1, last_claimed_at = $2 WHERE id = $3 AND next_fire_at = $4 AND enabled = 1 RETURNING id", [next, nowMs, t.id, seen]);
    if (!won) continue;                       // another worker claimed this slot
    const fireId = uid("fire");
    await exec("INSERT INTO trigger_fires (id, trigger_id, org_id, scheduled_for, status, created_at) VALUES ($1,$2,$3,$4,'claimed',$5) ON CONFLICT (trigger_id, scheduled_for) DO NOTHING",
      [fireId, t.id, t.org_id, seen, nowMs]);
    claimed.push({ trigger: _triggerRow(t), fireId, scheduledFor: Number(seen) });
  }
  return claimed;
}

export async function recordFireResult(fireId, { status = "ok", runId = null, firedAt = now() } = {}) {
  const f = await one("SELECT trigger_id FROM trigger_fires WHERE id = $1", [fireId]);
  await exec("UPDATE trigger_fires SET status = $1, run_id = $2, fired_at = $3 WHERE id = $4", [status, runId, firedAt, fireId]);
  if (f) await exec("UPDATE triggers SET last_fired_at = $1, last_status = $2, fire_count = fire_count + 1 WHERE id = $3", [firedAt, status, f.trigger_id]);
}

export async function listTriggerFires(triggerId, userId, limit = 50) {
  const t = await one("SELECT harness_id FROM triggers WHERE id = $1", [triggerId]);
  if (!t || !await roleFor(t.harness_id, userId)) throw new Error("You don't have access to this trigger.");
  return await many("SELECT id, scheduled_for, fired_at, status, run_id, created_at FROM trigger_fires WHERE trigger_id = $1 ORDER BY created_at DESC LIMIT $2", [triggerId, limit]);
}

/* ── managed connections (mirrors db.mjs) ── */
function _connRow(r) {
  if (!r) return null;
  let config = {}; try { config = r.config ? JSON.parse(r.config) : {}; } catch { /* ignore */ }
  return { id: r.id, orgId: r.org_id, connectorId: r.connector_id, name: r.name, config,
    last4: r.last4 || null, configured: !!r.secret, authType: config.oauth ? "oauth" : "static",
    expiresAt: r.expires_at != null ? Number(r.expires_at) : null, status: r.status || "active", createdAt: Number(r.created_at) };
}
const _connManage = async (orgId, userId) => { const role = await orgRoleFor(orgId, userId); return role === "owner" || role === "admin"; };

export async function listConnections(orgId, userId) {
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  return (await many("SELECT * FROM connections WHERE org_id = $1 ORDER BY created_at DESC", [orgId])).map(_connRow);
}

export async function createConnection(orgId, userId, { connectorId, name, config = {}, secret = null } = {}) {
  if (!await _connManage(orgId, userId)) throw new Error("Only an owner or admin can add a connection.");
  const v = validateConnection(connectorId, { name, config, secret });
  if (!v.ok) throw new Error(v.errors.join(" "));
  const id = uid("conn");
  await exec("INSERT INTO connections (id, org_id, connector_id, name, config, secret, last4, status, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [id, orgId, connectorId, String(name).trim(), JSON.stringify(config || {}), seal(secret), secret ? _last4(secret) : null, "active", userId, now()]);
  await logAudit(orgId, userId, "connection.create", { targetType: "connection", targetId: id, detail: { connectorId, name } });
  return _connRow(await one("SELECT * FROM connections WHERE id = $1", [id]));
}

export async function updateConnection(orgId, userId, connectionId, { name, config, secret } = {}) {
  if (!await _connManage(orgId, userId)) throw new Error("Only an owner or admin can change a connection.");
  const cur = await one("SELECT * FROM connections WHERE id = $1 AND org_id = $2", [connectionId, orgId]);
  if (!cur) throw new Error("Connection not found.");
  const nextName = name !== undefined ? String(name).trim() : cur.name;
  const nextConfig = config !== undefined ? JSON.stringify(config || {}) : cur.config;
  let nextSecret = cur.secret, nextLast4 = cur.last4;
  if (secret !== undefined && secret !== null && secret !== "") { nextSecret = seal(secret); nextLast4 = _last4(secret); }
  const v = validateConnection(cur.connector_id, { name: nextName, config: config !== undefined ? config : JSON.parse(cur.config || "{}"), secret: nextSecret ? "set" : "" });
  if (!v.ok) throw new Error(v.errors.join(" "));
  await exec("UPDATE connections SET name = $1, config = $2, secret = $3, last4 = $4 WHERE id = $5", [nextName, nextConfig, nextSecret, nextLast4, connectionId]);
  return _connRow(await one("SELECT * FROM connections WHERE id = $1", [connectionId]));
}

export async function deleteConnection(orgId, userId, connectionId) {
  if (!await _connManage(orgId, userId)) throw new Error("Only an owner or admin can delete a connection.");
  await exec("DELETE FROM connections WHERE id = $1 AND org_id = $2", [connectionId, orgId]);
  await logAudit(orgId, userId, "connection.delete", { targetType: "connection", targetId: connectionId });
  return { deleted: true };
}

export async function resolveConnectionSecret(connectionId, orgId) {
  const r = await one("SELECT secret FROM connections WHERE id = $1 AND org_id = $2", [connectionId, orgId]);
  return r && r.secret ? unseal(r.secret) : null;
}

export async function upsertOAuthConnection(orgId, userId, { connectorId, name, access, refresh = null, expiresAt = null, config = {} } = {}) {
  if (!await _connManage(orgId, userId)) throw new Error("Only an owner or admin can add a connection.");
  const cfg = { ...config, oauth: true };
  const existing = await one("SELECT id FROM connections WHERE org_id = $1 AND connector_id = $2 AND name = $3", [orgId, connectorId, String(name).trim()]);
  if (existing) {
    await exec("UPDATE connections SET config = $1, secret = $2, refresh = $3, expires_at = $4, last4 = $5 WHERE id = $6",
      [JSON.stringify(cfg), seal(access), refresh ? seal(refresh) : null, expiresAt, _last4(access), existing.id]);
    return _connRow(await one("SELECT * FROM connections WHERE id = $1", [existing.id]));
  }
  const id = uid("conn");
  await exec("INSERT INTO connections (id, org_id, connector_id, name, config, secret, refresh, expires_at, last4, status, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [id, orgId, connectorId, String(name).trim(), JSON.stringify(cfg), seal(access), refresh ? seal(refresh) : null, expiresAt, _last4(access), "active", userId, now()]);
  await logAudit(orgId, userId, "connection.oauth", { targetType: "connection", targetId: id, detail: { connectorId, name } });
  return _connRow(await one("SELECT * FROM connections WHERE id = $1", [id]));
}

export async function resolveConnection(orgId, connectionId, { env = process.env, fetchImpl, redirectUri } = {}) {
  const r = await one("SELECT * FROM connections WHERE id = $1 AND org_id = $2", [connectionId, orgId]);
  if (!r) throw new Error("Connection not found.");
  let config = {}; try { config = r.config ? JSON.parse(r.config) : {}; } catch { /* ignore */ }
  let access = r.secret ? unseal(r.secret) : null;
  if (config.oauth && isExpired(r.expires_at != null ? Number(r.expires_at) : null) && r.refresh) {
    const oauthCfg = oauthConfigFor(getConnector(r.connector_id), env);
    if (oauthCfg) {
      try {
        const t = await refreshTokens(oauthCfg, { refreshToken: unseal(r.refresh), redirectUri }, fetchImpl);
        access = t.access;
        await exec("UPDATE connections SET secret = $1, refresh = $2, expires_at = $3, last4 = $4 WHERE id = $5",
          [seal(t.access), t.refresh ? seal(t.refresh) : r.refresh, t.expiresAt, _last4(t.access), r.id]);
      } catch { /* refresh failed → fall back */ }
    }
  }
  return { id: r.id, connectorId: r.connector_id, name: r.name, authType: config.oauth ? "oauth" : "static", ...materialize(r.connector_id, { secret: access, config }) };
}

export async function saveHarness(userId, { id, name, graph, orgId, expectedVersion, force }) {
  if (id) {
    if (await roleFor(id, userId) !== "edit") throw new Error("You don't have edit access to this harness.");
    const curRow = await one("SELECT updated_at FROM harnesses WHERE id = $1", [id]);
    const curVer = curRow ? Number(curRow.updated_at) : 0;
    if (!force && expectedVersion != null && curVer !== Number(expectedVersion)) {
      throw new ConflictError(await getHarness(id, userId));
    }
    // version must be strictly monotonic: wall-clock ms alone can repeat within
    // the same millisecond under rapid saves, which would silently break the
    // optimistic-concurrency check — so always advance past the current version.
    const nextVer = Math.max(now(), curVer + 1);
    await exec("UPDATE harnesses SET name = $1, graph_json = $2, updated_at = $3 WHERE id = $4",
      [name, JSON.stringify(graph), nextVer, id]);
    await _recordVersion(id, nextVer, name, graph, userId);
    const saved = await getHarness(id, userId);
    await logAudit(saved.orgId, userId, "harness.update", { targetType: "harness", targetId: id, detail: { name } });
    return saved;
  }
  // new harness: into the given org (caller must have edit there) or personal org
  const targetOrg = orgId || await personalOrgId(userId);
  if (!targetOrg) throw new Error("No organization to save into.");
  const orole = await orgRoleFor(targetOrg, userId);
  if (!orole || orole === "member") throw new Error("You need edit access in that organization to create a harness.");
  const newId = uid("h");
  const createdVer = now();
  await exec("INSERT INTO harnesses (id, owner_id, name, graph_json, updated_at, org_id) VALUES ($1,$2,$3,$4,$5,$6)",
    [newId, userId, name, JSON.stringify(graph), createdVer, targetOrg]);
  await _recordVersion(newId, createdVer, name, graph, userId);
  await logAudit(targetOrg, userId, "harness.create", { targetType: "harness", targetId: newId, detail: { name } });
  return await getHarness(newId, userId);
}

export async function deleteHarness(harnessId, userId) {
  if (!await canManage(harnessId, userId)) throw new Error("Only an org owner or admin can delete a harness.");
  const row = await one("SELECT org_id, name FROM harnesses WHERE id = $1", [harnessId]);
  await exec("DELETE FROM harnesses WHERE id = $1", [harnessId]);
  if (row) await logAudit(row.org_id, userId, "harness.delete", { targetType: "harness", targetId: harnessId, detail: { name: row.name } });
  return { deleted: true };
}

// ── organizations (the RBAC overlay) ──
export async function createOrg(userId, name) {
  name = String(name || "").trim();
  if (!name) throw new Error("Organization name is required.");
  const id = uid("o");
  await exec("INSERT INTO orgs (id, name, created_at) VALUES ($1,$2,$3)", [id, name, now()]);
  await exec("INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,$3)", [id, userId, "owner"]);
  await logAudit(id, userId, "org.create", { detail: { name } });
  return { id, name, role: "owner" };
}

export async function listOrgs(userId) {
  return await many(`
    SELECT o.id, o.name, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id
    WHERE m.user_id = $1 ORDER BY o.name`, [userId]);
}

export async function listMembers(orgId, actorId) {
  if (!await orgRoleFor(orgId, actorId)) throw new Error("Not a member of this organization.");
  return await many(`
    SELECT u.email, m.role FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = $1 AND substr(u.id, 1, 5) <> 'svcu_' ORDER BY m.role, u.email`, [orgId]);
}

export async function addMember(orgId, actorId, targetEmail, role) {
  const actorRole = await orgRoleFor(orgId, actorId);
  if (actorRole !== "owner" && actorRole !== "admin") throw new Error("Only an owner or admin can add members.");
  if (!["owner", "admin", "member"].includes(role)) throw new Error("Role must be 'owner', 'admin', or 'member'.");
  if (role === "owner" && actorRole !== "owner") throw new Error("Only an owner can grant the owner role.");
  const target = await userByEmail(targetEmail);
  if (!target) throw new Error(`No account for ${targetEmail}. They need to sign up first.`);
  await exec(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,$3)
              ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [orgId, target.id, role]);
  await logAudit(orgId, actorId, "member.add", { targetType: "user", targetId: target.id, detail: { email: targetEmail, role } });
  return await listMembers(orgId, actorId);
}

export async function removeMember(orgId, actorId, targetEmail) {
  const actorRole = await orgRoleFor(orgId, actorId);
  if (actorRole !== "owner" && actorRole !== "admin") throw new Error("Only an owner or admin can remove members.");
  const target = await userByEmail(targetEmail);
  if (!target) return await listMembers(orgId, actorId);
  if (await orgRoleFor(orgId, target.id) === "owner") {
    const row = await one("SELECT COUNT(*)::int AS n FROM org_members WHERE org_id = $1 AND role = 'owner'", [orgId]);
    if ((row ? row.n : 0) <= 1) throw new Error("Can't remove the last owner of the organization.");
  }
  await exec("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, target.id]);
  await logAudit(orgId, actorId, "member.remove", { targetType: "user", targetId: target.id, detail: { email: targetEmail } });
  return await listMembers(orgId, actorId);
}

export async function setHarnessOrg(harnessId, userId, orgId) {
  if (!await canManage(harnessId, userId)) throw new Error("Only an org owner or admin can move this harness.");
  const orole = await orgRoleFor(orgId, userId);
  if (!orole || orole === "member") throw new Error("You need edit access in the target organization.");
  const prev = await one("SELECT org_id FROM harnesses WHERE id = $1", [harnessId]);
  const fromOrgId = prev ? prev.org_id : null;
  await exec("UPDATE harnesses SET org_id = $1 WHERE id = $2", [orgId, harnessId]);
  const detail = { fromOrgId, toOrgId: orgId };
  await logAudit(orgId, userId, "harness.move", { targetType: "harness", targetId: harnessId, detail });
  if (fromOrgId && fromOrgId !== orgId) await logAudit(fromOrgId, userId, "harness.move", { targetType: "harness", targetId: harnessId, detail });
  return await getHarness(harnessId, userId);
}

// ── audit log (append-only, per org) ──
export async function logAudit(orgId, actorId, action, { targetType = null, targetId = null, detail = null } = {}) {
  if (!orgId) return;
  try {
    await exec("INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id, detail, ts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [uid("al"), orgId, actorId || null, action, targetType, targetId, detail ? JSON.stringify(detail) : null, now()]);
  } catch { /* audit is best-effort; it must never break the action it records */ }
}

export async function listAudit(orgId, actorId, { limit = 100, before = null } = {}) {
  const role = await orgRoleFor(orgId, actorId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an org owner or admin can view the audit log.");
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = before
    ? await many("SELECT a.*, u.email AS actor_email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.org_id = $1 AND a.ts < $2 ORDER BY a.ts DESC LIMIT $3", [orgId, Number(before), lim])
    : await many("SELECT a.*, u.email AS actor_email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.org_id = $1 ORDER BY a.ts DESC LIMIT $2", [orgId, lim]);
  return rows.map((r) => ({ id: r.id, ts: Number(r.ts), actorId: r.actor_id, actorEmail: r.actor_email || null, action: r.action, targetType: r.target_type, targetId: r.target_id, detail: r.detail ? JSON.parse(r.detail) : null }));
}

// ── service accounts / API keys (see db.mjs for the model) ──
export async function createApiKey(orgId, actorId, name, role = "member") {
  const arole = await orgRoleFor(orgId, actorId);
  if (arole !== "owner" && arole !== "admin") throw new Error("Only an owner or admin can create API keys.");
  role = role === "admin" ? "admin" : "member";
  name = String(name || "").trim() || "API key";
  const keyId = uid("esk");
  const secret = `${keyId}.${crypto.randomBytes(24).toString("base64url")}`;
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  const prefix = secret.slice(0, 14) + "…";
  const svc = `svcu_${crypto.randomBytes(9).toString("base64url")}`;
  await exec("INSERT INTO users (id, email, pw_hash, created_at) VALUES ($1,$2,$3,$4)", [svc, `${keyId}@keys.ergon.local`, "!key", now()]);
  await exec("INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,$3)", [orgId, svc, role]);
  await exec("INSERT INTO api_keys (id, org_id, user_id, name, role, prefix, hash, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [keyId, orgId, svc, name, role, prefix, hash, actorId, now()]);
  await logAudit(orgId, actorId, "apikey.create", { targetType: "apikey", targetId: keyId, detail: { name, role } });
  return { id: keyId, name, role, prefix, secret };
}

export async function listApiKeys(orgId, actorId) {
  const arole = await orgRoleFor(orgId, actorId);
  if (arole !== "owner" && arole !== "admin") throw new Error("Only an owner or admin can view API keys.");
  const rows = await many(`SELECT k.id, k.name, k.role, k.prefix, k.created_at, k.last_used_at, k.revoked_at, u.email AS created_by
    FROM api_keys k LEFT JOIN users u ON u.id = k.created_by WHERE k.org_id = $1 ORDER BY k.created_at DESC`, [orgId]);
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, prefix: r.prefix,
    createdAt: Number(r.created_at), lastUsedAt: r.last_used_at != null ? Number(r.last_used_at) : null,
    revokedAt: r.revoked_at != null ? Number(r.revoked_at) : null, createdBy: r.created_by || null }));
}

export async function revokeApiKey(orgId, actorId, keyId) {
  const arole = await orgRoleFor(orgId, actorId);
  if (arole !== "owner" && arole !== "admin") throw new Error("Only an owner or admin can revoke API keys.");
  const row = await one("SELECT user_id, revoked_at FROM api_keys WHERE id = $1 AND org_id = $2", [keyId, orgId]);
  if (!row) throw new Error("API key not found.");
  if (!row.revoked_at) {
    await exec("UPDATE api_keys SET revoked_at = $1 WHERE id = $2", [now(), keyId]);
    await exec("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, row.user_id]);
    await logAudit(orgId, actorId, "apikey.revoke", { targetType: "apikey", targetId: keyId });
  }
  return { revoked: true };
}

export async function verifyApiKey(secret) {
  const s = String(secret || "");
  const dot = s.indexOf(".");
  if (dot < 1 || !s.startsWith("esk_")) return null;
  const keyId = s.slice(0, dot);
  const row = await one("SELECT id, org_id, user_id, revoked_at, hash FROM api_keys WHERE id = $1", [keyId]);
  if (!row || row.revoked_at) return null;
  const want = Buffer.from(row.hash, "hex");
  const got = crypto.createHash("sha256").update(s).digest();
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  await exec("UPDATE api_keys SET last_used_at = $1 WHERE id = $2", [now(), keyId]);
  const u = await one("SELECT id, email FROM users WHERE id = $1", [row.user_id]);
  if (!u) return null;
  return { id: u.id, email: u.email, orgId: row.org_id, keyId: row.id, apiKey: true };
}

// ── run history (see db.mjs for the model) ──
const RUNS_KEEP = Math.max(1, Number(process.env.ERGON_RUNS_KEEP) || 500);

async function _orgForRun(userId, { harnessId, orgId }) {
  if (harnessId) {
    const h = await one("SELECT org_id FROM harnesses WHERE id = $1", [harnessId]);
    if (h) return h.org_id;
  }
  return orgId || null;
}

export async function recordRun(userId, rec = {}) {
  const org = await _orgForRun(userId, rec);
  if (!org) throw new Error("A run needs a harnessId or orgId.");
  if (!await orgRoleFor(org, userId)) throw new Error("Not a member of this organization.");
  const gate = await checkBudget(org);
  if (!gate.allowed) { const e = new Error(`Organization budget exceeded: ${gate.reason}`); e.code = "budget"; throw e; }
  const u = rec.usage || {};
  const id = uid("run");
  await exec(`INSERT INTO runs (id, org_id, harness_id, harness_name, input, output, status,
      started_at, finished_at, latency_ms, tokens_in, tokens_out, cost, steps, created_by, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [
    id, org, rec.harnessId || null, rec.harnessName || null, rec.input || "", rec.output || "",
    rec.status || "ok", rec.startedAt || null, rec.finishedAt || null, rec.latencyMs || null,
    u.input_tokens || 0, u.output_tokens || 0, u.cost || 0,
    rec.steps ? JSON.stringify(rec.steps) : null, userId, now()]);
  await exec(`DELETE FROM runs WHERE org_id = $1 AND id NOT IN (
    SELECT id FROM runs WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2)`, [org, RUNS_KEEP]);
  return { id, orgId: org };
}

export async function listRuns(userId, { orgId, harnessId = null, limit = 50, before = null } = {}) {
  if (!orgId) throw new Error("orgId is required.");
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const args = [orgId]; let n = 1; const clauses = [`org_id = $${n}`];
  if (harnessId) { n++; clauses.push(`harness_id = $${n}`); args.push(harnessId); }
  if (before) { n++; clauses.push(`created_at < $${n}`); args.push(Number(before)); }
  n++;
  const rows = await many(`SELECT id, harness_id, harness_name, status, started_at, finished_at,
      latency_ms, tokens_in, tokens_out, cost, created_at, created_by, substr(input, 1, 200) AS input_preview
    FROM runs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT $${n}`, [...args, lim]);
  return rows.map(_runSummary);
}

export async function searchRuns(userId, { orgId, q = null, status = null, failed = false,
    harnessId = null, from = null, to = null, minLatencyMs = null, minCost = null,
    limit = 50, before = null } = {}) {
  if (!orgId) throw new Error("orgId is required.");
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const args = [orgId]; let n = 1; const clauses = [`org_id = $1`];
  if (status) { n++; clauses.push(`status = $${n}`); args.push(status); }
  if (failed) { clauses.push("status <> 'ok'"); }
  if (harnessId) { n++; clauses.push(`harness_id = $${n}`); args.push(harnessId); }
  if (from != null) { n++; clauses.push(`created_at >= $${n}`); args.push(Number(from)); }
  if (to != null) { n++; clauses.push(`created_at < $${n}`); args.push(Number(to)); }
  if (minLatencyMs != null) { n++; clauses.push(`latency_ms >= $${n}`); args.push(Number(minLatencyMs)); }
  if (minCost != null) { n++; clauses.push(`cost >= $${n}`); args.push(Number(minCost)); }
  if (before != null) { n++; clauses.push(`created_at < $${n}`); args.push(Number(before)); }
  if (q) { n++; clauses.push(`(input ILIKE $${n} OR output ILIKE $${n})`); args.push(`%${q}%`); }
  n++;
  const rows = await many(`SELECT id, harness_id, harness_name, status, started_at, finished_at,
      latency_ms, tokens_in, tokens_out, cost, created_at, created_by, substr(input, 1, 200) AS input_preview
    FROM runs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT $${n}`, [...args, lim]);
  return rows.map(_runSummary);
}

export async function getRun(userId, runId) {
  const r = await one("SELECT * FROM runs WHERE id = $1", [runId]);
  if (!r) throw new Error("Run not found.");
  if (!await orgRoleFor(r.org_id, userId)) throw new Error("Not a member of this organization.");
  return { ..._runSummary(r), orgId: r.org_id, input: r.input, output: r.output,
           steps: r.steps ? JSON.parse(r.steps) : [] };
}

function _runSummary(r) {
  return {
    id: r.id, harnessId: r.harness_id, harnessName: r.harness_name, status: r.status,
    startedAt: r.started_at != null ? Number(r.started_at) : null,
    finishedAt: r.finished_at != null ? Number(r.finished_at) : null,
    latencyMs: r.latency_ms != null ? Number(r.latency_ms) : null,
    tokensIn: Number(r.tokens_in || 0), tokensOut: Number(r.tokens_out || 0), cost: Number(r.cost || 0),
    createdAt: Number(r.created_at), createdBy: r.created_by,
    inputPreview: r.input_preview !== undefined ? r.input_preview : (r.input || "").slice(0, 200),
  };
}

// ── observability: aggregate metrics over the runs store (see db.mjs) ──
export async function metricsSummary(userId, { orgId, from = null, to = null, bucket = "day", harnessId = null } = {}) {
  if (!orgId) throw new Error("orgId is required.");
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  const toMs = Number(to) || now();
  const fromMs = Number(from) || (toMs - 7 * 86400_000);
  const bucketMs = bucket === "hour" ? 3600_000 : 86400_000;
  const args = [orgId, fromMs, toMs]; let n = 3;
  const clauses = ["org_id = $1", "created_at >= $2", "created_at < $3"];
  if (harnessId) { n++; clauses.push(`harness_id = $${n}`); args.push(harnessId); }
  const where = clauses.join(" AND ");
  const bp = `$${n + 1}`;   // bucket-size parameter, appended after the where args

  const t = await one(`SELECT COUNT(*)::int AS runs,
      COALESCE(SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END),0)::int AS errors,
      COALESCE(SUM(tokens_in),0)::bigint AS tokens_in, COALESCE(SUM(tokens_out),0)::bigint AS tokens_out,
      COALESCE(SUM(cost),0)::float AS cost, AVG(latency_ms)::float AS avg_latency,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::float AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::float AS p95
    FROM runs WHERE ${where}`, args);

  const series = await many(`SELECT (created_at / ${bp}) * ${bp} AS t, COUNT(*)::int AS runs,
      COALESCE(SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END),0)::int AS errors,
      COALESCE(SUM(cost),0)::float AS cost, COALESCE(SUM(tokens_in),0)::bigint AS tokens_in,
      COALESCE(SUM(tokens_out),0)::bigint AS tokens_out, AVG(latency_ms)::float AS avg_latency
    FROM runs WHERE ${where} GROUP BY t ORDER BY t`, [...args, bucketMs]);

  const byHarness = await many(`SELECT harness_id, harness_name, COUNT(*)::int AS runs,
      COALESCE(SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END),0)::int AS errors,
      COALESCE(SUM(cost),0)::float AS cost
    FROM runs WHERE ${where} GROUP BY harness_id, harness_name ORDER BY runs DESC LIMIT 10`, args);

  const runs = Number(t.runs || 0), errors = Number(t.errors || 0);
  return {
    range: { from: fromMs, to: toMs, bucket },
    totals: {
      runs, errors, successRate: runs ? (runs - errors) / runs : null,
      tokensIn: Number(t.tokens_in || 0), tokensOut: Number(t.tokens_out || 0), cost: Number(t.cost || 0),
      latencyAvg: t.avg_latency != null ? Math.round(Number(t.avg_latency)) : null,
      latencyP50: t.p50 != null ? Math.round(Number(t.p50)) : null,
      latencyP95: t.p95 != null ? Math.round(Number(t.p95)) : null,
    },
    series: series.map((s) => ({
      t: Number(s.t), runs: Number(s.runs), errors: Number(s.errors), cost: Number(s.cost),
      tokensIn: Number(s.tokens_in), tokensOut: Number(s.tokens_out),
      avgLatency: s.avg_latency != null ? Math.round(Number(s.avg_latency)) : null,
    })),
    byHarness: byHarness.map((h) => ({
      harnessId: h.harness_id, harnessName: h.harness_name,
      runs: Number(h.runs), errors: Number(h.errors), cost: Number(h.cost),
    })),
  };
}

// ── alerting (see db.mjs for the model) ──
const ALERT_METRICS = ["error_rate", "spend", "latency_p95", "run_count"];

function _alertRule(r) {
  return {
    id: r.id, orgId: r.org_id, name: r.name, metric: r.metric, comparator: r.comparator,
    threshold: Number(r.threshold), windowMs: Number(r.window_ms), harnessId: r.harness_id,
    enabled: !!r.enabled, lastState: r.last_state,
    lastEvaluatedAt: r.last_evaluated_at != null ? Number(r.last_evaluated_at) : null,
    lastTriggeredAt: r.last_triggered_at != null ? Number(r.last_triggered_at) : null,
    createdBy: r.created_by, createdAt: Number(r.created_at),
  };
}

export async function createAlertRule(orgId, userId, { name, metric, comparator, threshold, windowMs, harnessId = null } = {}) {
  const role = await orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can manage alerts.");
  if (!name) throw new Error("An alert needs a name.");
  if (!ALERT_METRICS.includes(metric)) throw new Error(`metric must be one of ${ALERT_METRICS.join(", ")}.`);
  if (comparator !== ">" && comparator !== "<") throw new Error("comparator must be '>' or '<'.");
  if (threshold == null || isNaN(Number(threshold))) throw new Error("threshold must be a number.");
  if (!windowMs || Number(windowMs) <= 0) throw new Error("windowMs must be a positive number.");
  const id = uid("alr");
  await exec(`INSERT INTO alert_rules (id, org_id, name, metric, comparator, threshold, window_ms,
      harness_id, enabled, last_state, created_by, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'ok',$9,$10)`,
    [id, orgId, name, metric, comparator, Number(threshold), Number(windowMs), harnessId || null, userId, now()]);
  return _alertRule(await one("SELECT * FROM alert_rules WHERE id = $1", [id]));
}

export async function listAlertRules(orgId, userId) {
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  return (await many("SELECT * FROM alert_rules WHERE org_id = $1 ORDER BY created_at DESC", [orgId])).map(_alertRule);
}

export async function updateAlertRule(userId, ruleId, patch = {}) {
  const r = await one("SELECT * FROM alert_rules WHERE id = $1", [ruleId]);
  if (!r) throw new Error("Alert rule not found.");
  const role = await orgRoleFor(r.org_id, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can manage alerts.");
  const comparator = patch.comparator ?? r.comparator;
  if (comparator !== ">" && comparator !== "<") throw new Error("comparator must be '>' or '<'.");
  await exec(`UPDATE alert_rules SET name=$1, comparator=$2, threshold=$3, window_ms=$4, harness_id=$5, enabled=$6
    WHERE id=$7`, [
    patch.name ?? r.name, comparator,
    patch.threshold != null ? Number(patch.threshold) : r.threshold,
    patch.windowMs != null ? Number(patch.windowMs) : r.window_ms,
    patch.harnessId !== undefined ? (patch.harnessId || null) : r.harness_id,
    patch.enabled != null ? (patch.enabled ? 1 : 0) : r.enabled, ruleId]);
  return _alertRule(await one("SELECT * FROM alert_rules WHERE id = $1", [ruleId]));
}

export async function deleteAlertRule(userId, ruleId) {
  const r = await one("SELECT * FROM alert_rules WHERE id = $1", [ruleId]);
  if (!r) throw new Error("Alert rule not found.");
  const role = await orgRoleFor(r.org_id, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can manage alerts.");
  await exec("DELETE FROM alert_rules WHERE id = $1", [ruleId]);
  return { ok: true };
}

export async function listAlertEvents(orgId, userId, { limit = 50 } = {}) {
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return (await many(`SELECT id, rule_id, org_id, state, value, threshold, message, created_at
    FROM alert_events WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2`, [orgId, lim]))
    .map((e) => ({ id: e.id, ruleId: e.rule_id, orgId: e.org_id, state: e.state,
      value: e.value != null ? Number(e.value) : null,
      threshold: e.threshold != null ? Number(e.threshold) : null,
      message: e.message, createdAt: Number(e.created_at) }));
}

export async function allEnabledAlertRules() {
  return (await many("SELECT * FROM alert_rules WHERE enabled = 1")).map(_alertRule);
}

export async function alertAggregate(orgId, { windowMs, harnessId = null, now: nowMs = now() } = {}) {
  const fromMs = nowMs - Number(windowMs || 0);
  // inclusive upper bound (see db.mjs): count a run recorded in the same ms.
  const args = [orgId, fromMs, nowMs]; let n = 3;
  const clauses = ["org_id = $1", "created_at >= $2", "created_at <= $3"];
  if (harnessId) { n++; clauses.push(`harness_id = $${n}`); args.push(harnessId); }
  const where = clauses.join(" AND ");
  const t = await one(`SELECT COUNT(*)::int AS runs,
      COALESCE(SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END),0)::int AS errors,
      COALESCE(SUM(cost),0)::float AS spend,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::float AS p95
    FROM runs WHERE ${where}`, args);
  const runs = Number(t.runs || 0), errors = Number(t.errors || 0);
  return { runs, errors, errorRate: runs ? errors / runs : 0,
           spend: Number(t.spend || 0), latencyP95: t.p95 != null ? Math.round(Number(t.p95)) : null };
}

export async function recordAlertEvent(ruleId, orgId, { state, value = null, threshold = null, message = null } = {}) {
  const id = uid("ale");
  await exec(`INSERT INTO alert_events (id, rule_id, org_id, state, value, threshold, message, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, ruleId, orgId, state, value, threshold, message, now()]);
  return { id };
}

export async function setAlertRuleState(ruleId, { state, evaluatedAt = now(), triggeredAt = undefined } = {}) {
  if (triggeredAt !== undefined) {
    await exec("UPDATE alert_rules SET last_state=$1, last_evaluated_at=$2, last_triggered_at=$3 WHERE id=$4",
      [state, evaluatedAt, triggeredAt, ruleId]);
  } else {
    await exec("UPDATE alert_rules SET last_state=$1, last_evaluated_at=$2 WHERE id=$3",
      [state, evaluatedAt, ruleId]);
  }
}

// ── alert delivery channels (see db.mjs for the model) ──
const ALERT_CHANNEL_TYPES = ["webhook", "slack"];

function _alertChannel(r) {
  let config = {}; try { config = r.config ? JSON.parse(r.config) : {}; } catch { /* ignore */ }
  return { id: r.id, orgId: r.org_id, type: r.type, target: r.target, config,
           enabled: !!r.enabled, createdBy: r.created_by, createdAt: Number(r.created_at) };
}

export async function createAlertChannel(orgId, userId, { type, target, config = {} } = {}) {
  const role = await orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can manage alert channels.");
  if (!ALERT_CHANNEL_TYPES.includes(type)) throw new Error(`type must be one of ${ALERT_CHANNEL_TYPES.join(", ")}.`);
  if (!/^https:\/\//.test(String(target || ""))) throw new Error("target must be an https URL.");
  const id = uid("ach");
  await exec(`INSERT INTO alert_channels (id, org_id, type, target, config, enabled, created_by, created_at)
    VALUES ($1,$2,$3,$4,$5,1,$6,$7)`, [id, orgId, type, target, JSON.stringify(config || {}), userId, now()]);
  await logAudit(orgId, userId, "alertchannel.create", { targetType: "alertchannel", targetId: id, detail: { type } });
  return _alertChannel(await one("SELECT * FROM alert_channels WHERE id = $1", [id]));
}

export async function listAlertChannels(orgId, userId) {
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  return (await many("SELECT * FROM alert_channels WHERE org_id = $1 ORDER BY created_at DESC", [orgId])).map(_alertChannel);
}

export async function updateAlertChannel(userId, channelId, patch = {}) {
  const r = await one("SELECT * FROM alert_channels WHERE id = $1", [channelId]);
  if (!r) throw new Error("Alert channel not found.");
  const role = await orgRoleFor(r.org_id, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can manage alert channels.");
  const target = patch.target !== undefined ? patch.target : r.target;
  if (!/^https:\/\//.test(String(target || ""))) throw new Error("target must be an https URL.");
  await exec("UPDATE alert_channels SET target=$1, config=$2, enabled=$3 WHERE id=$4", [
    target,
    patch.config !== undefined ? JSON.stringify(patch.config || {}) : r.config,
    patch.enabled != null ? (patch.enabled ? 1 : 0) : r.enabled, channelId]);
  return _alertChannel(await one("SELECT * FROM alert_channels WHERE id = $1", [channelId]));
}

export async function deleteAlertChannel(userId, channelId) {
  const r = await one("SELECT * FROM alert_channels WHERE id = $1", [channelId]);
  if (!r) throw new Error("Alert channel not found.");
  const role = await orgRoleFor(r.org_id, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can manage alert channels.");
  await exec("DELETE FROM alert_channels WHERE id = $1", [channelId]);
  return { deleted: true };
}

export async function enabledAlertChannels(orgId) {
  return (await many("SELECT * FROM alert_channels WHERE org_id = $1 AND enabled = 1", [orgId])).map(_alertChannel);
}

// ── human-in-the-loop approval inbox (see db.mjs for the model) ──
function _approval(r) {
  let detail = r.detail; try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { /* keep string */ }
  return { id: r.id, orgId: r.org_id, harnessId: r.harness_id, runId: r.run_id, title: r.title,
    detail, status: r.status, requestedBy: r.requested_by, decidedBy: r.decided_by,
    decisionNote: r.decision_note,
    expiresAt: r.expires_at != null ? Number(r.expires_at) : null,
    createdAt: Number(r.created_at), decidedAt: r.decided_at != null ? Number(r.decided_at) : null };
}

export async function createApprovalRequest(orgId, userId, { harnessId = null, runId = null, title, detail = null, expiresAt = null } = {}) {
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  if (!title || !String(title).trim()) throw new Error("An approval request needs a title.");
  const id = uid("apr");
  const det = detail == null ? null : (typeof detail === "string" ? detail : JSON.stringify(detail));
  await exec(`INSERT INTO approval_requests (id, org_id, harness_id, run_id, title, detail, status, requested_by, expires_at, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9)`, [id, orgId, harnessId, runId, String(title).trim(), det, userId, expiresAt, now()]);
  return _approval(await one("SELECT * FROM approval_requests WHERE id = $1", [id]));
}

export async function listApprovalRequests(orgId, userId, { status = null, limit = 50 } = {}) {
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = status
    ? await many("SELECT * FROM approval_requests WHERE org_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3", [orgId, status, lim])
    : await many("SELECT * FROM approval_requests WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2", [orgId, lim]);
  return rows.map(_approval);
}

export async function getApprovalRequest(userId, id) {
  const r = await one("SELECT * FROM approval_requests WHERE id = $1", [id]);
  if (!r) throw new Error("Approval request not found.");
  if (!await orgRoleFor(r.org_id, userId)) throw new Error("Not a member of this organization.");
  if (r.status === "pending" && r.expires_at && now() > Number(r.expires_at)) {
    await exec("UPDATE approval_requests SET status='expired', decided_at=$1 WHERE id=$2", [now(), id]);
    r.status = "expired"; r.decided_at = now();
  }
  return _approval(r);
}

export async function decideApprovalRequest(userId, id, { decision, note = null } = {}) {
  const r = await one("SELECT * FROM approval_requests WHERE id = $1", [id]);
  if (!r) throw new Error("Approval request not found.");
  if (!await orgRoleFor(r.org_id, userId)) throw new Error("Not a member of this organization.");
  if (!["approve", "reject"].includes(decision)) throw new Error("decision must be 'approve' or 'reject'.");
  if (r.status !== "pending") throw new Error(`This request is already ${r.status}.`);
  if (r.expires_at && now() > Number(r.expires_at)) {
    await exec("UPDATE approval_requests SET status='expired', decided_at=$1 WHERE id=$2", [now(), id]);
    throw new Error("This request has expired.");
  }
  const status = decision === "approve" ? "approved" : "rejected";
  await exec("UPDATE approval_requests SET status=$1, decided_by=$2, decision_note=$3, decided_at=$4 WHERE id=$5",
    [status, userId, note, now(), id]);
  await logAudit(r.org_id, userId, "approval.decide", { targetType: "approval", targetId: id, detail: { decision } });
  return _approval(await one("SELECT * FROM approval_requests WHERE id = $1", [id]));
}

// ── eval at scale (see db.mjs for the model) ──
function _dataset(r, withCases = true) {
  let cases = []; try { cases = r.cases ? JSON.parse(r.cases) : []; } catch { /* ignore */ }
  const out = { id: r.id, orgId: r.org_id, harnessId: r.harness_id, name: r.name, caseCount: cases.length,
    createdBy: r.created_by, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
  if (withCases) out.cases = cases;
  return out;
}

export async function createEvalDataset(orgId, userId, { name, harnessId = null, cases = [] } = {}) {
  const role = await orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can manage eval datasets.");
  if (!name || !String(name).trim()) throw new Error("A dataset needs a name.");
  if (!Array.isArray(cases)) throw new Error("cases must be an array.");
  const id = uid("eds"); const t = now();
  await exec("INSERT INTO eval_datasets (id, org_id, harness_id, name, cases, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [id, orgId, harnessId, String(name).trim(), JSON.stringify(cases), userId, t, t]);
  return _dataset(await one("SELECT * FROM eval_datasets WHERE id = $1", [id]));
}

export async function listEvalDatasets(orgId, userId) {
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  return (await many("SELECT * FROM eval_datasets WHERE org_id = $1 ORDER BY created_at DESC", [orgId])).map((r) => _dataset(r, false));
}

export async function getEvalDataset(userId, id) {
  const r = await one("SELECT * FROM eval_datasets WHERE id = $1", [id]);
  if (!r) throw new Error("Dataset not found.");
  if (!await orgRoleFor(r.org_id, userId)) throw new Error("Not a member of this organization.");
  return _dataset(r);
}

export async function updateEvalDataset(userId, id, patch = {}) {
  const r = await one("SELECT * FROM eval_datasets WHERE id = $1", [id]);
  if (!r) throw new Error("Dataset not found.");
  const role = await orgRoleFor(r.org_id, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can manage eval datasets.");
  if (patch.cases !== undefined && !Array.isArray(patch.cases)) throw new Error("cases must be an array.");
  await exec("UPDATE eval_datasets SET name=$1, cases=$2, updated_at=$3 WHERE id=$4", [
    patch.name !== undefined ? String(patch.name).trim() : r.name,
    patch.cases !== undefined ? JSON.stringify(patch.cases) : r.cases, now(), id]);
  return _dataset(await one("SELECT * FROM eval_datasets WHERE id = $1", [id]));
}

export async function deleteEvalDataset(userId, id) {
  const r = await one("SELECT * FROM eval_datasets WHERE id = $1", [id]);
  if (!r) throw new Error("Dataset not found.");
  const role = await orgRoleFor(r.org_id, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can manage eval datasets.");
  await exec("DELETE FROM eval_datasets WHERE id = $1", [id]);
  return { deleted: true };
}

function _evalRun(r, withResults = true) {
  let results = []; try { results = r.results ? JSON.parse(r.results) : []; } catch { /* ignore */ }
  const total = Number(r.total), passed = Number(r.passed);
  const out = { id: r.id, orgId: r.org_id, datasetId: r.dataset_id, harnessId: r.harness_id, label: r.label,
    total, passed, passRate: total ? passed / total : 0, scoreAvg: Number(r.score_avg),
    createdBy: r.created_by, createdAt: Number(r.created_at) };
  if (withResults) out.results = results;
  return out;
}

export async function recordEvalRun(orgId, userId, { datasetId = null, harnessId = null, label = null, cases = [] } = {}) {
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  const { results, total, passed, scoreAvg } = scoreDataset(cases);
  const id = uid("ern");
  await exec("INSERT INTO eval_runs (id, org_id, dataset_id, harness_id, label, total, passed, score_avg, results, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [id, orgId, datasetId, harnessId, label, total, passed, scoreAvg, JSON.stringify(results), userId, now()]);
  return _evalRun(await one("SELECT * FROM eval_runs WHERE id = $1", [id]));
}

export async function listEvalRuns(orgId, userId, { datasetId = null, limit = 50 } = {}) {
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = datasetId
    ? await many("SELECT * FROM eval_runs WHERE org_id = $1 AND dataset_id = $2 ORDER BY created_at DESC LIMIT $3", [orgId, datasetId, lim])
    : await many("SELECT * FROM eval_runs WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2", [orgId, lim]);
  return rows.map((r) => _evalRun(r, false));
}

export async function getEvalRun(userId, id) {
  const r = await one("SELECT * FROM eval_runs WHERE id = $1", [id]);
  if (!r) throw new Error("Eval run not found.");
  if (!await orgRoleFor(r.org_id, userId)) throw new Error("Not a member of this organization.");
  return _evalRun(r);
}

export async function compareEvalRuns(userId, aId, bId) {
  const a = await getEvalRun(userId, aId), b = await getEvalRun(userId, bId);
  const byInput = new Map(a.results.map((r) => [r.input, r]));
  const regressions = [], fixes = []; let changedCount = 0;
  for (const rb of b.results) {
    const ra = byInput.get(rb.input);
    if (!ra) continue;
    if (ra.passed && !rb.passed) regressions.push({ input: rb.input, before: ra, after: rb });
    else if (!ra.passed && rb.passed) fixes.push({ input: rb.input, before: ra, after: rb });
    if (ra.passed !== rb.passed) changedCount++;
  }
  return { a: { id: a.id, passRate: a.passRate, passed: a.passed, total: a.total },
           b: { id: b.id, passRate: b.passRate, passed: b.passed, total: b.total },
           passRateDelta: b.passRate - a.passRate, regressions, fixes, changedCount };
}

// ── budgets & quotas (see db.mjs for the model) ──
function _windowStart(period, nowMs = now()) {
  if (period === "total") return 0;
  const d = new Date(nowMs);
  if (period === "day") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
async function _spendSince(org, startMs) {
  const r = await one("SELECT COALESCE(SUM(cost),0) AS cost, COUNT(*)::int AS n FROM runs WHERE org_id = $1 AND created_at >= $2", [org, startMs]);
  return { cost: Number(r ? r.cost : 0) || 0, requests: r ? r.n : 0 };
}

export async function setBudget(orgId, userId, { period, maxCost = null, maxRequests = null }) {
  const role = await orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can set budgets.");
  if (!["day", "month", "total"].includes(period)) throw new Error("period must be 'day', 'month', or 'total'.");
  if (maxCost == null && maxRequests == null) throw new Error("Set at least one of maxCost or maxRequests.");
  await exec(`INSERT INTO budgets (id, org_id, period, max_cost, max_requests, created_by, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (org_id, period) DO UPDATE SET max_cost = EXCLUDED.max_cost,
        max_requests = EXCLUDED.max_requests, created_by = EXCLUDED.created_by`,
    [uid("bud"), orgId, period, maxCost, maxRequests, userId, now()]);
  await logAudit(orgId, userId, "budget.set", { targetType: "budget", detail: { period, maxCost, maxRequests } });
  return listBudgets(orgId, userId);
}

export async function listBudgets(orgId, userId) {
  const role = await orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can view budgets.");
  const rows = await many("SELECT id, period, max_cost, max_requests FROM budgets WHERE org_id = $1 ORDER BY period", [orgId]);
  return rows.map((b) => ({ id: b.id, period: b.period, maxCost: b.max_cost, maxRequests: b.max_requests != null ? Number(b.max_requests) : null }));
}

export async function deleteBudget(orgId, userId, budgetId) {
  const role = await orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can delete budgets.");
  await exec("DELETE FROM budgets WHERE id = $1 AND org_id = $2", [budgetId, orgId]);
  await logAudit(orgId, userId, "budget.delete", { targetType: "budget", targetId: budgetId });
  return { deleted: true };
}

export async function budgetStatus(orgId, userId) {
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  const rows = await many("SELECT period, max_cost, max_requests FROM budgets WHERE org_id = $1 ORDER BY period", [orgId]);
  const out = [];
  for (const b of rows) {
    const { cost, requests } = await _spendSince(orgId, _windowStart(b.period));
    out.push({
      period: b.period, maxCost: b.max_cost, maxRequests: b.max_requests != null ? Number(b.max_requests) : null,
      spend: Math.round(cost * 1e6) / 1e6, requests,
      costExceeded: b.max_cost != null && cost >= b.max_cost,
      requestsExceeded: b.max_requests != null && requests >= Number(b.max_requests),
    });
  }
  return out;
}

export async function checkBudget(orgId) {
  if (!orgId) return { allowed: true };
  const rows = await many("SELECT period, max_cost, max_requests FROM budgets WHERE org_id = $1", [orgId]);
  for (const b of rows) {
    const { cost, requests } = await _spendSince(orgId, _windowStart(b.period));
    if (b.max_cost != null && cost >= b.max_cost)
      return { allowed: false, reason: `spend cap reached ($${b.max_cost} / ${b.period})` };
    if (b.max_requests != null && requests >= Number(b.max_requests))
      return { allowed: false, reason: `request quota reached (${Number(b.max_requests)} / ${b.period})` };
  }
  return { allowed: true };
}

// ── deployments (hosted control plane; see db.mjs for the model) ──
const _slugOk = (s) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(String(s || ""));

export async function createDeployment(orgId, userId, { slug, harnessId = null, targetUrl = null }) {
  const role = await orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can create deployments.");
  slug = String(slug || "").trim().toLowerCase();
  if (!_slugOk(slug)) throw new Error("slug must be 2–63 chars: lowercase letters, digits, hyphens.");
  if (targetUrl != null && !/^https?:\/\//.test(targetUrl)) throw new Error("targetUrl must be an http(s) URL.");
  if (await one("SELECT 1 FROM deployments WHERE slug = $1", [slug])) throw new Error(`The slug '${slug}' is already taken.`);
  const id = uid("dep");
  await exec(`INSERT INTO deployments (id, org_id, harness_id, slug, target_url, status, created_by, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, orgId, harnessId, slug, targetUrl, "active", userId, now()]);
  await logAudit(orgId, userId, "deployment.create", { targetType: "deployment", targetId: id, detail: { slug, harnessId } });
  return { id, slug, harnessId, targetUrl, status: "active" };
}

export async function listDeployments(orgId, userId) {
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  const rows = await many("SELECT id, harness_id, slug, target_url, status, created_at, created_by FROM deployments WHERE org_id = $1 ORDER BY created_at DESC", [orgId]);
  return rows.map((d) => ({ id: d.id, harnessId: d.harness_id, slug: d.slug, targetUrl: d.target_url, status: d.status, createdAt: Number(d.created_at), createdBy: d.created_by }));
}

export async function deleteDeployment(orgId, userId, depId) {
  const role = await orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can delete deployments.");
  await exec("DELETE FROM deployments WHERE id = $1 AND org_id = $2", [depId, orgId]);
  await logAudit(orgId, userId, "deployment.delete", { targetType: "deployment", targetId: depId });
  return { deleted: true };
}

export async function resolveDeployment(slug) {
  const d = await one("SELECT id, org_id, harness_id, slug, target_url, status FROM deployments WHERE slug = $1", [String(slug || "").toLowerCase()]);
  if (!d) return null;
  return { id: d.id, orgId: d.org_id, harnessId: d.harness_id, slug: d.slug, targetUrl: d.target_url, status: d.status };
}

// ── managed runners (see db.mjs for the model) ──
function _managedRunner(r) {
  return {
    id: r.id, orgId: r.org_id, harnessId: r.harness_id, deploymentId: r.deployment_id,
    slug: r.slug, driver: r.driver, machineId: r.machine_id, region: r.region, image: r.image,
    status: r.status, url: r.url, detail: r.detail, apiKeyId: r.api_key_id,
    lastHealthAt: r.last_health_at != null ? Number(r.last_health_at) : null,
    createdBy: r.created_by, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

export async function createManagedRunner(orgId, userId, { harnessId = null, slug = null, driver, region = null, image = null } = {}) {
  const role = await orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can provision runners.");
  if (!driver) throw new Error("A machines driver is required.");
  const id = uid("run"); const t = now();
  await exec(`INSERT INTO managed_runners (id, org_id, harness_id, slug, driver, region, image, status, created_by, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'provisioning',$8,$9,$10)`, [id, orgId, harnessId, slug, driver, region, image, userId, t, t]);
  await logAudit(orgId, userId, "runner.provision", { targetType: "runner", targetId: id, detail: { harnessId, slug, driver } });
  return _managedRunner(await one("SELECT * FROM managed_runners WHERE id = $1", [id]));
}

export async function getManagedRunner(userId, runnerId) {
  const r = await one("SELECT * FROM managed_runners WHERE id = $1", [runnerId]);
  if (!r) throw new Error("Runner not found.");
  if (!await orgRoleFor(r.org_id, userId)) throw new Error("Not a member of this organization.");
  return _managedRunner(r);
}

export async function listManagedRunners(orgId, userId) {
  if (!await orgRoleFor(orgId, userId)) throw new Error("Not a member of this organization.");
  return (await many("SELECT * FROM managed_runners WHERE org_id = $1 ORDER BY created_at DESC", [orgId])).map(_managedRunner);
}

export async function updateManagedRunner(runnerId, patch = {}) {
  const r = await one("SELECT * FROM managed_runners WHERE id = $1", [runnerId]);
  if (!r) throw new Error("Runner not found.");
  const pick = (k, col) => (patch[k] !== undefined ? patch[k] : r[col]);
  await exec(`UPDATE managed_runners SET deployment_id=$1, slug=$2, machine_id=$3, region=$4, image=$5, status=$6, url=$7, detail=$8, api_key_id=$9, last_health_at=$10, updated_at=$11 WHERE id=$12`,
    [pick("deploymentId", "deployment_id"), pick("slug", "slug"), pick("machineId", "machine_id"),
     pick("region", "region"), pick("image", "image"), pick("status", "status"), pick("url", "url"),
     pick("detail", "detail"), pick("apiKeyId", "api_key_id"), pick("lastHealthAt", "last_health_at"), now(), runnerId]);
  return _managedRunner(await one("SELECT * FROM managed_runners WHERE id = $1", [runnerId]));
}

export async function deleteManagedRunner(orgId, userId, runnerId) {
  const role = await orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can remove runners.");
  await exec("DELETE FROM managed_runners WHERE id = $1 AND org_id = $2", [runnerId, orgId]);
  await logAudit(orgId, userId, "runner.delete", { targetType: "runner", targetId: runnerId });
  return { deleted: true };
}

export async function setDeploymentTarget(depId, { targetUrl, status } = {}) {
  const d = await one("SELECT * FROM deployments WHERE id = $1", [depId]);
  if (!d) return null;
  await exec("UPDATE deployments SET target_url = $1, status = $2 WHERE id = $3",
    [targetUrl !== undefined ? targetUrl : d.target_url, status !== undefined ? status : d.status, depId]);
  return { id: depId };
}

/* ── node-anchored comments (collaboration; see db.mjs for the model) ── */
export async function listComments(harnessId, userId) {
  if (!await roleFor(harnessId, userId)) throw new Error("Not found, or not in one of your organizations.");
  const rows = await many(`SELECT c.id, c.node_id, c.body, c.resolved, c.created_at, c.author_id, u.email AS author_email
    FROM comments c LEFT JOIN users u ON u.id = c.author_id
    WHERE c.harness_id = $1 ORDER BY c.created_at ASC`, [harnessId]);
  return rows.map((c) => ({ id: c.id, nodeId: c.node_id, body: c.body, resolved: !!c.resolved, createdAt: Number(c.created_at), authorId: c.author_id, authorEmail: c.author_email }));
}

export async function createComment(harnessId, userId, { nodeId = null, body }) {
  if (!await roleFor(harnessId, userId)) throw new Error("Not found, or not in one of your organizations.");
  body = String(body || "").trim();
  if (!body) throw new Error("A comment can't be empty.");
  if (body.length > 4000) throw new Error("Comment too long (max 4000 characters).");
  const h = await one("SELECT org_id FROM harnesses WHERE id = $1", [harnessId]);
  const id = uid("cm"), ts = now();
  await exec("INSERT INTO comments (id, harness_id, org_id, node_id, author_id, body, resolved, created_at) VALUES ($1,$2,$3,$4,$5,$6,0,$7)",
    [id, harnessId, h?.org_id || null, nodeId, userId, body, ts]);
  const u = await one("SELECT email FROM users WHERE id = $1", [userId]);
  return { id, nodeId, body, resolved: false, createdAt: ts, authorId: userId, authorEmail: u?.email };
}

async function _commentRow(id) { return one("SELECT id, harness_id, author_id FROM comments WHERE id = $1", [id]); }

export async function resolveComment(commentId, userId, resolved = true) {
  const c = await _commentRow(commentId);
  if (!c) throw new Error("Comment not found.");
  if (await roleFor(c.harness_id, userId) !== "edit" && c.author_id !== userId) throw new Error("Only an editor or the author can resolve this comment.");
  await exec("UPDATE comments SET resolved = $1 WHERE id = $2", [resolved ? 1 : 0, commentId]);
  return { id: commentId, resolved: !!resolved };
}

export async function deleteComment(commentId, userId) {
  const c = await _commentRow(commentId);
  if (!c) return { id: commentId, deleted: true };
  if (await roleFor(c.harness_id, userId) !== "edit" && c.author_id !== userId) throw new Error("Only an editor or the author can delete this comment.");
  await exec("DELETE FROM comments WHERE id = $1", [commentId]);
  return { id: commentId, deleted: true };
}

// ── data governance: export & right-to-erasure (see db.mjs for the model) ──
export async function exportOrg(orgId, userId) {
  const role = await orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can export organization data.");
  const org = await one("SELECT id, name, created_at, personal FROM orgs WHERE id = $1", [orgId]);
  if (!org) throw new Error("Organization not found.");
  const members = await many(`SELECT u.email, m.role FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = $1 AND substr(u.id,1,5) <> 'svcu_' ORDER BY m.role, u.email`, [orgId]);
  const harnesses = (await many("SELECT id, name, graph_json, updated_at FROM harnesses WHERE org_id = $1", [orgId]))
    .map((h) => ({ id: h.id, name: h.name, graph: JSON.parse(h.graph_json), updatedAt: Number(h.updated_at) }));
  const runs = await many(`SELECT id, harness_id, status, latency_ms, tokens_in, tokens_out, cost, created_at
    FROM runs WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1000`, [orgId]);
  const audit = await listAudit(orgId, userId, { limit: 500 });
  const budgets = await many("SELECT period, max_cost, max_requests FROM budgets WHERE org_id = $1", [orgId]);
  const deployments = await many("SELECT slug, harness_id, target_url, status FROM deployments WHERE org_id = $1", [orgId]);
  const apiKeys = await many("SELECT name, role, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE org_id = $1", [orgId]);
  await logAudit(orgId, userId, "org.export", { detail: { harnesses: harnesses.length, runs: runs.length } });
  return { exportedAt: now(), org: { id: org.id, name: org.name, createdAt: Number(org.created_at), personal: !!org.personal },
           members, harnesses, runs, audit, budgets, deployments, apiKeys };
}

export async function eraseOrg(orgId, userId) {
  if (await orgRoleFor(orgId, userId) !== "owner") throw new Error("Only an owner can erase an organization.");
  const svc = (await many("SELECT user_id FROM api_keys WHERE org_id = $1", [orgId])).map((r) => r.user_id);
  await exec("DELETE FROM deployments WHERE org_id = $1", [orgId]);
  await exec("DELETE FROM budgets WHERE org_id = $1", [orgId]);
  await exec("DELETE FROM runs WHERE org_id = $1", [orgId]);
  await exec("DELETE FROM comments WHERE org_id = $1", [orgId]);
  await exec("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
  await exec("DELETE FROM api_keys WHERE org_id = $1", [orgId]);
  await exec("DELETE FROM harnesses WHERE org_id = $1", [orgId]);
  await exec("DELETE FROM org_members WHERE org_id = $1", [orgId]);
  for (const sid of svc) await exec("DELETE FROM users WHERE id = $1 AND substr(id,1,5) = 'svcu_'", [sid]);
  await exec("DELETE FROM orgs WHERE id = $1", [orgId]);
  return { erased: true, orgId };
}

// ── per-user key/value ──
export async function kvGet(userId, key) {
  const r = await one("SELECT value FROM kv WHERE owner_id = $1 AND key = $2", [userId, key]);
  return r ? r.value : null;
}
export async function kvSet(userId, key, value, harnessId = null) {
  await exec(`INSERT INTO kv (owner_id, harness_id, key, value) VALUES ($1,$2,$3,$4)
              ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value, harness_id = EXCLUDED.harness_id`,
    [userId, harnessId, key, value]);
  return { key };
}
export async function kvDelete(userId, key) {
  await exec("DELETE FROM kv WHERE owner_id = $1 AND key = $2", [userId, key]);
  return { key, deleted: true };
}
export async function kvList(userId, prefix = "") {
  const rows = await many(
    "SELECT key FROM kv WHERE owner_id = $1 AND key LIKE $2 ORDER BY key",
    [userId, prefix.replace(/[%_]/g, "\\$&") + "%"]);
  return rows.map((r) => r.key);
}

// test/ops helper
export async function _close() { if (pool) await pool.end(); pool = null; }

// readiness probe: a cheap round-trip to confirm the pool answers
export async function ping() {
  if (!pool) throw new Error("postgres pool not initialized");
  await pool.query("SELECT 1");
  return true;
}
