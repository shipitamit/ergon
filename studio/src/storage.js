/* Storage shim + auth client.

   Three backends, one interface (get/set/delete/list):
     • window.storage  — inside a Claude artifact (persistent KV, injected)
     • localAdapter     — standalone build, signed out (browser localStorage)
     • apiAdapter       — standalone build, signed in (server-side, per-user)

   The active backend is chosen at runtime: sign in and the whole app
   (harness library sessions, timeline events) moves to the server with no
   other code change, because everything goes through `storage`.
*/

const PREFIX = "ergon:";

const localAdapter = {
  kind: "local",
  async get(key) {
    const v = localStorage.getItem(PREFIX + key);
    if (v === null) throw new Error(`key not found: ${key}`);
    return { key, value: v };
  },
  async set(key, value) {
    localStorage.setItem(PREFIX + key, value);
    return { key, value };
  },
  async delete(key) {
    localStorage.removeItem(PREFIX + key);
    return { key, deleted: true };
  },
  async list(prefix = "") {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(PREFIX + prefix)) keys.push(k.slice(PREFIX.length));
    }
    return { keys, prefix };
  },
};

const apiAdapter = {
  kind: "api",
  async get(key) {
    const r = await fetch(`/api/kv?key=${encodeURIComponent(key)}`, { credentials: "same-origin" });
    if (!r.ok) throw new Error(`get failed (${r.status})`);
    const { value } = await r.json();
    if (value == null) throw new Error(`key not found: ${key}`);
    return { key, value };
  },
  async set(key, value, harnessId) {
    const r = await fetch("/api/kv", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, value, harnessId }),
    });
    if (!r.ok) throw new Error(`set failed (${r.status})`);
    return { key, value };
  },
  async delete(key) {
    await fetch("/api/kv", {
      method: "DELETE", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    return { key, deleted: true };
  },
  async list(prefix = "") {
    const r = await fetch(`/api/kv?prefix=${encodeURIComponent(prefix)}`, { credentials: "same-origin" });
    if (!r.ok) throw new Error(`list failed (${r.status})`);
    const { keys } = await r.json();
    return { keys, prefix };
  },
};

const inArtifact = typeof window !== "undefined" && window.storage;

// Mutable active backend. `storage` is a stable proxy delegating to it, so
// modules that imported `storage` never need to re-import after sign-in.
let active = inArtifact ? window.storage : localAdapter;
export function useServerStorage(on) { active = on ? apiAdapter : (inArtifact ? window.storage : localAdapter); }
export const storageKind = () => active.kind || "artifact";

export const storage = {
  get: (...a) => active.get(...a),
  set: (...a) => active.set(...a),
  delete: (...a) => active.delete(...a),
  list: (...a) => active.list(...a),
};

/* ── auth client (only meaningful in the standalone app) ── */
export const auth = {
  available: !inArtifact,   // no accounts inside the Claude artifact
  async me() {
    try {
      const r = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (!r.ok) return null;
      return (await r.json()).user;
    } catch { return null; }
  },
  async signup(email, password) { return authPost("/api/auth/signup", { email, password }); },
  async login(email, password) { return authPost("/api/auth/login", { email, password }); },
  async logout() { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }); },
  // which sign-in methods the server offers; drives the SSO button's visibility
  async providers() {
    try {
      const r = await fetch("/api/auth/providers", { credentials: "same-origin" });
      if (!r.ok) return { password: true, sso: false };
      return await r.json();
    } catch { return { password: true, sso: false }; }
  },
  // full-page redirect into the OIDC flow (server sets state cookie + 302s to the IdP)
  ssoLogin() { window.location.href = "/api/auth/sso/login"; },
};

