/* Run an eval dataset against a harness's deployed runner, then record the
   scored result — the in-UI "Run" path. Execution goes through the same gateway
   `forward` the triggers/gateway use, so there's one run path. db + forward are
   injected, so this is unit-tested offline with a fake forward (no network). */

export async function runDataset(db, { orgId, userId, datasetId, harnessId = null, label = null } = {}, { forward } = {}) {
  if (!forward) throw new Error("a forward function is required.");
  const ds = await db.getEvalDataset(userId, datasetId);     // RBAC: member read
  const hid = harnessId || ds.harnessId;
  if (!hid) throw new Error("This dataset has no harness to run against. Set one, or push results via recordEvalRun.");
  const dep = await db.activeDeploymentForHarness(hid);
  if (!dep || !dep.targetUrl) {
    throw new Error("No active deployment for this harness — deploy it first (or push results from CI via recordEvalRun).");
  }
  const cases = [];
  for (const c of (ds.cases || [])) {
    let output = "";
    try {
      const out = await forward(dep.targetUrl, { input: c.input });
      output = (out && out.kind === "ok" && out.body && out.body.text) ? out.body.text : "";
    } catch { output = ""; }
    cases.push({ input: c.input, output, expected: c.expected, scorer: c.scorer });
  }
  return db.recordEvalRun(orgId, userId, { datasetId, harnessId: hid, label: label || "studio run", cases });
}
