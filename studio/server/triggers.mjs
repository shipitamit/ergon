/* Trigger firing — the shared path for a webhook ingress and the scheduler.

   A trigger starts a run the same way the gateway does: resolve the harness's
   active deployment (an `ergon serve` runner at target_url), budget-gate, forward
   the input, and record the run. Execution itself lives in the runner, not here —
   the server has no JS harness executor — so a trigger on a harness with no
   attached runner records a clear "no-runner" outcome instead of silently doing
   nothing.

   db and forward are injected so this is unit-testable with a fake backend and a
   fake forward (no network, no real deployment). */
import { forwardRun } from "./gateway.mjs";
import { nextFireAfter } from "./cron.mjs";

const nowMs = () => Date.now();

// Fire one trigger. Returns { ok, status, body, runId, reason }.
export async function fireTrigger(db, trigger, input = "", { forward = forwardRun, now = nowMs, noAdvance = false } = {}) {
  const t0 = now();
  // schedule triggers advance to their next slot regardless of outcome — unless
  // the caller already advanced it at claim time (the durable scheduler does).
  const advance = (!noAdvance && trigger.type === "schedule" && trigger.cron)
    ? { nextFireAt: nextFireAfter(trigger.cron, t0) } : {};

  const dep = await db.activeDeploymentForHarness(trigger.harnessId);
  if (!dep || !dep.targetUrl) {
    await db.markTriggerFired(trigger.id, { firedAt: t0, status: "no-runner", ...advance });
    return { ok: false, status: 503, reason: "no-runner", body: { error: "No active deployment/runner for this harness. Deploy it (set an `ergon serve` target_url) so the trigger has something to run." } };
  }

  const gate = await db.checkBudget(dep.orgId);
  if (!gate.allowed) {
    await db.markTriggerFired(trigger.id, { firedAt: t0, status: "budget", ...advance });
    return { ok: false, status: 402, reason: "budget", body: { error: `Organization budget exceeded: ${gate.reason}`, budget: true } };
  }

  const out = await forward(dep.targetUrl, { input });
  const ok = out.kind === "ok";
  let runId = null;
  try {
    const rec = await db.recordRun(trigger.createdBy, {
      harnessId: trigger.harnessId, orgId: dep.orgId, input: input || "",
      output: ok ? (out.body?.text || "") : "", status: ok ? "ok" : "error",
      startedAt: t0, finishedAt: now(), latencyMs: now() - t0, usage: out.usage || {},
    });
    runId = rec?.id || null;
  } catch { /* recording is best-effort */ }

  await db.markTriggerFired(trigger.id, { firedAt: t0, status: ok ? "ok" : "error", ...advance });
  return { ok, status: out.status, body: out.body, runId };
}

// Fire every schedule trigger that is due right now, durably and coordinated.
// Each due slot is atomically *claimed* (compare-and-swap on next_fire_at) before
// firing, so overlapping ticks and multiple instances never double-fire, and the
// claim advances the schedule so a crash after claim loses at most that one slot
// (not the whole schedule). A durable trigger_fires record is written per slot.
// Falls back to the legacy due+fire path if the backend predates claiming.
export async function scheduleTick(db, { forward = forwardRun, now = nowMs } = {}) {
  let fired = 0;
  if (typeof db.claimDueScheduleTriggers === "function") {
    let claimed = [];
    try { claimed = await db.claimDueScheduleTriggers(now()); } catch { return 0; }
    for (const c of claimed) {
      try {
        const r = await fireTrigger(db, c.trigger, c.trigger.payload || "", { forward, now, noAdvance: true });
        if (db.recordFireResult) await db.recordFireResult(c.fireId, { status: r.ok ? "ok" : (r.reason || "error"), runId: r.runId });
        fired++;
      } catch { /* a bad trigger must not stall the loop */ }
    }
    return fired;
  }
  // legacy path (no claiming): single-instance only
  let due = [];
  try { due = await db.dueScheduleTriggers(now()); } catch { return 0; }
  for (const t of due) {
    try { await fireTrigger(db, t, t.payload || "", { forward, now }); fired++; }
    catch { /* a bad trigger must not stall the loop */ }
  }
  return fired;
}

// Start the in-process scheduler. Returns a stop() function.
export function startScheduler(db, { intervalMs = 30_000, forward = forwardRun } = {}) {
  const h = setInterval(() => { scheduleTick(db, { forward }).catch(() => {}); }, intervalMs);
  h.unref?.();
  return () => clearInterval(h);
}
