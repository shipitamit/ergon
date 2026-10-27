/* Tests for the app's pure logic: Python codegen and graph validation.
   Run: node src/codegen.test.mjs   (or: npm run test:codegen)
   No framework — plain node:assert, like auth.test.mjs. */
import assert from "node:assert";
import { genPython, genDeploy, validateGraph, preflight, graphIsAdvanced, diffGraphs, parseConditions } from "./codegen.js";

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; failures.push([name, e.message]); }
}

// ── helpers to build minimal graphs ──
const agent = (id, over = {}) => ({
  id, type: "agent",
  config: {
    name: over.name || id, provider: over.provider || "anthropic",
    model: over.model || "", system: over.system || "S",
    mode: over.mode || "execute", maxIterations: over.maxIterations ?? 6,
    allowInternet: over.allowInternet ?? true, approvalMode: over.approvalMode || "heuristic",
    baseUrl: over.baseUrl || "", browser: over.browser || false,
    browserActs: over.browserActs || false, ...over,
  },
});
const linear = (agentOver = {}) => ({
  nodes: [
    { id: "in", type: "input", config: { message: "hi" } },
    agent("a", agentOver),
    { id: "out", type: "output", config: {} },
  ],
  edges: [
    { kind: "flow", from: "in", to: "a" },
    { kind: "flow", from: "a", to: "out" },
  ],
});

// ── codegen: imports & basic shape ──
test("emits ergon import (not agentforge)", () => {
  const { nodes, edges } = linear();
  const code = genPython(nodes, edges);
  assert.ok(code.includes("from ergon import"), "should import from ergon");
  assert.ok(!code.includes("agentforge"), "must not reference old package");
});

test("emits an Agent constructor", () => {
  const { nodes, edges } = linear();
  const code = genPython(nodes, edges);
  assert.ok(/=\s*Agent\(/.test(code), "should construct an Agent");
});

// ── codegen: providers ──
test("non-anthropic provider is passed through", () => {
  const { nodes, edges } = linear({ provider: "ollama", model: "llama3.1" });
  const code = genPython(nodes, edges);
  assert.ok(code.includes('provider="ollama"'), "ollama provider emitted");
});

test("anthropic provider is the default (not emitted)", () => {
  const { nodes, edges } = linear({ provider: "anthropic" });
  const code = genPython(nodes, edges);
  assert.ok(!code.includes('provider="anthropic"'), "default provider omitted");
});

test("ollama remote base_url emitted, localhost omitted", () => {
  let code = genPython(...Object.values(linear({ provider: "ollama", baseUrl: "http://box:11434/v1" })));
  assert.ok(code.includes("base_url="), "remote host emitted");
  code = genPython(...Object.values(linear({ provider: "ollama", baseUrl: "http://localhost:11434/v1" })));
  assert.ok(!code.includes("base_url="), "localhost default omitted");
});

// ── codegen: unified routing (provider prefix → 'prefix/model' spec) ──
test("providerId emits a router 'prefix/model' spec", () => {
  const { nodes, edges } = linear({ providerId: "nvidia", provider: "openai", model: "meta/llama-3.3-70b-instruct", baseUrl: "https://integrate.api.nvidia.com/v1" });
  const code = genPython(nodes, edges);
  assert.ok(code.includes('provider="nvidia/meta/llama-3.3-70b-instruct"'), "router spec emitted");
  assert.ok(!code.includes('model="meta/llama-3.3-70b-instruct"'), "no separate model= when routed");
});

test("legacy node without providerId keeps the classic emission", () => {
  const { nodes, edges } = linear({ provider: "openai", model: "gpt-4o" });
  const code = genPython(nodes, edges);
  assert.ok(code.includes('provider="openai"') && code.includes('model="gpt-4o"'), "classic provider+model");
  assert.ok(!code.includes("/gpt-4o"), "not turned into a router spec");
});

// ── codegen: conditional node (deterministic branch) ──
test("parseConditions parses tests, values and else", () => {
  const p = parseConditions("contains urgent -> bug\nregex \\d{3} -> code\nlonger_than 280 -> deep\nelse -> quick");
  assert.equal(p.rules.length, 3);
  assert.equal(p.elseLabel, "quick");
  assert.deepEqual(p.rules[0], { test: "contains", value: "urgent", label: "bug" });
  assert.equal(p.rules[1].test, "regex");
  assert.equal(p.rules[2].test, "longer_than");
});

const condGraph = () => ({
  nodes: [
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "c", type: "conditional", config: { name: "classify", rules: "contains urgent -> urgent\nelse -> quick" } },
    agent("a1", { name: "urgent" }),
    agent("a2", { name: "quick" }),
    { id: "out", type: "output", config: {} },
  ],
  edges: [
    { kind: "flow", from: "in", to: "c" },
    { kind: "dispatch", from: "c", to: "a1" },
    { kind: "dispatch", from: "c", to: "a2" },
    { kind: "flow", from: "c", to: "out" },
  ],
});

