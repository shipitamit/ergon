/* Managed hosting — the lifecycle that turns a harness into an Ergon-operated
   runner. Driver-agnostic and backend-agnostic: it talks to the data layer and
   a machines driver, both injected, so it's unit-testable offline against the
   fake driver and the real SQLite store (the pattern used by triggers.mjs and
   alerts.mjs).

   Flow: provision() records a managed_runner, launches a machine, health-gates
   it, and — once ready — registers a deployment so the EXISTING gateway routes
   `POST /api/gw/:slug/run` to it unchanged. Nothing new is needed on the
   ingress path; "managed" only means Ergon owns the runner's lifecycle instead
   of the operator running `ergon serve` themselves.

   RBAC: provision/stop/restart/remove are owner/admin; status/logs are any
   member. db.createManagedRunner enforces the provision check; the mutating
   helpers here re-check via db.orgRoleFor. */

function driverName(driver) {
  const n = driver?.constructor?.name || "";
  if (/Fly/i.test(n)) return "fly";
  if (/Fake/i.test(n)) return "fake";
  return n || "custom";
}

async function requireAdmin(db, orgId, userId) {
  const role = await db.orgRoleFor(orgId, userId);
  if (role !== "owner" && role !== "admin") throw new Error("Only an owner or admin can manage runners.");
}

// Deep-scan a harness graph for the managed connections it references.
function collectConnectionIds(graph) {
  const acc = new Set();
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    for (const [k, v] of Object.entries(n)) {
      if (k === "connectionId" && typeof v === "string" && v) acc.add(v);
      else walk(v);
    }
  })(graph);
  return [...acc];
}

/* Build the env a managed runner boots with. The security model matches the
   Python export: rather than baking plaintext credentials into the machine
   image, the runner is handed a scoped, org-bound service API key and the
   server's URL, and it resolves each connection's live material at run time via
   the existing key-authenticated resolver. The connections the harness
   references are listed (ERGON_CONNECTIONS) for preflight and so the runner
   knows what to fetch. Returns { env, apiKeyId } so the caller can revoke the
   key when the runner is torn down. */
export async function buildRunnerEnv(db, { orgId, userId, harnessId = null, slug = null, apiUrl = null, extraEnv = {} } = {}) {
  const key = await db.createApiKey(orgId, userId, `runner:${slug || harnessId || "managed"}`, "member");
  const env = { ...extraEnv, ERGON_API_KEY: key.secret, ERGON_ORG_ID: orgId };
  if (apiUrl) env.ERGON_API_URL = apiUrl;
  if (harnessId) {
    try {
      const h = await db.getHarness(harnessId, userId);
      const ids = collectConnectionIds(h && h.graph);
      if (ids.length) env.ERGON_CONNECTIONS = ids.join(",");
    } catch { /* harness unreadable → the runner simply gets no connection hint */ }
  }
  return { env, apiKeyId: key.id };
}

// Launch a managed runner for a harness and, once it's healthy, route to it.
export async function provision(db, { orgId, userId, harnessId = null, slug, region = null, image = null, env = {} } = {}, { driver, pollMax = 3, apiUrl = null, injectSecrets = true, now = () => Date.now() } = {}) {
  if (!driver) throw new Error("A machines driver is required.");
  if (!slug) throw new Error("A slug is required (the gateway routes by it).");
  const runner = await db.createManagedRunner(orgId, userId, { harnessId, slug, driver: driverName(driver), region, image });
  let apiKeyId = null;
  try {
    // secret provisioning: hand the runner a scoped key + callback URL (not raw
    // secrets); explicit env from the caller wins over the built-in values.
    let launchEnv = env;
    if (injectSecrets) {
      const built = await buildRunnerEnv(db, { orgId, userId, harnessId, slug, apiUrl, extraEnv: env });
      launchEnv = built.env; apiKeyId = built.apiKeyId;
    }
    const launched = await driver.launch({ slug, image, region, env: launchEnv });
    let state = launched.state, url = launched.url;
    for (let i = 0; state === "starting" && i < pollMax; i++) {
      const s = await driver.status(launched.machineId);
      state = s.state; url = s.url || url;
    }
    const base = { machineId: launched.machineId, url, apiKeyId, lastHealthAt: now() };
    if (state === "ready") {
      const dep = await db.createDeployment(orgId, userId, { slug, harnessId, targetUrl: url });
      return await db.updateManagedRunner(runner.id, { ...base, status: "ready", deploymentId: dep.id, detail: null });
    }
    // launched but not yet healthy — leave it provisioning; refresh() promotes it
    return await db.updateManagedRunner(runner.id, { ...base, status: state === "error" ? "error" : "provisioning", detail: state === "error" ? "machine reported error" : "awaiting health" });
  } catch (e) {
    // the scoped key was minted before the failure — don't leave it live
    if (apiKeyId) { try { await db.revokeApiKey(orgId, userId, apiKeyId); } catch { /* best-effort */ } }
    return await db.updateManagedRunner(runner.id, { status: "error", apiKeyId: null, detail: String(e.message || e) });
  }
}

