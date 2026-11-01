// Pure, framework-free logic extracted for testing and reuse.
// Imported by ErgonStudio.jsx; unit-tested in tests/codegen.test.mjs.

const py = (s) => JSON.stringify(String(s ?? ""));
const pyDict = (obj) => "{" + Object.entries(obj).map(([k, v]) => `${py(k)}: ${py(v)}`).join(", ") + "}";

export { py, pyDict };

// Parse a Conditional node's rule text into { rules: [{test,value,label}], elseLabel }.
// One rule per line: "<test> <value> -> <label>", plus optional "else -> <label>".
// Shared by the Studio preview (deterministic eval) and codegen (branch predicate).
export function parseConditions(text) {
  const rules = [];
  let elseLabel = null;
  const TESTS = ["contains", "regex", "longer_than", "shorter_than"];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.*?)\s*->\s*(.+)$/);
    if (!m) continue;
    const label = m[2].trim();
    const lhs = m[1].trim();
    if (/^else$/i.test(lhs)) { elseLabel = label; continue; }
    const parts = lhs.split(/\s+/);
    const test = (parts.shift() || "").toLowerCase();
    const value = parts.join(" ");
    if (TESTS.includes(test) && value) rules.push({ test, value, label });
  }
  return { rules, elseLabel };
}