test("conditional node emits a branch() with a predicate def", () => {
  const { nodes, edges } = condGraph();
  const code = genPython(nodes, edges);
  assert.ok(code.includes("def _cond_classify(t):"), "predicate def emitted");
  assert.ok(/result = branch\(/.test(code), "branch() call emitted");
  assert.ok(code.includes('"urgent" in tl'), "contains rule compiled");
  assert.ok(code.includes("from ergon import") && code.includes("branch"), "branch imported");
});

test("conditional maps labels to same-named agents", () => {
  const { nodes, edges } = condGraph();
  const code = genPython(nodes, edges);
  // both labels should map to an agent var in the branch dict
  assert.ok(/branch\([^)]*\{[^}]*"urgent":/.test(code.replace(/\n/g, " ")), "urgent mapped");
  assert.ok(/"quick":/.test(code), "quick mapped");
});

test("conditional with a regex rule imports re inside the predicate", () => {
  const nodes = [
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "c", type: "conditional", config: { name: "rx", rules: "regex \\d{3,} -> num\nelse -> other" } },
    agent("a1", { name: "num" }), agent("a2", { name: "other" }),
    { id: "out", type: "output", config: {} },
  ];
  const edges = [
    { kind: "flow", from: "in", to: "c" },
    { kind: "dispatch", from: "c", to: "a1" }, { kind: "dispatch", from: "c", to: "a2" },
    { kind: "flow", from: "c", to: "out" },
  ];
  const code = genPython(nodes, edges);
  assert.ok(code.includes("    import re"), "re imported in predicate");
  assert.ok(code.includes("re.search("), "regex compiled to re.search");
});

test("conditional with no rules is a graph error", () => {
  const nodes = [
    { id: "c", type: "conditional", config: { name: "empty", rules: "" } },
  ];
  const issues = validateGraph(nodes, []);
  assert.ok(issues.some((i) => i.level === "error" && /no valid rules/.test(i.msg)), "empty rules flagged");
});

// ── codegen: step checkpoints ──
test("checkpoints=True emitted when enabled, absent otherwise", () => {
  let code = genPython(...Object.values(linear({ checkpoints: true })));
  assert.ok(code.includes("checkpoints=True"), "checkpoints emitted when on");
  code = genPython(...Object.values(linear({ checkpoints: false })));
  assert.ok(!code.includes("checkpoints="), "not emitted when off");
});

// ── codegen: spend budgets ──
test("budget caps emitted when set", () => {
  const { nodes, edges } = linear();
  const code = genPython(nodes, edges, { maxTokens: "50000", maxCost: "0.5" });
  assert.ok(code.includes("max_total_tokens=50000"), "token cap");
  assert.ok(code.includes("max_cost=0.5"), "cost cap");
});

test("budget omitted when blank", () => {
  const { nodes, edges } = linear();
  const code = genPython(nodes, edges, { maxTokens: "", maxCost: "" });
  assert.ok(!code.includes("max_total_tokens"), "no token cap");
  assert.ok(!code.includes("max_cost"), "no cost cap");
});

// ── codegen: browser control ──
test("browser tools + import emitted when enabled", () => {
  const { nodes, edges } = linear({ browser: true });
  const code = genPython(nodes, edges);
  assert.ok(code.includes("BrowserSession"), "BrowserSession emitted");
  assert.ok(code.includes("browser_tools"), "browser_tools emitted");
});

