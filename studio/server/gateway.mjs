/* Hosted control-plane gateway — forward a gateway run to a deployment's
   runner (an `ergon serve` instance registered as `target_url`).

   The gateway itself is the tenant-aware edge: route resolution, API-key auth,
   budget + per-org limits, and run recording live in routes.mjs. This module is
   just the forward hop to the runner, isolated so it can be unit-tested with a
   fake fetch (the Node proxy is otherwise only a model proxy, never a client of
   arbitrary backends).

   A deployment with no `target_url` has no attached runner, so the caller gets
   a clear 503 rather than a broken forward. */

export async function forwardRun(targetUrl, { input, stream = false } = {}, fetchImpl = fetch) {
  if (!targetUrl) {
    return { status: 503, kind: "no-runner",
             body: { error: "This deployment has no runner attached (set target_url to an `ergon serve` endpoint)." } };
  }
  const base = String(targetUrl).replace(/\/$/, "");
  const path = stream ? "/run/stream" : "/run";
  let res;
  try {
    res = await fetchImpl(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify({ input }),
    });
  } catch (e) {
    return { status: 502, kind: "unreachable", body: { error: `runner unreachable: ${e.message}` } };
  }
  if (stream) {
    // pass the SSE stream through; usage isn't parsed from a stream here
    return { status: res.ok ? 200 : (res.status || 502), kind: "stream", stream: res };
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    return { status: res.status || 502, kind: "error", body: (data || { error: `runner error ${res.status}` }) };
  }
  return { status: 200, kind: "ok", body: data || {}, usage: (data && data.usage) || {} };
}