export function validateGraph(nodes, edges) {
  const issues = [];
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const agents = nodes.filter((n) => n.type === "agent");
  const inputs = nodes.filter((n) => n.type === "input");
  const outputs = nodes.filter((n) => n.type === "output");
  const flow = edges.filter((e) => e.kind === "flow");

  if (!inputs.length) issues.push({ level: "error", msg: "No Input block — a run has nowhere to start." });
  if (inputs.length > 1) issues.push({ level: "warn", msg: `${inputs.length} Input blocks — the preview runs from the first one only.` });
  if (!outputs.length) issues.push({ level: "warn", msg: "No Output block — the final answer won't be captured." });
  if (!agents.length) issues.push({ level: "error", msg: "No Agent block — nothing will run." });

  // reachability from the (first) input along flow + dispatch edges
  if (inputs.length) {
    const nextOf = {};
    for (const e of edges) if (e.kind === "flow" || e.kind === "dispatch") (nextOf[e.from] ||= []).push(e.to);
    const seen = new Set();
    const stack = [inputs[0].id];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const t of nextOf[id] || []) stack.push(t);
    }
    for (const a of agents) if (!seen.has(a.id))
      issues.push({ level: "warn", nodeId: a.id, msg: `Agent '${a.config.name}' isn't reachable from Input.` });
    for (const o of outputs) if (!seen.has(o.id))
      issues.push({ level: "warn", nodeId: o.id, msg: "Output isn't reachable from Input — the run won't reach it." });
  }

  // cycle detection in the flow chain (the preview guards against infinite
  // loops with a visited-set, but a cycle is almost always a mistake)
  const adj = {};
  for (const e of flow) (adj[e.from] ||= []).push(e.to);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {};
  let cycle = false;
  const dfs = (id) => {
    color[id] = GRAY;
    for (const t of adj[id] || []) {
      if (color[t] === GRAY) { cycle = true; return; }
      if (!color[t]) dfs(t);
    }
    color[id] = BLACK;
  };
  for (const n of nodes) if (!color[n.id]) dfs(n.id);
  if (cycle) issues.push({ level: "warn", msg: "The flow chain contains a cycle — the preview will stop at the first repeat." });

  // agents with multiple outgoing flow edges (only the first is followed)
  const outCount = {};
  for (const e of flow) outCount[e.from] = (outCount[e.from] || 0) + 1;
  for (const [id, c] of Object.entries(outCount))
    if (c > 1 && byId[id]) issues.push({ level: "warn", nodeId: id, msg: `'${byId[id].config?.name || byId[id].type}' has ${c} outgoing flow edges — the preview follows one; branching runs only in exported code.` });

  // custom tools not attached to any agent
  for (const t of nodes.filter((n) => n.type === "customtool")) {
    const attached = edges.some((e) => e.kind === "tool" && e.to === t.id);
    if (!attached) issues.push({ level: "warn", nodeId: t.id, msg: `Custom tool '${t.config.name}' isn't attached to any agent.` });
  }

  // router / parallel must dispatch to at least one agent
  for (const r of nodes.filter((n) => n.type === "router")) {
    const dispatchEdges = edges.filter((e) => e.kind === "dispatch" && e.from === r.id);
    const targetAgents = dispatchEdges.map((e) => byId[e.to]).filter((n) => n && n.type === "agent");
    if (!dispatchEdges.length) issues.push({ level: "warn", nodeId: r.id, msg: `Router '${r.config.name}' has no agents connected to route to.` });
    const labels = (r.config.labels || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!labels.length) issues.push({ level: "warn", nodeId: r.id, msg: `Router '${r.config.name}' has no category labels.` });

    // label ⇄ agent-name cross-checks (routing matches a label to the
    // same-named agent; positional fallback is surprising, so warn early)
    if (labels.length && targetAgents.length) {
      const agentNames = targetAgents.map((a) => (a.config.name || "").toLowerCase());
      const labelSet = labels.map((l) => l.toLowerCase());
      const unmatchedLabels = labels.filter((l) => !agentNames.includes(l.toLowerCase()));
      const unmatchedAgents = targetAgents.filter((a) => !labelSet.includes((a.config.name || "").toLowerCase()));
      if (unmatchedLabels.length)
        issues.push({ level: "warn", nodeId: r.id, msg: `Router '${r.config.name}': label(s) ${unmatchedLabels.map((l) => `'${l}'`).join(", ")} have no same-named agent — routing falls back to position order.` });
      if (unmatchedAgents.length)
        issues.push({ level: "warn", nodeId: r.id, msg: `Router '${r.config.name}': connected agent(s) ${unmatchedAgents.map((a) => `'${a.config.name}'`).join(", ")} match no label and may never be picked.` });
      // duplicate labels collapse to one route
      const dupes = labelSet.filter((l, i) => labelSet.indexOf(l) !== i);
      if (dupes.length)
        issues.push({ level: "warn", nodeId: r.id, msg: `Router '${r.config.name}' has duplicate label(s) ${[...new Set(dupes)].map((l) => `'${l}'`).join(", ")}.` });
    }
    // more connected agents than labels ⇒ extras are unreachable via routing
    if (labels.length && targetAgents.length > labels.length)
      issues.push({ level: "warn", nodeId: r.id, msg: `Router '${r.config.name}' has ${targetAgents.length} agents but only ${labels.length} label(s); extra agents can't be selected.` });
  }
  for (const p of nodes.filter((n) => n.type === "parallel")) {
    const workers = edges.filter((e) => e.kind === "dispatch" && e.from === p.id);
    if (workers.length < 2) issues.push({ level: "warn", nodeId: p.id, msg: `Parallel '${p.config.name}' needs at least two worker agents to be useful.` });
  }
  for (const cnode of nodes.filter((n) => n.type === "conditional")) {
    const dispatchEdges = edges.filter((e) => e.kind === "dispatch" && e.from === cnode.id);
    const targetAgents = dispatchEdges.map((e) => byId[e.to]).filter((n) => n && n.type === "agent");
    const parsed = parseConditions(cnode.config.rules);
    if (!dispatchEdges.length) issues.push({ level: "warn", nodeId: cnode.id, msg: `Conditional '${cnode.config.name}' has no agents connected to branch to.` });
    if (!parsed.rules.length && !parsed.elseLabel) issues.push({ level: "error", nodeId: cnode.id, msg: `Conditional '${cnode.config.name}' has no valid rules (use '<test> <value> -> <label>').` });
    const labels = [...parsed.rules.map((r) => r.label), ...(parsed.elseLabel ? [parsed.elseLabel] : [])];
    if (labels.length && targetAgents.length) {
      const names = targetAgents.map((a) => (a.config.name || "").toLowerCase());
      const unmatched = labels.filter((l) => !names.includes(l.toLowerCase()));
      if (unmatched.length) issues.push({ level: "warn", nodeId: cnode.id, msg: `Conditional '${cnode.config.name}': label(s) ${[...new Set(unmatched)].map((l) => `'${l}'`).join(", ")} have no same-named agent to dispatch to.` });
    }
  }

  // dangling edges (referential integrity, e.g. after a bad import)
  for (const e of edges)
    if (!byId[e.from] || !byId[e.to]) issues.push({ level: "error", msg: "An edge references a missing block (corrupt graph)." });

  // per-agent config sanity
  for (const a of agents) {
    const it = Number(a.config.maxIterations);
    if (!it || it < 1) issues.push({ level: "error", nodeId: a.id, msg: `Agent '${a.config.name}' has an invalid iteration limit.` });
    if (!(a.config.name || "").trim()) issues.push({ level: "warn", nodeId: a.id, msg: "An agent has no name." });
  }
  return issues;
}