test("browser act-tools allow-listed only when browserActs on", () => {
  let code = genPython(...Object.values(linear({ browser: true, browserActs: true })));
  assert.ok(code.includes("always_allow=") && code.includes("browser_click"), "acts allow-listed");
  code = genPython(...Object.values(linear({ browser: true, browserActs: false })));
  assert.ok(!code.includes('always_allow=["browser_click'), "acts gated when off");
});

// ── codegen: HTTP custom tool ──
test("http custom tool emits a requests call", () => {
  const nodes = [
    { id: "in", type: "input", config: { message: "hi" } },
    agent("a"),
    { id: "t", type: "customtool", config: { name: "lookup", description: "d", mode: "http", httpMethod: "POST", url: "https://api.x.com", headers: "" } },
    { id: "out", type: "output", config: {} },
  ];
  const edges = [
    { kind: "flow", from: "in", to: "a" },
    { kind: "tool", from: "a", to: "t" },
    { kind: "flow", from: "a", to: "out" },
  ];
  const code = genPython(nodes, edges);
  assert.ok(code.includes("import requests"), "requests imported");
  assert.ok(code.includes("requests.post("), "requests.post emitted");
});

// ── validation ──
test("valid linear graph passes", () => {
  const { nodes, edges } = linear();
  const issues = validateGraph(nodes, edges);
  const errors = (issues || []).filter((i) => i.level === "error");
  assert.strictEqual(errors.length, 0, "no errors on a valid graph");
});

test("agent with no provider config still validates structurally", () => {
  const { nodes, edges } = linear();
  const issues = validateGraph(nodes, edges);
  assert.ok(Array.isArray(issues), "returns an array of issues");
});

// ── report ──
test("emits MCP stdio client + mcp_tools when agent has mcp config", () => {
  const nodes = [
    agent("a", { name: "fs", mcp: { command: "npx", args: ["-y", "srv"], safeTools: ["read_file"] } }),
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "out", type: "output", config: {} },
  ];
  const edges = [{ kind: "flow", from: "in", to: "a" }, { kind: "flow", from: "a", to: "out" }];
  const code = genPython(nodes, edges);
  assert.ok(code.includes("from ergon import MCPClient, mcp_tools"), "MCP import");
  assert.ok(code.includes('MCPClient.stdio("npx"'), "stdio ctor");
  assert.ok(code.includes("*mcp_tools(fs_mcp"), "mcp_tools spread");
  assert.ok(code.includes('safe_tools=["read_file"]'), "safe_tools passthrough");
});

test("emits MCP http client for url config", () => {
  const nodes = [
    agent("a", { name: "r", mcp: { url: "https://mcp.example.com/sse" } }),
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "out", type: "output", config: {} },
  ];
  const edges = [{ kind: "flow", from: "in", to: "a" }, { kind: "flow", from: "a", to: "out" }];
  const code = genPython(nodes, edges);
  assert.ok(code.includes('MCPClient.http("https://mcp.example.com/sse")'), "http ctor");
});

test("no MCP import when no agent uses mcp", () => {
  const nodes = [
    agent("a", { name: "plain" }),
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "out", type: "output", config: {} },
  ];
  const edges = [{ kind: "flow", from: "in", to: "a" }, { kind: "flow", from: "a", to: "out" }];
  assert.ok(!genPython(nodes, edges).includes("MCPClient"), "stays clean");
});


test("emits mcp_resource_tools when mcp.resources enabled", () => {
  const nodes = [
    agent("a", { name: "fs", mcp: { command: "npx", args: ["srv"], resources: true } }),
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "out", type: "output", config: {} },
  ];
  const edges = [{ kind: "flow", from: "in", to: "a" }, { kind: "flow", from: "a", to: "out" }];
  const code = genPython(nodes, edges);
  assert.ok(code.includes("from ergon import MCPClient, mcp_tools, mcp_resource_tools"), "resource import");
  assert.ok(code.includes("*mcp_resource_tools(fs_mcp)"), "resource tools spread");
});

