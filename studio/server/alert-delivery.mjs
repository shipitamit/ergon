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

export async function deliverToChannel(channel, t, { http = defaultHttp } = {}) {
  return http("POST", channel.target, { json: payloadFor(channel, t) });
}

// Deliver a batch of transitions to each org's enabled channels. Returns the
// number of successful sends. Channels are loaded once per org.
export async function deliverTransitions(db, transitions, { http = defaultHttp } = {}) {
  let sent = 0;
  const cache = new Map();
  for (const t of transitions || []) {
    let channels = cache.get(t.orgId);
    if (channels === undefined) {
      try { channels = await db.enabledAlertChannels(t.orgId); } catch { channels = []; }
      cache.set(t.orgId, channels);
    }
    for (const ch of channels) {
      try { await deliverToChannel(ch, t, { http }); sent++; } catch { /* best-effort */ }
    }
  }
  return sent;
}

export async function testChannel(channel, { http = defaultHttp } = {}) {
  return deliverToChannel(channel, {
    state: "firing", name: "Test alert", metric: "test", value: 1, threshold: 0,
    message: "Ergon alert-channel test — if you can read this, delivery works.",
    orgId: channel.orgId, at: Date.now(),
  }, { http });
}