// A graph is "advanced" if it uses anything beyond a plain Input→agents→Output
// flow: a router/conditional/parallel/customtool block, or a non-flow edge
// (dispatch/tool/peer). The Studio uses this to decide whether guided "simple
// mode" can hide the advanced palette without orphaning what's on the canvas.
export function graphIsAdvanced(nodes = [], edges = []) {
  const basic = new Set(["input", "agent", "output"]);
  if ((nodes || []).some((n) => !basic.has(n.type))) return true;
  if ((edges || []).some((e) => e.kind && e.kind !== "flow")) return true;
  return false;
}

// Structural diff between two saved graphs (a = older, b = newer). Pure +
// deterministic so the version-history UI and its tests share one source of
// truth. Nodes are matched by id; a node is "changed" when its type or config
// differs. Edges are matched by a stable signature (endpoints + ports + kind).
export function diffGraphs(a = {}, b = {}) {
  const aN = a.nodes || [], bN = b.nodes || [], aE = a.edges || [], bE = b.edges || [];
  const aNodes = new Map(aN.map((n) => [n.id, n])), bNodes = new Map(bN.map((n) => [n.id, n]));
  const stable = (o) => JSON.stringify(o, Object.keys(o || {}).sort());
  const addedNodes = [], removedNodes = [], changedNodes = [];
  for (const n of bN) if (!aNodes.has(n.id)) addedNodes.push(n);
  for (const n of aN) if (!bNodes.has(n.id)) removedNodes.push(n);
  for (const n of bN) {
    const prev = aNodes.get(n.id);
    if (prev && (prev.type !== n.type || stable(prev.config) !== stable(n.config))) changedNodes.push({ before: prev, after: n });
  }
  const esig = (e) => `${e.from}:${e.fromPort}>${e.to}:${e.toPort}#${e.kind}`;
  const aEdges = new Map(aE.map((e) => [esig(e), e])), bEdges = new Map(bE.map((e) => [esig(e), e]));
  const addedEdges = [], removedEdges = [];
  for (const [k, e] of bEdges) if (!aEdges.has(k)) addedEdges.push(e);
  for (const [k, e] of aEdges) if (!bEdges.has(k)) removedEdges.push(e);
  const changed = addedNodes.length + removedNodes.length + changedNodes.length + addedEdges.length + removedEdges.length;
  return { addedNodes, removedNodes, changedNodes, addedEdges, removedEdges, changed };
}

const PROV_LABEL = { anthropic: "Anthropic", openai: "an OpenAI-compatible provider", ollama: "Ollama", gemini: "Gemini", bedrock: "Bedrock" };
const provLabel = (p) => PROV_LABEL[p] || p || "the default provider";

// Pre-run preflight: the class of problems validateGraph can't see — shapes that
// run without error but silently do the wrong thing or fail deep in a model
// call. Returned issues are advisory (the user can still "Run anyway"); level
// "block" = you'll almost certainly get no usable answer, "warn" = likely a
// silent no-op. Each may carry {nodeId, fix}. Pure + deterministic for tests.
export function preflight(nodes = [], edges = []) {
  const out = [];
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  const nameOf = (n) => (n && n.config && n.config.name) || (n && n.type) || "?";

  // 1) Output block with nothing wired into it → the run captures no answer.
  for (const o of nodes.filter((n) => n.type === "output")) {
    const fedIn = edges.some((e) => e.kind === "flow" && e.to === o.id);
    if (!fedIn)
      out.push({ level: "block", nodeId: o.id, msg: "The Output block has nothing connected into it — the run won't surface a final answer.", fix: "Draw a flow edge from your last agent's right port into the Output block." });
  }

  // 2) Peer (ask) link whose source agent is never told to use it → the model
  //    almost never calls ask_<peer> on its own, so the peer looks "broken".
  for (const e of edges.filter((x) => x.kind === "link")) {
    const from = byId[e.from], to = byId[e.to];
    if (!from || !to || from.type !== "agent") continue;
    const toolName = `ask_${String(nameOf(to)).replace(/\W/g, "_")}`;
    const sys = String(from.config?.system || "").toLowerCase();
    const mentioned = sys.includes(String(nameOf(to)).toLowerCase()) || sys.includes("ask_") || sys.includes(toolName.toLowerCase());
    if (!mentioned)
      out.push({ level: "warn", nodeId: from.id, msg: `'${nameOf(from)}' can consult '${nameOf(to)}' (tool ${toolName}), but its instructions never mention it — the model probably won't call it.`, fix: `Add a line to '${nameOf(from)}'s system prompt telling it when to call ${toolName}, or use a sequential flow edge if the review must always run.` });
  }

  // 3) Parallel join / Router classify on a provider none of the workers use →
  //    if the user only holds one provider key, that extra model call 401s.
  for (const p of nodes.filter((n) => n.type === "parallel" && n.config?.join)) {
    const workers = edges.filter((e) => e.kind === "dispatch" && e.from === p.id).map((e) => byId[e.to]).filter((n) => n && n.type === "agent");
    const provs = new Set(workers.map((w) => w.config?.provider).filter(Boolean));
    const jp = p.config?.provider;
    if (workers.length && jp && provs.size && !provs.has(jp))
      out.push({ level: "warn", nodeId: p.id, msg: `Parallel '${nameOf(p)}' merges with ${provLabel(jp)}, but its workers run on ${[...provs].map(provLabel).join(", ")}. If you don't have a key for ${provLabel(jp)}, the join step will fail.`, fix: `Set the Parallel block's provider to match its workers, or turn its join off to just concatenate.` });
  }
  for (const r of nodes.filter((n) => n.type === "router")) {
    const targets = edges.filter((e) => e.kind === "dispatch" && e.from === r.id).map((e) => byId[e.to]).filter((n) => n && n.type === "agent");
    const provs = new Set(targets.map((t) => t.config?.provider).filter(Boolean));
    const rp = r.config?.provider;
    if (targets.length && rp && provs.size && !provs.has(rp))
      out.push({ level: "warn", nodeId: r.id, msg: `Router '${nameOf(r)}' classifies with ${provLabel(rp)}, but routes to agents on ${[...provs].map(provLabel).join(", ")}. A missing ${provLabel(rp)} key will fail the routing step.`, fix: `Set the Router block's provider to match the agents it routes to.` });
  }

  return out;
}