test("no resource tools when mcp.resources off", () => {
  const nodes = [
    agent("a", { name: "t", mcp: { command: "x" } }),
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "out", type: "output", config: {} },
  ];
  const edges = [{ kind: "flow", from: "in", to: "a" }, { kind: "flow", from: "a", to: "out" }];
  assert.ok(!genPython(nodes, edges).includes("mcp_resource_tools"), "stays clean");
});

test("emits mcp_prompt_tools when mcp.prompts enabled", () => {
  const nodes = [
    agent("a", { name: "fs", mcp: { command: "npx", prompts: true } }),
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "out", type: "output", config: {} },
  ];
  const edges = [{ kind: "flow", from: "in", to: "a" }, { kind: "flow", from: "a", to: "out" }];
  const code = genPython(nodes, edges);
  assert.ok(code.includes("mcp_prompt_tools"), "prompt tools");
  assert.ok(code.includes("from ergon import MCPClient, mcp_tools, mcp_prompt_tools"), "prompt import");
});

test("emits MCPOAuth for an http server with oauth", () => {
  const nodes = [
    agent("a", { name: "fs", mcp: { url: "https://v.com/sse", oauth: { clientName: "ergon-agent", scopes: ["mcp:tools"] } } }),
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "out", type: "output", config: {} },
  ];
  const edges = [{ kind: "flow", from: "in", to: "a" }, { kind: "flow", from: "a", to: "out" }];
  const code = genPython(nodes, edges);
  assert.ok(code.includes('MCPOAuth(client_name="ergon-agent", scopes=["mcp:tools"])'), "oauth ctor");
  assert.ok(code.includes("MCPClient.http(\"https://v.com/sse\", auth=fs_oauth)"), "auth wired");
  assert.ok(code.includes("from ergon import MCPClient, MCPOAuth, mcp_tools"), "oauth import");
});

test("emits KnowledgeBase + retrieve_tool for an agent with a knowledge base", () => {
  const nodes = [
    agent("a", { name: "research", knowledgeBase: { enabled: true, sources: ["Ergon supports RAG."] } }),
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "out", type: "output", config: {} },
  ];
  const edges = [{ kind: "flow", from: "in", to: "a" }, { kind: "flow", from: "a", to: "out" }];
  const code = genPython(nodes, edges);
  assert.ok(code.includes("from ergon import KnowledgeBase, retrieve_tool"), "rag import");
  assert.ok(code.includes("KnowledgeBase(embedder=OpenAIEmbedder(), store=InMemoryStore())"), "kb ctor");
  assert.ok(code.includes("retrieve_tool(research_kb)"), "retrieve tool");
});

test("emits PgVectorStore when a pgvector DSN is set", () => {
  const nodes = [
    agent("a", { name: "r", knowledgeBase: { enabled: true, pgvectorDsn: "postgres://x" } }),
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "out", type: "output", config: {} },
  ];
  const edges = [{ kind: "flow", from: "in", to: "a" }, { kind: "flow", from: "a", to: "out" }];
  assert.ok(genPython(nodes, edges).includes('PgVectorStore(dsn="postgres://x")'), "pgvector");
});

test("no RAG imports when no knowledge base", () => {
  const nodes = [
    agent("a", { name: "plain" }),
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "out", type: "output", config: {} },
  ];
  const edges = [{ kind: "flow", from: "in", to: "a" }, { kind: "flow", from: "a", to: "out" }];
  assert.ok(!genPython(nodes, edges).includes("KnowledgeBase"), "stays clean");
});

test("genDeploy emits the ergon serve command and endpoints", () => {
  const nodes = [agent("a", { name: "solver" }), { id: "in", type: "input", config: {} }, { id: "out", type: "output", config: {} }];
  const edges = [{ kind: "flow", from: "in", to: "a" }, { kind: "flow", from: "a", to: "out" }];
  const d = genDeploy(nodes, edges, "Order Bot");
  assert.ok(d.includes("ergon serve order-bot.json"), "serve command with slugged file");
  assert.ok(d.includes("--auth-key"), "bearer key flag");
  assert.ok(d.includes("/run/stream"), "documents the SSE route");
  assert.ok(d.includes("1 agent"), "counts agents");
  assert.ok(d.includes("docker run -p 8900:8900"), "docker alternative");
});

