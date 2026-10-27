/* Connector catalog — the "pick-and-connect" registry.

   Each entry describes an integration a user can turn into a saved connection:
   its kind (how it wires into a harness), the auth it needs, and the non-secret
   config fields to collect. A connection (see the connections store) is one
   configured instance of a connector, with its credential sealed at rest.

   kind:
     mcp   — an MCP server (stdio command or HTTP url). The custom-tool node
             already speaks MCP; a connection supplies the endpoint + token.
     http  — a REST base URL called from the HTTP custom tool, with the
             connection's token as a bearer/header.
     db    — a database reached by connection string (e.g. Postgres for pgvector).

   auth:
     none | apikey | bearer | connstring | oauth
   For oauth connectors we currently collect a pasted access/integration token
   (which is how Slack/Notion/Airtable/GitHub personal tokens work in practice);
   a full 3-legged OAuth flow is a later add and is flagged `oauthFlow:false`.

   This registry is intentionally plain data so it's easy to extend and to test.
   Secret fields are never stored here — only the *shape* of what to collect. */

export const CONNECTOR_CATEGORIES = ["Core", "Messaging", "Dev & Issues", "Docs & Data", "CRM & Sales", "Databases"];

export const CONNECTORS = [
  // ── Core / generic ──
  { id: "http", name: "HTTP / REST", category: "Core", kind: "http", auth: "bearer", oauthFlow: false,
    description: "Call any REST API as a tool. Point it at a base URL and (optionally) a bearer token.",
    fields: [{ key: "baseUrl", label: "Base URL", type: "url", required: true, placeholder: "https://api.example.com" }],
    secret: { label: "Bearer token", required: false, placeholder: "optional" } },
  { id: "mcp", name: "Custom MCP server", category: "Core", kind: "mcp", auth: "bearer", oauthFlow: false,
    description: "Connect any Model Context Protocol server — an HTTP endpoint or a stdio command — and use its tools.",
    fields: [{ key: "endpoint", label: "URL or stdio command", type: "text", required: true, placeholder: "https://mcp.example.com  ·  npx @vendor/mcp" }],
    secret: { label: "Auth token", required: false, placeholder: "optional" } },

  // ── Messaging ──
  { id: "slack", name: "Slack", category: "Messaging", kind: "mcp", auth: "oauth", oauthFlow: false,
    description: "Post messages, read channels, and search. Connect via OAuth, or paste a bot token.",
    fields: [], secret: { label: "Bot token", required: false, placeholder: "xoxb-…" },
    oauth: { authUrl: "https://slack.com/oauth/v2/authorize", tokenUrl: "https://slack.com/api/oauth.v2.access", scopes: ["chat:write", "channels:read", "channels:history"] } },

  // ── Dev & Issues ──
  { id: "github", name: "GitHub", category: "Dev & Issues", kind: "mcp", auth: "oauth", oauthFlow: false,
    description: "Issues, PRs, code search, and repo operations. Connect via OAuth, or paste a token.",
    fields: [], secret: { label: "Personal access token", required: false, placeholder: "ghp_…" },
    oauth: { authUrl: "https://github.com/login/oauth/authorize", tokenUrl: "https://github.com/login/oauth/access_token", scopes: ["repo", "read:org"] } },
  { id: "linear", name: "Linear", category: "Dev & Issues", kind: "mcp", auth: "apikey", oauthFlow: false,
    description: "Create and query issues, projects, and cycles.",
    fields: [], secret: { label: "API key", required: true, placeholder: "lin_api_…" } },
  { id: "jira", name: "Jira", category: "Dev & Issues", kind: "http", auth: "bearer", oauthFlow: false,
    description: "Read and write issues on a Jira site.",
    fields: [{ key: "baseUrl", label: "Site URL", type: "url", required: true, placeholder: "https://your-domain.atlassian.net" }],
    secret: { label: "API token", required: true, placeholder: "ATATT…" } },

  // ── Docs & Data ──
  { id: "notion", name: "Notion", category: "Docs & Data", kind: "mcp", auth: "bearer", oauthFlow: false,
    description: "Read and write pages and databases with an internal integration token.",
    fields: [], secret: { label: "Integration token", required: true, placeholder: "secret_…" } },
  { id: "airtable", name: "Airtable", category: "Docs & Data", kind: "http", auth: "bearer", oauthFlow: false,
    description: "Query and update bases and tables with a personal access token.",
    fields: [{ key: "baseId", label: "Base ID", type: "text", required: false, placeholder: "app… (optional default)" }],
    secret: { label: "Personal access token", required: true, placeholder: "pat…" } },
  { id: "google_drive", name: "Google Drive", category: "Docs & Data", kind: "http", auth: "oauth", oauthFlow: false,
    description: "Read files and docs. Connect via Google OAuth, or paste an access token.",
    fields: [], secret: { label: "OAuth access token", required: false, placeholder: "ya29.…" },
    oauth: { authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", scopes: ["https://www.googleapis.com/auth/drive.readonly"], extraAuthParams: { access_type: "offline", prompt: "consent" } } },

  // ── CRM & Sales ──
  { id: "hubspot", name: "HubSpot", category: "CRM & Sales", kind: "http", auth: "bearer", oauthFlow: false,
    description: "Contacts, companies, and deals via a private-app token.",
    fields: [], secret: { label: "Private app token", required: true, placeholder: "pat-…" } },
  { id: "salesforce", name: "Salesforce", category: "CRM & Sales", kind: "http", auth: "bearer", oauthFlow: false,
    description: "Query and update records on your Salesforce instance.",
    fields: [{ key: "baseUrl", label: "Instance URL", type: "url", required: true, placeholder: "https://your.my.salesforce.com" }],
    secret: { label: "Access token", required: true, placeholder: "00D…" } },
  { id: "stripe", name: "Stripe", category: "CRM & Sales", kind: "http", auth: "bearer", oauthFlow: false,
    description: "Read customers, charges, and subscriptions (use a restricted key).",
    fields: [], secret: { label: "Secret key", required: true, placeholder: "sk_live_… / rk_…" } },

  // ── Databases ──
  { id: "postgres", name: "Postgres", category: "Databases", kind: "db", auth: "connstring", oauthFlow: false,
    description: "Query a Postgres database (also backs pgvector RAG).",
    fields: [], secret: { label: "Connection string", required: true, placeholder: "postgres://user:pass@host:5432/db" } },
  { id: "pgvector", name: "pgvector store", category: "Databases", kind: "db", auth: "connstring", oauthFlow: false,
    description: "A Postgres + pgvector connection used as a vector store for retrieval.",
    fields: [{ key: "table", label: "Table", type: "text", required: false, placeholder: "embeddings (optional)" }],
    secret: { label: "Connection string", required: true, placeholder: "postgres://…" } },
];

const BY_ID = new Map(CONNECTORS.map((c) => [c.id, c]));

export function getConnector(id) { return BY_ID.get(id) || null; }

export function listConnectors({ q = "", category = "" } = {}) {
  const needle = String(q || "").trim().toLowerCase();
  return CONNECTORS.filter((c) => {
    if (category && c.category !== category) return false;
    if (!needle) return true;
    return c.name.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle) || c.id.includes(needle) || c.category.toLowerCase().includes(needle);
  });
}

// Shape a resolved connection into run-time material for a runner/export:
// { kind, baseUrl, authHeaders, connectionString }. Pure — the DB resolver calls
// this after decrypting (and, for OAuth, refreshing) the credential.
export function materialize(connectorId, { secret = null, config = {} } = {}) {
  const c = getConnector(connectorId);
  const kind = c ? c.kind : "http";
  const out = { kind, baseUrl: config.baseUrl || config.endpoint || null, authHeaders: {}, connectionString: null };
  if (kind === "db") { out.connectionString = secret || null; return out; }
  if (!secret) return out;
  // GitHub's API wants "token <t>"; most others take a Bearer.
  out.authHeaders = connectorId === "github"
    ? { Authorization: `token ${secret}` }
    : { Authorization: `Bearer ${secret}` };
  return out;
}

// Validate a would-be connection's fields against its connector definition.
// Returns { ok, errors: [msg] }. Pure — the store calls this before persisting.
export function validateConnection(connectorId, { name, config = {}, secret = null } = {}) {
  const c = getConnector(connectorId);
  const errors = [];
  if (!c) return { ok: false, errors: [`Unknown connector "${connectorId}".`] };
  if (!name || !String(name).trim()) errors.push("A connection needs a name.");
  for (const f of c.fields || []) {
    if (f.required && !String(config[f.key] || "").trim()) errors.push(`${f.label} is required.`);
    if (f.type === "url" && config[f.key] && !/^https?:\/\//.test(config[f.key])) errors.push(`${f.label} must be an http(s) URL.`);
  }
  if (c.secret?.required && !String(secret || "").trim()) errors.push(`${c.secret.label} is required.`);
  return { ok: errors.length === 0, errors };
}
