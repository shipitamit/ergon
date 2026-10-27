/* Provider registry for the Studio — the server-side mirror of the SDK router's
   prefixes (ergon/router.py). One row per provider: how to reach it, which env
   var holds its key, and how to list its models.

   `kind` is the execution adapter the proxy already speaks:
     openai  → POST {base}/chat/completions, GET {base}/models   (Bearer key)
     anthropic → api.anthropic.com                                 (x-api-key)
     gemini  → generativelanguage.googleapis.com                   (x-goog-api-key)
   Everything OpenAI-compatible (NVIDIA, Groq, Together, …) is kind "openai"
   with a different base URL — exactly how the SDK router resolves them.
*/

export const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

// prefix → spec. keyEnvs are tried in order; baseUrl null = provider default.
export const PROVIDERS = {
  openai:     { label: "OpenAI",              kind: "openai",    baseUrl: null, keyEnvs: ["OPENAI_API_KEY"] },
  anthropic:  { label: "Anthropic",           kind: "anthropic", baseUrl: null, keyEnvs: ["ANTHROPIC_API_KEY"], hostedSearch: true },
  nvidia:     { label: "NVIDIA NIM",          kind: "openai",    baseUrl: "https://integrate.api.nvidia.com/v1", keyEnvs: ["NVIDIA_API_KEY", "OPENAI_API_KEY"] },
  groq:       { label: "Groq",                kind: "openai",    baseUrl: "https://api.groq.com/openai/v1", keyEnvs: ["GROQ_API_KEY"] },
  together:   { label: "Together AI",         kind: "openai",    baseUrl: "https://api.together.xyz/v1", keyEnvs: ["TOGETHER_API_KEY"] },
  mistral:    { label: "Mistral",             kind: "openai",    baseUrl: "https://api.mistral.ai/v1", keyEnvs: ["MISTRAL_API_KEY"] },
  deepseek:   { label: "DeepSeek",            kind: "openai",    baseUrl: "https://api.deepseek.com/v1", keyEnvs: ["DEEPSEEK_API_KEY"] },
  fireworks:  { label: "Fireworks",           kind: "openai",    baseUrl: "https://api.fireworks.ai/inference/v1", keyEnvs: ["FIREWORKS_API_KEY"] },
  openrouter: { label: "OpenRouter",          kind: "openai",    baseUrl: "https://openrouter.ai/api/v1", keyEnvs: ["OPENROUTER_API_KEY"] },
  perplexity: { label: "Perplexity",          kind: "openai",    baseUrl: "https://api.perplexity.ai", keyEnvs: ["PERPLEXITY_API_KEY"] },
  xai:        { label: "xAI (Grok)",          kind: "openai",    baseUrl: "https://api.x.ai/v1", keyEnvs: ["XAI_API_KEY"] },
  vllm:       { label: "vLLM (self-hosted)",  kind: "openai",    baseUrl: null, keyEnvs: ["VLLM_API_KEY", "OPENAI_API_KEY"], needsBaseUrl: true },
  azure:      { label: "Azure OpenAI",        kind: "openai",    baseUrl: null, keyEnvs: ["AZURE_OPENAI_API_KEY", "OPENAI_API_KEY"], needsBaseUrl: true },
  ollama:     { label: "Ollama (local)",      kind: "openai",    baseUrl: "http://localhost:11434/v1", keyEnvs: [], local: true },
  gemini:     { label: "Google Gemini",       kind: "gemini",    baseUrl: null, keyEnvs: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], hostedSearch: true },
};

// aliases accepted on input but not shown as separate picker rows
export const ALIASES = { claude: "anthropic", nim: "nvidia", google: "gemini", aws: "bedrock" };

export function canonicalPrefix(prefix) {
  const p = String(prefix || "").toLowerCase();
  return ALIASES[p] || p;
}

export function getProvider(prefix) {
  return PROVIDERS[canonicalPrefix(prefix)] || null;
}

/** Resolve the effective key + base URL for a provider.
 *  Precedence: a UI-saved setting wins, else the provider's env var chain.
 *  `settings` is { apiKey?, baseUrl? } for this prefix (from settings.mjs), or null.
 *  Never logs or returns nothing sensitive beyond the caller's use. */
export function resolveProvider(prefix, settings = null, env = process.env) {
  const spec = getProvider(prefix);
  if (!spec) return { error: `unknown provider '${prefix}'` };
  let key = settings && settings.apiKey ? settings.apiKey : null;
  let keySource = key ? "saved" : null;
  if (!key) {
    for (const e of spec.keyEnvs) {
      if (env[e]) { key = env[e]; keySource = `env:${e}`; break; }
    }
  }
  const baseUrl =
    (settings && settings.baseUrl) ||
    (spec.kind === "openai" ? (spec.baseUrl || OPENAI_DEFAULT_BASE) : spec.baseUrl) ||
    null;
  return { kind: spec.kind, baseUrl, key, keySource, spec };
}

/** Public, secret-free description of every provider for the UI picker. */
export function providerList(settingsFor) {
  return Object.entries(PROVIDERS).map(([prefix, spec]) => {
    const s = settingsFor ? settingsFor(prefix) : null;
    const r = resolveProvider(prefix, s);
    return {
      prefix, label: spec.label, kind: spec.kind,
      baseUrl: r.baseUrl || "",
      keyEnvs: spec.keyEnvs,
      local: !!spec.local,
      needsBaseUrl: !!spec.needsBaseUrl,
      hostedSearch: !!spec.hostedSearch,
      configured: spec.local ? true : !!r.key,
      keySource: r.keySource || null,
    };
  });
}

/** Build the upstream URL + headers to GET a provider's model list. */
export function modelsRequest(prefix, resolved) {
  const { kind, baseUrl, key } = resolved;
  if (kind === "anthropic") {
    return { url: "https://api.anthropic.com/v1/models",
             headers: { "x-api-key": key || "", "anthropic-version": "2023-06-01" } };
  }
  if (kind === "gemini") {
    return { url: "https://generativelanguage.googleapis.com/v1beta/models",
             headers: { "x-goog-api-key": key || "" } };
  }
  // openai-compatible
  const base = (baseUrl || OPENAI_DEFAULT_BASE).replace(/\/$/, "");
  return { url: `${base}/models`, headers: { authorization: `Bearer ${key || ""}` } };
}

/** Normalize an upstream /models JSON body into a sorted list of id strings. */
export function parseModelList(kind, body) {
  let ids = [];
  if (kind === "gemini") {
    ids = (body.models || []).map((m) => String(m.name || "").replace(/^models\//, "")).filter(Boolean);
  } else {
    // OpenAI + Anthropic both return { data: [{ id }, ...] }
    ids = (body.data || []).map((m) => m.id).filter(Boolean);
  }
  return Array.from(new Set(ids)).sort();
}