// Emit a shell snippet to deploy the harness as an HTTP endpoint (REST + SSE)
// via `ergon serve`. Pure/deterministic so it unit-tests cleanly.
export function genDeploy(nodes, edges, name = "harness") {
  const slug = (String(name) || "harness").replace(/\s+/g, "-").toLowerCase();
  const agents = (nodes || []).filter((n) => n.type === "agent").length;
  const file = `${slug}.json`;
  const L = [];
  L.push(`# Deploy "${name}" as an HTTP endpoint (REST + SSE) — ${agents} agent${agents === 1 ? "" : "s"}`);
  L.push("# 1) Export this harness with the \"Export JSON\" button, saved as:");
  L.push(`#    ${file}`);
  L.push("# 2) Install the SDK and serve it (set a bearer key for anything public):");
  L.push("");
  L.push("pip install ergon");
  L.push(`export ERGON_SERVE_KEY="$(openssl rand -hex 16)"`);
  L.push(`ergon serve ${file} --host 0.0.0.0 --port 8900 --auth-key "$ERGON_SERVE_KEY"`);
  L.push("");
  L.push("# Endpoints:");
  L.push("#   GET  /healthz                 liveness");
  L.push("#   GET  /readyz                  readiness");
  L.push("#   POST /run         {\"input\": \"...\"}  -> {\"text\",\"usage\",...}");
  L.push("#   POST /run/stream  same input, Server-Sent Events");
  L.push("");
  L.push("# Call it:");
  L.push(`curl -s localhost:8900/run \\`);
  L.push(`  -H "authorization: Bearer $ERGON_SERVE_KEY" \\`);
  L.push(`  -H "content-type: application/json" \\`);
  L.push(`  -d '{"input": "your task here"}'`);
  L.push("");
  L.push("# Or with Docker:");
  L.push("docker build -t ergon-serve ./sdk");
  L.push(`docker run -p 8900:8900 -v "$PWD/${file}:/app/harness.json:ro" \\`);
  L.push("  -e ANTHROPIC_API_KEY -e ERGON_SERVE_KEY ergon-serve");
  return L.join("\n");
}

