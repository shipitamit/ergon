/* Secrets management — env (local) + AWS / GCP / Azure cloud backends.

   Keeps provider API keys, SESSION_SECRET, DATABASE_URL, and REDIS_URL out of
   source and out of .env files in production. Same shape as the other Tier-2
   backends: a uniform interface, the backend chosen by an env var, graceful
   fallback to environment variables so local dev and small deploys need nothing.

   Selection (SECRETS_PROVIDER):
     env    (default)  read straight from process.env  — local / small single-host
     aws               AWS Secrets Manager             (@aws-sdk/client-secrets-manager)
     gcp               GCP Secret Manager              (@google-cloud/secret-manager)
     azure             Azure Key Vault                 (@azure/keyvault-secrets + @azure/identity)

   Two cloud layouts, both supported:
     • Bundle  (SECRETS_BUNDLE set): one secret holding a JSON object of all
       keys — a single fetch, cheapest and simplest.
     • Per-key (no SECRETS_BUNDLE): each key is its own cloud secret, fetched by
       name (optionally SECRETS_PREFIX + name). Better for per-secret rotation.

   Enable, e.g. AWS bundle:
     npm i @aws-sdk/client-secrets-manager
     export SECRETS_PROVIDER=aws AWS_REGION=us-east-1 SECRETS_BUNDLE=ergon/prod
     npm start

   Anything unresolved falls back to process.env, so you can mix (e.g. keys in
   the cloud, PORT in the environment). Every fetched value is cached for the
   process lifetime.

   NOTE: the cloud provider *logic* here (selection, bundle parse, per-key,
   caching, overlay, graceful fallback) is unit-tested offline against fakes.
   The real SDK calls have NOT been exercised against live AWS/GCP/Azure in this
   build — validate in your environment before relying on them.
*/

const _cache = new Map();     // secretId -> raw string
let _bundle = null;           // parsed bundle object (bundle mode)
let _provider = null;         // resolved provider instance
let _providerName = null;

export function providerName() {
  return (process.env.SECRETS_PROVIDER || "env").toLowerCase();
}

// ── cloud provider adapters: each exposes async fetch(secretId) -> string ──
async function awsProvider() {
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
  return {
    async fetch(secretId) {
      const r = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (r.SecretString != null) return r.SecretString;
      if (r.SecretBinary != null) return Buffer.from(r.SecretBinary).toString("utf8");
      return null;
    },
  };
}

async function gcpProvider() {
  const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
  const client = new SecretManagerServiceClient();
  return {
    async fetch(secretId) {
      // accept a full resource name, or a short id resolved against GCP_PROJECT
      const name = secretId.includes("/")
        ? secretId
        : `projects/${process.env.GCP_PROJECT}/secrets/${secretId}/versions/latest`;
      const [version] = await client.accessSecretVersion({ name });
      return version.payload.data.toString("utf8");
    },
  };
}

async function azureProvider() {
  const { SecretClient } = await import("@azure/keyvault-secrets");
  const { DefaultAzureCredential } = await import("@azure/identity");
  const url = process.env.AZURE_KEYVAULT_URL;
  if (!url) throw new Error("AZURE_KEYVAULT_URL is required for the azure provider");
  const client = new SecretClient(url, new DefaultAzureCredential());
  return {
    async fetch(secretId) {
      // Key Vault secret names can't contain some chars; callers should name
      // per-key secrets accordingly, or use bundle mode.
      const s = await client.getSecret(secretId);
      return s.value ?? null;
    },
  };
}

async function resolveProvider(name, injected) {
  if (injected) return injected;
  switch (name) {
    case "aws": return awsProvider();
    case "gcp": return gcpProvider();
    case "azure": return azureProvider();
    default: return null;   // env
  }
}

/* Fetch a single secret by logical name.

   env provider → process.env[name].
   cloud + bundle → key from the cached JSON bundle (fallback process.env).
   cloud + per-key → the cloud secret (SECRETS_PREFIX + name), cached
                     (fallback process.env on miss/error).

   `opts.injected` supplies a fake provider for tests; `opts.providerName`,
   `opts.bundleId`, and `opts.prefix` override env config.
*/
export async function getSecret(name, opts = {}) {
  const pname = opts.providerName || providerName();

  if (pname === "env") return process.env[name] ?? null;

  // ensure a provider (with graceful fallback to env if the SDK is missing)
  if (!_provider || _providerName !== pname || opts.injected) {
    try {
      _provider = await resolveProvider(pname, opts.injected);
      _providerName = pname;
    } catch (e) {
      (opts.log || console).warn?.(
        `[secrets] provider '${pname}' unavailable (${e.message}); using process.env.`);
      _provider = null;
    }
  }
  if (!_provider) return process.env[name] ?? null;

  const bundleId = opts.bundleId ?? process.env.SECRETS_BUNDLE;
  if (bundleId) {
    if (!_bundle) {
      try {
        const raw = _cache.get(bundleId) ?? await _provider.fetch(bundleId);
        _cache.set(bundleId, raw);
        _bundle = JSON.parse(raw);
      } catch (e) {
        (opts.log || console).warn?.(
          `[secrets] bundle '${bundleId}' unreadable (${e.message}); using process.env.`);
        _bundle = {};
      }
    }
    return _bundle[name] ?? process.env[name] ?? null;
  }

  // per-key mode
  const prefix = opts.prefix ?? process.env.SECRETS_PREFIX ?? "";
  const secretId = prefix + name;
  if (_cache.has(secretId)) return _cache.get(secretId);
  try {
    const v = await _provider.fetch(secretId);
    _cache.set(secretId, v);
    return v ?? process.env[name] ?? null;
  } catch (e) {
    (opts.log || console).warn?.(
      `[secrets] '${secretId}' unreadable (${e.message}); using process.env.`);
    return process.env[name] ?? null;
  }
}

/* Resolve several secrets at once and (by default) overlay them into
   process.env, so existing synchronous `process.env.X` reads downstream just
   work. Call this once at server startup, before secrets are used.

   Returns a { name: value } map. In env mode it's a cheap pass-through.
*/
export async function loadSecrets(names, opts = {}) {
  const pname = opts.providerName || providerName();
  const out = {};
  for (const n of names) out[n] = await getSecret(n, opts);
  if (opts.overlay !== false) {
    for (const [k, v] of Object.entries(out)) if (v != null) process.env[k] = v;
  }
  if (pname !== "env") {
    (opts.log || console).log?.(`[secrets] provider '${pname}' loaded ${names.length} secret name(s)`);
  }
  return out;
}

// the secret names Ergon uses — the default set loadSecrets pulls at startup
export const ERGON_SECRETS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY",
  "SESSION_SECRET", "DATABASE_URL", "REDIS_URL",
];

// test/ops helper: clear caches so a fresh provider/config can be selected
export function _reset() {
  _cache.clear(); _bundle = null; _provider = null; _providerName = null;
}
