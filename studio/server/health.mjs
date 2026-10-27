/* Health checks for container orchestration (Kubernetes, Docker, load balancers).

   Two standard endpoints:
     GET /healthz  — liveness: is the process up and the event loop responsive?
                     Always 200 unless the process is wedged. Cheap, no deps.
     GET /readyz   — readiness: can it actually serve traffic? Checks the data
                     layer is reachable (when the accounts tier is enabled).
                     Returns 503 until dependencies are ready, so a balancer
                     won't route to an instance whose DB is down.

   Kept framework-free and injectable (the readiness check is passed in) so it's
   unit-testable without a live server or database.
*/

const STARTED_AT = Date.now();

export async function handleHealth(req, res, { readinessCheck } = {}) {
  if (req.method !== "GET") return false;
  const url = (req.url || "").split("?")[0];

  if (url === "/healthz") {
    _json(res, 200, { status: "ok", uptime_s: Math.round((Date.now() - STARTED_AT) / 1000) });
    return true;
  }

  if (url === "/readyz") {
    let ready = true;
    let detail = "ok";
    if (typeof readinessCheck === "function") {
      try {
        const r = await readinessCheck();
        ready = r !== false;          // anything but explicit false = ready
        if (r && typeof r === "object" && r.detail) detail = r.detail;
      } catch (e) {
        ready = false;
        detail = String(e && e.message || e);
      }
    }
    _json(res, ready ? 200 : 503, { status: ready ? "ready" : "not_ready", detail });
    return true;
  }

  return false;
}

function _json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