// Tear a runner down: stop the machine, revoke its scoped key, drop the
// deployment, and delete the record. Best-effort on the external calls so a
// dead machine or an already-revoked key can't block cleanup.
export async function remove(db, userId, runnerId, { driver } = {}) {
  const runner = await db.getManagedRunner(userId, runnerId);
  await requireAdmin(db, runner.orgId, userId);
  if (runner.machineId && driver) { try { await driver.stop(runner.machineId); } catch { /* machine may be gone */ } }
  if (runner.apiKeyId) { try { await db.revokeApiKey(runner.orgId, userId, runner.apiKeyId); } catch { /* already revoked */ } }
  if (runner.deploymentId) { try { await db.setDeploymentTarget(runner.deploymentId, { status: "stopped" }); } catch { /* ignore */ } }
  return db.deleteManagedRunner(runner.orgId, userId, runnerId);
}

// Re-check a provisioning runner; when it turns healthy, register its deployment.
export async function refresh(db, userId, runnerId, { driver, now = () => Date.now() } = {}) {
  const runner = await db.getManagedRunner(userId, runnerId);
  if (!runner.machineId || runner.status === "stopped") return runner;
  const s = await driver.status(runner.machineId);
  const patch = { lastHealthAt: now(), url: s.url || runner.url };
  if (s.state === "ready" && !runner.deploymentId) {
    await requireAdmin(db, runner.orgId, userId);
    const dep = await db.createDeployment(runner.orgId, userId, { slug: runner.slug, harnessId: runner.harnessId, targetUrl: s.url || runner.url });
    return await db.updateManagedRunner(runnerId, { ...patch, status: "ready", deploymentId: dep.id, detail: null });
  }
  if (s.state === "ready" && runner.deploymentId) {
    await db.setDeploymentTarget(runner.deploymentId, { targetUrl: s.url || runner.url, status: "active" });
    return await db.updateManagedRunner(runnerId, { ...patch, status: "ready" });
  }
  return await db.updateManagedRunner(runnerId, { ...patch, status: s.state === "error" ? "error" : "provisioning" });
}

export async function stop(db, userId, runnerId, { driver } = {}) {
  const runner = await db.getManagedRunner(userId, runnerId);
  await requireAdmin(db, runner.orgId, userId);
  if (runner.machineId) await driver.stop(runner.machineId);
  if (runner.deploymentId) await db.setDeploymentTarget(runner.deploymentId, { status: "stopped" });
  return await db.updateManagedRunner(runnerId, { status: "stopped" });
}

export async function restart(db, userId, runnerId, { driver, pollMax = 3, now = () => Date.now() } = {}) {
  const runner = await db.getManagedRunner(userId, runnerId);
  await requireAdmin(db, runner.orgId, userId);
  if (!runner.machineId) throw new Error("Runner has no machine to restart.");
  const r = await driver.restart(runner.machineId);
  let state = r.state, url = r.url || runner.url;
  for (let i = 0; state === "starting" && i < pollMax; i++) { const s = await driver.status(runner.machineId); state = s.state; url = s.url || url; }
  if (state === "ready" && runner.deploymentId) await db.setDeploymentTarget(runner.deploymentId, { targetUrl: url, status: "active" });
  return await db.updateManagedRunner(runnerId, { url, lastHealthAt: now(), status: state === "ready" ? "ready" : (state === "error" ? "error" : "provisioning") });
}

export async function logs(db, userId, runnerId, { driver, limit = 100 } = {}) {
  const runner = await db.getManagedRunner(userId, runnerId);
  if (!runner.machineId) return [];
  return driver.logs(runner.machineId, { limit });
}
