/* Alert evaluation — the shared logic that turns alert rules into events.

   A rule watches one metric over a lookback window and fires when it crosses a
   threshold. Evaluation is backend-agnostic: it reads rules + aggregates and
   writes events/state through the injected `db`, so it's unit-testable against
   the real SQLite layer with no network and no scheduler.

   State machine (per rule): ok ⇄ firing. An event is recorded only on a
   transition — ok→firing emits a 'firing' event, firing→ok emits 'resolved' —
   so a rule that stays breached doesn't spam events every tick. */

export function metricValue(metric, agg) {
  switch (metric) {
    case "error_rate": return agg.errorRate;
    case "spend": return agg.spend;
    case "latency_p95": return agg.latencyP95 == null ? 0 : agg.latencyP95;
    case "run_count": return agg.runs;
    default: return 0;
  }
}

function breaches(comparator, value, threshold) {
  return comparator === ">" ? value > threshold : value < threshold;
}

// Evaluate every enabled rule once. Returns the transitions that fired this pass.
export async function evaluateAlerts(db, { now = Date.now() } = {}) {
  const rules = await db.allEnabledAlertRules();
  const transitions = [];
  for (const r of rules) {
    try {
      const agg = await db.alertAggregate(r.orgId, { windowMs: r.windowMs, harnessId: r.harnessId, now });
      const value = metricValue(r.metric, agg);
      const firing = breaches(r.comparator, value, r.threshold);
      const newState = firing ? "firing" : "ok";
      if (newState !== r.lastState) {
        const evState = firing ? "firing" : "resolved";
        const rounded = Math.round(value * 1000) / 1000;
        const message = `${r.name}: ${r.metric} = ${rounded} ${r.comparator} ${r.threshold}`;
        await db.recordAlertEvent(r.id, r.orgId, { state: evState, value, threshold: r.threshold, message });
        await db.setAlertRuleState(r.id, { state: newState, evaluatedAt: now, triggeredAt: firing ? now : null });
        transitions.push({ ruleId: r.id, orgId: r.orgId, state: evState, value,
          name: r.name, metric: r.metric, threshold: r.threshold, message, at: now });
      } else {
        await db.setAlertRuleState(r.id, { state: newState, evaluatedAt: now });
      }
    } catch { /* one bad rule must not stall the loop */ }
  }
  return transitions;
}

// Start periodic evaluation + delivery. Returns a stop() function.
export function startAlertEvaluator(db, { intervalMs = 60_000 } = {}) {
  const tick = async () => {
    const transitions = await evaluateAlerts(db);
    if (transitions.length) {
      const { deliverTransitions } = await import("./alert-delivery.mjs");
      await deliverTransitions(db, transitions);
    }
  };
  const h = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  h.unref?.();
  return () => clearInterval(h);
}