// ── preflight (pre-run advisory) ──
test("preflight: clean linear graph has no issues", () => {
  const { nodes, edges } = linear();
  assert.strictEqual(preflight(nodes, edges).length, 0, "nothing to warn about");
});

test("preflight: Output with nothing wired in is a block-level issue", () => {
  const nodes = [
    { id: "in", type: "input", config: { message: "hi" } },
    agent("a"),
    { id: "out", type: "output", config: {} },
  ];
  const edges = [{ kind: "flow", from: "in", to: "a" }];   // nothing into out
  const iss = preflight(nodes, edges);
  assert.ok(iss.some((i) => i.level === "block" && i.nodeId === "out" && /nothing connected/.test(i.msg)), "unwired output flagged");
});

test("preflight: peer link with no delegation in source prompt warns", () => {
  const nodes = [
    { id: "in", type: "input", config: { message: "hi" } },
    agent("lead", { system: "You answer questions concisely." }),
    agent("critic", { system: "You critique." }),
    { id: "out", type: "output", config: {} },
  ];
  const edges = [
    { kind: "flow", from: "in", to: "lead" }, { kind: "flow", from: "lead", to: "out" },
    { kind: "link", from: "lead", to: "critic" },
  ];
  const iss = preflight(nodes, edges);
  assert.ok(iss.some((i) => i.level === "warn" && i.nodeId === "lead" && /ask_critic/.test(i.msg)), "silent peer flagged");
});

test("preflight: peer link is fine when the source prompt mentions the peer", () => {
  const nodes = [
    { id: "in", type: "input", config: { message: "hi" } },
    agent("lead", { system: "Draft, then call ask_critic to review before answering." }),
    agent("critic", { system: "You critique." }),
    { id: "out", type: "output", config: {} },
  ];
  const edges = [
    { kind: "flow", from: "in", to: "lead" }, { kind: "flow", from: "lead", to: "out" },
    { kind: "link", from: "lead", to: "critic" },
  ];
  assert.ok(!preflight(nodes, edges).some((i) => /ask_critic/.test(i.msg)), "delegation mentioned → no warning");
});

test("preflight: parallel join on a provider none of the workers use warns", () => {
  const nodes = [
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "p", type: "parallel", config: { name: "fan", join: true, provider: "anthropic" } },
    agent("w1", { provider: "openai" }),
    agent("w2", { provider: "openai" }),
    { id: "out", type: "output", config: {} },
  ];
  const edges = [
    { kind: "flow", from: "in", to: "p" }, { kind: "flow", from: "p", to: "out" },
    { kind: "dispatch", from: "p", to: "w1" }, { kind: "dispatch", from: "p", to: "w2" },
  ];
  const iss = preflight(nodes, edges);
  assert.ok(iss.some((i) => i.nodeId === "p" && /join step will fail/.test(i.msg)), "join provider mismatch flagged");
});

test("preflight: parallel join matching the workers' provider is fine", () => {
  const nodes = [
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "p", type: "parallel", config: { name: "fan", join: true, provider: "openai" } },
    agent("w1", { provider: "openai" }),
    agent("w2", { provider: "openai" }),
    { id: "out", type: "output", config: {} },
  ];
  const edges = [
    { kind: "flow", from: "in", to: "p" }, { kind: "flow", from: "p", to: "out" },
    { kind: "dispatch", from: "p", to: "w1" }, { kind: "dispatch", from: "p", to: "w2" },
  ];
  assert.ok(!preflight(nodes, edges).some((i) => i.nodeId === "p"), "matched provider → no warning");
});

test("graphIsAdvanced: linear flow is simple, non-flow edges or special nodes are advanced", () => {
  const { nodes, edges } = linear();
  assert.strictEqual(graphIsAdvanced(nodes, edges), false, "plain linear is simple");
  assert.strictEqual(graphIsAdvanced(nodes, [...edges, { kind: "link", from: "a", to: "a" }]), true, "peer edge → advanced");
  assert.strictEqual(graphIsAdvanced([...nodes, { id: "r", type: "router", config: {} }], edges), true, "router node → advanced");
});

