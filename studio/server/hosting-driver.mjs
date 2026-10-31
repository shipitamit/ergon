/* Machines drivers — the thin provider adapter the hosting lifecycle talks to.

   A driver launches and operates a single runner instance. The lifecycle
   service (hosting.mjs) is driver-agnostic; swap the driver to target a
   different platform. Two ship here:

     FakeMachinesDriver  in-memory, deterministic — used by the tests and by a
                         zero-infra local/dev "managed" mode.
     FlyMachinesDriver   Fly.io Machines REST API, via an injectable HTTP
                         transport (same pattern as the RAG adapters), so its
                         request shaping is testable offline. Wire-level only —
                         validate against a real Fly org before relying on it.

   Driver contract (all async):
     launch({ slug, image, region, env }) -> { machineId, url, state }
     status(machineId)                    -> { state, url }
     stop(machineId)                      -> { state }
     restart(machineId)                   -> { machineId, url, state }
     logs(machineId, { limit })           -> string[]
   state is one of: "starting" | "ready" | "stopped" | "error".
*/

let _n = 0;
const nextId = () => `m_${Date.now().toString(36)}${(_n++).toString(36)}`;

export class FakeMachinesDriver {
  // readyAfter: how many status() calls until a launched machine reports ready
  // (0 = ready immediately). Lets tests exercise the provisioning→ready gate.
  constructor({ readyAfter = 0, baseDomain = "fake.ergon.dev" } = {}) {
    this._m = new Map();
    this._readyAfter = readyAfter;
    this._base = baseDomain;
  }
  _url(slug, id) { return `https://${slug || "app"}-${id}.${this._base}`; }
  async launch({ slug, image, region, env } = {}) {
    const id = nextId();
    const state = this._readyAfter <= 0 ? "ready" : "starting";
    this._m.set(id, { id, slug, image, region, env: env || {}, state, polls: 0, logs: [`launched ${id} (${image || "default-image"})`] });
    return { machineId: id, url: this._url(slug, id), state };
  }
  async status(machineId) {
    const m = this._m.get(machineId);
    if (!m) return { state: "error", url: null };
    if (m.state === "starting") { m.polls += 1; if (m.polls >= this._readyAfter) m.state = "ready"; }
    return { state: m.state, url: this._url(m.slug, m.id) };
  }
  async stop(machineId) { const m = this._m.get(machineId); if (m) m.state = "stopped"; return { state: m ? m.state : "error" }; }
  async restart(machineId) {
    const m = this._m.get(machineId);
    if (!m) return { machineId, url: null, state: "error" };
    m.state = this._readyAfter <= 0 ? "ready" : "starting"; m.polls = 0;
    return { machineId, url: this._url(m.slug, m.id), state: m.state };
  }
  async logs(machineId, { limit = 100 } = {}) { const m = this._m.get(machineId); return m ? m.logs.slice(-limit) : []; }
}

// Map Fly machine states onto the driver contract.
function flyState(s) {
  if (s === "started") return "ready";
  if (s === "stopped" || s === "destroyed" || s === "suspended") return "stopped";
  if (s === "created" || s === "starting" || s === "replacing") return "starting";
  return "error";
}

async function defaultHttp(method, url, { headers = {}, json } = {}) {
  const res = await fetch(url, {
    method, headers: { "Content-Type": "application/json", ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Fly API ${res.status}: ${text.slice(0, 200)}`);
  return body;
}

export class FlyMachinesDriver {
  constructor({ app, token, apiBase = "https://api.machines.dev/v1", defaultRegion = "iad", http } = {}) {
    if (!app) throw new Error("FlyMachinesDriver needs an app name.");
    this.app = app;
    this._token = token;
    this._base = apiBase.replace(/\/$/, "");
    this._region = defaultRegion;
    this._http = http || defaultHttp;
  }
  _h() { return this._token ? { Authorization: `Bearer ${this._token}` } : {}; }
  _appUrl() { return `https://${this.app}.fly.dev`; }
  async launch({ image, region, env } = {}) {
    const r = await this._http("POST", `${this._base}/apps/${this.app}/machines`, {
      headers: this._h(),
      json: { region: region || this._region, config: { image: image || "ergon/runner:latest", env: env || {}, auto_destroy: false } },
    });
    return { machineId: r.id, url: this._appUrl(), state: flyState(r.state) };
  }
  async status(machineId) {
    const r = await this._http("GET", `${this._base}/apps/${this.app}/machines/${machineId}`, { headers: this._h() });
    return { state: flyState(r.state), url: this._appUrl() };
  }
  async stop(machineId) {
    await this._http("POST", `${this._base}/apps/${this.app}/machines/${machineId}/stop`, { headers: this._h() });
    return { state: "stopped" };
  }
  async restart(machineId) {
    await this._http("POST", `${this._base}/apps/${this.app}/machines/${machineId}/restart`, { headers: this._h() });
    return { machineId, url: this._appUrl(), state: "starting" };
  }
  async logs() { return []; }   // Fly logs stream via a separate API; omitted in the MVP
}

export function makeMachinesDriver(kind = "fake", opts = {}) {
  const k = (kind || "fake").toLowerCase();
  if (k === "fake") return new FakeMachinesDriver(opts);
  if (k === "fly") return new FlyMachinesDriver(opts);
  throw new Error(`unknown machines driver: ${kind} (expected fake or fly)`);
}