export function genPython(nodes, edges, budget = { maxTokens: "", maxCost: "" }) {
  const agents = nodes.filter((n) => n.type === "agent");
  const inputNode = nodes.find((n) => n.type === "input");
  const L = [];
  L.push("# Generated by Ergon Studio — runs against the Ergon SDK");
  L.push("# pip install anthropic   &&   export ANTHROPIC_API_KEY=sk-ant-...");
  L.push("from ergon import Agent, ApprovalPolicy, tool, web_search_tool", "");
  const importLineIdx = 2;
  let usesRequests = false;
  let usesBrowser = false;
  let usesRag = false;
  let usesMcp = false;
  let usesMcpResources = false;
  let usesMcpPrompts = false;
  let usesMcpOAuth = false;

  // custom tools
  const toolVar = {};
  nodes.filter((n) => n.type === "customtool").forEach((t, i) => {
    const fn = (t.config.name || `tool${i}`).replace(/\W/g, "_");
    toolVar[t.id] = fn;
    L.push(`@tool(${py(t.config.description)})`);
    L.push(`def ${fn}(input: str) -> str:`);
    if (t.config.mode === "javascript") {
      L.push(`    # TODO: port your JavaScript implementation to Python:`);
      (t.config.js || "").split("\n").forEach((l) => L.push(`    #   ${l}`));
      L.push(`    raise NotImplementedError`);
    } else if (t.config.mode === "http") {
      const hdrs = {};
      for (const line of (t.config.headers || "").split("\n")) {
        const ci = line.indexOf(":");
        if (ci > 0) hdrs[line.slice(0, ci).trim()] = line.slice(ci + 1).trim();
      }
      const method = t.config.httpMethod === "GET" ? "GET" : "POST";
      usesRequests = true;
      if (t.config.connectionId) {
        // managed connection: base URL + credential resolved at run time from the
        // Ergon connection store — the secret is never written into this file.
        L.push(`    # Uses the managed connection ${py(t.config.connectionId)} (base URL + sealed`);
        L.push(`    # credential resolved at run time; nothing secret is baked into this file).`);
        L.push(`    conn = ergon.connection(${py(t.config.connectionId)})`);
        L.push(`    url = ${py(t.config.url || "")} or conn.base_url`);
        L.push(`    headers = {**conn.auth_headers(), **${pyDict(hdrs)}}`);
        if (method === "GET") L.push(`    r = requests.get(url, params={"input": input}, headers=headers, timeout=15)`);
        else L.push(`    r = requests.post(url, json={"input": input}, headers=headers, timeout=15)`);
      } else {
        L.push(`    # Calls a real HTTP endpoint (configured in the Studio).`);
        if (method === "GET") L.push(`    r = requests.get(${py(t.config.url || "")}, params={"input": input}, headers=${pyDict(hdrs)}, timeout=15)`);
        else L.push(`    r = requests.post(${py(t.config.url || "")}, json={"input": input}, headers=${pyDict(hdrs)}, timeout=15)`);
      }
      L.push(`    r.raise_for_status()`);
      L.push(`    return r.text`);
    } else {
      L.push(`    # In the Studio this tool was simulated by Claude — implement it here.`);
      L.push(`    raise NotImplementedError`);
    }
    L.push("");
  });

  // agents
  const agentVar = {};
  for (const a of agents) {
    const c = a.config;
    const v = (c.name || "agent").replace(/\W/g, "_");
    agentVar[a.id] = v;
    const myTools = edges.filter((e) => e.kind === "tool" && e.from === a.id).map((e) => toolVar[e.to]).filter(Boolean);
    if (c.browser) { usesBrowser = true; myTools.push(`*browser_tools(${v}_browser)`); }
    // RAG: a knowledge base the agent can retrieve from
    const kbCfg = c.knowledgeBase && (c.knowledgeBase.enabled || c.knowledgeBase.sources) ? c.knowledgeBase : null;
    if (kbCfg) { usesRag = true; myTools.push(`retrieve_tool(${v}_kb)`); }
    const browserAllow = c.browser && c.browserActs
      ? '"browser_click", "browser_type", "browser_press", "browser_submit"' : "";
    // MCP: an agent can point at an MCP server to inherit its tools
    const mcpCfg = c.mcp && (c.mcp.command || c.mcp.url) ? c.mcp : null;
    if (mcpCfg) {
      usesMcp = true;
      const safeArg = Array.isArray(mcpCfg.safeTools) && mcpCfg.safeTools.length
        ? `, safe_tools=[${mcpCfg.safeTools.map((s) => py(s)).join(", ")}]` : "";
      myTools.push(`*mcp_tools(${v}_mcp${safeArg})`);
      // also expose the server's data resources (read-only) when enabled
      if (mcpCfg.resources) { usesMcpResources = true; myTools.push(`*mcp_resource_tools(${v}_mcp)`); }
      // and its prompt templates (read-only) when enabled
      if (mcpCfg.prompts) { usesMcpPrompts = true; myTools.push(`*mcp_prompt_tools(${v}_mcp)`); }
    }
    const prov = c.provider || "anthropic";
    const noHostedSearch = prov === "openai" || prov === "bedrock";
    // Unified routing: when a provider prefix was chosen (the picker), emit a
    // single 'prefix/model' spec that the SDK router resolves (base_url+key+cost).
    const routerSpec = c.providerId && c.model;
    const args = [
      `${py(c.name)}`,
      `system=${py(c.system)}`,
      routerSpec ? `provider=${py(`${c.providerId}/${c.model}`)}` : (prov !== "anthropic" ? `provider=${py(prov)}` : null),
      routerSpec ? null : (c.model ? `model=${py(c.model)}` : null),
      routerSpec ? (c.baseUrl ? `base_url=${py(c.baseUrl)}` : null)
                 : (prov === "openai" && c.baseUrl ? `base_url=${py(c.baseUrl)}` : null),
      routerSpec ? null : (prov === "ollama" && c.baseUrl && c.baseUrl !== "http://localhost:11434/v1" ? `base_url=${py(c.baseUrl)}  # remote Ollama host` : null),
      routerSpec ? null : (prov === "bedrock" && c.baseUrl ? `base_url=${py(c.baseUrl)}  # base_url = AWS region` : null),
      myTools.length ? `tools=[${myTools.join(", ")}]` : null,
      `mode=${py(c.mode === "custom" ? c.customMode || "custom" : c.mode)}`,
      `max_iterations=${Number(c.maxIterations) || 6}`,
      (Number(budget.maxTokens) || 0) > 0 ? `max_total_tokens=${Number(budget.maxTokens)}` : null,
      (Number(budget.maxCost) || 0) > 0 ? `max_cost=${Number(budget.maxCost)}` : null,
      c.allowInternet ? null : "allow_internet=False",
      c.compaction ? `compaction=${Number(c.tokenBudget) || 30000}` : null,
      `session_dir=${py(`./sessions/${v}`)}`,
      c.files ? `working_dir=${py(c.workingDir || "./workspace")}` : null,
      c.shell ? "enable_shell=True" : null,
      c.subagents ? "enable_subagents=True" : null,
      c.todo ? null : "enable_todo=False",
      c.memory ? null : "enable_memory=False",
      c.skillsDir ? `skills_dir=${py(c.skillsDir)}` : null,
      c.otel ? null : "telemetry=False",
      c.checkpoints ? "checkpoints=True" : null,
      `approval=ApprovalPolicy(rules_path=${py(`./sessions/${v}/approval_rules.json`)}, interactive=${c.approvalMode === "interactive" ? "True" : "False"}${browserAllow ? `, always_allow=[${browserAllow}]` : ""})`,
    ].filter(Boolean);
    if (c.browser) L.push(`${v}_browser = BrowserSession(headless=True)   # remember to ${v}_browser.close() when done`);
    if (kbCfg) {
      const emb = kbCfg.embeddingModel
        ? `OpenAIEmbedder(model=${py(kbCfg.embeddingModel)}${kbCfg.embeddingBaseUrl ? `, base_url=${py(kbCfg.embeddingBaseUrl)}` : ""})`
        : "OpenAIEmbedder()";
      const store = kbCfg.pgvectorDsn
        ? `PgVectorStore(dsn=${py(kbCfg.pgvectorDsn)})`
        : "InMemoryStore()";
      L.push(`${v}_kb = KnowledgeBase(embedder=${emb}, store=${store})`);
      if (Array.isArray(kbCfg.sources) && kbCfg.sources.length) {
        L.push(`${v}_kb.add_texts([${kbCfg.sources.map((x) => py(x)).join(", ")}])  # replace with your documents`);
      } else {
        L.push(`# ${v}_kb.add_texts([...])  # ingest your documents here`);
      }
    }
    if (mcpCfg) {
      let line;
      if (mcpCfg.url) {
        if (mcpCfg.oauth) {
          usesMcpOAuth = true;
          const scopes = Array.isArray(mcpCfg.oauth.scopes) && mcpCfg.oauth.scopes.length
            ? `scopes=[${mcpCfg.oauth.scopes.map((s) => py(s)).join(", ")}]` : "";
          const name = mcpCfg.oauth.clientName ? `client_name=${py(mcpCfg.oauth.clientName)}` : "";
          const oargs = [name, scopes].filter(Boolean).join(", ");
          L.push(`${v}_oauth = MCPOAuth(${oargs})`);
          line = `${v}_mcp = MCPClient.http(${py(mcpCfg.url)}, auth=${v}_oauth).connect()`;
        } else {
          line = `${v}_mcp = MCPClient.http(${py(mcpCfg.url)}).connect()`;
        }
      } else {
        line = `${v}_mcp = MCPClient.stdio(${py(mcpCfg.command)}${Array.isArray(mcpCfg.args) && mcpCfg.args.length ? `, ${JSON.stringify(mcpCfg.args)}` : ""}).connect()`;
      }
      L.push(`${line}   # remember to ${v}_mcp.close() when done`);
    }
    L.push(`${v} = Agent(`);
    args.forEach((arg) => {
      const m = arg.match(/^(.*?)(\s+#.*)$/);           // keep inline comments after the comma
      L.push(m ? `    ${m[1]},${m[2]}` : `    ${arg},`);
    });
    L.push(")");
    if (noHostedSearch && c.allowInternet) {
      L.push(`# '${v}' runs on ${prov}: no hosted web search there.`);
      L.push(`# Wrap any backend: ${v}.add_tool(web_search_tool(my_search_fn))  # from ergon`);
    }
    const allow = (c.alwaysAllow || "").split(",").map((s) => s.trim()).filter(Boolean);
    allow.forEach((t) => L.push(`${v}.approval.always_allow(${py(t)})`));
    L.push("");
  }

  // connections
  for (const e of edges.filter((x) => x.kind === "link")) {
    if (agentVar[e.from] && agentVar[e.to]) L.push(`${agentVar[e.from]}.connect(${agentVar[e.to]})`);
  }
  L.push("");

  // flow chain
  L.push("# ── run the flow ──");
  L.push(`task = ${py(inputNode?.config.message || "Your task here")}`);
  let cur = inputNode, step = 0, emitted = false;
  const seen = new Set();
  let usesFlows = false, usesGuards = false, usesApproval = false;
  while (cur) {
    const e = edges.find((x) => x.kind === "flow" && x.from === cur.id);
    const nxt = e && nodes.find((n) => n.id === e.to);
    if (!nxt || seen.has(nxt.id)) break;
    seen.add(nxt.id);
    const src = step === 0 ? "task" : "result.text";
    if (nxt.type === "agent") {
      const v = agentVar[nxt.id], c = nxt.config;
      if (c.loopEnabled) L.push(`result = ${v}.run_until(${src}, condition=${py(c.loopMarker || "DONE")}, max_rounds=${Number(c.maxRounds) || 3})`);
      else L.push(`result = ${v}.run(${src})`);
      step++; emitted = true;
    } else if (nxt.type === "router") {
      usesFlows = true;
      const labels = (nxt.config.labels || "").split(",").map((x) => x.trim()).filter(Boolean);
      const targets = edges.filter((x) => x.kind === "dispatch" && x.from === nxt.id).map((x) => nodes.find((n) => n.id === x.to)).filter((n) => n && n.type === "agent");
      // map each label to the agent var whose name matches, else by position
      const routeMap = labels.map((lab, i) => {
        const t = targets.find((tt) => (tt.config.name || "").toLowerCase() === lab.toLowerCase()) || targets[i];
        return t ? `${py(lab)}: ${agentVar[t.id]}` : null;
      }).filter(Boolean);
      // router itself needs an Agent to classify; declare an inline one
      const rv = `${(nxt.config.name || "router").replace(/\W/g, "_")}_agent`;
      L.push(`${rv} = Agent(${py(nxt.config.name)}, system=${py(nxt.config.instruction || "Classify the request.")}${nxt.config.provider !== "anthropic" ? `, provider=${py(nxt.config.provider)}` : ""}${nxt.config.model ? `, model=${py(nxt.config.model)}` : ""}, allow_internet=False)`);
      L.push(`result = route(${src}, ${rv}, {${routeMap.join(", ")}})`);
      step++; emitted = true;
    } else if (nxt.type === "conditional") {
      usesFlows = true;
      const parsed = parseConditions(nxt.config.rules);
      const targets = edges.filter((x) => x.kind === "dispatch" && x.from === nxt.id).map((x) => nodes.find((n) => n.id === x.to)).filter((n) => n && n.type === "agent");
      const byName = (lab) => targets.find((t) => (t.config.name || "").toLowerCase() === lab.toLowerCase());
      const fn = `_cond_${(nxt.config.name || "cond").replace(/\W/g, "_")}`;
      const needsRe = parsed.rules.some((r) => r.test === "regex");
      L.push(`def ${fn}(t):`);
      if (needsRe) L.push(`    import re`);
      L.push(`    tl = t.lower()`);
      for (const r of parsed.rules) {
        if (r.test === "contains") L.push(`    if ${py((r.value || "").toLowerCase())} in tl: return ${py(r.label)}`);
        else if (r.test === "regex") L.push(`    if re.search(r${py(r.value)}, t): return ${py(r.label)}`);
        else if (r.test === "longer_than") L.push(`    if len(t) > ${Number(r.value) || 0}: return ${py(r.label)}`);
        else if (r.test === "shorter_than") L.push(`    if len(t) < ${Number(r.value) || 0}: return ${py(r.label)}`);
      }
      const fallback = parsed.elseLabel || (parsed.rules[0] && parsed.rules[0].label) || "";
      L.push(`    return ${py(fallback)}`);
      const pairs = [];
      for (const lab of [...parsed.rules.map((r) => r.label), ...(parsed.elseLabel ? [parsed.elseLabel] : [])]) {
        const t = byName(lab);
        if (t) pairs.push(`${py(lab)}: ${agentVar[t.id]}`);
      }
      L.push(`result = branch(${src}, ${fn}, {${[...new Set(pairs)].join(", ")}})`);
      step++; emitted = true;
    } else if (nxt.type === "parallel") {
      usesFlows = true;
      const workers = edges.filter((x) => x.kind === "dispatch" && x.from === nxt.id).map((x) => nodes.find((n) => n.id === x.to)).filter((n) => n && n.type === "agent");
      const wl = workers.map((w) => agentVar[w.id]).join(", ");
      if (nxt.config.join) {
        const jv = `${(nxt.config.name || "join").replace(/\W/g, "_")}_joiner`;
        L.push(`${jv} = Agent(${py(nxt.config.name + "_joiner")}, system=${py(nxt.config.joinPrompt || "Combine the results.")}${nxt.config.provider !== "anthropic" ? `, provider=${py(nxt.config.provider)}` : ""}${nxt.config.model ? `, model=${py(nxt.config.model)}` : ""}, allow_internet=False)`);
        L.push(`result = parallel(${src}, [${wl}], ${jv})`);
      } else {
        L.push(`result = parallel(${src}, [${wl}])`);
      }
      step++; emitted = true;
    } else if (nxt.type === "guardrail") {
      usesGuards = true;
      const c = nxt.config || {};
      const gl = [];
      if (c.pii !== false) gl.push("PIIGuard()");
      if (c.moderation) gl.push("ModerationGuard()");
      if (c.schema) { try { gl.push(`SchemaGuard(${pyDict(JSON.parse(c.schema))}, action=${py(c.schemaAction || "flag")})`); } catch { /* skip bad schema */ } }
      if (!gl.length) gl.push("PIIGuard()");
      L.push(`_g = apply_guards(${src}, [${gl.join(", ")}], "output")`);
      L.push(`result = _Text(_g.text)`);
      step++; emitted = true;
    } else if (nxt.type === "approval") {
      usesApproval = true;
      const title = (nxt.config && nxt.config.title) || "Approve to continue";
      L.push(`_ok, _req = ApprovalClient.from_env().request_and_wait(${py(title)}, detail=${src})`);
      L.push(`if not _ok: raise SystemExit("stopped by approval: " + str(_req.get("status")))`);
      L.push(`result = _Text(${src})`);
      step++; emitted = true;
    } else if (nxt.type === "output") {
      L.push("print(result.text)");
      L.push("print(result.usage)   # tokens + estimated cost");
      L.push("# crash recovery:  agent.run('continue', resume=True)");
    }
    cur = nxt;
  }
  if (usesGuards) L[importLineIdx] = L[importLineIdx].replace("from ergon import ", "from ergon import apply_guards, PIIGuard, ModerationGuard, SchemaGuard, ");
  if (usesApproval) L[importLineIdx] = L[importLineIdx].replace("from ergon import ", "from ergon import ApprovalClient, ");
  if (usesGuards || usesApproval) L.splice(importLineIdx + 1, 0, "class _Text:  # carries .text between guardrail/approval steps\n    def __init__(self, text): self.text = text");
  if (usesFlows) L[importLineIdx] = "from ergon import Agent, ApprovalPolicy, tool, web_search_tool, chain, route, parallel, branch";
  if (usesBrowser) L[importLineIdx] = L[importLineIdx].replace("from ergon import ", "from ergon import BrowserSession, browser_tools, ");
  if (usesRag) L[importLineIdx] = L[importLineIdx].replace("from ergon import ", "from ergon import KnowledgeBase, retrieve_tool, OpenAIEmbedder, InMemoryStore, PgVectorStore, ");
  if (usesMcp) {
    const mcpNames = ["MCPClient"];
    if (usesMcpOAuth) mcpNames.push("MCPOAuth");
    mcpNames.push("mcp_tools");
    if (usesMcpResources) mcpNames.push("mcp_resource_tools");
    if (usesMcpPrompts) mcpNames.push("mcp_prompt_tools");
    const mcpImports = mcpNames.join(", ") + ", ";
    L[importLineIdx] = L[importLineIdx].replace("from ergon import ", "from ergon import " + mcpImports);
  }
  if (!emitted) L.push("# (connect Input → Agent → Output on the canvas to generate a run)");
  if (usesRequests) L.splice(importLineIdx + 1, 0, "import requests");
  return L.join("\n");
}