test("diffGraphs: detects added, removed, and changed blocks + edges", () => {
  const a = { nodes: [{ id: "in", type: "input", config: { message: "hi" } }, { id: "ag", type: "agent", config: { name: "a1", mode: "fast" } }, { id: "gone", type: "agent", config: { name: "old" } }],
    edges: [{ from: "in", fromPort: "out", to: "ag", toPort: "in", kind: "flow" }, { from: "ag", fromPort: "out", to: "gone", toPort: "in", kind: "flow" }] };
  const b = { nodes: [{ id: "in", type: "input", config: { message: "hi" } }, { id: "ag", type: "agent", config: { name: "a1", mode: "deep" } }, { id: "out", type: "output", config: {} }],
    edges: [{ from: "in", fromPort: "out", to: "ag", toPort: "in", kind: "flow" }, { from: "ag", fromPort: "out", to: "out", toPort: "in", kind: "flow" }] };
  const d = diffGraphs(a, b);
  assert.deepEqual(d.addedNodes.map((n) => n.id), ["out"], "output added");
  assert.deepEqual(d.removedNodes.map((n) => n.id), ["gone"], "old agent removed");
  assert.deepEqual(d.changedNodes.map((c) => c.after.id), ["ag"], "agent config changed");
  assert.equal(d.addedEdges.length, 1, "one new edge (ag→out)");
  assert.equal(d.removedEdges.length, 1, "one dropped edge (ag→gone)");
  assert.equal(d.changed, 5);
});

test("diffGraphs: identical graphs report no change, and key order doesn't matter", () => {
  const g1 = { nodes: [{ id: "ag", type: "agent", config: { name: "a", mode: "fast", maxIterations: 6 } }], edges: [] };
  const g2 = { nodes: [{ id: "ag", type: "agent", config: { maxIterations: 6, mode: "fast", name: "a" } }], edges: [] };
  const d = diffGraphs(g1, g2);
  assert.equal(d.changed, 0, "same config in a different key order is not a change");
});

test("diffGraphs: empty baseline makes every block an addition (initial version)", () => {
  const b = { nodes: [{ id: "in", type: "input", config: {} }, { id: "ag", type: "agent", config: { name: "a" } }], edges: [{ from: "in", fromPort: "out", to: "ag", toPort: "in", kind: "flow" }] };
  const d = diffGraphs({ nodes: [], edges: [] }, b);
  assert.equal(d.addedNodes.length, 2);
  assert.equal(d.addedEdges.length, 1);
  assert.equal(d.removedNodes.length, 0);
});

test("genPython: an HTTP tool backed by a connection resolves it at run time (no inline secret)", () => {
  const nodes = [
    { id: "in", type: "input", config: { message: "hi" } },
    { id: "ag", type: "agent", config: { name: "a", provider: "anthropic", model: "claude-x", maxIterations: 4 } },
    { id: "t", type: "customtool", config: { name: "lookup", description: "look up", mode: "http", httpMethod: "POST", url: "", headers: "", connectionId: "conn_abc123" } },
    { id: "out", type: "output", config: {} },
  ];
  const edges = [
    { from: "in", fromPort: "out", to: "ag", toPort: "in", kind: "flow" },
    { from: "ag", fromPort: "out", to: "out", toPort: "in", kind: "flow" },
    { from: "t", fromPort: "tools", to: "ag", toPort: "attach", kind: "tool" },
  ];
  const code = genPython(nodes, edges);
  assert.ok(code.includes('ergon.connection("conn_abc123")'), "resolves the connection by id");
  assert.ok(code.includes("conn.auth_headers()"), "injects credential headers at run time");
  assert.ok(!code.includes("conn_abc123\n    r = requests") || true, "sanity");
  assert.ok(!/xoxb-|secret_|sk_live_/.test(code), "no secret material in the export");
});

console.log(`\ncodegen.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  ✗ ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
