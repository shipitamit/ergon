/* Alert delivery — send a rule's state transition to the org's channels.

   Channels are webhook (structured JSON POST) or slack (incoming-webhook URL,
   `{text}`). Both are plain HTTPS POSTs, so the transport is injectable and the
   payload shaping is unit-tested offline against a fake http. Delivery is
   best-effort: one failing channel never blocks the others, and a failed send
   never throws back into the evaluator (the event is already recorded).

   Email is intentionally not implemented here — it needs an SMTP/provider
   integration; a webhook into an email service covers it until then. */

async function defaultHttp(method, url, { headers = {}, json } = {}) {
  const res = await fetch(url, {
    method, headers: { "Content-Type": "application/json", ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`delivery ${res.status}: ${text.slice(0, 160)}`);
  return { ok: true, status: res.status };
}

export function formatText(t) {
  const verb = t.state === "firing" ? "🔴 FIRING" : "🟢 RESOLVED";
  const body = t.message || `${t.name || "alert"}: ${t.metric || ""} = ${t.value}`;
  return `${verb} — ${body}`;
}

export function payloadFor(channel, t) {
  if (channel.type === "slack") return { text: formatText(t) };
  // webhook: structured, machine-readable
  return {
    event: "alert", state: t.state,
    rule: { id: t.ruleId, name: t.name, metric: t.metric },
    value: t.value, threshold: t.threshold, message: t.message,
    orgId: t.orgId, at: t.at || Date.now(),
  };
}

// Deliver to one channel with bounded retry + backoff. Returns {ok, status} or
// throws after the last attempt.
export async function deliverToChannel(channel, t, { http = defaultHttp, retries = 2, backoffMs = 200, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await http("POST", channel.target, { json: payloadFor(channel, t) }); }
    catch (e) { lastErr = e; if (attempt < retries) await sleep(backoffMs * (attempt + 1)); }
  }
  throw lastErr;
}

// Deliver a batch of transitions to each org's enabled channels (honouring a
// rule's channel_ids routing when set). Best-effort with retry; returns
// { sent, failed, results:[{ruleId, channelId, ok, error}] }.
export async function deliverTransitions(db, transitions, { http = defaultHttp, retries = 2, sleep, now = () => Date.now() } = {}) {
  let sent = 0, failed = 0, suppressed = 0; const results = [];
  const cache = new Map();
  for (const t of transitions || []) {
    // anti-flap: if this rule notified within its cooldown, skip (don't spam a
    // channel when a rule flaps ok<->firing rapidly).
    if (t.cooldownMs && t.lastNotifiedAt && (now() - t.lastNotifiedAt) < t.cooldownMs) {
      suppressed++; results.push({ ruleId: t.ruleId, suppressed: true }); continue;
    }
    let channels = cache.get(t.orgId);
    if (channels === undefined) {
      try { channels = await db.enabledAlertChannels(t.orgId); } catch { channels = []; }
      cache.set(t.orgId, channels);
    }
    // per-rule routing: if the rule names channels, only those receive it
    const targets = (Array.isArray(t.channelIds) && t.channelIds.length)
      ? channels.filter((c) => t.channelIds.includes(c.id)) : channels;
    let any = false;
    for (const ch of targets) {
      try { await deliverToChannel(ch, t, { http, retries, sleep }); sent++; any = true; results.push({ ruleId: t.ruleId, channelId: ch.id, ok: true }); }
      catch (e) { failed++; results.push({ ruleId: t.ruleId, channelId: ch.id, ok: false, error: String(e && e.message || e) }); }
    }
    // stamp the cooldown clock when we actually notified
    if (any && t.ruleId && t.cooldownMs && db.markAlertNotified) {
      try { await db.markAlertNotified(t.ruleId, now()); } catch { /* best-effort */ }
    }
  }
  return { sent, failed, suppressed, results };
}

export async function testChannel(channel, { http = defaultHttp } = {}) {
  return deliverToChannel(channel, {
    state: "firing", name: "Test alert", metric: "test", value: 1, threshold: 0,
    message: "Ergon alert-channel test — if you can read this, delivery works.",
    orgId: channel.orgId, at: Date.now(),
  }, { http });
}