async function authPost(url, body) {
  const r = await fetch(url, {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
  return data.user;
}

/* ── harness & sharing client (server-backed library) ── */
export const cloud = {
  async list() { return (await getJSON("/api/harnesses")).harnesses; },
  async get(id) { return (await getJSON(`/api/harnesses/${encodeURIComponent(id)}`)).harness; },
  async save({ id, name, graph, orgId, expectedVersion, force }) {
    const r = await fetch("/api/harnesses", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, name, graph, orgId, expectedVersion, force }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 409) {
      const err = new Error(data.error || "This harness changed on the server since you opened it.");
      err.conflict = true; err.current = data.current;
      throw err;
    }
    if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
    return data.harness;
  },
  async remove(id) { return sendJSON("DELETE", `/api/harnesses/${encodeURIComponent(id)}`); },
  // organizations (org + RBAC access model)
  async orgs() { return (await getJSON("/api/orgs")).orgs; },
  async createOrg(name) { return (await sendJSON("POST", "/api/orgs", { name })).org; },
  async members(orgId) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/members`)).members; },
  async addMember(orgId, email, role) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/members`, { email, role })).members; },
  async removeMember(orgId, email) { return (await sendJSON("DELETE", `/api/orgs/${encodeURIComponent(orgId)}/members`, { email })).members; },
  async setHarnessOrg(id, orgId) { return (await sendJSON("POST", `/api/harnesses/${encodeURIComponent(id)}/org`, { orgId })).harness; },
  async audit(orgId, { limit, before } = {}) {
    const qs = new URLSearchParams();
    if (limit != null) qs.set("limit", String(limit));
    if (before != null) qs.set("before", String(before));
    const q = qs.toString();
    return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/audit${q ? `?${q}` : ""}`)).entries;
  },
  // service accounts / API keys
  async keys(orgId) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/keys`)).keys; },
  async createKey(orgId, name, role) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/keys`, { name, role })).key; },
  async revokeKey(orgId, keyId) { return sendJSON("DELETE", `/api/orgs/${encodeURIComponent(orgId)}/keys/${encodeURIComponent(keyId)}`); },
  // run history
  async recordRun(rec) { try { return await sendJSON("POST", "/api/runs", rec); } catch { return null; } },
  async runs(orgId, { harnessId, limit, before } = {}) {
    const qs = new URLSearchParams({ orgId });
    if (harnessId) qs.set("harnessId", harnessId);
    if (limit != null) qs.set("limit", String(limit));
    if (before != null) qs.set("before", String(before));
    return (await getJSON(`/api/runs?${qs.toString()}`)).runs;
  },
  async getRun(id) { return (await getJSON(`/api/runs/${encodeURIComponent(id)}`)).run; },
  // observability: metrics, trace search, alerts
  async metrics(orgId, { from, to, bucket, harnessId } = {}) {
    const qs = new URLSearchParams({ orgId });
    if (from != null) qs.set("from", String(from));
    if (to != null) qs.set("to", String(to));
    if (bucket) qs.set("bucket", bucket);
    if (harnessId) qs.set("harnessId", harnessId);
    return getJSON(`/api/metrics?${qs.toString()}`);
  },
  async searchRuns(orgId, opts = {}) {
    const qs = new URLSearchParams({ orgId });
    for (const [k, v] of Object.entries(opts)) if (v != null && v !== "") qs.set(k, String(v));
    return (await getJSON(`/api/runs/search?${qs.toString()}`)).runs;
  },
  async alerts(orgId) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/alerts`)).rules; },
  async createAlert(orgId, body) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/alerts`, body)).rule; },
  async updateAlert(orgId, ruleId, body) { return (await sendJSON("PATCH", `/api/orgs/${encodeURIComponent(orgId)}/alerts/${encodeURIComponent(ruleId)}`, body)).rule; },
  async deleteAlert(orgId, ruleId) { return sendJSON("DELETE", `/api/orgs/${encodeURIComponent(orgId)}/alerts/${encodeURIComponent(ruleId)}`); },
  async alertEvents(orgId, { limit } = {}) { const q = limit != null ? `?limit=${limit}` : ""; return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/alert-events${q}`)).events; },
  async evaluateAlerts(orgId) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/alerts/evaluate`, {})).transitions; },
  async alertChannels(orgId) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/alert-channels`)).channels; },
  async createAlertChannel(orgId, body) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/alert-channels`, body)).channel; },
  async updateAlertChannel(orgId, id, body) { return (await sendJSON("PATCH", `/api/orgs/${encodeURIComponent(orgId)}/alert-channels/${encodeURIComponent(id)}`, body)).channel; },
  async deleteAlertChannel(orgId, id) { return sendJSON("DELETE", `/api/orgs/${encodeURIComponent(orgId)}/alert-channels/${encodeURIComponent(id)}`); },
  async testAlertChannel(orgId, id) { return sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/alert-channels/${encodeURIComponent(id)}/test`, {}); },
  // human-in-the-loop approvals inbox
  async approvals(orgId, { status } = {}) { const q = status ? `?status=${encodeURIComponent(status)}` : ""; return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/approvals${q}`)).requests; },
  async decideApproval(orgId, id, decision, note) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/approvals/${encodeURIComponent(id)}/decide`, { decision, note })).request; },
  // eval at scale: datasets + runs
  async evalDatasets(orgId) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/eval/datasets`)).datasets; },
  async evalDataset(orgId, id) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/eval/datasets/${encodeURIComponent(id)}`)).dataset; },
  async createEvalDataset(orgId, body) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/eval/datasets`, body)).dataset; },
  async updateEvalDataset(orgId, id, body) { return (await sendJSON("PATCH", `/api/orgs/${encodeURIComponent(orgId)}/eval/datasets/${encodeURIComponent(id)}`, body)).dataset; },
  async deleteEvalDataset(orgId, id) { return sendJSON("DELETE", `/api/orgs/${encodeURIComponent(orgId)}/eval/datasets/${encodeURIComponent(id)}`); },
  async evalRuns(orgId, { datasetId } = {}) { const q = datasetId ? `?datasetId=${encodeURIComponent(datasetId)}` : ""; return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/eval/runs${q}`)).runs; },
  async evalRun(orgId, id) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/eval/runs/${encodeURIComponent(id)}`)).run; },
  async recordEvalRun(orgId, body) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/eval/runs`, body)).run; },
  async compareEvalRuns(orgId, a, b) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/eval/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)).comparison; },
  // budgets & quotas
  async budgets(orgId) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/budgets`)).budgets; },
  async budgetStatus(orgId) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/budgets/status`)).status; },
  async setBudget(orgId, period, maxCost, maxRequests) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/budgets`, { period, maxCost, maxRequests })).budgets; },
  async deleteBudget(orgId, id) { return sendJSON("DELETE", `/api/orgs/${encodeURIComponent(orgId)}/budgets/${encodeURIComponent(id)}`); },
  // deployments (hosted control plane)
  async deployments(orgId) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/deployments`)).deployments; },
  async createDeployment(orgId, slug, harnessId, targetUrl) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/deployments`, { slug, harnessId, targetUrl })).deployment; },
  async deleteDeployment(orgId, id) { return sendJSON("DELETE", `/api/orgs/${encodeURIComponent(orgId)}/deployments/${encodeURIComponent(id)}`); },
  // managed hosting (Ergon-operated runners)
  async runners(orgId) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/runners`)).runners; },
  async provisionRunner(orgId, body) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/runners`, body)).runner; },
  async runner(orgId, id) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/runners/${encodeURIComponent(id)}`)).runner; },
  async stopRunner(orgId, id) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/runners/${encodeURIComponent(id)}/stop`, {})).runner; },
  async restartRunner(orgId, id) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/runners/${encodeURIComponent(id)}/restart`, {})).runner; },
  async refreshRunner(orgId, id) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/runners/${encodeURIComponent(id)}/refresh`, {})).runner; },
  async runnerLogs(orgId, id) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/runners/${encodeURIComponent(id)}/logs`)).logs; },
  async deleteRunner(orgId, id) { return sendJSON("DELETE", `/api/orgs/${encodeURIComponent(orgId)}/runners/${encodeURIComponent(id)}`); },
  // data governance
  async exportOrg(orgId) { return getJSON(`/api/orgs/${encodeURIComponent(orgId)}/export`); },
  // collaboration: node-anchored comments
  async comments(harnessId) { return (await getJSON(`/api/harnesses/${encodeURIComponent(harnessId)}/comments`)).comments; },
  async addComment(harnessId, nodeId, body) { return (await sendJSON("POST", `/api/harnesses/${encodeURIComponent(harnessId)}/comments`, { nodeId, body })).comment; },
  async resolveComment(harnessId, commentId, resolved) { return (await sendJSON("PATCH", `/api/harnesses/${encodeURIComponent(harnessId)}/comments/${encodeURIComponent(commentId)}`, { resolved })).comment; },
  async deleteComment(harnessId, commentId) { return sendJSON("DELETE", `/api/harnesses/${encodeURIComponent(harnessId)}/comments/${encodeURIComponent(commentId)}`); },
  // collaboration: live presence heartbeat (returns the other viewers)
  async presence(harnessId, selection, cursor) { return (await sendJSON("POST", `/api/harnesses/${encodeURIComponent(harnessId)}/presence`, { selection, cursor })).viewers; },
  // version history: list saved versions (newest first) and fetch one's graph
  async versions(harnessId) { return (await getJSON(`/api/harnesses/${encodeURIComponent(harnessId)}/versions`)).versions; },
  async version(harnessId, versionId) { return (await getJSON(`/api/harnesses/${encodeURIComponent(harnessId)}/versions/${encodeURIComponent(versionId)}`)).version; },
  // triggers: webhook + schedule entry points that start a run
  async triggers(harnessId) { return (await getJSON(`/api/harnesses/${encodeURIComponent(harnessId)}/triggers`)).triggers; },
  async createTrigger(harnessId, body) { return (await sendJSON("POST", `/api/harnesses/${encodeURIComponent(harnessId)}/triggers`, body)).trigger; },
  async updateTrigger(harnessId, triggerId, body) { return (await sendJSON("PATCH", `/api/harnesses/${encodeURIComponent(harnessId)}/triggers/${encodeURIComponent(triggerId)}`, body)).trigger; },
  async deleteTrigger(harnessId, triggerId) { return sendJSON("DELETE", `/api/harnesses/${encodeURIComponent(harnessId)}/triggers/${encodeURIComponent(triggerId)}`); },
  webhookUrl(token) { try { return `${window.location.origin}/api/hook/${token}`; } catch { return `/api/hook/${token}`; } },
  // connector catalog + managed connections
  async connectors(q = "", category = "") { return (await getJSON(`/api/connectors?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}`)).connectors; },
  async connections(orgId) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/connections`)).connections; },
  async createConnection(orgId, body) { return (await sendJSON("POST", `/api/orgs/${encodeURIComponent(orgId)}/connections`, body)).connection; },
  async updateConnection(orgId, connId, body) { return (await sendJSON("PATCH", `/api/orgs/${encodeURIComponent(orgId)}/connections/${encodeURIComponent(connId)}`, body)).connection; },
  async deleteConnection(orgId, connId) { return sendJSON("DELETE", `/api/orgs/${encodeURIComponent(orgId)}/connections/${encodeURIComponent(connId)}`); },
  async oauthStart(orgId, connectorId) { return (await getJSON(`/api/orgs/${encodeURIComponent(orgId)}/connections/oauth/start?connectorId=${encodeURIComponent(connectorId)}`)).url; },
};

async function getJSON(url) {
  const r = await fetch(url, { credentials: "same-origin" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
  return data;
}
async function sendJSON(method, url, body) {
  const r = await fetch(url, {
    method, credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
  return data;
}
