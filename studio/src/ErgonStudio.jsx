import React, { useState, useRef, useEffect, useCallback } from "react";
import { genPython, genDeploy, validateGraph, preflight, graphIsAdvanced, diffGraphs, py, pyDict, parseConditions } from "./codegen.js";
import { storage, useServerStorage, storageKind, auth, cloud } from "./storage";

/* ═══════════════════════════════════════════════════════════════════
   ERGON STUDIO — drag-and-drop harness builder
   Wire agents, tools and peers on a canvas; every harness feature is a
   toggle in the inspector. Run a live preview in-browser, inspect the
   trace / todo / virtual files / persisted sessions, then export the
   whole harness as Python code against the Ergon SDK.
   ═══════════════════════════════════════════════════════════════════ */

const FONT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
* { box-sizing: border-box; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: currentColor; opacity: 0.18; border-radius: 4px; }
::-webkit-scrollbar-track { background: transparent; }
@keyframes flowdash { to { stroke-dashoffset: -28; } }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .5; } }
@keyframes ergon-fade-in { from { opacity: 0; transform: translateY(6px) scale(.985); } to { opacity: 1; transform: none; } }
@keyframes ergon-pop-in { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: none; } }
/* smooth theme + interaction transitions on chrome elements (not the canvas SVG) */
button, select, input, textarea, [data-popover] > div, [role="switch"] {
  transition: background-color .22s ease, border-color .22s ease, color .22s ease, box-shadow .22s ease, transform .12s ease;
}
button:not(:disabled):hover { filter: brightness(1.06); }
button:not(:disabled):active { transform: translateY(0.5px) scale(.99); }
.ergon-node { transition: filter .16s ease, transform .16s ease; }
.ergon-node:hover { filter: brightness(1.07); }
.ergon-modal { animation: ergon-fade-in .2s ease both; }
.ergon-popover { animation: ergon-pop-in .14s ease both; }
@media (prefers-reduced-motion: reduce) {
  .edge-active { animation: none !important; }
  *, .ergon-modal, .ergon-popover, .ergon-node { animation: none !important; transition: none !important; }
}
input:focus, textarea:focus, select:focus, button:focus-visible { outline: 2px solid var(--ergon-focus, #5CCFE6); outline-offset: 1px; }
`;

const THEMES = {
  dark: {
    // deep indigo-slate, not flat black — a touch of blue warmth in the darks
    bg: "#0E1117", panel: "#161A23", panel2: "#1C2130",
    border: "#2B3242", borderSoft: "#222838",
    text: "#EAECF3", mut: "#8D95A8", faint: "#818897",   // faint lifted to pass WCAG AA (4.5:1) on panels
    // jewel-toned accents, slightly deepened for richness on dark
    agent: "#FFB454", tool: "#5CCFE6", input: "#8CE07A",
    output: "#F4737D", link: "#C99BF0", run: "#8CE07A",
    conditional: "#4FB7C7", parallel: "#E6B450",
    onAccent: "#0D1410",   // text on a filled accent button (fills are light on dark → dark text)
    shadow: "0 8px 30px rgba(0,0,0,0.38)", glow: "0 0 0 1px rgba(255,255,255,0.03)",
    canvasDot: "rgba(255,255,255,0.05)", accentSoft: "rgba(92,207,230,0.10)",
  },
  light: {
    // warm parchment, not stark white — easy on the eyes, still crisp
    bg: "#F4F1EA", panel: "#FBF9F4", panel2: "#F0ECE2",
    border: "#DAD3C4", borderSoft: "#E7E1D5",
    text: "#232A33", mut: "#5E6673", faint: "#676B73",   // all text tokens pass WCAG AA (4.5:1) on panels
    // accents retuned: same identities, deepened to pass 4.5:1 as text on light parchment
    agent: "#975D11", tool: "#16738D", input: "#2F7832",
    output: "#B93F4D", link: "#8651C0", run: "#2F7832",
    conditional: "#32737D", parallel: "#83672E",
    onAccent: "#FFFFFF",   // fills are deepened on light → light text for AA contrast
    shadow: "0 8px 26px rgba(60,50,30,0.12)", glow: "0 0 0 1px rgba(0,0,0,0.02)",
    canvasDot: "rgba(80,70,50,0.10)", accentSoft: "rgba(30,156,191,0.10)",
  },
};

let C = THEMES.dark;   // active palette; reassigned per-render from theme state so
                       // module-level helper components (Field, Toggle, modals) track the theme

const NODE_W = 224, NODE_H = 96;

// Sticky notes — canvas annotations, not part of the flow graph (ignored by run/codegen).
const NOTE_W = 200, NOTE_H = 130, NOTE_MIN_W = 130, NOTE_MIN_H = 84;
const NOTE_PALETTE = {
  amber: { dark: { bg: "#3B3012", bd: "#6E5A1E", tx: "#F1E0A6" }, light: { bg: "#FDF3C9", bd: "#E3C65B", tx: "#5A4712" } },
  green: { dark: { bg: "#16301D", bd: "#2E5A3C", tx: "#AEE6C0" }, light: { bg: "#D9F2E0", bd: "#6CBA85", tx: "#1F5233" } },
  blue:  { dark: { bg: "#172A3D", bd: "#2B5070", tx: "#A9D2F2" }, light: { bg: "#D8EAFB", bd: "#5B9BD8", tx: "#1C4A74" } },
  pink:  { dark: { bg: "#381A2C", bd: "#6B3350", tx: "#F2B8D6" }, light: { bg: "#FBDCEC", bd: "#DB76A9", tx: "#6E2149" } },
  gray:  { dark: { bg: "#21262F", bd: "#3B424F", tx: "#C3C9D4" }, light: { bg: "#E7E9ED", bd: "#AEB4BF", tx: "#3A3F48" } },
};
const NOTE_COLOR_KEYS = Object.keys(NOTE_PALETTE);

const NODE_TYPES = {
  input:  { label: "Input",  color: C.input,  icon: "▸", ports: ["out"],
            desc: "Where a run starts — the user message." },
  agent:  { label: "Agent",  color: C.agent,  icon: "◈", ports: ["in", "out", "tools", "mesh"],
            desc: "An LLM agent (any provider). Full harness config in the inspector." },
  customtool: { label: "Custom Tool", color: C.tool, icon: "⚙", ports: ["attach"],
            desc: "Your tool — simulated by Claude, real JavaScript, or an HTTP endpoint." },
  router: { label: "Router", color: C.link, icon: "⑃", ports: ["in", "routes"],
            desc: "Classifies the input and routes flow to one downstream agent." },
  conditional: { label: "Conditional", color: "#4FB7C7", icon: "◇", ports: ["in", "routes"],
            desc: "Branches flow by a rule on the text — no model call. Exports to branch()." },
  parallel: { label: "Parallel", color: "#E6B450", icon: "⑈", ports: ["in", "fan", "out"],
            desc: "Fans the input out to several agents, then joins their results." },
  output: { label: "Output", color: C.output, icon: "▪", ports: ["in"],
            desc: "Where the final answer lands." },
};
// NODE_TYPES.color freezes to the dark palette at module load, so a node's accent
// must be resolved from the CURRENT theme at render time via this map.
const TYPE_COLOR_KEY = { input: "input", agent: "agent", customtool: "tool", router: "link", conditional: "conditional", parallel: "parallel", output: "output" };
const typeColor = (type) => C[TYPE_COLOR_KEY[type]] || C.agent;

// The port pairs that make a valid edge (sorted-join keys), mirroring
// finishConnect. Used to highlight valid drop targets while dragging.
const VALID_PORT_PAIRS = new Set(["in+out", "attach+tools", "mesh+mesh", "in+routes", "in+fan"]);
const portsConnectable = (a, b) => VALID_PORT_PAIRS.has([a, b].sort().join("+"));
// What kind of edge (and a human label) a drag from this port will create.
const PORT_EDGE_LABEL = { out: "flow", in: "flow", tools: "attach tool", attach: "attach tool", mesh: "ask peer", routes: "route", fan: "fan-out" };
const portEdgeLabel = (port) => PORT_EDGE_LABEL[port] || "";
const portEdgeKind = (port) => (port === "out" || port === "in") ? "flow" : (port === "tools" || port === "attach") ? "tool" : port === "mesh" ? "link" : (port === "routes" || port === "fan") ? "dispatch" : "flow";
// Ports hidden by guided simple mode (unless an edge already uses them).
const ADVANCED_PORTS = new Set(["tools", "mesh", "routes", "fan"]);
const SIMPLE_NODE_TYPES = new Set(["input", "agent", "output"]);
const RUNNABLE_TYPES = new Set(["agent", "router", "conditional", "parallel"]);   // blocks that execute (support partial runs)
// Short permanent labels drawn next to each port handle.
const PORT_LABELS = { in: "in", out: "out", tools: "tools", mesh: "peer", routes: "route", fan: "fan", attach: "tool" };
// Placement of a port's label relative to the handle position.
const portLabelStyle = (port, p) => {
  const base = { position: "absolute", fontFamily: MONO, fontSize: 8, letterSpacing: 0.3, pointerEvents: "none", zIndex: 4, whiteSpace: "nowrap", textTransform: "uppercase" };
  if (port === "in")  return { ...base, left: p.x - 10, top: p.y, transform: "translate(-100%, -50%)" };
  if (port === "out") return { ...base, left: p.x + 10, top: p.y, transform: "translate(0, -50%)" };
  if (port === "mesh" || port === "attach") return { ...base, left: p.x, top: p.y - 11, transform: "translate(-50%, -100%)" };
  return { ...base, left: p.x, top: p.y + 11, transform: "translate(-50%, 0)" };   // tools / routes / fan (bottom)
};
// Friendly hover text explaining what each port does.
const portHint = (_type, port) => ({
  out: "flow out — drag to the next block's left port",
  in: "flow in — the previous block connects here",
  tools: "attach a custom tool (drag down to a tool block)",
  mesh: "ask a peer agent — drag to another agent's top port",
  routes: "route — drag to each agent this should dispatch to",
  fan: "fan-out — drag to each worker agent to run in parallel",
  attach: "attach — connect to an agent's tools port",
}[port] || port);

// The one field each node type lets you quick-edit inline (double-click body),
// without opening the full inspector. Mirrors the inspector's primary control.
const QUICK_FIELD = {
  input:       { field: "message",     label: "Input message",            rows: 4, mono: false },
  agent:       { field: "system",      label: "System prompt",            rows: 5, mono: false },
  customtool:  { field: "description", label: "Tool description",         rows: 3, mono: false },
  router:      { field: "labels",      label: "Categories (comma-sep)",   rows: 2, mono: true  },
  conditional: { field: "rules",       label: "Rules (one per line)",     rows: 4, mono: true  },
  parallel:    { field: "joinPrompt",  label: "Join prompt",              rows: 3, mono: false },
};
const hasEditableName = (t) => t === "agent" || t === "customtool" || t === "router" || t === "conditional" || t === "parallel";

// deterministic per-user color + initials for collaboration avatars / cursors
function userColor(key) {
  const s = String(key || ""); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h}, 60%, 58%)`;
}
const initials = (email) => String(email || "?").replace(/@.*/, "").slice(0, 2).toUpperCase();

let idc = 100;
const uid = (p) => `${p}_${idc++}`;

const defaultAgentCfg = (name) => ({
  name,
  provider: "anthropic", model: "claude-sonnet-4-6", baseUrl: "",
  system: "You are a careful, concise agent. Use your tools when they help.",
  mode: "execute", customMode: "",
  maxIterations: 6,
  // context
  compaction: false, tokenBudget: 30000,
  // memory & files
  todo: true, memory: true, files: false, workingDir: "./workspace",
  // safety
  allowInternet: true, approvalMode: "heuristic", alwaysAllow: "",
  // advanced (SDK-only ones still export to code)
  skillsDir: "", subagents: false, shell: false, browser: false, browserActs: false, otel: true,
  checkpoints: false,
  loopEnabled: false, loopMarker: "TASK_COMPLETE", maxRounds: 3,
});

function defaultConfig(type) {
  if (type === "input") return { message: "Research the Raspberry Pi 5 vs Zero 2 W for a weather station, keep a todo list, and write a short brief." };
  if (type === "agent") return defaultAgentCfg("lead");
  if (type === "customtool") return {
    name: "unit_converter",
    description: "Converts a value between units, e.g. '5 miles to km'.",
    mode: "simulate",
    js: "// `input` is a string from the agent. Return a string.\nreturn `Converted: ${input}`;",
    url: "",
    httpMethod: "POST",
    headers: "",
    connectionId: null,
  };
  if (type === "router") return {
    name: "router",
    // labels are matched (case-insensitive substring) against the classifier's answer;
    // each label should also be the name of a downstream agent it routes to.
    labels: "bug, feature, question",
    instruction: "Classify the request into exactly one category and reply with only that word.",
    provider: "anthropic", model: "claude-sonnet-4-6",
  };
  if (type === "conditional") return {
    name: "classify",
    // one rule per line: "<test> <value> -> <label>", plus an optional "else -> <label>".
    // tests: contains <word> · regex <pattern> · longer_than <n> · shorter_than <n>.
    // each label should be the name of a downstream agent it dispatches to.
    rules: "contains urgent -> urgent\nlonger_than 280 -> detailed\nelse -> quick",
  };
  if (type === "parallel") return {
    name: "parallel",
    join: true,                 // merge worker outputs with a joiner model call
    joinPrompt: "Combine these parallel results into one coherent answer.",
    provider: "anthropic", model: "claude-sonnet-4-6",
  };
  return {};
}

/* ─────────────── graph validation ─────────────── */
// Returns a list of {level:"error"|"warn", nodeId?, msg}. Errors are things
// that will break a run; warnings are likely-unintended shapes.

// Coerce an imported object into a valid graph, backfilling config defaults so
// harnesses saved by older versions still load. Returns {graph, warnings}.
function normalizeImportedGraph(obj) {
  const warnings = [];
  if (!obj || !Array.isArray(obj.nodes) || !Array.isArray(obj.edges))
    throw new Error("Not an Ergon harness (missing nodes/edges arrays).");
  const validType = (t) => ["input", "agent", "customtool", "output", "router", "conditional", "parallel"].includes(t);
  const nodes = obj.nodes.filter((n) => n && n.id && validType(n.type)).map((n) => {
    let config = n.config || {};
    if (n.type === "agent") config = { ...defaultAgentCfg(config.name || "agent"), ...config };
    else if (n.type === "input" || n.type === "customtool") config = { ...defaultConfig(n.type), ...config };
    return { id: String(n.id), type: n.type, x: Number(n.x) || 0, y: Number(n.y) || 0, config };
  });
  if (nodes.length !== obj.nodes.length) warnings.push(`${obj.nodes.length - nodes.length} block(s) were skipped (unknown type or missing id).`);
  const ids = new Set(nodes.map((n) => n.id));
  const validPort = { flow: [["out", "in"]], tool: [["tools", "attach"]], link: [["mesh", "mesh"]], dispatch: [["routes", "in"]] };
  const edges = obj.edges.filter((e) => e && ids.has(e.from) && ids.has(e.to) && ["flow", "tool", "link", "dispatch"].includes(e.kind))
    .map((e) => ({ id: e.id || uid("e"), from: e.from, to: e.to, kind: e.kind,
                   fromPort: e.fromPort || validPort[e.kind][0][0], toPort: e.toPort || validPort[e.kind][0][1] }));
  if (edges.length !== obj.edges.length) warnings.push(`${obj.edges.length - edges.length} edge(s) were dropped (referenced a missing block).`);
  // keep the id counter ahead of imported ids so new nodes don't collide
  for (const n of nodes) { const m = /_(\d+)$/.exec(n.id); if (m) idc = Math.max(idc, Number(m[1]) + 1); }
  return { graph: { nodes, edges }, warnings };
}

function starterGraph() {
  const inp = { id: uid("n"), type: "input", x: 40, y: 240, config: defaultConfig("input") };
  const lead = { id: uid("n"), type: "agent", x: 360, y: 220, config: defaultAgentCfg("lead") };
  const critic = { id: uid("n"), type: "agent", x: 640, y: 40, config: { ...defaultAgentCfg("critic"), system: "You review answers and point out gaps in 3 bullets max.", allowInternet: false, todo: false, memory: false, maxIterations: 3 } };
  const tool = { id: uid("n"), type: "customtool", x: 364, y: 430, config: defaultConfig("customtool") };
  const out = { id: uid("n"), type: "output", x: 700, y: 260, config: {} };
  return {
    nodes: [inp, lead, critic, tool, out],
    edges: [
      { id: uid("e"), from: inp.id, fromPort: "out", to: lead.id, toPort: "in", kind: "flow" },
      { id: uid("e"), from: lead.id, fromPort: "tools", to: tool.id, toPort: "attach", kind: "tool" },
      { id: uid("e"), from: lead.id, fromPort: "mesh", to: critic.id, toPort: "mesh", kind: "link" },
      { id: uid("e"), from: lead.id, fromPort: "out", to: out.id, toPort: "in", kind: "flow" },
    ],
  };
}

/* ─────────────── starter templates (one-click example harnesses) ─────────────── */
// Small builders so templates stay terse; each returns a fresh graph (new ids).
const _n = (type, x, y, config) => ({ id: uid("n"), type, x, y, config });
const _ag = (name, x, y, extra = {}) => _n("agent", x, y, { ...defaultAgentCfg(name), ...extra });
const _e = (from, fp, to, tp, kind) => ({ id: uid("e"), from: from.id, fromPort: fp, to: to.id, toPort: tp, kind });
const _flow = (a, b) => _e(a, "out", b, "in", "flow");
const _dispatch = (a, b, port = "routes") => _e(a, port, b, "in", "dispatch");

const TEMPLATES = [
  {
    id: "single", name: "Single agent", desc: "One agent, input to output — the simplest harness.",
    build: () => {
      const inp = _n("input", 40, 200, { message: "Summarize the key trade-offs of serverless vs. containers in 5 bullets." });
      const a = _ag("assistant", 360, 190);
      const out = _n("output", 700, 210, {});
      return { nodes: [inp, a, out], edges: [_flow(inp, a), _flow(a, out)] };
    },
  },
  {
    id: "draft-critique", name: "Draft + critique", desc: "A drafter writes, a critic tightens — a two-stage chain.",
    build: () => {
      const inp = _n("input", 40, 200, { message: "Draft a short launch announcement for a new API, then tighten it." });
      const drafter = _ag("drafter", 330, 120, { system: "Write a first draft. Be complete; don't self-edit yet." });
      const critic = _ag("critic", 620, 120, { system: "Review the draft: cut fluff, fix unclear claims, return the improved version.", allowInternet: false, todo: false, memory: false, maxIterations: 3 });
      const out = _n("output", 900, 150, {});
      return { nodes: [inp, drafter, critic, out], edges: [_flow(inp, drafter), _flow(drafter, critic), _flow(critic, out)] };
    },
  },
  {
    id: "router-triage", name: "Router triage", desc: "An LLM router classifies the request and dispatches to a specialist.",
    build: () => {
      const inp = _n("input", 40, 240, { message: "The app crashes every time I upload a 20MB file." });
      const router = _n("router", 320, 240, defaultConfig("router"));
      const bug = _ag("bug", 600, 60, { system: "You triage bugs: reproduce, locate, and propose a fix." });
      const feature = _ag("feature", 600, 240, { system: "You scope feature requests into a short plan." });
      const question = _ag("question", 600, 420, { system: "You answer product questions concisely." });
      const out = _n("output", 900, 240, {});
      return {
        nodes: [inp, router, bug, feature, question, out],
        edges: [
          _flow(inp, router), _flow(router, out),
          _dispatch(router, bug), _dispatch(router, feature), _dispatch(router, question),
          _flow(bug, out), _flow(feature, out), _flow(question, out),
        ],
      };
    },
  },
  {
    id: "conditional-branch", name: "Conditional branch", desc: "Deterministic rule routing — no model call for the decision.",
    build: () => {
      const inp = _n("input", 40, 240, { message: "URGENT: production is down after the deploy." });
      const cond = _n("conditional", 320, 240, defaultConfig("conditional"));
      const urgent = _ag("urgent", 600, 80, { system: "Handle urgent incidents: triage, mitigate, escalate." });
      const detailed = _ag("detailed", 600, 250, { system: "Handle long, detailed requests thoroughly." });
      const quick = _ag("quick", 600, 420, { system: "Answer short requests quickly." });
      const out = _n("output", 900, 240, {});
      return {
        nodes: [inp, cond, urgent, detailed, quick, out],
        edges: [
          _flow(inp, cond), _flow(cond, out),
          _dispatch(cond, urgent), _dispatch(cond, detailed), _dispatch(cond, quick),
          _flow(urgent, out), _flow(detailed, out), _flow(quick, out),
        ],
      };
    },
  },
  {
    id: "parallel-join", name: "Parallel + join", desc: "Fan one task to three workers, then merge their answers.",
    build: () => {
      const inp = _n("input", 40, 240, { message: "Evaluate TypeScript for a new backend service." });
      const par = _n("parallel", 320, 240, defaultConfig("parallel"));
      const pros = _ag("pros", 600, 80, { system: "Argue the strongest case FOR. Be specific.", allowInternet: false });
      const cons = _ag("cons", 600, 250, { system: "Argue the strongest case AGAINST. Be specific.", allowInternet: false });
      const risks = _ag("risks", 600, 420, { system: "List the operational risks and unknowns.", allowInternet: false });
      const out = _n("output", 900, 240, {});
      return {
        nodes: [inp, par, pros, cons, risks, out],
        edges: [
          _flow(inp, par), _flow(par, out),
          _dispatch(par, pros, "fan"), _dispatch(par, cons, "fan"), _dispatch(par, risks, "fan"),
        ],
      };
    },
  },
  {
    id: "looping-worker", name: "Looping worker", desc: "Re-run one agent until it declares done (agent loop → run_until).",
    build: () => {
      const inp = _n("input", 40, 200, { message: "Refine a haiku about autumn until it's genuinely good, then say TASK_COMPLETE." });
      const a = _ag("poet", 360, 190, { loopEnabled: true, loopMarker: "TASK_COMPLETE", maxRounds: 4, system: "Improve the poem each round. Include TASK_COMPLETE only when you're satisfied." });
      const out = _n("output", 700, 210, {});
      return { nodes: [inp, a, out], edges: [_flow(inp, a), _flow(a, out)] };
    },
  },
];

function portPos(n) {
  return {
    in:    { x: n.x,              y: n.y + NODE_H / 2 },
    out:   { x: n.x + NODE_W,     y: n.y + NODE_H / 2 },
    tools: { x: n.x + NODE_W / 2, y: n.y + NODE_H },
    mesh:  { x: n.x + NODE_W / 2, y: n.y },
    attach:{ x: n.x + NODE_W / 2, y: n.y },
    routes:{ x: n.x + NODE_W / 2, y: n.y + NODE_H },
    fan:   { x: n.x + NODE_W / 2, y: n.y + NODE_H },
  };
}

// the cubic control points for an edge (shared by edgePath and the direction marker)
function edgeControls(a, b, kind) {
  if (kind === "flow") {
    const dx = Math.max(48, Math.abs(b.x - a.x) * 0.5);
    return [a, { x: a.x + dx, y: a.y }, { x: b.x - dx, y: b.y }, b];
  }
  const dy = Math.max(36, Math.abs(b.y - a.y) * 0.5);
  const s1 = kind === "tool" ? dy : -dy;
  return [a, { x: a.x, y: a.y + s1 }, { x: b.x, y: b.y - dy }, b];
}
function edgePath(a, b, kind) {
  const [p0, p1, p2, p3] = edgeControls(a, b, kind);
  return `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`;
}
// midpoint of an edge + its local tangent angle (for a direction arrowhead that
// sits on the line, clear of the port dots)
function edgeMid(a, b, kind) {
  const [p0, p1, p2, p3] = edgeControls(a, b, kind);
  const t = 0.5, m = 1 - t;
  const x = m * m * m * p0.x + 3 * m * m * t * p1.x + 3 * m * t * t * p2.x + t * t * t * p3.x;
  const y = m * m * m * p0.y + 3 * m * m * t * p1.y + 3 * m * t * t * p2.y + t * t * t * p3.y;
  const dx = 3 * m * m * (p1.x - p0.x) + 6 * m * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x);
  const dy = 3 * m * m * (p1.y - p0.y) + 6 * m * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y);
  return { x, y, angle: Math.atan2(dy, dx) * 180 / Math.PI };
}

/* ─────────────── run engine (live in-browser preview) ─────────────── */

const estTokens = (msgs) => Math.ceil(JSON.stringify(msgs).length / 4);

// compact snapshot of a message list for the compaction diff panel
function trimForDiff(messages, perMsg = 400) {
  return messages.map((m) => ({
    role: m.role || "?",
    preview: (Array.isArray(m.content) ? JSON.stringify(m.content) : String(m.content ?? "")).slice(0, perMsg),
  }));
}

/* ── transport (environment-specific: app build posts to the proxy) ── */
const IN_CLAUDE_ARTIFACT = false;
async function postModel(provider, payload, providerPrefix = null) {
  const res = await fetch("/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, payload, providerPrefix }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`API error ${res.status} — proxy running? keys set? ${detail.slice(0, 200)}`);
  }
  return res.json();
}
/* ── end transport ── */

/* ── provider catalog + live model lists (standalone app; proxy-backed) ── */
// Offline / artifact fallback so the picker always works even with no proxy.
const FALLBACK_PROVIDERS = [
  { prefix: "anthropic", label: "Anthropic", kind: "anthropic", baseUrl: "", configured: true, hostedSearch: true },
  { prefix: "openai", label: "OpenAI-compatible", kind: "openai", baseUrl: "", configured: true },
  { prefix: "ollama", label: "Ollama (local)", kind: "openai", baseUrl: "http://localhost:11434/v1", local: true, configured: true },
  { prefix: "gemini", label: "Google Gemini", kind: "gemini", baseUrl: "", configured: true, hostedSearch: true },
];
// Bedrock can't be proxied (SigV4) — kept as a picker option that previews via Claude.
const BEDROCK_OPTION = { prefix: "bedrock", label: "AWS Bedrock (preview via Claude)", kind: "bedrock", baseUrl: "", configured: true, noModelList: true };

async function fetchProviderCatalog() {
  if (IN_CLAUDE_ARTIFACT) return [...FALLBACK_PROVIDERS, BEDROCK_OPTION];
  try {
    const res = await fetch("/api/providers");
    if (!res.ok) throw new Error();
    const { providers } = await res.json();
    return [...providers, BEDROCK_OPTION];
  } catch { return [...FALLBACK_PROVIDERS, BEDROCK_OPTION]; }
}

async function fetchModels(prefix) {
  const res = await fetch(`/api/models?provider=${encodeURIComponent(prefix)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
  return body.models || [];
}

/* ── provider adapters: neutral messages <-> wire formats ──
   neutral: {role:"user",content} | {role:"assistant",content,tool_calls:[{id,name,input}],_raw?}
          | {role:"tool",tool_call_id,name,content}                                            */

function toAnthropic(cfg, system, neutral, toolDefs, useHostedSearch) {
  const wire = [];
  for (const m of neutral) {
    if (m.role === "user") wire.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      if (m._raw) { wire.push({ role: "assistant", content: m._raw }); continue; }
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls || []) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      wire.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
    } else if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content) };
      const last = wire[wire.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") last.content.push(block);
      else wire.push({ role: "user", content: [block] });
    }
  }
  const tools = toolDefs.map((t) => ({ ...t }));
  if (useHostedSearch) tools.push({ type: "web_search_20250305", name: "web_search" });
  return {
    model: cfg.model || "claude-sonnet-4-6", max_tokens: 1200,
    ...(system ? { system } : {}), messages: wire, ...(tools.length ? { tools } : {}),
  };
}
function parseAnthropic(data) {
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const toolCalls = data.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
  const usage = { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 };
  return { text, toolCalls, stop: data.stop_reason === "tool_use" ? "tool_use" : "end", raw: data.content, usage };
}

function toOpenAI(cfg, system, neutral, toolDefs) {
  const wire = system ? [{ role: "system", content: system }] : [];
  for (const m of neutral) {
    if (m.role === "user") wire.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const out = { role: "assistant", content: m.content || null };
      if (m.tool_calls?.length) out.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      }));
      wire.push(out);
    } else if (m.role === "tool") wire.push({ role: "tool", tool_call_id: m.tool_call_id, content: String(m.content) });
  }
  return {
    model: cfg.model || "gpt-4o", max_tokens: 1200, messages: wire,
    ...(toolDefs.length ? { tools: toolDefs.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
  };
}
function parseOpenAI(data) {
  const msg = data.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => {
    let input; try { input = JSON.parse(tc.function.arguments || "{}"); } catch { input = { input: tc.function.arguments }; }
    return { id: tc.id, name: tc.function.name, input };
  });
  const usage = { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 };
  return { text: (msg.content || "").trim(), toolCalls, stop: data.choices?.[0]?.finish_reason === "tool_calls" ? "tool_use" : "end", raw: null, usage };
}

function toGemini(cfg, system, neutral, toolDefs, hostedSearch) {
  const contents = [];
  for (const m of neutral) {
    if (m.role === "user") contents.push({ role: "user", parts: [{ text: m.content }] });
    else if (m.role === "assistant") {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls || []) parts.push({ functionCall: { name: tc.name, args: tc.input } });
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
    } else if (m.role === "tool") {
      const part = { functionResponse: { name: m.name || "tool", response: { result: String(m.content) } } };
      const last = contents[contents.length - 1];
      if (last?.role === "user" && last.parts[0]?.functionResponse) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
    }
  }
  const gtools = [];
  if (toolDefs.length) gtools.push({ functionDeclarations: toolDefs.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })) });
  if (hostedSearch) gtools.push({ google_search: {} });   // some models restrict mixing with functions
  return {
    model: cfg.model || "gemini-2.0-flash",
    body: {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { maxOutputTokens: 1200 },
      ...(gtools.length ? { tools: gtools } : {}),
    },
  };
}
function parseGemini(data) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => p.text).map((p) => p.text).join("").trim();
  const toolCalls = parts.filter((p) => p.functionCall).map((p, i) => ({ id: `gem_${i}`, name: p.functionCall.name, input: p.functionCall.args || {} }));
  const um = data.usageMetadata || {};
  const usage = { input: um.promptTokenCount || 0, output: um.candidatesTokenCount || 0 };
  return { text, toolCalls, stop: toolCalls.length ? "tool_use" : "end", raw: null, usage };
}

const HOSTED_SEARCH_PROVIDERS = ["anthropic", "gemini"];
const PREVIEWABLE_PROVIDERS = ["anthropic", "openai", "ollama", "gemini"];   // bedrock needs AWS SigV4 → SDK/codegen only

/* ── token meter: USD per 1M tokens (input, output); estimates, editable ── */
const PRICES = [
  ["claude-opus-4", [15, 75]], ["claude-sonnet-4", [3, 15]], ["claude-3-5-sonnet", [3, 15]],
  ["claude-3-5-haiku", [0.8, 4]], ["claude-3-opus", [15, 75]], ["claude-3-haiku", [0.25, 1.25]], ["claude", [3, 15]],
  ["gpt-4o-mini", [0.15, 0.6]], ["gpt-4o", [2.5, 10]], ["gpt-4.1", [2, 8]], ["o3", [2, 8]], ["gpt-4", [30, 60]], ["gpt-3.5", [0.5, 1.5]],
  ["gemini-2.0-flash", [0.1, 0.4]], ["gemini-1.5-pro", [1.25, 5]], ["gemini-1.5-flash", [0.075, 0.3]], ["gemini", [0.1, 0.4]],
  ["anthropic.claude-3-5-sonnet", [3, 15]], ["anthropic.claude-3-haiku", [0.25, 1.25]],
  ["meta.llama", [0.65, 0.65]], ["mistral", [0.7, 0.7]], ["amazon.nova-pro", [0.8, 3.2]], ["amazon.nova-lite", [0.06, 0.24]],
];
function priceFor(model) {
  const m = (model || "").toLowerCase();
  let best = null, bestLen = -1;
  for (const [key, val] of PRICES) if (m.includes(key) && key.length > bestLen) { best = val; bestLen = key.length; }
  return best;
}
function costOf(model, inTok, outTok) {
  const p = priceFor(model);
  return p ? inTok / 1e6 * p[0] + outTok / 1e6 * p[1] : 0;
}
const fmtCost = (c) => c >= 0.01 ? `$${c.toFixed(2)}` : c > 0 ? `$${c.toFixed(4)}` : "$0";
const fmtTok = (t) => t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);

// One call surface for the engine. Hosted search: Anthropic + Gemini.
async function callModel(cfg, { system, messages, toolDefs = [], hostedSearch = false }, log) {
  let provider = cfg.provider || "anthropic";
  const fallback = IN_CLAUDE_ARTIFACT
    ? provider !== "anthropic" && `Preview inside Claude runs on Claude — '${provider}/${cfg.model}' applies to the exported Python and the standalone app.`
    : !PREVIEWABLE_PROVIDERS.includes(provider) && `'${provider}' needs AWS request signing, so the preview falls back to Claude — the exported Python runs it natively via boto3.`;
  if (fallback) {
    log?.("info", fallback);
    provider = "anthropic";
    cfg = { ...cfg, model: "claude-sonnet-4-6" };            // don't send a foreign model string
    hostedSearch = hostedSearch && true;
  }
  if (!IN_CLAUDE_ARTIFACT && provider === "ollama") {
    log?.("info", `Ollama preview routes through the dev proxy to ${cfg.baseUrl || "http://localhost:11434/v1"} — make sure 'ollama serve' is running and the model is pulled.`);
  }
  const billedModel = cfg.model || (provider === "openai" ? "gpt-4o" : provider === "ollama" ? "llama3.1" : provider === "gemini" ? "gemini-2.0-flash" : "claude-sonnet-4-6");
  // the chosen provider prefix (nvidia/groq/…) routes the proxy to the right
  // base_url + saved key; cleared when we fell back to Claude for the preview.
  const prefix = fallback ? null : (cfg.providerId || null);
  let r, data;
  const net0 = performance.now();
  if (provider === "anthropic") data = await postModel("anthropic", toAnthropic(cfg, system, messages, toolDefs, hostedSearch), prefix);
  else if (provider === "gemini") data = await postModel("gemini", toGemini(cfg, system, messages, toolDefs, hostedSearch), prefix);
  else data = await postModel("openai", toOpenAI(cfg, system, messages, toolDefs), prefix);
  const networkMs = Math.round(performance.now() - net0);
  if (provider === "anthropic") r = parseAnthropic(data);
  else if (provider === "gemini") r = parseGemini(data);
  else r = parseOpenAI(data);
  r.billedModel = billedModel;
  r.local = (cfg.provider === "ollama");   // local models are free — meter shouldn't bill them
  r.networkMs = networkMs;
  return r;
}

async function callHttpTool(cfg, input, log) {
  const url = (cfg.url || "").trim();
  if (!url) return "[http tool error] no endpoint URL configured";
  const method = cfg.httpMethod === "GET" ? "GET" : "POST";
  const headers = {};
  for (const line of (cfg.headers || "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  try {
    // Route through the dev proxy to sidestep browser CORS; in the artifact build
    // (no proxy) this endpoint won't exist, so fall back to a direct call.
    const viaProxy = !IN_CLAUDE_ARTIFACT;
    const target = viaProxy ? "/api/tool-fetch" : url;
    const res = viaProxy
      ? await fetch(target, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, method, headers, input }) })
      : await fetch(method === "GET" ? `${url}${url.includes("?") ? "&" : "?"}input=${encodeURIComponent(input)}` : url,
          { method, headers: { "Content-Type": "application/json", ...headers },
            body: method === "POST" ? JSON.stringify({ input }) : undefined });
    const text = await res.text();
    if (!res.ok) { log?.("info", `HTTP tool ${url} → ${res.status}`); return `[http ${res.status}] ${text.slice(0, 500)}`; }
    return text.slice(0, 4000);
  } catch (e) {
    return `[http tool error] ${e.message}`;
  }
}

async function simulateTool(cfg, name, description, input) {
  const r = await callModel(cfg, { system: null, messages: [{ role: "user", content: `You are simulating a software tool named "${name}" (${description}). It was invoked with input:\n${input}\nRespond ONLY with the tool's plausible raw output. No preamble.` }] });
  return r.text;
}

async function compact(cfg, messages, log) {
  const keep = 6;
  if (messages.length <= keep + 1) return messages;
  let cut = messages.length - keep;
  while (cut > 0 && messages[cut].role === "tool") cut--;   // never orphan tool results
  const head = messages.slice(0, cut), tail = messages.slice(cut);
  if (!head.length) return messages;
  log("compact", `Compacting context: summarizing ${head.length} older messages…`);
  let summary;
  try {
    const r = await callModel(cfg, { system: null, messages: [{ role: "user", content: "Summarize this agent conversation — decisions, facts, key tool results, what remains. Dense and factual:\n\n" + JSON.stringify(head).slice(0, 300000) }] });
    summary = r.text;
  } catch (e) { summary = `(summary unavailable: ${e.message})`; }
  return [
    { role: "user", content: `[Context was compacted. Summary of earlier turns:]\n${summary}` },
    { role: "assistant", content: "Understood — continuing from that summary.", tool_calls: [] },
    ...tail,
  ];
}

// old sessions stored Anthropic content blocks; normalize them to neutral on resume
function normalizeLoaded(messages) {
  if (!messages.some((m) => Array.isArray(m.content))) return messages;
  const out = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) { out.push(m); continue; }
    if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
        tool_calls: m.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input || {} })),
        _raw: m.content,
      });
    } else {
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, name: "", content: String(b.content) });
      }
    }
  }
  return out;
}

const MODE_PREAMBLE = (cfg) =>
  cfg.mode === "plan"
    ? "You are in PLAN mode. Investigate with read-only tools, write a step-by-step plan via todo_write, and present it. Do NOT write files or take mutating actions."
    : cfg.mode === "execute"
    ? "You are in EXECUTE mode. Keep the todo list current (in_progress → done) and work through the plan step by step."
    : `You are in ${(cfg.customMode || "CUSTOM").toUpperCase()} mode.`;

const SAFE_TOOL = /^(read_|list_|todo_read|memory_read|ask_)/;

// ctx: { nodes, edges, log, markEdge, persist(msgs, meta), addStandingRule, state:{todo, files, memory}, refreshPanels }
async function runAgentNode(node, userMessage, ctx, depth = 0, initialMessages = null) {
  const cfg = node.config;
  const label = cfg.name || "agent";

  /* build the tool belt */
  const tools = []; // {def, exec, safe, simulated}
  const push = (def, exec, safe = false, simulated = false) => tools.push({ def, exec, safe, simulated });
  const strSchema = (desc) => ({ type: "object", properties: { input: { type: "string", description: desc } }, required: ["input"] });

  if (cfg.todo) {
    push({ name: "todo_read", description: "Read the current todo list.", input_schema: { type: "object", properties: {} } },
      async () => ctx.state.todo.length ? ctx.state.todo.map((t, i) => `[${t.status}] ${i + 1}. ${t.text}`).join("\n") : "(todo list is empty)", true);
    push({ name: "todo_write", description: 'Replace the todo list. input: JSON array of {"text","status":"pending"|"in_progress"|"done"}.', input_schema: strSchema("JSON array") },
      async ({ input }) => { ctx.state.todo = JSON.parse(input); ctx.refreshPanels(); return `todo saved: ${ctx.state.todo.length} items`; }, true);
  }
  if (cfg.memory) {
    push({ name: "memory_save", description: "Save a named note to session memory.", input_schema: { type: "object", properties: { key: { type: "string" }, content: { type: "string" } }, required: ["key", "content"] } },
      async ({ key, content }) => { ctx.state.memory[key] = content; ctx.refreshPanels(); return `saved note '${key}'`; });
    push({ name: "memory_read", description: "Read a note by key, or list keys with key='*'.", input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
      async ({ key }) => key === "*" ? (Object.keys(ctx.state.memory).join("\n") || "(no notes)") : (ctx.state.memory[key] ?? `(no note '${key}')`), true);
  }
  if (cfg.files) {
    push({ name: "write_file", description: `Write a text file in the working directory (${cfg.workingDir}).`, input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      async ({ path, content }) => { if (path.includes("..")) throw new Error("path escapes working directory"); ctx.state.files[path] = content; ctx.refreshPanels(); return `wrote ${content.length} chars to ${path}`; });
    push({ name: "read_file", description: "Read a text file from the working directory.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      async ({ path }) => ctx.state.files[path] ?? `(no file '${path}')`, true);
    push({ name: "list_files", description: "List files in the working directory.", input_schema: { type: "object", properties: {} } },
      async () => Object.keys(ctx.state.files).join("\n") || "(empty)", true);
  }
  // browser control: drive a real headless Chromium via the proxy (/api/browser)
  if (cfg.browser && !IN_CLAUDE_ARTIFACT) {
    const sid = ctx.runId || "preview";
    const call = async (action, extra) => {
      try {
        const r = await fetch("/api/browser", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: sid, action, ...extra }) });
        const d = await r.json();
        return d.error ? `[browser unavailable] ${d.error}` : d.result;
      } catch (e) { return `[browser error] ${e.message}`; }
    };
    push({ name: "browser_navigate", description: "Navigate the browser to a URL.", input_schema: strSchema("url") },
      async ({ url }) => call("navigate", { url }), true);
    push({ name: "browser_read", description: "Read the visible text of the current page.", input_schema: { type: "object", properties: {} } },
      async () => call("read", {}), true);
    push({ name: "browser_find", description: "Find clickable elements/inputs matching a text query.", input_schema: strSchema("query") },
      async ({ query }) => call("find", { text: query }), true);
    // act tools — NOT safe → approval-gated (allow-listed only if browserActs)
    const browserActsAllowed = !!cfg.browserActs;
    push({ name: "browser_click", description: "Click an element by CSS selector. (acts on the page)", input_schema: strSchema("selector") },
      async ({ selector }) => call("click", { selector }), false);
    push({ name: "browser_type", description: "Type text into an input by CSS selector. (acts on the page)", input_schema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" } }, required: ["selector", "text"] } },
      async ({ selector, text }) => call("type", { selector, text }), false);
    push({ name: "browser_submit", description: "Submit a form by CSS selector. (acts on the page)", input_schema: strSchema("selector") },
      async ({ selector }) => call("submit", { selector }), false);
    if (browserActsAllowed) ctx.state.browserAllow = ["browser_click", "browser_type", "browser_submit"];
  }
  // attached custom tools
  const toolIds = ctx.edges.filter((e) => e.kind === "tool" && e.from === node.id).map((e) => e.to);
  for (const t of ctx.nodes.filter((n) => toolIds.includes(n.id))) {
    const name = (t.config.name || "tool").replace(/[^a-zA-Z0-9_]/g, "_");
    push({ name, description: t.config.description || "Custom tool.", input_schema: strSchema("tool input") },
      async ({ input }) => {
        ctx.markEdge(node.id, t.id);
        if (t.config.mode === "javascript") return String(await new Function("input", t.config.js || "return ''")(input));
        if (t.config.mode === "http") return await callHttpTool(t.config, input, ctx.log);
        return simulateTool(cfg, name, t.config.description, input);
      }, false, t.config.mode !== "javascript" && t.config.mode !== "http");   // simulated unless it's JS or HTTP
  }
  // peer agents (agent-to-agent links, directed from → to)
  const peerIds = ctx.edges.filter((e) => e.kind === "link" && e.from === node.id).map((e) => e.to);
  for (const p of ctx.nodes.filter((n) => n.type === "agent" && peerIds.includes(n.id))) {
    push({ name: `ask_${(p.config.name || "peer").replace(/\W/g, "_")}`, description: `Ask agent '${p.config.name}' (${(p.config.system || "").slice(0, 120)}) to handle a task.`, input_schema: strSchema("the task") },
      async ({ input }) => {
        if (depth >= 2) return "(peer depth limit reached)";
        ctx.markEdge(node.id, p.id);
        ctx.log("link", `${label} → asking ${p.config.name}…`);
        ctx.markNode?.(p.id, "running");
        let r;
        try { r = await runAgentNode(p, input, ctx, depth + 1); ctx.markNode?.(p.id, "done"); }
        catch (err) { ctx.markNode?.(p.id, "error"); throw err; }
        ctx.log("link", `${p.config.name} answered ${label}.`);
        return r;
      }, true);
  }

  const toolDefs = tools.map((t) => t.def);
  const hostedSearch = cfg.allowInternet && HOSTED_SEARCH_PROVIDERS.includes(cfg.provider || "anthropic");
  if (!cfg.allowInternet) ctx.log("info", `${label}: internet kill switch is OFF — web search removed.`);
  else if (!hostedSearch)
    ctx.log("info", `${label}: '${cfg.provider}' has no hosted web search — attach a custom search tool (SDK: search_tool=web_search_tool(fn)).`);

  const allowList = new Set((cfg.alwaysAllow || "").split(",").map((s) => s.trim()).filter(Boolean));
  if (cfg.browser && cfg.browserActs) ["browser_click", "browser_type", "browser_submit"].forEach((n) => allowList.add(n));
  const approve = (name, input) => {
    if (allowList.has(name)) return true;                      // standing rule
    const t = tools.find((x) => x.def.name === name);
    if (cfg.mode === "plan" && t && !(t.safe || SAFE_TOOL.test(name)))
      return { deny: `blocked: plan mode is read-only` };
    if (t && (t.safe || SAFE_TOOL.test(name))) return true;    // heuristic
    if (cfg.approvalMode === "interactive") {
      const ans = (window.prompt(
        `[${label}] approve tool call?\n\n${name}(${JSON.stringify(input).slice(0, 300)})\n\ny = allow once · a = always allow · n = deny`, "y"
      ) || "").trim().toLowerCase();
      if (ans === "a") {                                       // → standing rule, like the SDK's y/n/a
        allowList.add(name);
        ctx.addStandingRule?.(node.id, name);
        ctx.log("info", `Standing rule added: always allow '${name}' for ${label}.`);
        return true;
      }
      return ans === "y" ? true : { deny: "user denied" };
    }
    return { deny: "requires approval (unattended mode, no standing rule)" };
  };

  const system = [cfg.system, MODE_PREAMBLE(cfg)].filter(Boolean).join("\n\n");
  let messages = initialMessages
    ? [...normalizeLoaded(initialMessages), { role: "user", content: userMessage }]
    : [{ role: "user", content: userMessage }];
  const maxIt = Math.min(Number(cfg.maxIterations) || 6, 12);
  let final = "";

  for (let i = 0; i < maxIt; i++) {
    if (cfg.compaction && estTokens(messages) > Number(cfg.tokenBudget || 30000)) {
      const before = messages;
      const beforeTok = estTokens(before);
      const ct0 = performance.now();
      messages = await compact(cfg, messages, ctx.log);
      ctx.event?.({
        kind: "compaction", agent: label, ms: Math.round(performance.now() - ct0),
        beforeMsgs: before.length, afterMsgs: messages.length,
        beforeTokens: beforeTok, afterTokens: estTokens(messages),
        diff: { before: trimForDiff(before), after: trimForDiff(messages) },
      });
    }
    ctx.log("agent", `${label} · turn ${i + 1}/${maxIt} · ${cfg.provider}/${cfg.model || "default"} · mode:${cfg.mode} · ~${estTokens(messages)} tok`);
    const mt0 = performance.now();
    const r = await callModel(cfg, { system, messages, toolDefs, hostedSearch }, i === 0 ? ctx.log : null);
    const mms = Math.round(performance.now() - mt0);
    const budgetHit = ctx.meter?.(r.billedModel, r.usage, label, r.local);     // token/cost accounting (returns a reason if over budget)
    messages.push({ role: "assistant", content: r.text, tool_calls: r.toolCalls, ...(r.raw ? { _raw: r.raw } : {}) });
    const assistantIdx = messages.length - 1;
    ctx.event?.({
      kind: "model_call", agent: label, iteration: i, ms: mms, networkMs: r.networkMs, model: r.billedModel,
      inTok: r.usage?.input || 0, outTok: r.usage?.output || 0, stop: r.stop,
      nToolCalls: r.toolCalls.length, msgIndex: assistantIdx,
    });
    await ctx.persist(messages, { agent: label, iteration: i });      // ← after every model call
    final = r.text || final;

    if (budgetHit) {
      ctx.log("error", `⛔ Spend budget reached (${budgetHit}) — stopping run.`);
      ctx.event?.({ kind: "budget_exceeded", agent: label, iteration: i, detail: budgetHit });
      return final || "(stopped: over budget)";
    }

    if (r.stop !== "tool_use" || !r.toolCalls.length) return final || "(no text)";

    for (const tc of r.toolCalls) {
      ctx.log("tool", `→ ${tc.name}(${JSON.stringify(tc.input).slice(0, 140)})`);
      let out, denied = false;
      const tt0 = performance.now();
      const ok = approve(tc.name, tc.input);
      let simulated = false;
      if (ok !== true) { out = `DENIED: ${ok.deny}`; denied = true; ctx.log("error", `✕ ${tc.name} ${ok.deny}`); }
      else {
        const t = tools.find((x) => x.def.name === tc.name);
        simulated = !!(t && t.simulated);
        try { out = t ? String(await t.exec(tc.input)) : "(handled server-side)"; }
        catch (e) { out = `tool error: ${e.message}`; }
        ctx.log("result", `←${simulated ? " ⚠ simulated" : ""} ${out.slice(0, 180)}`);
      }
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: out.slice(0, 6000) });
      ctx.event?.({
        kind: "tool_call", agent: label, iteration: i, tool: tc.name, ms: Math.round(performance.now() - tt0),
        denied, simulated, input: tc.input, output: out.slice(0, 300), msgIndex: messages.length - 1,
      });
    }
    await ctx.persist(messages, { agent: label, iteration: i });
  }
  ctx.log("info", `${label} hit its iteration limit (${maxIt}).`);
  return final || "(iteration limit reached)";
}

/* ─────────────── Python code generation ─────────────── */



/* ─────────────── UI atoms ─────────────── */

const MONO = "'IBM Plex Mono', monospace";
const SANS = "'Space Grotesk', sans-serif";

const Field = ({ label, children, sdkOnly }) => (
  <label style={{ display: "block", marginBottom: 13 }}>
    <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", color: C.mut, marginBottom: 5, display: "flex", gap: 6, alignItems: "center" }}>
      {label}
      {sdkOnly && <span style={{ background: C.accentSoft, color: C.link, borderRadius: 3, padding: "1px 5px", fontSize: 9, letterSpacing: 0.5 }}>SDK ONLY</span>}
    </div>
    {children}
  </label>
);

let inputStyle = { width: "100%", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, padding: "8px 10px", fontSize: 13, fontFamily: SANS };
let monoInput = { ...inputStyle, fontFamily: MONO, fontSize: 12 };
function applyTheme(t) {   // reassign module bindings so all consumers (incl. helper components) track the theme
  C = THEMES[t] || THEMES.dark;
  inputStyle = { width: "100%", background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, padding: "8px 10px", fontSize: 13, fontFamily: SANS };
  monoInput = { ...inputStyle, fontFamily: MONO, fontSize: 12 };
}

const Toggle = ({ label, value, onChange, hint, sdkOnly }) => (
  <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 11 }}>
    <button role="switch" aria-checked={value} onClick={() => onChange(!value)}
      style={{ width: 34, height: 19, borderRadius: 10, border: `1px solid ${value ? C.run : C.border}`, background: value ? "rgba(135,217,108,.25)" : C.bg, position: "relative", cursor: "pointer", flexShrink: 0, marginTop: 1 }}>
      <span style={{ position: "absolute", top: 2, left: value ? 16 : 2, width: 13, height: 13, borderRadius: "50%", background: value ? C.run : C.faint, transition: "left .15s" }} />
    </button>
    <div>
      <div style={{ fontSize: 12.5, fontWeight: 600, display: "flex", gap: 6, alignItems: "center" }}>
        {label}
        {sdkOnly && <span style={{ background: C.accentSoft, color: C.link, borderRadius: 3, padding: "1px 5px", fontSize: 9, fontFamily: MONO }}>SDK ONLY</span>}
      </div>
      {hint && <div style={{ fontSize: 11, color: C.faint, lineHeight: 1.35 }}>{hint}</div>}
    </div>
  </div>
);

function Port({ x, y, color, onDown, onUp, title, highlight, dim }) {
  const r = highlight ? 9 : 7;
  return (
    <div title={title} onPointerDown={onDown} onPointerUp={onUp}
      style={{ position: "absolute", left: x - r, top: y - r, width: r * 2, height: r * 2, borderRadius: "50%",
        background: highlight ? color : C.panel, border: `2.5px solid ${color}`, cursor: "crosshair",
        zIndex: highlight ? 7 : 5, opacity: dim ? 0.2 : 1,
        boxShadow: highlight ? `0 0 0 3px ${color}44` : "none",
        transition: "opacity .12s ease, box-shadow .12s ease", pointerEvents: dim ? "none" : "auto" }} />
  );
}

/* ─────────────── node-type icons (inline SVG, inherit the accent color) ─────────────── */
const NODE_ICON_PATHS = {
  input:       (c) => <path d="M8 5v14l11-7z" fill={c} stroke="none" />,
  agent:       (c) => <><path d="M12 3l9 9-9 9-9-9z" /><circle cx="12" cy="12" r="2.3" fill={c} stroke="none" /></>,
  customtool:  (c) => <><path d="M12 2.5l8.3 4.8v9.4L12 21.5 3.7 16.7V7.3z" /><circle cx="12" cy="12" r="3" /></>,
  router:      (c) => <><circle cx="5" cy="12" r="1.6" fill={c} stroke="none" /><circle cx="19" cy="5" r="1.6" fill={c} stroke="none" /><circle cx="19" cy="12" r="1.6" fill={c} stroke="none" /><circle cx="19" cy="19" r="1.6" fill={c} stroke="none" /><path d="M6.6 12 17.4 5M6.6 12H17.4M6.6 12 17.4 19" /></>,
  conditional: (c) => <><circle cx="6" cy="5" r="1.8" fill={c} stroke="none" /><circle cx="6" cy="19" r="1.8" fill={c} stroke="none" /><circle cx="18" cy="12" r="1.8" fill={c} stroke="none" /><path d="M6 6.8v10.4M6 12h10.2" /></>,
  parallel:    (c) => <><path d="M4 7h6M4 12h6M4 17h6" /><path d="M10 7c4.5 0 4.5 5 8 5M10 17c4.5 0 4.5-5 8-5M10 12h8" /></>,
  output:      (c) => <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.6" fill={c} stroke="none" /></>,
};
const NodeIcon = ({ type, size = 16, color = "currentColor" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} aria-hidden="true" focusable="false"
    strokeLinecap="round" strokeLinejoin="round" style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}>
    {(NODE_ICON_PATHS[type] || NODE_ICON_PATHS.agent)(color)}
  </svg>
);

/* ─────────────── provider marks (original monogram badges, not official logos) ─────────────── */
// fg chosen per brand for WCAG-AA contrast of the monogram (ink or white, ≥4.5:1)
const PROVIDERS = {
  anthropic: { label: "Anthropic",          mark: "A",  color: "#CC785C", fg: "#14181F" },
  openai:    { label: "OpenAI-compatible",  mark: "O",  color: "#10A37F", fg: "#14181F" },
  gemini:    { label: "Gemini",             mark: "G",  color: "#1A73E8", fg: "#FFFFFF" },
  ollama:    { label: "Ollama",             mark: "OL", color: "#64748B", fg: "#FFFFFF" },
  bedrock:   { label: "Bedrock",            mark: "B",  color: "#FF9900", fg: "#14181F" },
};
const provModelShort = (cfg) => (cfg?.model || "").split(/[-.]/).slice(0, 2).join("-") || "default";
const ProviderMark = ({ provider, size = 13 }) => {
  const p = PROVIDERS[provider] || PROVIDERS.anthropic;
  return (
    <span title={p.label} aria-label={`${p.label} provider`} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: size, height: size, padding: "0 2px", borderRadius: 3.5, background: p.color, color: p.fg,
      fontSize: Math.round(size * (p.mark.length > 1 ? 0.5 : 0.62)), fontWeight: 800, fontFamily: MONO, lineHeight: 1, flexShrink: 0 }}>{p.mark}</span>
  );
};

/* ─────────────── main app ─────────────── */

/* ── auth modal ── */
function AuthModal({ onClose, onAuthed }) {
  const [mode, setMode] = React.useState("login");   // 'login' | 'signup'
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const [sso, setSso] = React.useState(false);
  React.useEffect(() => { auth.providers?.().then((p) => setSso(!!p.sso)).catch(() => {}); }, []);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const u = mode === "signup" ? await auth.signup(email, password) : await auth.login(email, password);
      onAuthed(u);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.7)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
      <div className="ergon-modal" onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(380px, 94vw)", padding: 22 }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{mode === "signup" ? "Create an account" : "Sign in"}</div>
        <div style={{ color: C.faint, fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>Save harnesses and run-sessions on the server, and share them with teammates by email.</div>
        <Field label="Email"><input type="email" style={inputStyle} value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} /></Field>
        <Field label="Password (min 8 chars)"><input type="password" style={inputStyle} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} /></Field>
        {err && <div style={{ color: C.output, fontSize: 12, marginBottom: 10 }}>{err}</div>}
        <button onClick={submit} disabled={busy} style={{ width: "100%", background: C.run, border: "none", color: C.onAccent, borderRadius: 6, padding: "9px", fontSize: 13, fontWeight: 700, cursor: busy ? "default" : "pointer", marginBottom: 10 }}>
          {busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}
        </button>
        {sso && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 10px", color: C.faint, fontSize: 11 }}>
              <span style={{ flex: 1, height: 1, background: C.borderSoft }} /> or <span style={{ flex: 1, height: 1, background: C.borderSoft }} />
            </div>
            <button onClick={() => auth.ssoLogin()} style={{ width: "100%", background: "transparent", border: `1px solid ${C.border}`, color: C.text, borderRadius: 6, padding: "9px", fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 10 }}>
              Sign in with SSO
            </button>
          </>
        )}
        <div style={{ textAlign: "center", fontSize: 12, color: C.mut }}>
          {mode === "signup" ? "Already have an account? " : "New here? "}
          <button onClick={() => { setMode(mode === "signup" ? "login" : "signup"); setErr(null); }} style={{ background: "transparent", border: "none", color: C.link, cursor: "pointer", fontSize: 12 }}>
            {mode === "signup" ? "Sign in" : "Create an account"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── provider keys modal: paste / test / save keys without a terminal ── */
function KeysModal({ catalog, onClose, onChanged }) {
  const [status, setStatus] = React.useState({});   // prefix -> {saved,last4,baseUrl}
  const [draft, setDraft] = React.useState({});      // prefix -> {apiKey?, baseUrl?}
  const [msg, setMsg] = React.useState({});          // prefix -> string
  const [busy, setBusy] = React.useState(null);
  const refresh = React.useCallback(async () => {
    try { const r = await fetch("/api/provider/settings"); const { settings } = await r.json(); setStatus(settings || {}); } catch {}
  }, []);
  React.useEffect(() => { refresh(); }, [refresh]);
  const rows = catalog.filter((p) => !p.local && p.prefix !== "bedrock");   // keys only for remote, proxyable providers
  const setField = (prefix, k, v) => setDraft((d) => ({ ...d, [prefix]: { ...d[prefix], [k]: v } }));
  const call = async (prefix, fn, pending) => {
    setBusy(prefix); setMsg((m) => ({ ...m, [prefix]: pending }));
    try { await fn(); } catch (e) { setMsg((m) => ({ ...m, [prefix]: String(e.message || e) })); } finally { setBusy(null); }
  };
  const save = (prefix) => call(prefix, async () => {
    const r = await fetch("/api/provider/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: prefix, ...(draft[prefix] || {}) }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "save failed");
    setDraft((d) => ({ ...d, [prefix]: {} })); await refresh(); onChanged?.(); setMsg((m) => ({ ...m, [prefix]: "saved ✓" }));
  }, "saving…");
  const test = (prefix) => call(prefix, async () => {
    const r = await fetch("/api/provider/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: prefix }) });
    const j = await r.json();
    setMsg((m) => ({ ...m, [prefix]: j.ok ? `✓ reachable${j.modelCount ? ` · ${j.modelCount} models` : ""}` : `✗ ${j.detail || "failed"}` }));
  }, "testing…");
  const clear = (prefix) => call(prefix, async () => {
    await fetch("/api/provider/settings", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: prefix }) });
    await refresh(); onChanged?.(); setMsg((m) => ({ ...m, [prefix]: "cleared" }));
  }, "…");
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.7)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
      <div className="ergon-modal" onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(560px, 95vw)", maxHeight: "86vh", overflowY: "auto", padding: 22 }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Provider keys</div>
        <div style={{ color: C.faint, fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>
          Paste a key, hit <b style={{ color: C.mut }}>Test</b>, then <b style={{ color: C.mut }}>Save</b>. Keys are stored encrypted on the proxy and take precedence over environment variables — no restart needed. Saved keys never leave the server.
        </div>
        {rows.map((p) => {
          const st = status[p.prefix] || {};
          const src = st.saved ? `saved · ••••${st.last4 || ""}` : (p.configured ? `from ${p.keySource || "env"}` : "not set");
          const d = draft[p.prefix] || {};
          return (
            <div key={p.prefix} style={{ borderBottom: `1px solid ${C.borderSoft}`, padding: "10px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{p.label} <span style={{ color: C.faint, fontWeight: 400, fontFamily: MONO, fontSize: 11 }}>{p.prefix}</span></span>
                <span style={{ fontSize: 11, color: p.configured ? C.run : C.faint, fontFamily: MONO }}>{p.configured ? "✓ " : ""}{src}</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <input type="password" placeholder="paste API key" style={{ ...inputStyle, flex: "1 1 200px", marginBottom: 0 }}
                  value={d.apiKey || ""} onChange={(e) => setField(p.prefix, "apiKey", e.target.value)} />
                {p.needsBaseUrl && (
                  <input placeholder="base URL (required)" style={{ ...inputStyle, flex: "1 1 160px", marginBottom: 0, fontFamily: MONO }}
                    value={d.baseUrl ?? (st.baseUrl || "")} onChange={(e) => setField(p.prefix, "baseUrl", e.target.value)} />
                )}
                <button onClick={() => save(p.prefix)} disabled={busy === p.prefix} style={{ background: C.run, border: "none", color: C.onAccent, borderRadius: 6, padding: "0 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Save</button>
                <button onClick={() => test(p.prefix)} disabled={busy === p.prefix} style={{ background: "transparent", border: `1px solid ${C.link}`, color: C.link, borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>Test</button>
                {st.saved && <button onClick={() => clear(p.prefix)} disabled={busy === p.prefix} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.faint, borderRadius: 6, padding: "4px 8px", fontSize: 12, cursor: "pointer" }}>Clear</button>}
              </div>
              {msg[p.prefix] && <div style={{ fontSize: 11, color: /✗|fail|error/i.test(msg[p.prefix]) ? C.output : C.faint, marginTop: 5, fontFamily: MONO }}>{msg[p.prefix]}</div>}
            </div>
          );
        })}
        <button onClick={onClose} style={{ marginTop: 14, width: "100%", background: C.panel2, border: `1px solid ${C.border}`, color: C.mut, borderRadius: 6, padding: "8px", fontSize: 12, cursor: "pointer" }}>Done</button>
      </div>
    </div>
  );
}

/* ── run history: recent runs for an org, with a per-run trace ── */
function RunsModal({ currentOrgId, onClose }) {
  const [orgs, setOrgs] = React.useState([]);
  const [orgId, setOrgId] = React.useState(currentOrgId || null);
  const [runs, setRuns] = React.useState([]);
  const [sel, setSel] = React.useState(null);      // the expanded run (full detail)
  const [msg, setMsg] = React.useState(null);

  React.useEffect(() => {
    (async () => {
      try {
        const o = await cloud.orgs(); setOrgs(o);
        if (!orgId && o.length) setOrgId(o[0].id);
      } catch (e) { setMsg(e.message); }
    })();
  }, []);  // eslint-disable-line
  React.useEffect(() => {
    if (!orgId) return;
    (async () => {
      setSel(null);
      try { setRuns(await cloud.runs(orgId, { limit: 50 })); setMsg(null); }
      catch (e) { setMsg(e.message); setRuns([]); }
    })();
  }, [orgId]);

  const open = async (id) => {
    try { setSel(await cloud.getRun(id)); } catch (e) { setMsg(e.message); }
  };
  const statusColor = (s) => s === "ok" ? C.run : s === "cancelled" ? C.faint : C.output;
  const when = (ms) => ms ? new Date(ms).toLocaleString() : "—";

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.7)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
      <div className="ergon-modal" onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(820px, 96vw)", maxHeight: "88vh", overflowY: "auto", padding: 22 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Run history</div>
          <select style={{ ...inputStyle, width: 220, marginBottom: 0 }} value={orgId || ""} onChange={(e) => setOrgId(e.target.value)}>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>

        {!sel && (
          <div>
            {runs.length === 0 && <div style={{ fontSize: 12, color: C.faint }}>No runs recorded yet. Run a harness while signed in and it appears here.</div>}
            {runs.map((r) => (
              <button key={r.id} onClick={() => open(r.id)} style={{ display: "flex", width: "100%", gap: 10, alignItems: "center", textAlign: "left", background: "transparent", border: `1px solid ${C.borderSoft}`, borderRadius: 6, padding: "7px 10px", marginBottom: 5, cursor: "pointer", color: C.text }}>
                <span style={{ width: 8, height: 8, borderRadius: 8, background: statusColor(r.status), flex: "0 0 auto" }} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5 }}>
                  <b>{r.harnessName || "harness"}</b> <span style={{ color: C.faint }}>· {r.inputPreview || ""}</span>
                </span>
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.faint, flex: "0 0 auto" }}>
                  {(r.latencyMs != null ? `${r.latencyMs}ms · ` : "")}{(r.tokensIn + r.tokensOut)}tok{r.cost ? ` · ${fmtCost(r.cost)}` : ""}
                </span>
              </button>
            ))}
          </div>
        )}

        {sel && (
          <div>
            <button onClick={() => setSel(null)} style={{ background: "transparent", border: "none", color: C.link, cursor: "pointer", fontSize: 12, marginBottom: 8, padding: 0 }}>← all runs</button>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontFamily: MONO, fontSize: 11, color: C.faint, marginBottom: 10 }}>
              <span style={{ color: statusColor(sel.status) }}>{sel.status}</span>
              <span>{when(sel.startedAt)}</span>
              <span>{sel.latencyMs != null ? `${sel.latencyMs}ms` : ""}</span>
              <span>{(sel.tokensIn + sel.tokensOut)} tok ({sel.tokensIn}↓ {sel.tokensOut}↑)</span>
              {sel.cost ? <span>{fmtCost(sel.cost)}</span> : null}
            </div>
            <div style={{ fontSize: 11, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase", color: C.faint, marginBottom: 4 }}>Input</div>
            <pre style={{ margin: "0 0 10px", padding: 10, background: C.panel2, borderRadius: 6, fontFamily: MONO, fontSize: 11.5, whiteSpace: "pre-wrap", color: C.text }}>{sel.input || "(empty)"}</pre>
            <div style={{ fontSize: 11, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase", color: C.faint, marginBottom: 4 }}>Output</div>
            <pre style={{ margin: "0 0 10px", padding: 10, background: C.panel2, borderRadius: 6, fontFamily: MONO, fontSize: 11.5, whiteSpace: "pre-wrap", color: C.text }}>{sel.output || "(empty)"}</pre>
            <div style={{ fontSize: 11, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase", color: C.faint, marginBottom: 4 }}>Trace · {sel.steps.length} step{sel.steps.length === 1 ? "" : "s"}</div>
            <div style={{ fontFamily: MONO, fontSize: 11, maxHeight: 240, overflowY: "auto" }}>
              {sel.steps.map((s, i) => (
                <div key={i} style={{ display: "flex", gap: 8, padding: "2px 0", borderBottom: `1px solid ${C.borderSoft}` }}>
                  <span style={{ color: C.faint, width: 60, flex: "0 0 auto" }}>{s.at_ms != null ? `${s.at_ms}ms` : ""}</span>
                  <span style={{ color: C.link, width: 92, flex: "0 0 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.kind}</span>
                  <span style={{ color: C.mut, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.node || ""}{s.detail && (s.detail.name || s.detail.type) ? ` · ${s.detail.name || s.detail.type}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {msg && <div style={{ fontSize: 11.5, color: C.output, marginTop: 12, fontFamily: MONO }}>{msg}</div>}
        <button onClick={onClose} style={{ marginTop: 14, width: "100%", background: C.panel2, border: `1px solid ${C.border}`, color: C.mut, borderRadius: 6, padding: "8px", fontSize: 12, cursor: "pointer" }}>Done</button>
      </div>
    </div>
  );
}

/* ── organizations: create orgs, manage members, place the open harness ── */
function OrgsModal({ currentHarnessId, currentOrgId, onClose, onChanged, onMoved }) {
  const [orgs, setOrgs] = React.useState([]);
  const [sel, setSel] = React.useState(null);          // selected org {id,name,role}
  const [members, setMembers] = React.useState([]);
  const [newOrg, setNewOrg] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState("member");
  const [msg, setMsg] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [audit, setAudit] = React.useState(null);     // null = not loaded/hidden
  const [keys, setKeys] = React.useState(null);        // null = not loaded/hidden
  const [newKey, setNewKey] = React.useState("");      // name field
  const [keyRole, setKeyRole] = React.useState("member");
  const [freshKey, setFreshKey] = React.useState(null); // plaintext shown once
  const [budgets, setBudgets] = React.useState(null);   // null = not loaded/hidden
  const [budPeriod, setBudPeriod] = React.useState("month");
  const [budCost, setBudCost] = React.useState("");
  const [budReq, setBudReq] = React.useState("");
  const [deps, setDeps] = React.useState(null);         // null = not loaded/hidden
  const [depSlug, setDepSlug] = React.useState("");
  const [depUrl, setDepUrl] = React.useState("");
  const say = (m, bad = true) => setMsg({ m, bad });

  const loadOrgs = React.useCallback(async () => {
    try { const o = await cloud.orgs(); setOrgs(o); return o; } catch (e) { say(e.message); return []; }
  }, []);
  React.useEffect(() => { loadOrgs(); }, [loadOrgs]);
  const pick = async (o) => {
    setSel(o); setMembers([]); setMsg(null); setAudit(null); setKeys(null); setFreshKey(null); setBudgets(null); setDeps(null);
    try { setMembers(await cloud.members(o.id)); } catch (e) { say(e.message); }
  };
  const loadDeps = async () => {
    if (!sel) return;
    try { setDeps(await cloud.deployments(sel.id)); } catch (e) { say(e.message); setDeps([]); }
  };
  const addDep = async () => {
    if (!sel || !depSlug.trim()) return;
    setBusy(true); setMsg(null);
    try { await cloud.createDeployment(sel.id, depSlug.trim(), currentHarnessId || null, depUrl.trim() || null);
          setDepSlug(""); setDepUrl(""); setDeps(await cloud.deployments(sel.id)); say("deployment registered", false); }
    catch (e) { say(e.message); } finally { setBusy(false); }
  };
  const removeDep = async (id) => {
    try { await cloud.deleteDeployment(sel.id, id); setDeps(await cloud.deployments(sel.id)); } catch (e) { say(e.message); }
  };
  const exportOrg = async () => {
    if (!sel) return;
    try {
      const bundle = await cloud.exportOrg(sel.id);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(sel.name || "org").replace(/\s+/g, "-").toLowerCase()}-export.json`;
      a.click(); URL.revokeObjectURL(a.href);
      say("exported org data", false);
    } catch (e) { say(e.message); }
  };
  const loadBudgets = async () => {
    if (!sel) return;
    try { setBudgets(await cloud.budgetStatus(sel.id)); }
    catch (e) { say(e.message); setBudgets([]); }
  };
  const addBudget = async () => {
    if (!sel) return;
    const cost = budCost.trim() === "" ? null : Number(budCost);
    const reqs = budReq.trim() === "" ? null : Number(budReq);
    if (cost == null && reqs == null) { say("Set a spend cap or a request quota."); return; }
    setBusy(true); setMsg(null);
    try { await cloud.setBudget(sel.id, budPeriod, cost, reqs); setBudCost(""); setBudReq("");
          setBudgets(await cloud.budgetStatus(sel.id)); say("budget saved", false); }
    catch (e) { say(e.message); } finally { setBusy(false); }
  };
  const removeBudget = async () => {
    if (!sel) return;
    try {
      const list = await cloud.budgets(sel.id);
      const match = list.find((b) => b.period === budPeriod);
      if (match) { await cloud.deleteBudget(sel.id, match.id); setBudgets(await cloud.budgetStatus(sel.id)); say("budget removed", false); }
    } catch (e) { say(e.message); }
  };
  const loadAudit = async () => {
    if (!sel) return;
    try { setAudit(await cloud.audit(sel.id, { limit: 50 })); }
    catch (e) { say(e.message); setAudit([]); }
  };
  const loadKeys = async () => {
    if (!sel) return;
    try { setKeys(await cloud.keys(sel.id)); }
    catch (e) { say(e.message); setKeys([]); }
  };
  const createKey = async () => {
    if (!sel) return;
    setBusy(true); setMsg(null);
    try {
      const k = await cloud.createKey(sel.id, newKey.trim() || "API key", keyRole);
      setFreshKey(k); setNewKey("");
      setKeys(await cloud.keys(sel.id));
      say("key created — copy it now", false);
    } catch (e) { say(e.message); } finally { setBusy(false); }
  };
  const revokeKey = async (id) => {
    try { await cloud.revokeKey(sel.id, id); setKeys(await cloud.keys(sel.id)); }
    catch (e) { say(e.message); }
  };
  const create = async () => {
    if (!newOrg.trim()) return;
    setBusy(true); setMsg(null);
    try { const o = await cloud.createOrg(newOrg.trim()); setNewOrg(""); const all = await loadOrgs(); onChanged?.(); const made = all.find((x) => x.id === o.id); if (made) pick(made); say("organization created", false); }
    catch (e) { say(e.message); } finally { setBusy(false); }
  };
  const add = async () => {
    if (!sel || !email.trim()) return;
    setBusy(true); setMsg(null);
    try { setMembers(await cloud.addMember(sel.id, email.trim(), role)); setEmail(""); say("member added", false); }
    catch (e) { say(e.message); } finally { setBusy(false); }
  };
  const remove = async (em) => {
    try { setMembers(await cloud.removeMember(sel.id, em)); } catch (e) { say(e.message); }
  };
  const moveHarness = async (orgId) => {
    setBusy(true); setMsg(null);
    try { const h = await cloud.setHarnessOrg(currentHarnessId, orgId); onMoved?.(h.orgId || orgId); onChanged?.(); say("harness moved", false); }
    catch (e) { say(e.message); } finally { setBusy(false); }
  };
  const canManage = sel && (sel.role === "owner" || sel.role === "admin");

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.7)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
      <div className="ergon-modal" onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(640px, 96vw)", maxHeight: "88vh", overflowY: "auto", padding: 22 }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Organizations</div>
        <div style={{ color: C.faint, fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>
          Access is by org role: <b style={{ color: C.mut }}>owner/admin</b> can edit, <b style={{ color: C.mut }}>member</b> can view. Put a harness in an org and everyone in it gets access by role.
        </div>

        {currentHarnessId && (
          <div style={{ border: `1px solid ${C.borderSoft}`, borderRadius: 8, padding: "10px 12px", marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase", color: C.faint, marginBottom: 6 }}>Open harness</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, color: C.mut }}>Organization:</span>
              <select style={{ ...inputStyle, flex: "1 1 220px", marginBottom: 0 }} value={currentOrgId || ""} onChange={(e) => moveHarness(e.target.value)} disabled={busy}>
                {!orgs.some((o) => o.id === currentOrgId) && <option value={currentOrgId || ""}>current</option>}
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.role}</option>)}
              </select>
            </div>
            <div style={{ fontSize: 10.5, color: C.faint, marginTop: 5 }}>Moving needs owner/admin in both the current and the target org.</div>
          </div>
        )}

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {/* org list + create */}
          <div style={{ flex: "1 1 220px", minWidth: 200 }}>
            <div style={{ fontSize: 11, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase", color: C.faint, marginBottom: 8 }}>Your organizations</div>
            {orgs.map((o) => (
              <button key={o.id} onClick={() => pick(o)} style={{ display: "block", width: "100%", textAlign: "left", background: sel?.id === o.id ? C.panel2 : "transparent", border: `1px solid ${sel?.id === o.id ? C.border : "transparent"}`, borderRadius: 6, padding: "7px 9px", marginBottom: 4, cursor: "pointer", color: C.text }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.name}</div>
                <div style={{ fontSize: 10, color: C.faint, fontFamily: MONO }}>{o.role}</div>
              </button>
            ))}
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <input placeholder="new org name" style={{ ...inputStyle, flex: 1, marginBottom: 0 }} value={newOrg} onChange={(e) => setNewOrg(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
              <button onClick={create} disabled={busy || !newOrg.trim()} style={{ background: C.run, border: "none", color: C.onAccent, borderRadius: 6, padding: "0 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Create</button>
            </div>
          </div>

          {/* members of the selected org */}
          <div style={{ flex: "1 1 300px", minWidth: 260 }}>
            <div style={{ fontSize: 11, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase", color: C.faint, marginBottom: 8 }}>{sel ? `Members · ${sel.name}` : "Members"}</div>
            {!sel && <div style={{ fontSize: 12, color: C.faint }}>Select an organization.</div>}
            {sel && members.map((m) => (
              <div key={m.email} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 0", borderBottom: `1px solid ${C.borderSoft}` }}>
                <span style={{ fontSize: 12.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.email}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.link, border: `1px solid ${C.borderSoft}`, borderRadius: 3, padding: "1px 6px" }}>{m.role}</span>
                  {canManage && <button onClick={() => remove(m.email)} style={{ background: "transparent", border: "none", color: C.output, cursor: "pointer", fontSize: 11 }}>remove</button>}
                </span>
              </div>
            ))}
            {sel && canManage && (
              <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                <input type="email" placeholder="teammate@company.com" style={{ ...inputStyle, flex: "1 1 160px", marginBottom: 0 }} value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
                <select style={{ ...inputStyle, width: 92, marginBottom: 0 }} value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="member">member</option><option value="admin">admin</option>{sel.role === "owner" && <option value="owner">owner</option>}
                </select>
                <button onClick={add} disabled={busy || !email.trim()} style={{ background: C.link, border: "none", color: C.onAccent, borderRadius: 6, padding: "0 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Add</button>
              </div>
            )}
            {sel && !canManage && <div style={{ fontSize: 10.5, color: C.faint, marginTop: 8 }}>Owner or admin can manage members.</div>}
          </div>
        </div>

        {/* Data governance — owner/admin only */}
        {sel && canManage && (
          <div style={{ marginTop: 16, borderTop: `1px solid ${C.borderSoft}`, paddingTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 11, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase", color: C.faint }}>Data · {sel.name}</div>
            <button onClick={exportOrg} title="Download a portable JSON export of this organization's data (no secrets)" style={{ background: "transparent", border: `1px solid ${C.borderSoft}`, color: C.mut, borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: "pointer" }}>Export data</button>
          </div>
        )}

        {/* Deployments (hosted control plane) — owner/admin only */}
        {sel && canManage && (
          <div style={{ marginTop: 16, borderTop: `1px solid ${C.borderSoft}`, paddingTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 11, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase", color: C.faint }}>Deployments · {sel.name}</div>
              <button onClick={() => (deps === null ? loadDeps() : setDeps(null))} style={{ background: "transparent", border: `1px solid ${C.borderSoft}`, color: C.mut, borderRadius: 5, padding: "3px 9px", fontSize: 11, cursor: "pointer" }}>{deps === null ? "Show" : "Hide"}</button>
            </div>
            {deps !== null && (
              <div style={{ marginTop: 8 }}>
                {deps.length === 0 && <div style={{ color: C.faint, fontSize: 11, fontFamily: MONO }}>No deployments. Register a slug to serve the open harness via the gateway.</div>}
                {deps.map((d) => (
                  <div key={d.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${C.borderSoft}`, fontSize: 11.5, fontFamily: MONO }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ color: C.link }}>/api/gw/{d.slug}/run</span>
                      <span style={{ color: C.faint }}>{d.targetUrl ? ` → ${d.targetUrl}` : " · no runner"}</span>
                    </span>
                    <button onClick={() => removeDep(d.id)} style={{ background: "transparent", border: "none", color: C.output, cursor: "pointer", fontSize: 11 }}>remove</button>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  <input placeholder="slug (e.g. support-bot)" style={{ ...inputStyle, flex: "1 1 140px", marginBottom: 0 }} value={depSlug} onChange={(e) => setDepSlug(e.target.value)} />
                  <input placeholder="runner url (optional)" style={{ ...inputStyle, flex: "1 1 160px", marginBottom: 0 }} value={depUrl} onChange={(e) => setDepUrl(e.target.value)} />
                  <button onClick={addDep} disabled={busy || !depSlug.trim()} style={{ background: C.run, border: "none", color: C.onAccent, borderRadius: 6, padding: "0 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Register</button>
                </div>
                <div style={{ fontSize: 10.5, color: C.faint, marginTop: 5 }}>The gateway authenticates with an org API key and enforces budgets + limits, then forwards to the runner (an <span style={{ fontFamily: MONO }}>ergon serve</span> endpoint).</div>
              </div>
            )}
          </div>
        )}

        {/* Budgets & quotas — owner/admin only */}
        {sel && canManage && (
          <div style={{ marginTop: 16, borderTop: `1px solid ${C.borderSoft}`, paddingTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 11, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase", color: C.faint }}>Budgets &amp; quotas · {sel.name}</div>
              <button onClick={() => (budgets === null ? loadBudgets() : setBudgets(null))} style={{ background: "transparent", border: `1px solid ${C.borderSoft}`, color: C.mut, borderRadius: 5, padding: "3px 9px", fontSize: 11, cursor: "pointer" }}>{budgets === null ? "Show" : "Hide"}</button>
            </div>
            {budgets !== null && (
              <div style={{ marginTop: 8 }}>
                {budgets.length === 0 && <div style={{ color: C.faint, fontSize: 11, fontFamily: MONO }}>No budgets set — runs are unlimited.</div>}
                {budgets.map((b) => (
                  <div key={b.period} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${C.borderSoft}`, fontSize: 11.5, fontFamily: MONO }}>
                    <span style={{ color: C.mut, width: 60 }}>{b.period}</span>
                    <span style={{ flex: 1, color: b.costExceeded ? C.output : C.faint }}>
                      {b.maxCost != null ? `${fmtCost(b.spend)} / ${fmtCost(b.maxCost)}` : "—"}
                    </span>
                    <span style={{ flex: 1, color: b.requestsExceeded ? C.output : C.faint }}>
                      {b.maxRequests != null ? `${b.requests} / ${b.maxRequests} runs` : `${b.requests} runs`}
                    </span>
                    {(b.costExceeded || b.requestsExceeded) && <span style={{ color: C.output, fontSize: 10 }}>exceeded</span>}
                  </div>
                ))}
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <select style={{ ...inputStyle, width: 86, marginBottom: 0 }} value={budPeriod} onChange={(e) => setBudPeriod(e.target.value)}>
                    <option value="day">day</option><option value="month">month</option><option value="total">total</option>
                  </select>
                  <input placeholder="$ cap" style={{ ...inputStyle, width: 70, marginBottom: 0 }} value={budCost} onChange={(e) => setBudCost(e.target.value)} />
                  <input placeholder="# runs" style={{ ...inputStyle, width: 70, marginBottom: 0 }} value={budReq} onChange={(e) => setBudReq(e.target.value)} />
                  <button onClick={addBudget} disabled={busy} style={{ background: C.link, border: "none", color: C.onAccent, borderRadius: 6, padding: "0 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Set</button>
                  <button onClick={removeBudget} disabled={busy} title="remove the budget for the selected period" style={{ background: "transparent", border: `1px solid ${C.borderSoft}`, color: C.mut, borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>Clear</button>
                </div>
                <div style={{ fontSize: 10.5, color: C.faint, marginTop: 5 }}>Caps are checked at run admission (spend is summed from recorded runs); over a cap, further runs return 402.</div>
              </div>
            )}
          </div>
        )}

        {/* API keys — owner/admin only */}
        {sel && canManage && (
          <div style={{ marginTop: 16, borderTop: `1px solid ${C.borderSoft}`, paddingTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 11, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase", color: C.faint }}>API keys · {sel.name}</div>
              <button onClick={() => (keys === null ? loadKeys() : (setKeys(null), setFreshKey(null)))} style={{ background: "transparent", border: `1px solid ${C.borderSoft}`, color: C.mut, borderRadius: 5, padding: "3px 9px", fontSize: 11, cursor: "pointer" }}>{keys === null ? "Show" : "Hide"}</button>
            </div>
            {keys !== null && (
              <div style={{ marginTop: 8 }}>
                {freshKey && (
                  <div style={{ background: C.panel2, border: `1px solid ${C.run}`, borderRadius: 6, padding: "8px 10px", marginBottom: 8 }}>
                    <div style={{ fontSize: 10.5, color: C.faint, marginBottom: 4 }}>Copy this now — it won't be shown again:</div>
                    <code style={{ fontFamily: MONO, fontSize: 11, color: C.run, wordBreak: "break-all" }}>{freshKey.secret}</code>
                  </div>
                )}
                {keys.length === 0 && <div style={{ color: C.faint, fontSize: 11, fontFamily: MONO }}>No keys yet.</div>}
                {keys.map((k) => (
                  <div key={k.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${C.borderSoft}`, fontSize: 11.5, opacity: k.revokedAt ? 0.5 : 1 }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {k.name} <span style={{ fontFamily: MONO, color: C.faint }}>{k.prefix}</span>
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.link, border: `1px solid ${C.borderSoft}`, borderRadius: 3, padding: "1px 6px" }}>{k.role}</span>
                      {k.revokedAt ? <span style={{ fontSize: 10.5, color: C.faint }}>revoked</span>
                        : <button onClick={() => revokeKey(k.id)} style={{ background: "transparent", border: "none", color: C.output, cursor: "pointer", fontSize: 11 }}>revoke</button>}
                    </span>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  <input placeholder="key name (e.g. CI pipeline)" style={{ ...inputStyle, flex: "1 1 160px", marginBottom: 0 }} value={newKey} onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createKey()} />
                  <select style={{ ...inputStyle, width: 92, marginBottom: 0 }} value={keyRole} onChange={(e) => setKeyRole(e.target.value)}>
                    <option value="member">read</option><option value="admin">read/write</option>
                  </select>
                  <button onClick={createKey} disabled={busy} style={{ background: C.link, border: "none", color: C.onAccent, borderRadius: 6, padding: "0 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Create</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* audit log — owner/admin only */}
        {sel && canManage && (
          <div style={{ marginTop: 16, borderTop: `1px solid ${C.borderSoft}`, paddingTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 11, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase", color: C.faint }}>Activity log · {sel.name}</div>
              <button onClick={() => (audit === null ? loadAudit() : setAudit(null))} style={{ background: "transparent", border: `1px solid ${C.borderSoft}`, color: C.mut, borderRadius: 5, padding: "3px 9px", fontSize: 11, cursor: "pointer" }}>{audit === null ? "Show" : "Hide"}</button>
            </div>
            {audit !== null && (
              <div style={{ marginTop: 8, maxHeight: 200, overflowY: "auto", fontFamily: MONO, fontSize: 11 }}>
                {audit.length === 0 && <div style={{ color: C.faint }}>No activity yet.</div>}
                {audit.map((e) => (
                  <div key={e.id} style={{ display: "flex", gap: 8, padding: "3px 0", borderBottom: `1px solid ${C.borderSoft}`, lineHeight: 1.4 }}>
                    <span style={{ color: C.faint, whiteSpace: "nowrap" }}>{new Date(e.ts).toLocaleString()}</span>
                    <span style={{ color: C.link, whiteSpace: "nowrap" }}>{e.action}</span>
                    <span style={{ color: C.mut, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {e.actorEmail || "—"}{e.detail && (e.detail.name || e.detail.email) ? ` · ${e.detail.name || e.detail.email}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {msg && <div style={{ fontSize: 11.5, color: msg.bad ? C.output : C.run, marginTop: 12, fontFamily: MONO }}>{msg.m}</div>}
        <button onClick={onClose} style={{ marginTop: 14, width: "100%", background: C.panel2, border: `1px solid ${C.border}`, color: C.mut, borderRadius: 6, padding: "8px", fontSize: 12, cursor: "pointer" }}>Done</button>
      </div>
    </div>
  );
}

export default function ErgonStudio() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("ergon:theme") || "dark"; } catch { return "dark"; }
  });
  applyTheme(theme);   // reassign palette before the render body reads C
  useEffect(() => { try { localStorage.setItem("ergon:theme", theme); } catch {} }, [theme]);

  const init = useRef(starterGraph()).current;
  const [nodes, setNodes] = useState(init.nodes);
  const [edges, setEdges] = useState(init.edges);
  const [selected, setSelected] = useState(null);          // primary selection (drives the inspector)
  const [multiSel, setMultiSel] = useState(() => new Set()); // additional selected node ids (multi-select group)
  const [marquee, setMarquee] = useState(null);            // {x0,y0,x1,y1} world rect while box-selecting
  const clipboardRef = useRef(null);                       // copied {nodes, edges} for paste
  const [notes, setNotes] = useState(() => init.notes || []); // sticky notes: {id,x,y,w,h,text,color}
  const [selectedNote, setSelectedNote] = useState(null);  // note id selected (drag/resize/recolor)
  const [noteEdit, setNoteEdit] = useState(null);          // note id whose text is being edited
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [pending, setPending] = useState(null);
  const [preflightModal, setPreflightModal] = useState(null);   // {issues} or null — pre-run advisory
  const [simpleMode, setSimpleMode] = useState(() => {
    try { const v = localStorage.getItem("ergon:simple"); if (v != null) return v === "1"; } catch {}
    return !graphIsAdvanced(init.nodes, init.edges);   // first run: simple unless the starter needs advanced
  });
  const toggleSimpleMode = () => setSimpleMode((v) => { const nv = !v; try { localStorage.setItem("ergon:simple", nv ? "1" : "0"); } catch {} return nv; });
  const [paletteQuery, setPaletteQuery] = useState("");
  const [nodeEdit, setNodeEdit] = useState(null);   // { id, field } — inline quick-edit / rename
  const [galleryOpen, setGalleryOpen] = useState(() => { try { return !localStorage.getItem("ergon:onboarded"); } catch { return false; } });
  const markOnboarded = () => { try { localStorage.setItem("ergon:onboarded", "1"); } catch {} };
  // one-time per template: block count + which control-flow blocks it includes, for the gallery cards
  const templateStats = React.useMemo(() => {
    const out = {};
    for (const t of TEMPLATES) {
      try { const g = t.build(); const by = {}; g.nodes.forEach((n) => { by[n.type] = (by[n.type] || 0) + 1; });
        out[t.id] = { nodes: g.nodes.length, agents: by.agent || 0, router: !!by.router, parallel: !!by.parallel, conditional: !!by.conditional, tool: !!by.customtool }; }
      catch { out[t.id] = null; }
    }
    return out;
  }, []);
  const [running, setRunning] = useState(false);
  const [trace, setTrace] = useState([]);
  const [events, setEvents] = useState([]);        // structured timeline events
  const [outputs, setOutputs] = useState({});      // output node id -> final answer text
  const [nodeStatus, setNodeStatus] = useState({});// node id -> "running" | "done" | "error" (live during a run)
  const [nodeOutputs, setNodeOutputs] = useState({}); // node id -> last output text (per-node inspection)
  const [outputPanel, setOutputPanel] = useState(null); // { nodeId } — floating full-output viewer
  const [hoverNode, setHoverNode] = useState(null); // node id hovered (for elevation)
  const [hoverEdge, setHoverEdge] = useState(null); // edge id hovered (shows the insert + affordance)
  const [edgeInsert, setEdgeInsert] = useState(null); // { edgeId, sx, sy } — insert-on-edge menu anchor
  const eventsRef = useRef([]);
  const runHistoryRef = useRef([]);                // last run's full message history (for click-through)
  const [historyModal, setHistoryModal] = useState(null);   // {index} or null
  const [diffModal, setDiffModal] = useState(null);         // a compaction event or null
  const [viewingSessionKey, setViewingSessionKey] = useState(null);  // non-null = Timeline shows a past run
  const [activeEdges, setActiveEdges] = useState(new Set());
  const [tab, setTab] = useState("core");
  const [consoleTab, setConsoleTab] = useState("trace");
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [panels, setPanels] = useState({ todo: [], files: {}, memory: {} });
  const [sessions, setSessions] = useState([]);
  const [sessionView, setSessionView] = useState(null);
  const [codeModal, setCodeModal] = useState(null);
  const [deployModal, setDeployModal] = useState(null);
  const emptyMeter = () => ({ input: 0, output: 0, cost: 0, calls: 0, byModel: {} });
  const meterFromEvents = (evs) => {
    const m = emptyMeter();
    for (const e of evs) {
      if (e.kind !== "model_call") continue;
      const inTok = e.inTok || 0, outTok = e.outTok || 0;
      m.input += inTok; m.output += outTok; m.cost += costOf(e.model, inTok, outTok); m.calls += 1;
      const bm = m.byModel[e.model] || { input: 0, output: 0, calls: 0 };
      bm.input += inTok; bm.output += outTok; bm.calls += 1;
      m.byModel[e.model] = bm;
    }
    return m;
  };
  const [meter, setMeter] = useState(emptyMeter());
  const meterRef = useRef(emptyMeter());
  const [budget, setBudget] = useState({ maxTokens: "", maxCost: "" });   // run-wide spend caps ("" = off)
  const [budgetOpen, setBudgetOpen] = useState(false);   // budget popover visibility
  const [userMenuOpen, setUserMenuOpen] = useState(false);   // account menu visibility
  const [moreOpen, setMoreOpen] = useState(false);       // ⋯ overflow menu (export/admin actions)
  const [cmdOpen, setCmdOpen] = useState(false);         // ⌘K command palette
  const [cmdQ, setCmdQ] = useState("");
  const [cmdIdx, setCmdIdx] = useState(0);

  // close top-bar popovers (account menu, budget, overflow) on outside click or Escape
  useEffect(() => {
    if (!userMenuOpen && !budgetOpen && !moreOpen) return;
    const onDown = (e) => {
      if (!e.target.closest?.("[data-popover]")) { setUserMenuOpen(false); setBudgetOpen(false); setMoreOpen(false); }
    };
    const onKey = (e) => { if (e.key === "Escape") { setUserMenuOpen(false); setBudgetOpen(false); setMoreOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [userMenuOpen, budgetOpen, moreOpen]);
  const budgetHitRef = useRef(null);   // set to a reason string when a cap is crossed mid-run
  const saveHarnessRef = useRef(null);
  const ctxLogUsage = (who, inTok, outTok, cost) =>
    setTrace((t) => [...t, { type: "usage", text: `  ⊹ ${who}: +${inTok + outTok} tok (${inTok}↓ ${outTok}↑)${cost ? ` · ${fmtCost(cost)}` : ""}` }]);
  const [showValidation, setShowValidation] = useState(false);
  const [importError, setImportError] = useState(null);

  // ── undo / redo: snapshot stacks of {nodes, edges} ──
  const past = useRef([]);
  const future = useRef([]);
  const [histTick, setHistTick] = useState(0);   // forces toolbar re-render
  const snapshot = useCallback(() => ({
    nodes: JSON.parse(JSON.stringify(nodes)),
    edges: JSON.parse(JSON.stringify(edges)),
    notes: JSON.parse(JSON.stringify(notes)),
  }), [nodes, edges, notes]);
  // Call BEFORE a mutation to record the pre-change state.
  const commit = useCallback(() => {
    past.current.push(snapshot());
    if (past.current.length > 50) past.current.shift();
    future.current = [];
    setHistTick((t) => t + 1);
  }, [snapshot]);
  const undo = useCallback(() => {
    if (!past.current.length) return;
    future.current.push(snapshot());
    const prev = past.current.pop();
    setNodes(prev.nodes); setEdges(prev.edges); setNotes(prev.notes || []);
    setSelected(null); setSelectedEdge(null); setSelectedNote(null); setNoteEdit(null);
    setHistTick((t) => t + 1);
  }, [snapshot]);
  const redo = useCallback(() => {
    if (!future.current.length) return;
    past.current.push(snapshot());
    const nxt = future.current.pop();
    setNodes(nxt.nodes); setEdges(nxt.edges); setNotes(nxt.notes || []);
    setSelected(null); setSelectedEdge(null); setSelectedNote(null); setNoteEdit(null);
    setHistTick((t) => t + 1);
  }, [snapshot]);

  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const traceEnd = useRef(null);
  useEffect(() => { traceEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [trace]);

  // ── zoom / viewport ──
  const ZMIN = 0.25, ZMAX = 2.5;
  const clampZoom = (z) => Math.min(ZMAX, Math.max(ZMIN, z));
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ w: 1200, h: 700 });   // canvas pixel size, for the minimap
  useEffect(() => {
    const el = canvasRef.current; if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); setViewport({ w: r.width, h: r.height }); });
    ro.observe(el); return () => ro.disconnect();
  }, []);
  // non-passive wheel so we can zoom-to-cursor without the page scrolling
  useEffect(() => {
    const el = canvasRef.current; if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setZoom((z) => {
        const nz = clampZoom(z * Math.exp(-e.deltaY * 0.0015));
        setPan((p) => ({ x: mx - ((mx - p.x) / z) * nz, y: my - ((my - p.y) / z) * nz }));   // keep point under cursor fixed
        return nz;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const zoomBy = (factor) => {
    const cx = viewport.w / 2, cy = viewport.h / 2;
    setZoom((z) => { const nz = clampZoom(z * factor); setPan((p) => ({ x: cx - ((cx - p.x) / z) * nz, y: cy - ((cy - p.y) / z) * nz })); return nz; });
  };
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const fitView = () => {
    if (!nodes.length || !canvasRef.current) return;
    const r = canvasRef.current.getBoundingClientRect();
    const minX = Math.min(...nodes.map((n) => n.x)), minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + NODE_W)), maxY = Math.max(...nodes.map((n) => n.y + NODE_H));
    const pad = 70, bw = maxX - minX + pad * 2, bh = maxY - minY + pad * 2;
    const z = clampZoom(Math.min(r.width / bw, r.height / bh, 1.2));
    setZoom(z);
    setPan({ x: r.width / 2 - (minX + (maxX - minX) / 2) * z, y: r.height / 2 - (minY + (maxY - minY) / 2) * z });
  };

  const toWorld = useCallback((e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: (e.clientX - r.left - pan.x) / zoom, y: (e.clientY - r.top - pan.y) / zoom };
  }, [pan, zoom]);

  /* dragging & panning */
  // the full selection group (primary + multi), and membership test
  const selGroupIds = () => (selected ? [selected, ...[...multiSel].filter((id) => id !== selected)] : [...multiSel]);
  const inSelGroup = (id) => id === selected || multiSel.has(id);
  const onNodeDown = (e, node) => {
    e.stopPropagation();
    if (nodeEdit && nodeEdit.id !== node.id) setNodeEdit(null);
    if (e.shiftKey) {   // toggle this node in/out of the selection group — no drag
      setMultiSel((prev) => {
        const s = new Set(prev);
        if (inSelGroup(node.id)) s.delete(node.id);
        else { if (selected && selected !== node.id) s.add(selected); s.add(node.id); }
        return s;
      });
      setSelected(node.id); setSelectedEdge(null);
      return;
    }
    const w = toWorld(e);
    // drag the whole group if this node is part of a multi-selection, else just this node
    const groupIds = inSelGroup(node.id) && selGroupIds().length > 1 ? selGroupIds() : [node.id];
    const group = groupIds.map((id) => { const nn = nodes.find((n) => n.id === id); return { id, x0: nn.x, y0: nn.y }; });
    dragRef.current = { mode: "node", id: node.id, dx: w.x - node.x, dy: w.y - node.y, group, snap: snapshot() };
    if (!inSelGroup(node.id)) { setSelected(node.id); setMultiSel(new Set()); }   // clicking outside the group → single select
    setSelectedEdge(null);
  };
  const onCanvasDown = (e) => {
    if (e.shiftKey) {   // shift-drag on empty canvas = marquee box-select
      const w = toWorld(e);
      dragRef.current = { mode: "marquee" };
      setMarquee({ x0: w.x, y0: w.y, x1: w.x, y1: w.y });
      setSelectedEdge(null); setNodeEdit(null); setCommentPanel(null);
      return;
    }
    dragRef.current = { mode: "pan", sx: e.clientX, sy: e.clientY, p0: { ...pan } };
    setSelected(null); setMultiSel(new Set()); setSelectedEdge(null); setNodeEdit(null); setCommentPanel(null); setOutputPanel(null); setEdgeInsert(null); setSelectedNote(null); setNoteEdit(null);
  };
  // open the inline quick-editor for a node's primary field (double-click body)
  const openQuickEdit = (node) => { if (QUICK_FIELD[node.type]) { setSelected(node.id); setSelectedEdge(null); setNodeEdit({ id: node.id, field: QUICK_FIELD[node.type].field }); } };
  const onMove = (e) => {
    if (collabOn) { const w = toWorld(e); cursorRef.current = { x: Math.round(w.x), y: Math.round(w.y) }; }
    if (pending) { const w = toWorld(e); setPending((p) => ({ ...p, x: w.x, y: w.y })); }
    const d = dragRef.current;
    if (!d) return;
    if (d.mode === "marquee") { const w = toWorld(e); setMarquee((m) => (m ? { ...m, x1: w.x, y1: w.y } : m)); return; }
    if (d.mode === "note") { const w = toWorld(e); setNotes((ns) => ns.map((n) => (n.id === d.id ? { ...n, x: Math.round(d.x0 + (w.x - d.wx)), y: Math.round(d.y0 + (w.y - d.wy)) } : n))); return; }
    if (d.mode === "note-resize") { const w = toWorld(e); setNotes((ns) => ns.map((n) => (n.id === d.id ? { ...n, w: Math.max(NOTE_MIN_W, Math.round(d.w0 + (w.x - d.sx))), h: Math.max(NOTE_MIN_H, Math.round(d.h0 + (w.y - d.sy))) } : n))); return; }
    if (d.mode === "node") {
      const w = toWorld(e);
      const lead = d.group.find((g) => g.id === d.id);
      const ddx = (w.x - d.dx) - lead.x0, ddy = (w.y - d.dy) - lead.y0;
      setNodes((ns) => ns.map((n) => { const g = d.group.find((gg) => gg.id === n.id); return g ? { ...n, x: g.x0 + ddx, y: g.y0 + ddy } : n; }));
    } else setPan({ x: d.p0.x + (e.clientX - d.sx), y: d.p0.y + (e.clientY - d.sy) });
  };
  const onUp = () => {
    const d = dragRef.current;
    if (d?.mode === "marquee") {
      if (marquee) {
        const rx0 = Math.min(marquee.x0, marquee.x1), ry0 = Math.min(marquee.y0, marquee.y1);
        const rx1 = Math.max(marquee.x0, marquee.x1), ry1 = Math.max(marquee.y0, marquee.y1);
        const hit = nodes.filter((n) => n.x < rx1 && n.x + NODE_W > rx0 && n.y < ry1 && n.y + NODE_H > ry0).map((n) => n.id);
        if (hit.length) { setSelected(hit[0]); setMultiSel(new Set(hit.slice(1))); }
        else { setSelected(null); setMultiSel(new Set()); }
      }
      setMarquee(null); dragRef.current = null; return;
    }
    if (d?.mode === "node") {
      const moved = d.group.some((g) => { const nn = nodes.find((n) => n.id === g.id); return nn && (nn.x !== g.x0 || nn.y !== g.y0); });
      if (moved) { past.current.push(d.snap); if (past.current.length > 50) past.current.shift(); future.current = []; setHistTick((t) => t + 1); }
    }
    if (d?.mode === "note" || d?.mode === "note-resize") {
      const nn = notes.find((n) => n.id === d.id);
      const changed = nn && (d.mode === "note" ? (nn.x !== d.x0 || nn.y !== d.y0) : (nn.w !== d.w0 || nn.h !== d.h0));
      if (changed) { past.current.push(d.snap); if (past.current.length > 50) past.current.shift(); future.current = []; setHistTick((t) => t + 1); }
    }
    dragRef.current = null; setPending(null); setMarquee(null);
  };

  /* connecting */
  const startConnect = (e, node, port) => {
    e.stopPropagation(); e.preventDefault();
    try { e.target.releasePointerCapture(e.pointerId); } catch (_) {}
    const p = portPos(node)[port];
    setPending({ nodeId: node.id, port, x: p.x, y: p.y });
  };
  const finishConnect = (e, node, port) => {
    e.stopPropagation();
    if (!pending || pending.nodeId === node.id) return setPending(null);
    const pair = [pending.port, port].sort().join("+");
    let edge = null;
    if (pair === "in+out") {
      const [f, t] = pending.port === "out" ? [pending.nodeId, node.id] : [node.id, pending.nodeId];
      edge = { id: uid("e"), from: f, fromPort: "out", to: t, toPort: "in", kind: "flow" };
    } else if (pair === "attach+tools") {
      const [f, t] = pending.port === "tools" ? [pending.nodeId, node.id] : [node.id, pending.nodeId];
      edge = { id: uid("e"), from: f, fromPort: "tools", to: t, toPort: "attach", kind: "tool" };
    } else if (pair === "mesh+mesh") {
      edge = { id: uid("e"), from: pending.nodeId, fromPort: "mesh", to: node.id, toPort: "mesh", kind: "link" };
    } else if (pair === "in+routes" || pair === "in+fan") {
      // router/parallel dispatch: source's routes/fan port → an agent's in-port
      const srcPort = pending.port === "routes" || pending.port === "fan" ? pending.port : port;
      const [f, t] = (pending.port === "routes" || pending.port === "fan") ? [pending.nodeId, node.id] : [node.id, pending.nodeId];
      edge = { id: uid("e"), from: f, fromPort: srcPort, to: t, toPort: "in", kind: "dispatch" };
    }
    if (edge) {
      const exists = edges.some((x) => x.from === edge.from && x.to === edge.to && x.kind === edge.kind);
      if (!exists) {
        commit();
        setEdges((es) => {
          let next = es;
          if (edge.kind === "flow") next = es.filter((x) => !(x.kind === "flow" && (x.from === edge.from || x.to === edge.to)));
          return [...next, edge];
        });
      }
    }
    setPending(null);
  };

  const addNode = (type) => {
    const base = defaultConfig(type);
    if (type === "agent") {
      const count = nodes.filter((n) => n.type === "agent").length;
      base.name = `agent${count + 1}`;
    }
    const n = { id: uid("n"), type, x: 140 - pan.x + Math.random() * 60, y: 120 - pan.y + Math.random() * 60, config: base };
    commit();
    setNodes((ns) => [...ns, n]); setSelected(n.id);
  };
  // splice a new block into a flow connection: A → B becomes A → new → B
  const insertNodeOnEdge = (edgeId, type) => {
    const edge = edges.find((e) => e.id === edgeId); if (!edge || edge.kind !== "flow") return;
    const a = nodes.find((n) => n.id === edge.from), b = nodes.find((n) => n.id === edge.to);
    if (!a || !b) return;
    const mid = edgeMid(portPos(a)[edge.fromPort], portPos(b)[edge.toPort], "flow");
    if (simpleMode && !SIMPLE_NODE_TYPES.has(type)) toggleSimpleMode();
    const base = defaultConfig(type);
    if (type === "agent") base.name = `agent${nodes.filter((n) => n.type === "agent").length + 1}`;
    const nid = uid("n");
    const newNode = { id: nid, type, x: Math.round(mid.x - NODE_W / 2), y: Math.round(mid.y - NODE_H / 2), config: base };
    commit();
    setNodes((ns) => [...ns, newNode]);
    setEdges((es) => [
      ...es.filter((e) => e.id !== edgeId),
      { id: uid("e"), from: edge.from, fromPort: edge.fromPort, to: nid, toPort: "in", kind: "flow" },
      { id: uid("e"), from: nid, fromPort: "out", to: edge.to, toPort: edge.toPort, kind: "flow" },
    ]);
    setSelected(nid); setMultiSel(new Set()); setEdgeInsert(null); setHoverEdge(null);
  };
  // ── sticky notes (canvas annotations; not part of the flow graph) ──
  const noteColors = (key) => (NOTE_PALETTE[key] || NOTE_PALETTE.amber)[theme === "light" ? "light" : "dark"];
  const addNote = () => {
    const cx = (viewport.w / 2 - pan.x) / zoom, cy = (viewport.h / 2 - pan.y) / zoom;
    const n = { id: uid("note"), x: Math.round(cx - NOTE_W / 2), y: Math.round(cy - NOTE_H / 2), w: NOTE_W, h: NOTE_H, text: "", color: "amber" };
    commit();
    setNotes((ns) => [...ns, n]);
    setSelected(null); setSelectedEdge(null); setMultiSel(new Set());
    setSelectedNote(n.id); setNoteEdit(n.id);
  };
  const onNoteDown = (e, note) => {
    e.stopPropagation();
    if (noteEdit && noteEdit !== note.id) setNoteEdit(null);
    setSelectedNote(note.id); setSelected(null); setSelectedEdge(null); setMultiSel(new Set());
    const w = toWorld(e);
    dragRef.current = { mode: "note", id: note.id, wx: w.x, wy: w.y, x0: note.x, y0: note.y, snap: snapshot() };
  };
  const onNoteResizeDown = (e, note) => {
    e.stopPropagation();
    setSelectedNote(note.id);
    const w = toWorld(e);
    dragRef.current = { mode: "note-resize", id: note.id, sx: w.x, sy: w.y, w0: note.w, h0: note.h, snap: snapshot() };
  };
  const setNoteText = (id, text) => setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, text } : n)));
  const recolorNote = (id, color) => { commit(); setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, color } : n))); };
  const deleteNote = (id) => { commit(); setNotes((ns) => ns.filter((n) => n.id !== id)); if (selectedNote === id) setSelectedNote(null); if (noteEdit === id) setNoteEdit(null); };
  const deleteSelected = useCallback(() => {
    const group = new Set(selected ? [selected, ...multiSel] : [...multiSel]);
    if (group.size) {
      commit();
      setNodes((ns) => ns.filter((n) => !group.has(n.id)));
      setEdges((es) => es.filter((e) => !group.has(e.from) && !group.has(e.to)));
      setSelected(null); setMultiSel(new Set());
    } else if (selectedEdge) {
      commit();
      setEdges((es) => es.filter((e) => e.id !== selectedEdge)); setSelectedEdge(null);
    } else if (selectedNote) {
      commit();
      setNotes((ns) => ns.filter((n) => n.id !== selectedNote)); setSelectedNote(null); setNoteEdit(null);
    }
  }, [selected, multiSel, selectedEdge, selectedNote, commit]);

  /* copy / paste / duplicate (node-level) */
  const copySelection = () => {
    const group = new Set(selected ? [selected, ...multiSel] : [...multiSel]);
    if (!group.size) return;
    clipboardRef.current = {
      nodes: nodes.filter((n) => group.has(n.id)).map((n) => ({ ...n, config: { ...n.config } })),
      edges: edges.filter((e) => group.has(e.from) && group.has(e.to)).map((e) => ({ ...e })),   // only edges within the copied set
    };
  };
  const pasteGraph = (src, ox = 44, oy = 44) => {
    if (!src || !src.nodes.length) return;
    commit();
    const idMap = {};
    const newNodes = src.nodes.map((n) => { const nid = uid("n"); idMap[n.id] = nid; return { ...n, id: nid, x: n.x + ox, y: n.y + oy, config: { ...n.config } }; });
    const newEdges = src.edges.map((e) => ({ ...e, id: uid("e"), from: idMap[e.from], to: idMap[e.to] }));
    setNodes((ns) => [...ns, ...newNodes]);
    setEdges((es) => [...es, ...newEdges]);
    const ids = newNodes.map((n) => n.id);
    setSelected(ids[0]); setMultiSel(new Set(ids.slice(1))); setSelectedEdge(null);
  };
  const pasteClipboard = () => pasteGraph(clipboardRef.current);
  const duplicateSelection = () => {
    const group = new Set(selected ? [selected, ...multiSel] : [...multiSel]);
    if (!group.size) return;
    pasteGraph({
      nodes: nodes.filter((n) => group.has(n.id)).map((n) => ({ ...n, config: { ...n.config } })),
      edges: edges.filter((e) => group.has(e.from) && group.has(e.to)).map((e) => ({ ...e })),
    });
  };

  /* auto-layout: layered left→right by longest path over flow + dispatch edges */
  const tidyLayout = () => {
    if (!nodes.length) return;
    commit();
    const flowish = edges.filter((e) => e.kind === "flow" || e.kind === "dispatch");
    const layer = {}; nodes.forEach((n) => { layer[n.id] = 0; });
    for (let i = 0; i < nodes.length + 2; i++) {   // relax longest-path layering
      let changed = false;
      for (const e of flowish) if (layer[e.to] != null && layer[e.from] != null && layer[e.to] < layer[e.from] + 1) { layer[e.to] = layer[e.from] + 1; changed = true; }
      if (!changed) break;
    }
    // custom tools sit in the column of the agent they attach to
    for (const e of edges) if (e.kind === "tool" && layer[e.to] != null && layer[e.from] != null) layer[e.to] = layer[e.from];
    const byLayer = {}; nodes.forEach((n) => { (byLayer[layer[n.id]] ||= []).push(n); });
    const COLW = NODE_W + 96, ROWH = NODE_H + 48, X0 = 60, Y0 = 60;
    const pos = {};
    Object.keys(byLayer).map(Number).sort((a, b) => a - b).forEach((Lv) => {
      byLayer[Lv].sort((a, b) => a.y - b.y).forEach((n, i) => { pos[n.id] = { x: X0 + Lv * COLW, y: Y0 + i * ROWH }; });
    });
    setNodes((ns) => ns.map((n) => ({ ...n, ...pos[n.id] })));
    setTimeout(() => fitView(), 40);
  };
  // keep the latest copy/paste/dup/tidy reachable from the (stable) keydown effect
  const editActionsRef = useRef({});
  editActionsRef.current = { copySelection, pasteClipboard, duplicateSelection };
  useEffect(() => {
    const h = (e) => {
      const tag = document.activeElement?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
      if (mod && (e.key === "k" || e.key === "K")) { e.preventDefault(); setCmdOpen((o) => !o); setCmdQ(""); setCmdIdx(0); return; }
      if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); saveHarnessRef.current?.(false); return; }
      if (e.key === "Escape") { setGalleryOpen(false); setPreflightModal(null); setCommentPanel(null); setOutputPanel(null); setEdgeInsert(null); setHoverEdge(null); setNoteEdit(null); setHistOpen(false); setTrigOpen(false); setConnOpen(false); if (!typing) { setNodeEdit(null); setMultiSel(new Set()); setSelectedNote(null); } return; }
      if (mod && (e.key === "c" || e.key === "C") && !typing) { editActionsRef.current.copySelection(); return; }
      if (mod && (e.key === "v" || e.key === "V") && !typing) { e.preventDefault(); editActionsRef.current.pasteClipboard(); return; }
      if (mod && (e.key === "d" || e.key === "D") && !typing) { e.preventDefault(); editActionsRef.current.duplicateSelection(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && !typing) deleteSelected();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [deleteSelected, undo, redo]);

  /* import a harness JSON (matches exportJSON's shape) */
  const fileInputRef = useRef(null);
  const importJSON = (file) => {
    setImportError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(String(reader.result));
        const { graph, warnings } = normalizeImportedGraph(obj);
        commit();                                  // importing is undoable
        if (graphIsAdvanced(graph.nodes, graph.edges)) setSimpleMode(false);
        setNodes(graph.nodes); setEdges(graph.edges); setNotes(Array.isArray(obj.notes) ? obj.notes : []);
        setSelected(null); setSelectedEdge(null); setSelectedNote(null);
        setPan({ x: 0, y: 0 });
        if (warnings.length) { setImportError({ level: "warn", msgs: warnings }); setShowValidation(true); }
      } catch (err) {
        setImportError({ level: "error", msgs: [err.message] });
        setShowValidation(true);
      }
    };
    reader.onerror = () => setImportError({ level: "error", msgs: ["Could not read the file."] });
    reader.readAsText(file);
  };

  const cfgCommitTimer = useRef(null);
  const updateConfig = (id, patch) => {
    // coalesce a burst of edits (typing) into one undo step
    if (cfgCommitTimer.current) clearTimeout(cfgCommitTimer.current);
    else commit();
    cfgCommitTimer.current = setTimeout(() => { cfgCommitTimer.current = null; }, 600);
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, config: { ...n.config, ...patch } } : n)));
  };

  /* sessions & workspace (persistent storage) */
  const WORKSPACE_KEY = "state:harness";
  const loadWorkspace = async () => {
    try {
      const r = await storage.get(WORKSPACE_KEY);
      const s = JSON.parse(r.value);
      return { todo: s.todo || [], files: s.files || {}, memory: s.memory || {} };
    } catch { return { todo: [], files: {}, memory: {} }; }
  };
  const persistWorkspace = (s) => { try { storage.set(WORKSPACE_KEY, JSON.stringify(s)); } catch (_) {} };
  const clearWorkspace = async () => {
    try { await storage.delete(WORKSPACE_KEY); } catch (_) {}
    setPanels({ todo: [], files: {}, memory: {} });
  };
  useEffect(() => {   // restore todo/files/memory from previous runs on mount
    loadWorkspace().then((s) => setPanels({ todo: [...s.todo], files: { ...s.files }, memory: { ...s.memory } }));
  }, []);

  const loadSessions = async () => {
    try {
      const r = await storage.list("sess:");
      setSessions((r?.keys || []).sort().reverse());
    } catch { setSessions([]); }
  };
  useEffect(() => { loadSessions(); }, []);

  /* run */
  const log = (type, text) => setTrace((t) => [...t, { type, text }]);
  // Run gate: block on hard graph errors, then surface advisory preflight issues
  // (silent-no-op shapes) before committing to a run. "Run anyway" calls executeRun.
  const run = () => {
    if (running) return;
    const hardErrors = validateGraph(nodes, edges).filter((i) => i.level === "error");
    if (hardErrors.length) { setShowValidation(true); return; }   // block runs with real errors
    const pf = preflight(nodes, edges);
    if (pf.length) { setPreflightModal({ issues: pf }); return; }  // advisory — user can run anyway
    executeRun();
  };
  // partial runs for debugging: run from a block onward, or just that one block
  const runFromNode = (node) => { if (!running && node) executeRun({ start: node }); };
  const runOnlyNode = (node) => { if (!running && node) executeRun({ start: node, single: true }); };

  const executeRun = async (opts = {}) => {
    if (running) return;
    const full = !opts.start;   // opts: { start: node, single: bool } for partial / single-node runs
    setPreflightModal(null);
    setTrace([]); setActiveEdges(new Set()); setConsoleOpen(true); setConsoleTab("trace"); setRunning(true);
    meterRef.current = emptyMeter(); setMeter(emptyMeter()); budgetHitRef.current = null;
    eventsRef.current = []; setEvents([]); setNodeStatus({}); runHistoryRef.current = []; setViewingSessionKey(null);
    if (full) { setOutputs({}); setNodeOutputs({}); }   // partial runs keep prior outputs (upstream feeds the start block)
    const state = await loadWorkspace();                       // todo/files/memory survive across runs
    setPanels({ todo: [...state.todo], files: { ...state.files }, memory: { ...state.memory } });
    const runId = `sess:${Date.now()}`;
    const startedAt = Date.now();
    let inputText = "", finalText = "", runStatus = "ok";
    const ctx = makeCtx(runId, state);
    const flowSuccessor = (id) => edges.find((x) => x.kind === "flow" && x.from === id);
    try {
      const inputNode = nodes.find((n) => n.type === "input");
      let node, payload, hop = null, after = null;
      const seen = new Set();
      if (opts.start) {
        node = opts.start;
        const inc = edges.find((e) => e.kind === "flow" && e.to === node.id);   // feed from the upstream block's last output, else the task
        payload = inc && nodeOutputs[inc.from] != null ? nodeOutputs[inc.from] : (inputNode?.config.message || "");
        inputText = payload;
        log("route", `Running ${opts.single ? "only" : "from"} '${node.config?.name || node.type}' (input: ${inc && nodeOutputs[inc.from] != null ? `'${inc.from}' output` : "task"}).`);
      } else {
        if (!inputNode) throw new Error("Add an Input block to start a run.");
        log("info", `Run ${runId.slice(7)} started — history persists after every model call.`);
        payload = inputNode.config.message || "";
        inputText = payload;
        ctx.markNode(inputNode.id, "done"); ctx.recordOutput(inputNode.id, payload);   // the input provided the task
        seen.add(inputNode.id);
        hop = flowSuccessor(inputNode.id);
        node = hop ? nodes.find((n) => n.id === hop.to) : null;
        if (!node) log("info", "Flow ended (no outgoing connection).");
      }
      while (node) {
        if (seen.has(node.id)) break;
        seen.add(node.id);
        if (hop) setActiveEdges((s) => new Set(s).add(hop.id));
        ctx.markNode(node.id, "running");
        let done;
        try { done = await runNode(node, payload, ctx); }
        catch (err) { ctx.markNode(node.id, "error"); throw err; }
        ctx.markNode(node.id, budgetHitRef.current ? "error" : "done");
        if (done.payload != null) ctx.recordOutput(node.id, done.payload);   // per-node output for inspection
        if (budgetHitRef.current) {
          log("final", done.payload);
          finalText = done.payload; runStatus = "error";
          const mtr = meterRef.current;
          log("error", `⛔ Run stopped: spend budget reached (${budgetHitRef.current}) · ${mtr.input + mtr.output} tokens · ~${fmtCost(mtr.cost)}`);
          break;
        }
        if (opts.single) { log("final", done.payload); break; }   // single-node run stops here
        if (done.final) {
          log("final", done.payload);
          finalText = done.payload;
          if (node.type === "output") setOutputs({ [node.id]: done.payload });
          const mtr = meterRef.current;
          if (mtr.calls) log("usage", `Run total: ${mtr.input + mtr.output} tokens (${mtr.input}↓ ${mtr.output}↑) over ${mtr.calls} calls · ~${fmtCost(mtr.cost)}`);
          break;
        }
        payload = done.payload;
        if (done.jumpTo) {
          after = flowSuccessor(node.id);                 // remember the router's own flow edge as a fallback
          node = done.jumpTo; hop = null;                 // run the chosen specialist next (dispatch edge already animated)
        } else {
          hop = flowSuccessor(node.id) || after;          // the block's own flow edge, else fall back to the router's
          after = null;
          node = hop ? nodes.find((n) => n.id === hop.to) : null;
          if (!node) log("info", "Flow ended (no outgoing connection).");
        }
      }
    } catch (e) { log("error", e.message); runStatus = "error"; finalText = finalText || e.message; }
    finally {
      setRunning(false); loadSessions(); setTimeout(() => setActiveEdges(new Set()), 1200);
      // persist a run record to the server (signed in, standalone app only) — best-effort
      if (signedIn && !IN_CLAUDE_ARTIFACT && (currentId || currentOrgId)) {
        const m = meterRef.current; const finishedAt = Date.now();
        cloud.recordRun({
          harnessId: currentId || undefined, harnessName: currentName, orgId: currentOrgId || undefined,
          input: inputText, output: finalText, status: runStatus,
          startedAt, finishedAt, latencyMs: finishedAt - startedAt,
          usage: { input_tokens: m.input, output_tokens: m.output, cost: m.cost },
          steps: eventsRef.current.slice(0, 500),
        });
      }
    }
  };

  // Execute one node; returns {payload, final?, jumpTo?}.
  async function runNode(nxt, payload, ctx) {
    if (nxt.type === "agent") {
      const c = nxt.config;
      if (c.loopEnabled) {
        let prompt = payload + `\n\nWhen the task is fully complete, include the literal marker ${c.loopMarker} in your answer.`;
        let rounds = Math.min(Number(c.maxRounds) || 3, 5);
        let res = await runAgentNode(nxt, prompt, ctx);
        for (let r = 1; r < rounds && !res.includes(c.loopMarker); r++) {
          log("loop", `Completion marker not found — re-invoking ${c.name} (round ${r + 1}/${rounds}).`);
          res = await runAgentNode(nxt, "The completion condition is not satisfied yet. Review the todo list and memory notes, then continue.", ctx);
        }
        return { payload: res.replaceAll(c.loopMarker, "").trim() };
      }
      return { payload: await runAgentNode(nxt, payload, ctx) };
    }
    if (nxt.type === "router") {
      const c = nxt.config;
      const labels = (c.labels || "").split(",").map((s) => s.trim()).filter(Boolean);
      const dispatchEdges = ctx.edges.filter((x) => x.kind === "dispatch" && x.from === nxt.id);
      const targets = dispatchEdges.map((x) => ctx.nodes.find((n) => n.id === x.to)).filter(Boolean);
      log("route", `${c.name} classifying into: ${labels.join(", ") || "(no labels)"}`);
      const rr = await callModel({ provider: c.provider, model: c.model },
        { system: c.instruction || "Classify the request; reply with only the category word.",
          messages: [{ role: "user", content: `${payload}\n\nCategories: ${labels.join(", ")}. Reply with only one.` }] }, ctx.log);
      ctx.meter?.(rr.billedModel, rr.usage, c.name);
      const picked = (rr.text || "").trim().toLowerCase();
      const matchLabel = labels.find((l) => picked.includes(l.toLowerCase())) || labels[0];
      // choose the target agent whose name matches the label, else the i-th target
      const chosen = targets.find((t) => (t.config.name || "").toLowerCase() === (matchLabel || "").toLowerCase())
        || targets[Math.max(0, labels.indexOf(matchLabel))] || targets[0];
      if (!chosen) { log("error", `Router '${c.name}' has no downstream agent to dispatch to.`); return { payload }; }
      const de = dispatchEdges.find((x) => x.to === chosen.id);
      if (de) setActiveEdges((s) => new Set(s).add(de.id));
      log("route", `${c.name} → ${chosen.config.name} (matched '${matchLabel}')`);
      return { payload, jumpTo: chosen };     // continue the flow walk from the chosen agent
    }
    if (nxt.type === "conditional") {
      const c = nxt.config;
      const parsed = parseConditions(c.rules);
      const dispatchEdges = ctx.edges.filter((x) => x.kind === "dispatch" && x.from === nxt.id);
      const targets = dispatchEdges.map((x) => ctx.nodes.find((n) => n.id === x.to)).filter(Boolean);
      // evaluate rules deterministically against the incoming text (no model call)
      const tl = (payload || "").toLowerCase();
      let label = parsed.elseLabel;
      for (const r of parsed.rules) {
        let hit = false;
        if (r.test === "contains") hit = tl.includes((r.value || "").toLowerCase());
        else if (r.test === "regex") { try { hit = new RegExp(r.value).test(payload); } catch {} }
        else if (r.test === "longer_than") hit = (payload || "").length > Number(r.value);
        else if (r.test === "shorter_than") hit = (payload || "").length < Number(r.value);
        if (hit) { label = r.label; break; }
      }
      const chosen = targets.find((t) => (t.config.name || "").toLowerCase() === (label || "").toLowerCase()) || targets[0];
      if (!chosen) { log("error", `Conditional '${c.name}' has no downstream agent to dispatch to.`); return { payload }; }
      const de = dispatchEdges.find((x) => x.to === chosen.id);
      if (de) setActiveEdges((s) => new Set(s).add(de.id));
      log("route", `${c.name} → ${chosen.config.name} (rule matched '${label || "else"}')`);
      return { payload, jumpTo: chosen };
    }
    if (nxt.type === "parallel") {
      const c = nxt.config;
      const fanEdges = ctx.edges.filter((x) => x.kind === "dispatch" && x.from === nxt.id);
      const workers = fanEdges.map((x) => ctx.nodes.find((n) => n.id === x.to)).filter((n) => n && n.type === "agent");
      if (!workers.length) { log("error", `Parallel '${c.name}' has no worker agents connected.`); return { payload }; }
      log("parallel", `${c.name} fanning out to ${workers.length}: ${workers.map((w) => w.config.name).join(", ")}`);
      fanEdges.forEach((de) => setActiveEdges((s) => new Set(s).add(de.id)));
      workers.forEach((w) => ctx.markNode(w.id, "running"));
      const results = await Promise.all(workers.map(async (w) => {
        try { const r = await runAgentNode(w, payload, ctx); ctx.markNode(w.id, "done"); ctx.recordOutput(w.id, r); return r; }
        catch (err) { ctx.markNode(w.id, "error"); throw err; }
      }));
      const combined = workers.map((w, i) => `### ${w.config.name}\n${results[i]}`).join("\n\n");
      if (!c.join) { log("parallel", `${c.name} joined ${workers.length} outputs (concatenated).`); return { payload: combined }; }
      log("parallel", `${c.name} merging results…`);
      const mr = await callModel({ provider: c.provider, model: c.model },
        { system: c.joinPrompt || "Combine these parallel results into one coherent answer.",
          messages: [{ role: "user", content: combined }] }, ctx.log);
      ctx.meter?.(mr.billedModel, mr.usage, c.name);
      return { payload: mr.text };
    }
    if (nxt.type === "output") return { payload, final: true };
    return { payload };
  }

  function makeCtx(runId, state) {
    return {
      nodes, edges, log, state, runId,
      event: (ev) => {
        const withTs = { ...ev, at: performance.now() };
        eventsRef.current.push(withTs);
        setEvents([...eventsRef.current]);
        // persist the timeline into the session record so it can be reopened later
        try { storage.set(runId + ":events", JSON.stringify(eventsRef.current)); } catch (_) {}
      },
      captureHistory: (messages) => { runHistoryRef.current = messages.map((m) => ({ ...m })); },
      meter: (model, usage, who, local) => {
        const inTok = usage?.input || 0, outTok = usage?.output || 0;
        const cost = local ? 0 : costOf(model, inTok, outTok);
        meterRef.current.input += inTok;
        meterRef.current.output += outTok;
        meterRef.current.cost += cost;
        meterRef.current.calls += 1;
        const bm = meterRef.current.byModel[model] || { input: 0, output: 0, calls: 0 };
        bm.input += inTok; bm.output += outTok; bm.calls += 1;
        meterRef.current.byModel[model] = bm;
        setMeter({ ...meterRef.current, byModel: { ...meterRef.current.byModel } });
        if (inTok || outTok) ctxLogUsage(who, inTok, outTok, cost);
        // spend budget: flag a breach so the run loop can stop before the next call
        const maxTok = Number(budget.maxTokens) || 0, maxCost = Number(budget.maxCost) || 0;
        const tot = meterRef.current.input + meterRef.current.output;
        if (maxTok > 0 && tot >= maxTok) budgetHitRef.current = `tokens ${tot} ≥ ${maxTok}`;
        else if (maxCost > 0 && meterRef.current.cost >= maxCost) budgetHitRef.current = `cost ${fmtCost(meterRef.current.cost)} ≥ ${fmtCost(maxCost)}`;
        return budgetHitRef.current;
      },
      refreshPanels: () => {
        setPanels({ todo: [...state.todo], files: { ...state.files }, memory: { ...state.memory } });
        persistWorkspace(state);                               // ← workspace persists across runs
      },
      markEdge: (a, b) => setActiveEdges((s) => {
        const e = edges.find((x) => (x.from === a && x.to === b) || (x.from === b && x.to === a));
        if (!e) return s; const n = new Set(s); n.add(e.id); return n;
      }),
      markNode: (id, status) => setNodeStatus((s) => (s[id] === status ? s : { ...s, [id]: status })),
      recordOutput: (id, text) => setNodeOutputs((s) => ({ ...s, [id]: String(text ?? "") })),
      persist: async (messages, meta) => {
        runHistoryRef.current = messages.map((m) => ({ ...m }));   // for trace click-through
        try { await storage.set(runId, JSON.stringify({ saved_at: Date.now(), meta, messages })); }
        catch (e) { /* persistence best-effort in preview */ }
      },
      addStandingRule: (nodeId, toolName) =>                   // "always allow" from the approval prompt
        setNodes((ns) => ns.map((n) => {
          if (n.id !== nodeId) return n;
          const cur = (n.config.alwaysAllow || "").split(",").map((s) => s.trim()).filter(Boolean);
          if (cur.includes(toolName)) return n;
          return { ...n, config: { ...n.config, alwaysAllow: [...cur, toolName].join(", ") } };
        })),
    };
  }

  /* resume a crashed / stopped run from its persisted history */
  const resumeSession = async (key) => {
    if (running) return;
    let saved;
    try { saved = JSON.parse((await storage.get(key)).value); }
    catch { setTrace([{ type: "error", text: `Could not load session ${key}.` }]); return; }
    const msgs = saved.messages || [];
    const agentNode =
      nodes.find((n) => n.type === "agent" && n.config.name === saved.meta?.agent) ||
      nodes.find((n) => n.type === "agent");
    if (!agentNode) { setTrace([{ type: "error", text: "No agent on the canvas to resume onto." }]); return; }
    setSessionView(null);
    setTrace([]); setActiveEdges(new Set()); setConsoleOpen(true); setConsoleTab("trace"); setRunning(true);
    meterRef.current = emptyMeter(); setMeter(emptyMeter()); budgetHitRef.current = null;
    eventsRef.current = []; setEvents([]); setOutputs({}); setNodeStatus({}); setNodeOutputs({}); runHistoryRef.current = []; setViewingSessionKey(null);
    const state = await loadWorkspace();
    setPanels({ todo: [...state.todo], files: { ...state.files }, memory: { ...state.memory } });
    const ctx = makeCtx(key, state);                           // keep writing into the SAME session
    try {
      log("info", `Resuming ${key.slice(7)} on '${agentNode.config.name}' — ${msgs.length} messages restored.`);
      const res = await runAgentNode(
        agentNode,
        "Continue from where you left off. Review the todo list and memory notes, then finish the task.",
        ctx, 0, msgs
      );
      log("final", res);
    } catch (e) { log("error", e.message); }
    finally { setRunning(false); loadSessions(); setTimeout(() => setActiveEdges(new Set()), 1200); }
  };

  const openSession = async (key) => {
    try {
      const r = await storage.get(key);
      const data = JSON.parse(r.value);
      setSessionView({ key, data });
      // pull the persisted timeline + history for this run so Timeline/click-through reflect it
      let evs = [];
      try { evs = JSON.parse((await storage.get(key + ":events")).value) || []; } catch (_) {}
      if (evs.length || data?.messages) {
        eventsRef.current = evs; setEvents(evs);
        runHistoryRef.current = (data?.messages || []).map((m) => ({ ...m }));
        setViewingSessionKey(key);
        setConsoleTab("timeline"); setConsoleOpen(true);
      }
    } catch { setSessionView({ key, data: null }); }
  };

  // download the current run's timeline as JSONL, shaped like the SDK's events.jsonl
  const exportTimeline = () => {
    if (!events.length) return;
    const lines = events.map((e) => {
      const base = { kind: e.kind, agent: e.agent, iteration: e.iteration, duration_ms: e.ms };
      if (e.kind === "model_call") Object.assign(base, {
        model: e.model, network_ms: e.networkMs, input_tokens: e.inTok, output_tokens: e.outTok,
        stop: e.stop, n_tool_calls: e.nToolCalls, message_index: e.msgIndex,
      });
      else if (e.kind === "tool_call") Object.assign(base, {
        tool: e.tool, denied: e.denied, simulated: e.simulated, input: e.input, output: e.output, message_index: e.msgIndex,
      });
      else if (e.kind === "compaction") Object.assign(base, {
        before_msgs: e.beforeMsgs, after_msgs: e.afterMsgs,
        before_tokens: e.beforeTokens, after_tokens: e.afterTokens,
      });
      return JSON.stringify(base);
    });
    const blob = new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" });
    const a = document.createElement("a");
    const tag = viewingSessionKey ? "past-run" : "run";
    a.href = URL.createObjectURL(blob); a.download = `${(currentName || "harness").replace(/\s+/g, "-")}-${tag}-events.jsonl`; a.click(); URL.revokeObjectURL(a.href);
  };
  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({ version: 2, nodes, edges, notes }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${(currentName || "harness").replace(/\s+/g, "-")}.json`; a.click(); URL.revokeObjectURL(a.href);
  };

  /* ── harness library: named graphs saved in storage under lib:<id> ── */
  const [library, setLibrary] = useState([]);        // [{id, name, updated, nodeCount, role?, ownerEmail?}]
  const [currentId, setCurrentId] = useState(null);
  const [currentName, setCurrentName] = useState("Untitled harness");
  const [currentRole, setCurrentRole] = useState("owner");   // 'owner' | 'edit' | 'view'
  const [currentVersion, setCurrentVersion] = useState(null); // server updated_at at load/save time
  const [currentOrgId, setCurrentOrgId] = useState(null);     // org the open harness belongs to (server)
  const [conflict, setConflict] = useState(null);            // {name, graph, role, updated_at} from a 409
  const [libraryOpen, setLibraryOpen] = useState(false);

  // ── provider catalog, live model lists, key management (minimum-effort UI) ──
  const [providerCatalog, setProviderCatalog] = useState([...FALLBACK_PROVIDERS, BEDROCK_OPTION]);
  const [keysOpen, setKeysOpen] = useState(false);
  const [orgsOpen, setOrgsOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [modelOpts, setModelOpts] = useState({});    // prefix -> [model ids]
  const [modelMsg, setModelMsg] = useState({});      // prefix -> status string
  const refreshCatalog = useCallback(() => { fetchProviderCatalog().then(setProviderCatalog); }, []);
  useEffect(() => { refreshCatalog(); }, [refreshCatalog]);
  const loadModelsFor = useCallback(async (prefix) => {
    if (!prefix || IN_CLAUDE_ARTIFACT) { setModelMsg((m) => ({ ...m, [prefix]: "Live model list needs the standalone app." })); return; }
    setModelMsg((m) => ({ ...m, [prefix]: "loading…" }));
    try {
      const models = await fetchModels(prefix);
      setModelOpts((o) => ({ ...o, [prefix]: models }));
      setModelMsg((m) => ({ ...m, [prefix]: models.length ? `${models.length} models` : "none returned" }));
    } catch (e) { setModelMsg((m) => ({ ...m, [prefix]: String(e.message || e) })); }
  }, []);

  // ── accounts / collaboration ──
  const [user, setUser] = useState(null);            // {id, email} or null
  const [authOpen, setAuthOpen] = useState(false);
  const signedIn = !!user;
  useEffect(() => {
    if (!auth.available) return;
    auth.me().then((u) => { if (u) { setUser(u); useServerStorage(true); loadLibrary(true); } });
  }, []);

  const onAuthed = (u) => {
    setUser(u); useServerStorage(true); setAuthOpen(false);
    loadLibrary(true); loadSessions();
  };
  const signOut = async () => {
    await auth.logout(); setUser(null); useServerStorage(false);
    setCurrentId(null); setCurrentRole("owner"); setCurrentVersion(null); loadLibrary(false); loadSessions();
  };

  // ── collaboration: live presence + node comments (server-backed; a saved,
  //    signed-in harness only — needs a server harness id to scope to) ──
  const collabOn = signedIn && !!currentId && !IN_CLAUDE_ARTIFACT;
  const [collabViewers, setCollabViewers] = useState([]);   // other people on this harness now
  const [comments, setComments] = useState([]);             // all comments for the open harness
  const [commentPanel, setCommentPanel] = useState(null);   // { nodeId } | null
  const [commentDraft, setCommentDraft] = useState("");
  const selectionRef = useRef(null);
  useEffect(() => { selectionRef.current = selected; }, [selected]);
  const cursorRef = useRef(null);        // my pointer in world coords, or null when off-canvas
  const lastCursorSentRef = useRef("");  // last cursor+selection signature we pushed (skip no-op pings)

  const reloadComments = useCallback(async () => {
    if (!collabOn) return;
    try { setComments(await cloud.comments(currentId)); } catch { /* ignore */ }
  }, [collabOn, currentId]);

  useEffect(() => {   // load comments when the open harness changes
    if (!collabOn) { setComments([]); setCommentPanel(null); return; }
    reloadComments();
  }, [collabOn, currentId, reloadComments]);

  useEffect(() => {   // heartbeat presence + poll comments while a harness is open
    if (!collabOn) { setCollabViewers([]); return; }
    let alive = true;
    const beat = async () => { try { const v = await cloud.presence(currentId, selectionRef.current); if (alive) setCollabViewers(v); } catch { /* ignore */ } };
    beat();
    const t = setInterval(() => { beat(); reloadComments(); }, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [collabOn, currentId, reloadComments]);

  useEffect(() => {   // push selection promptly so peers see the selection move
    if (!collabOn) return;
    const id = setTimeout(() => { cloud.presence(currentId, selected, cursorRef.current).then((v) => setCollabViewers(v)).catch(() => {}); }, 250);
    return () => clearTimeout(id);
  }, [selected, collabOn, currentId]);

  useEffect(() => {   // live cursors: push my pointer ~1.5s while it's moving (idle is covered by the 8s beat)
    if (!collabOn) return;
    let alive = true;
    const tick = async () => {
      const c = cursorRef.current;
      const sig = c ? `${c.x},${c.y}|${selectionRef.current || ""}` : `off|${selectionRef.current || ""}`;
      if (sig === lastCursorSentRef.current) return;   // nothing moved — let the slow heartbeat keep us alive
      lastCursorSentRef.current = sig;
      try { const v = await cloud.presence(currentId, selectionRef.current, c); if (alive) setCollabViewers(v); } catch { /* ignore */ }
    };
    const t = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [collabOn, currentId]);

  const postComment = async (nodeId, body) => {
    if (!body.trim()) return;
    try { await cloud.addComment(currentId, nodeId, body.trim()); setCommentDraft(""); await reloadComments(); }
    catch (e) { log("error", e.message); }
  };
  const toggleResolveComment = async (c) => { try { await cloud.resolveComment(currentId, c.id, !c.resolved); await reloadComments(); } catch (e) { log("error", e.message); } };
  const removeComment = async (c) => { try { await cloud.deleteComment(currentId, c.id); await reloadComments(); } catch (e) { log("error", e.message); } };
  const canManageComment = (c) => currentRole !== "view" || (user && c.authorEmail === user.email);
  useEffect(() => { setCommentDraft(""); }, [commentPanel?.nodeId]);

  // ── version history: a timeline of saves with structural diff + restore ──
  const [histOpen, setHistOpen] = useState(false);
  const [histList, setHistList] = useState([]);        // [{id, version, name, authorEmail, createdAt, nodeCount, edgeCount}]
  const [histSel, setHistSel] = useState(null);        // the "after" version id (B)
  const [histBase, setHistBase] = useState(null);      // chosen baseline id (A); null = B's predecessor
  const [histGraphs, setHistGraphs] = useState({});    // versionId -> graph (cache)
  const [histBusy, setHistBusy] = useState(false);
  const [histErr, setHistErr] = useState(null);
  const predecessorOf = useCallback((id) => { const i = histList.findIndex((v) => v.id === id); return i >= 0 ? (histList[i + 1]?.id || null) : null; }, [histList]);
  const openHistory = async () => {
    if (!currentId) return;
    setHistOpen(true); setHistBusy(true); setHistErr(null); setHistBase(null);
    try {
      const list = await cloud.versions(currentId);
      setHistList(list);
      setHistSel(list[0]?.id || null);
    } catch (e) { setHistErr(e.message); }
    finally { setHistBusy(false); }
  };
  const ensureVersionGraph = useCallback(async (id) => {
    if (!id || histGraphs[id]) return;
    try { const v = await cloud.version(currentId, id); setHistGraphs((g) => ({ ...g, [id]: v.graph })); }
    catch (e) { setHistErr(e.message); }
  }, [currentId, histGraphs]);
  useEffect(() => {   // load the two graphs the current comparison needs
    if (!histOpen || !histSel) return;
    ensureVersionGraph(histSel);
    const base = histBase || predecessorOf(histSel);
    if (base) ensureVersionGraph(base);
  }, [histOpen, histSel, histBase, ensureVersionGraph, predecessorOf]);
  const restoreVersion = async (id) => {
    try {
      const v = histGraphs[id] ? { graph: histGraphs[id] } : await cloud.version(currentId, id);
      const g = v.graph || {};
      commit();
      if (graphIsAdvanced(g.nodes || [], g.edges || [])) setSimpleMode(false);
      setNodes(g.nodes || []); setEdges(g.edges || []); setNotes(Array.isArray(g.notes) ? g.notes : []);
      setSelected(null); setSelectedEdge(null); setSelectedNote(null);
      setHistOpen(false);
    } catch (e) { setHistErr(e.message); }
  };

  // ── triggers: webhook + schedule entry points that start a run ──
  const [trigOpen, setTrigOpen] = useState(false);
  const [trigList, setTrigList] = useState([]);
  const [trigBusy, setTrigBusy] = useState(false);
  const [trigErr, setTrigErr] = useState(null);
  const [trigCron, setTrigCron] = useState("0 9 * * *");
  const [trigPayload, setTrigPayload] = useState("");
  const [copiedTok, setCopiedTok] = useState(null);
  const CRON_PRESETS = [
    ["*/15 * * * *", "Every 15 minutes"], ["0 * * * *", "Hourly"], ["0 */6 * * *", "Every 6 hours"],
    ["0 9 * * *", "Daily 09:00 UTC"], ["0 9 * * 1-5", "Weekdays 09:00 UTC"], ["0 0 * * 0", "Weekly (Sun)"],
  ];
  const reloadTriggers = async () => { try { setTrigList(await cloud.triggers(currentId)); } catch (e) { setTrigErr(e.message); } };
  const openTriggers = async () => {
    if (!currentId) return;
    setTrigOpen(true); setTrigBusy(true); setTrigErr(null);
    try { setTrigList(await cloud.triggers(currentId)); } catch (e) { setTrigErr(e.message); }
    finally { setTrigBusy(false); }
  };
  const addWebhook = async () => { setTrigErr(null); try { await cloud.createTrigger(currentId, { type: "webhook" }); await reloadTriggers(); } catch (e) { setTrigErr(e.message); } };
  const addSchedule = async () => { setTrigErr(null); try { await cloud.createTrigger(currentId, { type: "schedule", cron: trigCron.trim(), payload: trigPayload || "" }); setTrigPayload(""); await reloadTriggers(); } catch (e) { setTrigErr(e.message); } };
  const toggleTrigger = async (t) => { setTrigErr(null); try { await cloud.updateTrigger(currentId, t.id, { enabled: !t.enabled }); await reloadTriggers(); } catch (e) { setTrigErr(e.message); } };
  const removeTrigger = async (t) => { setTrigErr(null); try { await cloud.deleteTrigger(currentId, t.id); await reloadTriggers(); } catch (e) { setTrigErr(e.message); } };
  const copyWebhook = (t) => { const url = cloud.webhookUrl(t.token); try { navigator.clipboard?.writeText(url); } catch {} setCopiedTok(t.id); setTimeout(() => setCopiedTok((c) => (c === t.id ? null : c)), 1500); };

  // ── connectors: catalog + managed connections ──
  const [connOpen, setConnOpen] = useState(false);
  const [connTab, setConnTab] = useState("catalog");   // "catalog" | "connections"
  const [catalog, setCatalog] = useState([]);
  const [connList, setConnList] = useState([]);
  const [connBusy, setConnBusy] = useState(false);
  const [connErr, setConnErr] = useState(null);
  const [connSearch, setConnSearch] = useState("");
  const [connectDraft, setConnectDraft] = useState(null);   // { connector, name, config, secret }
  const connMgmtOrg = currentOrgId;   // connections are org-scoped
  const loadConnections = useCallback(async () => {
    if (!connMgmtOrg) { setConnList([]); return; }
    try { setConnList(await cloud.connections(connMgmtOrg)); } catch (e) { setConnErr(e.message); }
  }, [connMgmtOrg]);
  useEffect(() => { if (signedIn && connMgmtOrg && !IN_CLAUDE_ARTIFACT) loadConnections(); }, [signedIn, connMgmtOrg, loadConnections]);
  const openConnectors = async () => {
    setConnOpen(true); setConnBusy(true); setConnErr(null); setConnectDraft(null); setConnTab("catalog");
    try { const [cat] = await Promise.all([cloud.connectors(""), loadConnections()]); setCatalog(cat); } catch (e) { setConnErr(e.message); }
    finally { setConnBusy(false); }
  };
  const beginConnectorSetup = (connector) => { const config = {}; (connector.fields || []).forEach((f) => { config[f.key] = ""; }); setConnectDraft({ connector, name: connector.name, config, secret: "" }); setConnErr(null); };
  const saveConnect = async () => {
    if (!connectDraft || !connMgmtOrg) { setConnErr("No organization to save into."); return; }
    setConnErr(null);
    try {
      await cloud.createConnection(connMgmtOrg, { connectorId: connectDraft.connector.id, name: connectDraft.name, config: connectDraft.config, secret: connectDraft.secret || null });
      setConnectDraft(null); await loadConnections(); setConnTab("connections");
    } catch (e) { setConnErr(e.message); }
  };
  const removeConnection = async (c) => { setConnErr(null); try { await cloud.deleteConnection(connMgmtOrg, c.id); await loadConnections(); } catch (e) { setConnErr(e.message); } };
  const connectorName = (id) => (catalog.find((c) => c.id === id)?.name) || id;
  const startOAuth = async (connector) => {
    if (!connMgmtOrg) { setConnErr("Save this harness to an organization first."); return; }
    setConnErr(null);
    try {
      const u = await cloud.oauthStart(connMgmtOrg, connector.id);
      window.open(u, "ergon-oauth", "width=600,height=720");
    } catch (e) { setConnErr(e.message); }
  };
  useEffect(() => {   // OAuth popup finished → refresh the connection list
    if (IN_CLAUDE_ARTIFACT) return;
    const onMsg = (ev) => { if (ev.data && ev.data.ergonConnected && ev.data.ok) { loadConnections(); setConnectDraft(null); setConnTab("connections"); } };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [loadConnections]);

  const loadLibrary = async (asCloud = signedIn) => {
    try {
      if (asCloud) {
        const items = await cloud.list();
        setLibrary(items.map((h) => ({ id: h.id, name: h.name, updated: h.updated_at, role: h.role, ownerEmail: h.ownerEmail })));
        return;
      }
      const r = await storage.list("lib:");
      const items = await Promise.all((r?.keys || []).map(async (k) => {
        try { const v = JSON.parse((await storage.get(k)).value); return { id: k, name: v.name, updated: v.updated, nodeCount: (v.nodes || []).length, role: "owner" }; }
        catch { return null; }
      }));
      setLibrary(items.filter(Boolean).sort((a, b) => (b.updated || 0) - (a.updated || 0)));
    } catch { setLibrary([]); }
  };
  useEffect(() => { loadLibrary(false); }, []);

  const saveHarness = async (asNew = false, force = false) => {
    const name = currentName || "Untitled harness";
    try {
      if (signedIn) {
        const saved = await cloud.save({
          id: asNew ? null : currentId, name, graph: { version: 2, nodes, edges, notes },
          expectedVersion: asNew ? null : currentVersion, force,
        });
        setCurrentId(saved.id); setCurrentRole(saved.role || "owner");
        setCurrentVersion(saved.updated_at || null); setCurrentOrgId(saved.orgId || null); setConflict(null);
        await loadLibrary(true);
        return;
      }
      const id = asNew || !currentId ? `lib:${Date.now()}` : currentId;
      await storage.set(id, JSON.stringify({ version: 2, name, updated: Date.now(), nodes, edges, notes }));
      setCurrentId(id); await loadLibrary(false);
    } catch (e) {
      if (e.conflict) { setConflict(e.current); return; }   // resolve via dialog, don't lose work
      setImportError({ level: "error", msgs: [`Could not save: ${e.message}`] }); setShowValidation(true);
    }
  };
  saveHarnessRef.current = saveHarness;
  // apply the server's current version onto the canvas (Reload), discarding local edits
  const reloadFromConflict = () => {
    if (!conflict) return;
    const { graph } = normalizeImportedGraph({ ...conflict.graph, name: conflict.name });
    commit();
    setNodes(graph.nodes); setEdges(graph.edges); setNotes(Array.isArray(conflict.graph?.notes) ? conflict.graph.notes : []);
    setCurrentName(conflict.name || "Untitled harness");
    setCurrentRole(conflict.role || "owner"); setCurrentVersion(conflict.updated_at || null);
    setSelected(null); setSelectedEdge(null); setConflict(null);
  };
  const openHarness = async (id) => {
    try {
      let v, role = "owner", version = null, orgId = null;
      if (signedIn) { const h = await cloud.get(id); v = h.graph; v.name = h.name; role = h.role; version = h.updated_at || null; orgId = h.orgId || null; }
      else { v = JSON.parse((await storage.get(id)).value); }
      const { graph } = normalizeImportedGraph(v);
      commit();
      if (graphIsAdvanced(graph.nodes, graph.edges)) setSimpleMode(false);
      setNodes(graph.nodes); setEdges(graph.edges); setNotes(Array.isArray(v.notes) ? v.notes : []);
      setCurrentId(id); setCurrentName(v.name || "Untitled harness"); setCurrentRole(role); setCurrentVersion(version); setCurrentOrgId(orgId);
      setSelected(null); setSelectedEdge(null); setPan({ x: 0, y: 0 }); setLibraryOpen(false);
    } catch (e) { setImportError({ level: "error", msgs: [`Could not open: ${e.message}`] }); setShowValidation(true); }
  };
  const duplicateHarness = async (id) => {
    try {
      if (signedIn) {
        const h = await cloud.get(id);
        await cloud.save({ id: null, name: `${h.name} (copy)`, graph: h.graph });
        await loadLibrary(true); return;
      }
      const v = JSON.parse((await storage.get(id)).value);
      await storage.set(`lib:${Date.now()}`, JSON.stringify({ ...v, name: `${v.name} (copy)`, updated: Date.now() }));
      await loadLibrary(false);
    } catch (_) {}
  };
  const deleteHarness = async (id) => {
    try {
      if (signedIn) { await cloud.remove(id); } else { await storage.delete(id); }
      if (currentId === id) { setCurrentId(null); setCurrentRole("owner"); setCurrentVersion(null); }
      await loadLibrary(signedIn);
    } catch (e) { setImportError({ level: "error", msgs: [`Could not delete: ${e.message}`] }); setShowValidation(true); }
  };
  const newHarness = () => {
    commit();
    const g = starterGraph();
    setNodes(g.nodes); setEdges(g.edges); setNotes([]);
    setCurrentId(null); setCurrentName("Untitled harness"); setCurrentRole("owner"); setCurrentVersion(null); setCurrentOrgId(null);
    setSelected(null); setSelectedEdge(null); setSelectedNote(null); setPan({ x: 0, y: 0 }); setLibraryOpen(false);
  };
  const loadTemplate = (tpl) => {
    commit();
    const g = tpl.build();
    if (graphIsAdvanced(g.nodes, g.edges)) setSimpleMode(false);   // don't hide what the template needs
    setNodes(g.nodes); setEdges(g.edges); setNotes(Array.isArray(g.notes) ? g.notes : []);
    setCurrentId(null); setCurrentName(tpl.name); setCurrentRole("owner"); setCurrentVersion(null); setCurrentOrgId(null);
    setSelected(null); setSelectedEdge(null); setSelectedNote(null); setPan({ x: 0, y: 0 }); setLibraryOpen(false);
  };


  const selNode = nodes.find((n) => n.id === selected);
  const displayMeter = viewingSessionKey ? meterFromEvents(events) : meter;
  const meterIsHistorical = !!viewingSessionKey && !running;
  const issues = validateGraph(nodes, edges);
  const nodeIssue = {};
  issues.forEach((i) => { if (i.nodeId) nodeIssue[i.nodeId] = i.level === "error" ? "error" : (nodeIssue[i.nodeId] || "warn"); });
  const errorCount = issues.filter((i) => i.level === "error").length;
  const warnCount = issues.length - errorCount;
  const canUndo = past.current.length > 0;
  const canRedo = future.current.length > 0;
  const iconBtn = (enabled) => ({
    background: "transparent", border: `1px solid ${C.border}`, color: enabled ? C.mut : C.faint,
    borderRadius: 6, padding: "7px 10px", fontSize: 13, cursor: enabled ? "pointer" : "default",
    fontFamily: MONO, opacity: enabled ? 1 : 0.5,
  });
  const menuItem = (color = C.mut) => ({ width: "100%", textAlign: "left", background: "transparent", border: "none", color, borderRadius: 5, padding: "7px 10px", fontSize: 12, cursor: "pointer", fontFamily: MONO });
  const vsep = <div style={{ width: 1, height: 20, background: C.borderSoft, flexShrink: 0 }} />;

  /* ── ⌘K command palette commands ── */
  const cmdList = [
    { g: "Add", label: "Add Agent", kw: "node llm", run: () => addNode("agent") },
    { g: "Add", label: "Add Input", run: () => addNode("input") },
    { g: "Add", label: "Add Output", run: () => addNode("output") },
    { g: "Add", label: "Add Custom Tool", kw: "function", run: () => { if (simpleMode) toggleSimpleMode(); addNode("customtool"); } },
    { g: "Add", label: "Add Router", kw: "route classify", run: () => { if (simpleMode) toggleSimpleMode(); addNode("router"); } },
    { g: "Add", label: "Add Conditional", kw: "branch if", run: () => { if (simpleMode) toggleSimpleMode(); addNode("conditional"); } },
    { g: "Add", label: "Add Parallel", kw: "fan out", run: () => { if (simpleMode) toggleSimpleMode(); addNode("parallel"); } },
    { g: "Add", label: "Add sticky note", kw: "note comment annotate memo", run: () => addNote() },
    { g: "Run", label: "Run preview", kw: "execute", run: () => run() },
    { g: "Canvas", label: "Tidy layout", kw: "arrange auto align", run: () => tidyLayout() },
    { g: "Canvas", label: "Fit to view", kw: "zoom", run: () => fitView() },
    { g: "Canvas", label: "Reset zoom to 100%", run: () => resetView() },
    { g: "Edit", label: "Duplicate selection", kw: "copy", run: () => duplicateSelection() },
    { g: "Edit", label: "Delete selection", run: () => deleteSelected() },
    { g: "Edit", label: "Undo", run: () => undo() },
    { g: "Edit", label: "Redo", run: () => redo() },
    { g: "File", label: "New harness", run: () => newHarness() },
    { g: "File", label: "Save harness", run: () => saveHarness(false) },
    { g: "File", label: "Export JSON", run: () => exportJSON() },
    { g: "File", label: "Import JSON…", run: () => fileInputRef.current?.click() },
    { g: "File", label: "Python SDK code", kw: "export code", run: () => setCodeModal(genPython(nodes, edges, budget)) },
    { g: "File", label: "Deploy (REST + SSE)", kw: "serve http", run: () => setDeployModal(genDeploy(nodes, edges, currentName || "harness")) },
    { g: "View", label: "Toggle theme (light / dark)", run: () => setTheme((t) => (t === "dark" ? "light" : "dark")) },
    { g: "View", label: `Switch to ${simpleMode ? "Advanced" : "Simple"} mode`, run: () => toggleSimpleMode() },
    { g: "View", label: "Open template gallery…", run: () => setGalleryOpen(true) },
    ...(signedIn && currentId && !IN_CLAUDE_ARTIFACT ? [{ g: "View", label: "Version history…", kw: "diff restore timeline past saves", run: () => openHistory() }] : []),
    ...(signedIn && currentId && !IN_CLAUDE_ARTIFACT ? [{ g: "View", label: "Triggers — webhook & schedule…", kw: "webhook schedule cron event automate run", run: () => openTriggers() }] : []),
    ...(signedIn && !IN_CLAUDE_ARTIFACT ? [{ g: "View", label: "Connectors & connections…", kw: "integration connect slack github notion api oauth credential catalog", run: () => openConnectors() }] : []),
    ...TEMPLATES.map((t) => ({ g: "Template", label: `Template: ${t.name}`, kw: t.desc, run: () => loadTemplate(t) })),
  ];
  const cmdQnorm = cmdQ.trim().toLowerCase();
  const cmdFiltered = cmdQnorm ? cmdList.filter((c) => `${c.label} ${c.kw || ""} ${c.g}`.toLowerCase().includes(cmdQnorm)) : cmdList;
  const runCmd = (c) => { setCmdOpen(false); if (c) setTimeout(() => c.run(), 0); };

  /* ── render ── */
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: C.bg, color: C.text, fontFamily: SANS, overflow: "hidden", transition: "background-color .35s ease, color .35s ease", "--ergon-focus": C.tool }}>
      <style>{FONT_CSS}</style>

      {/* ⌘K command palette */}
      {cmdOpen && (
        <div onClick={() => setCmdOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.55)", zIndex: 70, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "12vh 20px 20px" }}>
          <div onClick={(e) => e.stopPropagation()} className="ergon-modal" style={{ width: "min(560px, 94vw)", maxHeight: "62vh", display: "flex", flexDirection: "column", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,.5)" }}>
            <input autoFocus value={cmdQ} placeholder="Type a command…   ↑ ↓ move · ↵ run · esc close"
              onChange={(e) => { setCmdQ(e.target.value); setCmdIdx(0); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setCmdIdx((i) => Math.min(i + 1, cmdFiltered.length - 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setCmdIdx((i) => Math.max(i - 1, 0)); }
                else if (e.key === "Enter") { e.preventDefault(); runCmd(cmdFiltered[cmdIdx]); }
                else if (e.key === "Escape") { e.preventDefault(); setCmdOpen(false); }
              }}
              style={{ border: "none", borderBottom: `1px solid ${C.borderSoft}`, background: "transparent", color: C.text, fontSize: 14, fontFamily: SANS, padding: "14px 16px", outline: "none" }} />
            <div style={{ overflowY: "auto", padding: "6px 0" }}>
              {!cmdFiltered.length && <div style={{ padding: "14px 16px", color: C.faint, fontSize: 12.5 }}>No commands match “{cmdQ}”.</div>}
              {cmdFiltered.map((c, i) => {
                const newGroup = i === 0 || cmdFiltered[i - 1].g !== c.g;
                return (
                  <React.Fragment key={c.label}>
                    {newGroup && <div style={{ padding: "7px 16px 3px", fontFamily: MONO, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: C.faint }}>{c.g}</div>}
                    <button onMouseEnter={() => setCmdIdx(i)} onClick={() => runCmd(c)}
                      style={{ display: "block", width: "100%", textAlign: "left", background: i === cmdIdx ? C.accentSoft : "transparent", border: "none", borderLeft: `2px solid ${i === cmdIdx ? C.tool : "transparent"}`, color: i === cmdIdx ? C.text : C.mut, padding: "8px 16px", fontSize: 13, cursor: "pointer", fontFamily: SANS }}>
                      {c.label}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
            <div style={{ padding: "7px 16px", borderTop: `1px solid ${C.borderSoft}`, fontFamily: MONO, fontSize: 9.5, color: C.faint }}>⌘K to toggle · {cmdFiltered.length} command{cmdFiltered.length === 1 ? "" : "s"}</div>
          </div>
        </div>
      )}

      {/* top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 16px", borderBottom: `1px solid ${C.border}`, background: C.panel, flexShrink: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>ER<span style={{ color: C.agent }}>GON</span> <span style={{ color: C.faint, fontWeight: 400 }}>studio</span></div>
        <button onClick={() => { setLibraryOpen((o) => !o); loadLibrary(); }} title="Harness library"
          style={{ background: libraryOpen ? C.panel2 : "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 6, padding: "6px 10px", fontSize: 12, cursor: "pointer", fontFamily: MONO }}>
          ☰ Library{library.length ? ` ${library.length}` : ""}
        </button>
        <button onClick={() => setGalleryOpen(true)} title="Start from a template"
          style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 6, padding: "6px 10px", fontSize: 12, cursor: "pointer", fontFamily: MONO }}>
          ✦ Templates
        </button>
        <input value={currentName} onChange={(e) => setCurrentName(e.target.value)} title="Harness name"
          style={{ background: "transparent", border: "1px solid transparent", borderBottom: `1px solid ${C.borderSoft}`, color: C.text, fontSize: 13, fontFamily: SANS, padding: "4px 6px", width: 170 }} />
        <button onClick={() => saveHarness(false)} disabled={currentRole === "view"} title={currentRole === "view" ? "You have view-only access to this harness" : "Save to library (⌘S)"}
          style={{ background: "transparent", border: `1px solid ${C.border}`, color: currentRole === "view" ? C.faint : C.mut, borderRadius: 6, padding: "6px 10px", fontSize: 12, cursor: currentRole === "view" ? "default" : "pointer", fontFamily: MONO }}>
          ⤓ Save
        </button>
        {signedIn && currentId && (
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.faint }}>{currentRole === "view" ? "view-only" : ""}</span>
        )}
        <div style={{ flex: 1 }} />
        {/* edit */}
        <button onClick={undo} disabled={!canUndo} title="Undo (⌘Z)" style={iconBtn(canUndo)}>↶</button>
        <button onClick={redo} disabled={!canRedo} title="Redo (⌘⇧Z)" style={iconBtn(canRedo)}>↷</button>
        {vsep}
        {/* status */}
        <button onClick={() => setShowValidation((v) => !v)} title="Graph validation"
          style={{ background: "transparent", border: `1px solid ${errorCount ? C.output : warnCount ? C.agent : C.border}`, color: errorCount ? C.output : warnCount ? C.agent : C.faint, borderRadius: 6, padding: "7px 12px", fontSize: 12, cursor: "pointer", fontFamily: MONO }}>
          {errorCount ? `⚠ ${errorCount} error${errorCount > 1 ? "s" : ""}` : warnCount ? `⚠ ${warnCount}` : "✓ valid"}
        </button>
        {(displayMeter.calls > 0 || running) && (
          <div title={Object.entries(displayMeter.byModel).map(([m, u]) => `${m}: ${u.input + u.output} tok`).join("\n") || "token usage"}
            style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 11, color: C.mut, border: `1px solid ${meterIsHistorical ? C.tool : C.borderSoft}`, borderRadius: 6, padding: "5px 10px" }}>
            <span style={{ color: meterIsHistorical ? C.tool : C.agent }}>{meterIsHistorical ? "⏱" : "⊹"}</span>
            <span>{fmtTok(displayMeter.input + displayMeter.output)} tok</span>
            <span style={{ color: C.faint }}>·</span>
            <span style={{ color: displayMeter.cost > 0 ? C.input : C.faint }}>{fmtCost(displayMeter.cost)}</span>
            {meterIsHistorical && <span style={{ color: C.faint, fontSize: 9.5 }}>past run</span>}
          </div>
        )}
        {vsep}
        {/* overflow: share / export / account admin */}
        <input ref={fileInputRef} type="file" accept="application/json,.json" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) importJSON(f); e.target.value = ""; }} />
        <div data-popover style={{ position: "relative" }}>
          <button onClick={() => setMoreOpen((v) => !v)} title="Share, export & settings"
            style={{ background: moreOpen ? C.panel2 : "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 6, padding: "6px 11px", fontSize: 15, cursor: "pointer", fontFamily: MONO, lineHeight: 1 }}>⋯</button>
          {moreOpen && (
            <div className="ergon-popover" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 40, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 6, minWidth: 196, boxShadow: "0 8px 24px rgba(0,0,0,.3)" }}>
              <div style={{ fontSize: 9, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase", color: C.faint, padding: "4px 10px 5px" }}>Share &amp; export</div>
              <button style={menuItem()} onClick={() => { setMoreOpen(false); fileInputRef.current?.click(); }}>Import JSON</button>
              <button style={menuItem()} onClick={() => { setMoreOpen(false); exportJSON(); }}>Export JSON</button>
              <button style={menuItem(C.tool)} onClick={() => { setMoreOpen(false); setCodeModal(genPython(nodes, edges, budget)); }}>⌥ Python SDK code</button>
              <button style={menuItem(C.run)} onClick={() => { setMoreOpen(false); setDeployModal(genDeploy(nodes, edges, currentName || "harness")); }} title="Serve this harness as an HTTP endpoint (REST + SSE)">↗ Deploy — REST + SSE</button>
              {!IN_CLAUDE_ARTIFACT && <div style={{ height: 1, background: C.borderSoft, margin: "6px 4px" }} />}
              {!IN_CLAUDE_ARTIFACT && <button style={menuItem()} onClick={() => { setMoreOpen(false); setKeysOpen(true); }}>Provider keys…</button>}
              {signedIn && !IN_CLAUDE_ARTIFACT && <button style={menuItem()} onClick={() => { setMoreOpen(false); setOrgsOpen(true); }}>Organizations…</button>}
              {signedIn && !IN_CLAUDE_ARTIFACT && <button style={menuItem()} onClick={() => { setMoreOpen(false); setRunsOpen(true); }}>Run history…</button>}
              {signedIn && !!currentId && !IN_CLAUDE_ARTIFACT && <button style={menuItem()} onClick={() => { setMoreOpen(false); openHistory(); }}>⟲ Version history…</button>}
              {signedIn && !!currentId && !IN_CLAUDE_ARTIFACT && <button style={menuItem(C.run)} onClick={() => { setMoreOpen(false); openTriggers(); }}>⚡ Triggers — webhook &amp; schedule…</button>}
              {signedIn && !IN_CLAUDE_ARTIFACT && <button style={menuItem(C.tool)} onClick={() => { setMoreOpen(false); openConnectors(); }}>🔌 Connectors &amp; connections…</button>}
            </div>
          )}
        </div>
        <button onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 6, padding: "6px 9px", fontSize: 13, cursor: "pointer", lineHeight: 1, transition: "border-color .2s, color .2s" }}>
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <div data-popover style={{ position: "relative" }}>
          <button onClick={() => setBudgetOpen((v) => !v)}
            title="Set a spend cap: stop the run at a token or cost ceiling"
            style={{ background: (budget.maxTokens || budget.maxCost) ? "rgba(92,207,230,0.12)" : "transparent",
              border: `1px solid ${(budget.maxTokens || budget.maxCost) ? C.tool : C.border}`,
              color: (budget.maxTokens || budget.maxCost) ? C.tool : C.mut,
              borderRadius: 6, padding: "6px 10px", fontSize: 11.5, cursor: "pointer", fontFamily: MONO }}>
            ⛔ Budget{(budget.maxTokens || budget.maxCost) ? " ●" : ""}
          </button>
          {budgetOpen && (
            <div className="ergon-popover" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 40, background: C.panel,
              border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, width: 236, boxShadow: "0 8px 24px rgba(0,0,0,.3)" }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 8 }}>Run spend cap</div>
              <div style={{ fontSize: 10.5, color: C.mut, marginBottom: 10, lineHeight: 1.5 }}>
                Stops the run before the next model call once either ceiling is crossed. Blank = off.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ fontSize: 10.5, color: C.mut }}>Max total tokens
                  <input type="number" min={0} step={1000} placeholder="e.g. 50000" value={budget.maxTokens}
                    onChange={(e) => setBudget((b) => ({ ...b, maxTokens: e.target.value }))}
                    style={{ ...inputStyle, marginTop: 3, width: "100%" }} />
                </label>
                <label style={{ fontSize: 10.5, color: C.mut }}>Max cost (USD $)
                  <input type="number" min={0} step={0.01} placeholder="e.g. 0.50" value={budget.maxCost}
                    onChange={(e) => setBudget((b) => ({ ...b, maxCost: e.target.value }))}
                    style={{ ...inputStyle, marginTop: 3, width: "100%" }} />
                </label>
                {(budget.maxTokens || budget.maxCost) && (
                  <button onClick={() => setBudget({ maxTokens: "", maxCost: "" })}
                    style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 5, padding: "5px", fontSize: 11, cursor: "pointer", marginTop: 2 }}>
                    Clear caps
                  </button>
                )}
                <div style={{ fontSize: 9.5, color: C.faint, lineHeight: 1.5, marginTop: 2 }}>
                  Exports to the SDK as <span style={{ fontFamily: MONO }}>max_total_tokens</span> / <span style={{ fontFamily: MONO }}>max_cost</span> on every agent.
                </div>
              </div>
            </div>
          )}
        </div>
        {collabOn && collabViewers.length > 0 && (
          <div title="People viewing this harness now" style={{ display: "flex", alignItems: "center", marginRight: 2 }}>
            {collabViewers.slice(0, 5).map((v, i) => (
              <span key={v.id} title={`${v.email}${v.selection ? " · on a block" : ""}`}
                style={{ width: 24, height: 24, borderRadius: "50%", background: userColor(v.id), color: "#0D1410", fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", border: `2px solid ${C.panel}`, marginLeft: i ? -8 : 0, fontFamily: MONO }}>{initials(v.email)}</span>
            ))}
            {collabViewers.length > 5 && <span style={{ marginLeft: 3, fontSize: 10, color: C.faint, fontFamily: MONO }}>+{collabViewers.length - 5}</span>}
          </div>
        )}
        {auth.available && (signedIn ? (
          <div data-popover style={{ position: "relative" }}>
            <button onClick={() => setUserMenuOpen((v) => !v)} title={`Signed in as ${user.email}`}
              style={{ background: "transparent", border: `1px solid ${C.borderSoft}`, color: C.mut, borderRadius: 6, padding: "6px 10px", fontSize: 11.5, cursor: "pointer", fontFamily: MONO, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              ◔ {user.email.split("@")[0]} ▾
            </button>
            {userMenuOpen && (
              <div className="ergon-popover" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 40, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 6, minWidth: 180, boxShadow: "0 8px 24px rgba(0,0,0,.3)" }}>
                <div style={{ padding: "6px 10px", fontSize: 10.5, color: C.faint, borderBottom: `1px solid ${C.borderSoft}`, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis" }}>
                  Signed in as<br /><span style={{ color: C.mut, fontSize: 11.5 }}>{user.email}</span>
                </div>
                <button onClick={() => { setUserMenuOpen(false); signOut(); }}
                  style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", color: C.output, borderRadius: 5, padding: "7px 10px", fontSize: 12, cursor: "pointer", fontFamily: MONO }}>
                  Sign out
                </button>
              </div>
            )}
          </div>
        ) : (
          <button onClick={() => setAuthOpen(true)} title="Sign in to save & share harnesses on the server"
            style={{ background: "transparent", border: `1px solid ${C.link}`, color: C.link, borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontFamily: MONO }}>
            Sign in
          </button>
        ))}
        {vsep}
        <button onClick={run} disabled={running} title="Run the preview (executes the graph in your browser)"
          style={{ background: running ? C.panel2 : C.run, border: "none", color: running ? C.mut : C.onAccent, borderRadius: 6, padding: "7px 22px", fontSize: 13, fontWeight: 700, cursor: running ? "default" : "pointer", boxShadow: running ? "none" : `0 1px 8px ${C.run}55` }}>{running ? "Running…" : "▶ Run"}</button>
      </div>

      {/* validation / import panel */}
      {showValidation && (
        <div style={{ borderBottom: `1px solid ${C.border}`, background: C.panel2, padding: "10px 16px", maxHeight: 200, overflowY: "auto", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", color: C.faint }}>
              Graph check {errorCount ? `· ${errorCount} error(s)` : ""} {warnCount ? `· ${warnCount} warning(s)` : ""}
            </div>
            <button aria-label="Close" onClick={() => { setShowValidation(false); setImportError(null); }} style={{ background: "transparent", border: "none", color: C.faint, cursor: "pointer", fontSize: 14 }}>✕</button>
          </div>
          {importError && importError.msgs.map((m, i) => (
            <div key={`imp${i}`} style={{ fontSize: 12.5, color: importError.level === "error" ? C.output : C.agent, padding: "2px 0" }}>
              {importError.level === "error" ? "✕ Import failed: " : "⚠ Import note: "}{m}
            </div>
          ))}
          {!issues.length && !importError && <div style={{ fontSize: 12.5, color: C.input }}>✓ No problems found — the graph is ready to run.</div>}
          {issues.map((iss, i) => (
            <button key={i} onClick={() => { if (iss.nodeId) { setSelected(iss.nodeId); setSelectedEdge(null); } }}
              style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", cursor: iss.nodeId ? "pointer" : "default", padding: "2px 0", fontSize: 12.5, color: iss.level === "error" ? C.output : C.agent, fontFamily: SANS }}>
              {iss.level === "error" ? "✕ " : "⚠ "}{iss.msg}{iss.nodeId ? "  ↗" : ""}
            </button>
          ))}
        </div>
      )}

      {/* template gallery */}
      {galleryOpen && (
        <div onClick={() => { markOnboarded(); setGalleryOpen(false); }} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.78)", zIndex: 65, display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
          <div className="ergon-modal" onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, width: "min(860px, 95vw)", maxHeight: "86vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "20px 24px 12px" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 18 }}>Start building</div>
                <div style={{ color: C.faint, fontSize: 12.5, marginTop: 3 }}>Pick a template to learn the patterns, or start from a blank canvas.</div>
              </div>
              <button aria-label="Close" onClick={() => { markOnboarded(); setGalleryOpen(false); }} style={{ background: "transparent", border: "none", color: C.faint, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ overflowY: "auto", padding: "4px 24px 22px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(236px, 1fr))", gap: 12 }}>
                <button onClick={() => { newHarness(); markOnboarded(); setGalleryOpen(false); }}
                  style={{ textAlign: "left", background: C.panel2, border: `1px dashed ${C.border}`, borderRadius: 9, padding: "14px 15px", cursor: "pointer", color: C.text, minHeight: 116, display: "flex", flexDirection: "column" }}>
                  <div style={{ fontSize: 22, marginBottom: 6, color: C.run }}>＋</div>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>Blank canvas</div>
                  <div style={{ fontSize: 11.5, color: C.faint, lineHeight: 1.4, marginTop: 3 }}>The default starter: Input → agent → Output, with a tool and a peer to explore.</div>
                </button>
                {TEMPLATES.map((t) => {
                  const st = templateStats[t.id];
                  const tags = st ? [`${st.nodes} blocks`, st.agents ? `${st.agents} agent${st.agents > 1 ? "s" : ""}` : null, st.router ? "router" : null, st.parallel ? "parallel" : null, st.conditional ? "conditional" : null, st.tool ? "tool" : null].filter(Boolean) : [];
                  return (
                    <button key={t.id} onClick={() => { loadTemplate(t); markOnboarded(); setGalleryOpen(false); }}
                      style={{ textAlign: "left", background: C.panel2, border: `1px solid ${C.borderSoft}`, borderRadius: 9, padding: "14px 15px", cursor: "pointer", color: C.text, minHeight: 116, display: "flex", flexDirection: "column" }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700 }}>{t.name}</div>
                      <div style={{ fontSize: 11.5, color: C.mut, lineHeight: 1.45, marginTop: 4, flex: 1 }}>{t.desc}</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 10 }}>
                        {tags.map((tg) => <span key={tg} style={{ fontFamily: MONO, fontSize: 9, color: C.mut, border: `1px solid ${C.borderSoft}`, borderRadius: 3, padding: "1px 5px" }}>{tg}</span>)}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* pre-run preflight (advisory) */}
      {preflightModal && (
        <div onClick={() => setPreflightModal(null)} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.7)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
          <div className="ergon-modal" onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(560px, 94vw)", maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "16px 20px 10px" }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 3 }}>Before you run</div>
              <div style={{ color: C.faint, fontSize: 12, lineHeight: 1.5 }}>
                These won't stop the run, but they're the kind of thing that silently produces no answer or fails mid-run. Fix what applies, or run anyway.
              </div>
            </div>
            <div style={{ overflowY: "auto", padding: "4px 20px 12px", flex: 1 }}>
              {preflightModal.issues.map((iss, i) => (
                <div key={i} style={{ borderLeft: `3px solid ${iss.level === "block" ? C.output : C.agent}`, background: C.panel2, borderRadius: 6, padding: "10px 12px", marginBottom: 8 }}>
                  <div style={{ fontSize: 12.5, color: iss.level === "block" ? C.output : C.agent, fontWeight: 600, lineHeight: 1.45 }}>
                    {iss.level === "block" ? "✕ " : "⚠ "}{iss.msg}
                  </div>
                  {iss.fix && <div style={{ fontSize: 11.5, color: C.mut, marginTop: 5, lineHeight: 1.5 }}>→ {iss.fix}</div>}
                  {iss.nodeId && (
                    <button onClick={() => { setSelected(iss.nodeId); setSelectedEdge(null); setPreflightModal(null); }}
                      style={{ marginTop: 7, background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 5, padding: "4px 9px", fontSize: 11, cursor: "pointer", fontFamily: MONO }}>
                      Select block ↗
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", padding: "12px 20px", borderTop: `1px solid ${C.borderSoft}` }}>
              <button onClick={() => setPreflightModal(null)} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 6, padding: "8px 16px", fontSize: 12.5, cursor: "pointer", fontFamily: MONO }}>Cancel</button>
              <button onClick={() => executeRun()} style={{ background: C.run, border: "none", color: C.onAccent, borderRadius: 6, padding: "8px 18px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>Run anyway ▶</button>
            </div>
          </div>
        </div>
      )}

      {/* harness library drawer */}
      {libraryOpen && (
        <div style={{ position: "absolute", top: 52, left: 0, bottom: 0, width: 320, background: C.panel, borderRight: `1px solid ${C.border}`, zIndex: 40, display: "flex", flexDirection: "column", boxShadow: "6px 0 24px rgba(0,0,0,.35)" }}>
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.borderSoft}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: C.mut }}>Harness library</div>
            <button aria-label="Close" onClick={() => setLibraryOpen(false)} style={{ background: "transparent", border: "none", color: C.faint, cursor: "pointer", fontSize: 15 }}>✕</button>
          </div>
          <div style={{ padding: 12, display: "flex", gap: 8, borderBottom: `1px solid ${C.borderSoft}` }}>
            <button onClick={newHarness} style={{ flex: 1, background: C.panel2, border: `1px solid ${C.borderSoft}`, color: C.text, borderRadius: 6, padding: "8px 10px", fontSize: 12, cursor: "pointer" }}>+ New</button>
            <button onClick={() => saveHarness(true)} style={{ flex: 1, background: C.panel2, border: `1px solid ${C.borderSoft}`, color: C.text, borderRadius: 6, padding: "8px 10px", fontSize: 12, cursor: "pointer" }}>⧉ Save as new</button>
          </div>
          <div style={{ padding: "10px 12px 8px", borderBottom: `1px solid ${C.borderSoft}` }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", color: C.faint, marginBottom: 8 }}>Start from a template</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {TEMPLATES.map((t) => (
                <button key={t.id} onClick={() => loadTemplate(t)} title={t.desc}
                  style={{ textAlign: "left", background: C.panel2, border: `1px solid ${C.borderSoft}`, borderRadius: 6, padding: "7px 9px", cursor: "pointer", color: C.text }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t.name}</div>
                  <div style={{ fontSize: 10.5, color: C.faint, lineHeight: 1.35, marginTop: 1 }}>{t.desc}</div>
                </button>
              ))}
            </div>
          </div>
          <div style={{ padding: "10px 12px 2px", fontFamily: MONO, fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", color: C.faint }}>Saved harnesses</div>
          <div style={{ overflowY: "auto", flex: 1, padding: 8 }}>
            {!library.length && <div style={{ color: C.faint, fontSize: 12.5, padding: "12px 8px", lineHeight: 1.6 }}>No saved harnesses yet. Design one on the canvas, name it up top, and press <b style={{ color: C.mut }}>⤓ Save</b>.</div>}
            {library.map((h) => (
              <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 8px", borderRadius: 6, marginBottom: 3, background: currentId === h.id ? C.panel2 : "transparent", border: `1px solid ${currentId === h.id ? C.border : "transparent"}` }}>
                <button onClick={() => openHarness(h.id)} style={{ flex: 1, textAlign: "left", background: "transparent", border: "none", cursor: "pointer", color: C.text, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {h.name}
                    {h.role && h.role !== "owner" && <span style={{ color: C.link, fontSize: 9, marginLeft: 6, fontFamily: MONO, border: `1px solid ${C.borderSoft}`, borderRadius: 3, padding: "0 4px" }}>{h.role}</span>}
                    {currentId === h.id && <span style={{ color: C.input, fontSize: 10, marginLeft: 6 }}>● open</span>}
                  </div>
                  <div style={{ fontSize: 10.5, color: C.faint, fontFamily: MONO }}>
                    {h.role && h.role !== "owner" && h.ownerEmail ? `${h.ownerEmail} · ` : h.nodeCount != null ? `${h.nodeCount} blocks · ` : ""}{h.updated ? new Date(h.updated).toLocaleDateString() : "—"}
                  </div>
                </button>
                <button onClick={() => duplicateHarness(h.id)} title="Duplicate" style={{ background: "transparent", border: "none", color: C.faint, cursor: "pointer", fontSize: 13 }}>⧉</button>
                {(h.role === "edit" || h.role == null) && (
                  <button onClick={() => { if (window.confirm(`Delete "${h.name}"?`)) deleteHarness(h.id); }} title="Delete (org owners & admins)" style={{ background: "transparent", border: "none", color: C.output, cursor: "pointer", fontSize: 13 }}>🗑</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ width: 188, borderRight: `1px solid ${C.border}`, background: C.panel, padding: 12, flexShrink: 0, overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.4, color: C.faint, textTransform: "uppercase" }}>Add a block</div>
          </div>
          {/* guided mode toggle */}
          <div style={{ display: "flex", border: `1px solid ${C.borderSoft}`, borderRadius: 6, overflow: "hidden", marginBottom: 12 }}>
            {[["simple", "Simple"], ["advanced", "Advanced"]].map(([k, lbl]) => {
              const on = (k === "simple") === simpleMode;
              return (
                <button key={k} onClick={() => { if (on) return; toggleSimpleMode(); }}
                  title={k === "simple" ? "Just Input → agents → Output" : "All blocks: routers, parallel, conditionals, custom tools, peer links"}
                  style={{ flex: 1, background: on ? C.accentSoft : "transparent", color: on ? C.text : C.faint, border: "none", padding: "6px 4px", fontSize: 11, fontFamily: MONO, cursor: on ? "default" : "pointer", fontWeight: on ? 700 : 400 }}>
                  {lbl}
                </button>
              );
            })}
          </div>
          <div style={{ position: "relative", marginBottom: 10 }}>
            <input value={paletteQuery} onChange={(e) => setPaletteQuery(e.target.value)} placeholder="Search blocks…"
              style={{ ...inputStyle, width: "100%", fontSize: 11.5, padding: "6px 24px 6px 9px" }} />
            {paletteQuery && <button onClick={() => setPaletteQuery("")} title="Clear" style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", color: C.faint, cursor: "pointer", fontSize: 13 }}>✕</button>}
          </div>
          {(() => {
            const q = paletteQuery.trim().toLowerCase();
            const list = Object.entries(NODE_TYPES)
              .filter(([type]) => !simpleMode || SIMPLE_NODE_TYPES.has(type))
              .filter(([, m]) => !q || m.label.toLowerCase().includes(q) || m.desc.toLowerCase().includes(q));
            if (!list.length) return <div style={{ fontSize: 11, color: C.faint, padding: "4px 2px 8px" }}>No blocks match “{paletteQuery}”.{simpleMode ? " Try Advanced mode." : ""}</div>;
            return list.map(([type, m]) => (
              <button key={type} onClick={() => addNode(type)} style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 8, background: C.panel2, border: `1px solid ${C.borderSoft}`, borderLeft: `3px solid ${typeColor(type)}`, borderRadius: 6, padding: "9px 10px", cursor: "pointer", color: C.text }}>
                <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 7 }}><NodeIcon type={type} color={typeColor(type)} size={15} />{m.label}</div>
                <div style={{ fontSize: 11, color: C.mut, marginTop: 3, lineHeight: 1.35 }}>{m.desc}</div>
              </button>
            ));
          })()}
          <button onClick={addNote} title="Drop a sticky note on the canvas"
            style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left", marginTop: 2, background: "transparent", border: `1px dashed ${C.border}`, borderRadius: 6, padding: "8px 10px", cursor: "pointer", color: C.mut, fontFamily: MONO, fontSize: 12 }}>
            <span style={{ display: "inline-flex", width: 15, height: 15, alignItems: "center", justifyContent: "center", fontSize: 13 }}>🗒</span>
            Sticky note
          </button>
          <div style={{ marginTop: 14, fontSize: 11, color: C.faint, lineHeight: 1.6, borderTop: `1px solid ${C.borderSoft}`, paddingTop: 10 }}>
            <span style={{ color: C.agent }}>—</span> flow: left → right<br />
            {!simpleMode && <><span style={{ color: C.tool }}>┈</span> tools: agent belly ↓<br /></>}
            {!simpleMode && <><span style={{ color: C.link }}>┈</span> peers: agent top ↔ agent top<br /></>}
            {simpleMode
              ? <><br />Routers, parallel, conditionals & custom tools live in <span style={{ color: C.text }}>Advanced</span>.</>
              : <><br />Web search rides on every agent by default — the kill switch lives in Safety.</>}
            <br /><br /><span style={{ color: C.mut }}>Shift-drag</span> to box-select · <span style={{ fontFamily: MONO }}>⌘C/⌘V/⌘D</span> copy/paste/dup · <span style={{ color: C.mut }}>Tidy</span> auto-arranges.
          </div>
        </div>

        {/* canvas */}
        <div ref={canvasRef} onPointerDown={onCanvasDown} onPointerMove={onMove} onPointerUp={onUp}
          onPointerLeave={() => { if (collabOn && cursorRef.current) { cursorRef.current = null; cloud.presence(currentId, selectionRef.current, null).catch(() => {}); } }}
          style={{ flex: 1, position: "relative", overflow: "hidden", backgroundColor: C.bg, backgroundImage: `radial-gradient(circle, ${C.canvasDot} 1px, transparent 1px)`, backgroundSize: "26px 26px", backgroundPosition: `${pan.x}px ${pan.y}px`, transition: "background-color .35s ease" }}>
          <div style={{ position: "absolute", transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0", inset: 0 }}>
            {/* sticky notes — behind edges & nodes (canvas annotations) */}
            {notes.map((nt) => {
              const col = noteColors(nt.color), sel = selectedNote === nt.id, editing = noteEdit === nt.id;
              return (
                <div key={nt.id} onPointerDown={(e) => onNoteDown(e, nt)}
                  onDoubleClick={(e) => { e.stopPropagation(); setNoteEdit(nt.id); setSelectedNote(nt.id); }}
                  style={{ position: "absolute", left: nt.x, top: nt.y, width: nt.w, height: nt.h, zIndex: 0,
                    background: col.bg, border: `1px solid ${sel ? col.tx : col.bd}`, borderRadius: 8,
                    boxShadow: sel ? `0 0 0 1.5px ${col.tx}, 0 8px 22px rgba(0,0,0,.3)` : "0 3px 12px rgba(0,0,0,.22)",
                    display: "flex", flexDirection: "column", cursor: editing ? "default" : "grab", overflow: "hidden" }}>
                  {/* drag grip bar */}
                  <div style={{ height: 14, flex: "0 0 14px", display: "flex", alignItems: "center", gap: 3, padding: "0 7px", opacity: 0.5 }}>
                    <span style={{ width: 3, height: 3, borderRadius: 2, background: col.tx }} />
                    <span style={{ width: 3, height: 3, borderRadius: 2, background: col.tx }} />
                    <span style={{ width: 3, height: 3, borderRadius: 2, background: col.tx }} />
                  </div>
                  {editing ? (
                    <textarea autoFocus value={nt.text} onChange={(e) => setNoteText(nt.id, e.target.value)}
                      onPointerDown={(e) => e.stopPropagation()} onBlur={() => setNoteEdit(null)}
                      onFocus={() => { if (!dragRef.current) past.current.push(snapshot()); future.current = []; }}
                      placeholder="Write a note…"
                      style={{ flex: 1, width: "100%", resize: "none", background: "transparent", border: "none", outline: "none",
                        color: col.tx, fontFamily: MONO, fontSize: 12.5, lineHeight: 1.5, padding: "2px 10px 10px", boxSizing: "border-box" }} />
                  ) : (
                    <div style={{ flex: 1, overflow: "hidden", padding: "2px 10px 10px", color: col.tx, fontFamily: MONO, fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {nt.text || <span style={{ opacity: 0.5 }}>Double-click to edit</span>}
                    </div>
                  )}
                  {/* selected: color swatches + delete */}
                  {sel && (
                    <div onPointerDown={(e) => e.stopPropagation()} style={{ position: "absolute", top: -30, left: 0, display: "flex", alignItems: "center", gap: 5, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 7, padding: "4px 6px", boxShadow: "0 4px 14px rgba(0,0,0,.35)" }}>
                      {NOTE_COLOR_KEYS.map((k) => { const cc = noteColors(k); return (
                        <button key={k} aria-label={`Color ${k}`} onClick={() => recolorNote(nt.id, k)}
                          style={{ width: 15, height: 15, borderRadius: "50%", background: cc.bg, border: `1.5px solid ${nt.color === k ? C.text : cc.bd}`, cursor: "pointer", padding: 0 }} />
                      ); })}
                      <span style={{ width: 1, height: 15, background: C.borderSoft, margin: "0 1px" }} />
                      <button aria-label="Delete note" onClick={() => deleteNote(nt.id)} style={{ background: "transparent", border: "none", color: C.faint, cursor: "pointer", fontSize: 13, lineHeight: 1 }}>✕</button>
                    </div>
                  )}
                  {/* resize handle */}
                  <div onPointerDown={(e) => onNoteResizeDown(e, nt)} style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize", display: "flex", alignItems: "flex-end", justifyContent: "flex-end", padding: 2 }}>
                    <svg width="8" height="8" viewBox="0 0 8 8" style={{ opacity: 0.55 }}><path d="M8 0 L8 8 L0 8" fill="none" stroke={col.tx} strokeWidth="1" /><path d="M8 4 L4 8 M8 7 L7 8" stroke={col.tx} strokeWidth="1" /></svg>
                  </div>
                </div>
              );
            })}
            <svg style={{ position: "absolute", overflow: "visible", width: 1, height: 1, zIndex: 1 }}>
              {edges.map((e) => {
                const a = nodes.find((n) => n.id === e.from), b = nodes.find((n) => n.id === e.to);
                if (!a || !b) return null;
                const p1 = portPos(a)[e.fromPort], p2 = portPos(b)[e.toPort];
                const active = activeEdges.has(e.id), sel = selectedEdge === e.id;
                const color = e.kind === "tool" ? C.tool : e.kind === "link" ? C.link : e.kind === "dispatch" ? C.link : C.agent;
                const canInsert = e.kind === "flow";
                const showPlus = canInsert && (hoverEdge === e.id || (edgeInsert && edgeInsert.edgeId === e.id));
                return (
                  <g key={e.id}
                    onPointerOver={canInsert ? () => setHoverEdge(e.id) : undefined}
                    onPointerOut={canInsert ? (ev) => { if (!ev.currentTarget.contains(ev.relatedTarget)) setHoverEdge((h) => (h === e.id ? null : h)); } : undefined}>
                    <path d={edgePath(p1, p2, e.kind)} stroke="transparent" strokeWidth={14} fill="none" style={{ cursor: "pointer", pointerEvents: "stroke" }}
                      onPointerDown={(ev) => { ev.stopPropagation(); setSelectedEdge(e.id); setSelected(null); }} />
                    <path className={active ? "edge-active" : ""} d={edgePath(p1, p2, e.kind)} stroke={sel ? C.text : color} strokeWidth={sel ? 2.6 : 2} fill="none"
                      strokeLinecap="round"
                      strokeDasharray={active ? "7 7" : e.kind === "flow" ? "none" : e.kind === "link" ? "1.5 5" : e.kind === "dispatch" ? "6 4" : "4 4"}
                      style={active ? { animation: "flowdash .5s linear infinite" } : {}} opacity={active ? 1 : 0.75} pointerEvents="none" />
                    {/* direction arrowhead on the line (clear of the port dots) */}
                    {(e.kind === "flow" || e.kind === "dispatch" || e.kind === "link") && !showPlus && (() => {
                      const md = edgeMid(p1, p2, e.kind);
                      return <path d="M-3.4 -4 L4.6 0 L-3.4 4 Z" fill={sel ? C.text : color} opacity={active ? 1 : 0.9}
                        transform={`translate(${md.x} ${md.y}) rotate(${md.angle})`} pointerEvents="none" />;
                    })()}
                    {/* insert-on-edge "+" affordance (flow edges only) */}
                    {showPlus && (() => {
                      const md = edgeMid(p1, p2, e.kind);
                      const openK = edgeInsert && edgeInsert.edgeId === e.id;
                      return (
                        <g transform={`translate(${md.x} ${md.y})`} style={{ cursor: "pointer" }}
                          onPointerDown={(ev) => {
                            ev.stopPropagation();
                            setEdgeInsert(openK ? null : { edgeId: e.id, sx: md.x * zoom + pan.x, sy: md.y * zoom + pan.y });
                          }}>
                          <circle r={11} fill={C.panel} stroke={openK ? C.accent : color} strokeWidth={1.5} />
                          <path d="M-5 0 L5 0 M0 -5 L0 5" stroke={openK ? C.accent : color} strokeWidth={1.8} strokeLinecap="round" />
                        </g>
                      );
                    })()}
                    {e.kind === "link" && (() => { const mx = (p1.x + p2.x) / 2, my = Math.min(p1.y, p2.y) - Math.max(36, Math.abs(p2.y - p1.y) * 0.5) * 0.75;
                      return <text x={mx} y={my} fill={C.link} fontSize="10" fontFamily={MONO} textAnchor="middle" pointerEvents="none">ask</text>; })()}
                  </g>
                );
              })}
              {pending && (() => {
                const n = nodes.find((x) => x.id === pending.nodeId); if (!n) return null;
                const p1 = portPos(n)[pending.port];
                const kind = portEdgeKind(pending.port);
                const col = kind === "tool" ? C.tool : kind === "link" ? C.link : kind === "dispatch" ? C.link : C.agent;
                return (
                  <g pointerEvents="none">
                    <path d={edgePath(p1, { x: pending.x, y: pending.y }, kind)} stroke={col} strokeWidth={2} strokeDasharray="5 5" fill="none" opacity={0.85} />
                    <text x={pending.x + 12} y={pending.y - 10} fill={col} fontSize="10.5" fontFamily={MONO} style={{ paintOrder: "stroke" }} stroke={C.bg} strokeWidth={3}>{portEdgeLabel(pending.port)}</text>
                  </g>
                );
              })()}
              {marquee && (() => {
                const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
                const w = Math.abs(marquee.x1 - marquee.x0), h = Math.abs(marquee.y1 - marquee.y0);
                return <rect x={x} y={y} width={w} height={h} fill={`${C.tool}18`} stroke={C.tool} strokeWidth={1} strokeDasharray="4 3" pointerEvents="none" />;
              })()}
            </svg>

            {nodes.map((n) => {
              const m = NODE_TYPES[n.type], sel = selected === n.id || multiSel.has(n.id), pp = portPos(n);
              const issueLevel = nodeIssue[n.id];
              const title = n.type === "agent" || n.type === "customtool" ? n.config.name : m.label;
              const routerChips = n.type === "router" ? (n.config.labels || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 4)
                : n.type === "conditional" ? (() => { const p = parseConditions(n.config.rules); return [...p.rules.map((r) => r.label), ...(p.elseLabel ? [p.elseLabel] : [])].slice(0, 4); })()
                : n.type === "parallel" ? [n.config.join ? "join" : "concat"] : [];
              const chips = n.type === "agent" ? [
                n.config.mode === "custom" ? (n.config.customMode || "custom") : n.config.mode,
                `≤${n.config.maxIterations} it`,
                n.config.allowInternet ? "web ✓" : "web ✕",
                n.config.compaction ? "compact" : null,
                n.config.loopEnabled ? "loop" : null,
              ].filter(Boolean) : [];
              const sub = n.type === "input" ? `"${(n.config.message || "").slice(0, 30)}…"`
                : n.type === "customtool" ? (n.config.mode === "javascript" ? "javascript" : n.config.mode === "http" ? "HTTP endpoint" : "simulated by Claude")
                : n.type === "output" ? (outputs[n.id] ? outputs[n.id].replace(/\s+/g, " ").slice(0, 44) + "…" : "final answer") : "";
              const watchers = collabOn ? collabViewers.filter((v) => v.selection === n.id) : [];
              const cCount = collabOn ? comments.filter((c) => c.nodeId === n.id && !c.resolved).length : 0;
              const watchRing = watchers.length ? `0 0 0 2px ${userColor(watchers[0].id)}` : null;
              const status = nodeStatus[n.id];
              const statusCol = status === "running" ? C.agent : status === "done" ? C.run : status === "error" ? C.output : null;
              const hovered = hoverNode === n.id;
              const baseShadow = hovered ? "0 10px 26px rgba(0,0,0,.5)" : "0 4px 14px rgba(0,0,0,.35)";
              const coreShadow = sel ? `0 0 0 1.5px ${typeColor(n.type)}, 0 12px 30px rgba(0,0,0,.5)`
                : issueLevel ? `0 0 0 1px ${issueLevel === "error" ? C.output : C.agent}55, ${baseShadow}` : baseShadow;
              return (
                <div key={n.id}>
                  <div className="ergon-node" onPointerDown={(e) => onNodeDown(e, n)}
                    onMouseEnter={() => setHoverNode(n.id)} onMouseLeave={() => setHoverNode((h) => (h === n.id ? null : h))}
                    onDoubleClick={(e) => { e.stopPropagation(); if (!nodeEdit || nodeEdit.id !== n.id) openQuickEdit(n); }}
                    title={QUICK_FIELD[n.type] ? `Double-click to edit ${QUICK_FIELD[n.type].label.toLowerCase()}` : undefined}
                    style={{ position: "absolute", left: n.x, top: n.y, width: NODE_W, height: NODE_H, background: C.panel2, borderRadius: 10, zIndex: hovered || sel ? 4 : 3, cursor: "grab",
                      border: `1px solid ${sel ? typeColor(n.type) : issueLevel === "error" ? C.output : issueLevel === "warn" ? C.agent : hovered ? C.mut : C.border}`,
                      boxShadow: [watchRing, coreShadow].filter(Boolean).join(", "),
                      transform: hovered ? "translateY(-1.5px)" : "none",
                      transition: "box-shadow .15s ease, transform .12s ease, border-color .15s ease",
                      animation: status === "running" ? "pulse 1.8s ease-in-out infinite" : "none" }}>
                    {status && (
                      <div style={{ position: "absolute", top: -8, left: -6, display: "flex", alignItems: "center", gap: 3, background: C.panel, border: `1px solid ${statusCol}`, borderRadius: 9, padding: "1px 6px", fontSize: 8.5, fontFamily: MONO, color: statusCol, textTransform: "uppercase", letterSpacing: 0.4, zIndex: 6, boxShadow: "0 2px 6px rgba(0,0,0,.35)" }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: statusCol, animation: status === "running" ? "pulse 1s ease-in-out infinite" : "none" }} />
                        {status === "running" ? "running" : status === "done" ? "✓ done" : "✕ error"}
                      </div>
                    )}
                    {watchers.length > 0 && (
                      <div style={{ position: "absolute", top: -9, right: -4, display: "flex", zIndex: 6 }}>
                        {watchers.slice(0, 3).map((w, i) => (
                          <span key={w.id} title={`${w.email} is here`} style={{ width: 16, height: 16, borderRadius: "50%", background: userColor(w.id), color: "#0D1410", fontSize: 8, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", border: `1.5px solid ${C.bg}`, marginLeft: i ? -5 : 0, fontFamily: MONO }}>{initials(w.email)}</span>
                        ))}
                      </div>
                    )}
                    {collabOn && (
                      <div onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setSelected(n.id); setCommentPanel({ nodeId: n.id }); }}
                        title={cCount ? `${cCount} open comment${cCount > 1 ? "s" : ""}` : "Add a comment"}
                        style={{ position: "absolute", bottom: 6, right: 8, fontSize: 10, fontFamily: MONO, color: cCount ? C.agent : C.faint, cursor: "pointer", display: "flex", alignItems: "center", gap: 2, zIndex: 6 }}>
                        <span style={{ fontSize: 11 }}>💬</span>{cCount ? <span>{cCount}</span> : null}
                      </div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px 4px" }}>
                      <NodeIcon type={n.type} color={typeColor(n.type)} size={17} />
                      {nodeEdit && nodeEdit.id === n.id && nodeEdit.field === "name" ? (
                        <input autoFocus defaultValue={n.config.name} spellCheck={false}
                          onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
                          onBlur={(e) => { updateConfig(n.id, { name: e.target.value.trim() || n.config.name }); setNodeEdit(null); }}
                          onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); else if (e.key === "Escape") setNodeEdit(null); }}
                          style={{ fontWeight: 600, fontSize: 13.5, fontFamily: SANS, background: C.bg, border: `1px solid ${typeColor(n.type)}`, borderRadius: 4, color: C.text, padding: "0 5px", width: 150 }} />
                      ) : (
                        <span onDoubleClick={hasEditableName(n.type) ? (e) => { e.stopPropagation(); setSelected(n.id); setNodeEdit({ id: n.id, field: "name" }); } : undefined}
                          title={hasEditableName(n.type) ? "Double-click to rename" : undefined}
                          style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: hasEditableName(n.type) ? "text" : "grab" }}>{title}</span>
                      )}
                    </div>
                    {(n.type === "agent" || n.type === "router" || n.type === "conditional" || n.type === "parallel") ? (
                      <div style={{ padding: "2px 12px 0", display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                        {(n.type === "agent" || n.type === "router" || n.type === "parallel") && (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, border: `1px solid ${C.borderSoft}`, borderRadius: 3, padding: "1px 4px 1px 2px" }}>
                            <ProviderMark provider={n.config.provider} size={12} />
                            <span style={{ fontFamily: MONO, fontSize: 9, color: C.mut }}>{provModelShort(n.config)}</span>
                          </span>
                        )}
                        {(n.type === "agent" ? chips : routerChips).map((c) => <span key={c} style={{ fontFamily: MONO, fontSize: 9, color: C.mut, border: `1px solid ${C.borderSoft}`, borderRadius: 3, padding: "1px 5px" }}>{c}</span>)}
                        {nodeOutputs[n.id] != null && (
                          <span onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setSelected(n.id); setOutputPanel({ nodeId: n.id }); }}
                            title="View this block's last output" style={{ fontFamily: MONO, fontSize: 9, color: C.tool, border: `1px solid ${C.tool}66`, borderRadius: 3, padding: "1px 5px", cursor: "pointer" }}>⤷ out</span>
                        )}
                      </div>
                    ) : (
                      <div style={{ padding: "0 12px", fontFamily: MONO, fontSize: 10.5, color: C.mut, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
                    )}
                    <div style={{ position: "absolute", bottom: 7, left: 12, fontSize: 9.5, fontFamily: MONO, letterSpacing: 1, color: C.faint, textTransform: "uppercase" }}>{m.label}</div>
                  </div>
                  {m.ports.filter((port) => {
                    if (!simpleMode || !ADVANCED_PORTS.has(port)) return true;
                    // in simple mode hide advanced ports unless an edge already uses them
                    return edges.some((e) => (e.from === n.id && e.fromPort === port) || (e.to === n.id && e.toPort === port));
                  }).map((port) => {
                    const dragging = !!pending;
                    const isSource = dragging && pending.nodeId === n.id && pending.port === port;
                    const isValidTarget = dragging && pending.nodeId !== n.id && portsConnectable(pending.port, port);
                    const pcol = port === "tools" ? C.tool : port === "mesh" || port === "routes" ? C.link : port === "fan" ? C.parallel : typeColor(n.type);
                    return (
                      <React.Fragment key={port}>
                        <div style={{ ...portLabelStyle(port, pp[port]), color: dragging && isValidTarget ? pcol : C.faint, opacity: dragging && !isSource && !isValidTarget ? 0.2 : 0.8 }}>{PORT_LABELS[port] || port}</div>
                        <Port x={pp[port].x} y={pp[port].y} color={pcol}
                          title={dragging ? (isValidTarget ? `drop to create a ${portEdgeLabel(pending.port)} edge` : "") : portHint(n.type, port)}
                          highlight={isValidTarget}
                          dim={dragging && !isSource && !isValidTarget}
                          onDown={(e) => startConnect(e, n, port)} onUp={(e) => finishConnect(e, n, port)} />
                      </React.Fragment>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* zoom / view controls (not transformed) */}
          <div onPointerDown={(e) => e.stopPropagation()} style={{ position: "absolute", left: 12, bottom: 12, display: "flex", alignItems: "center", gap: 2, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 3, boxShadow: "0 4px 14px rgba(0,0,0,.3)", zIndex: 20 }}>
            <button onClick={() => zoomBy(1 / 1.2)} title="Zoom out" style={{ background: "transparent", border: "none", color: C.mut, width: 26, height: 26, borderRadius: 5, cursor: "pointer", fontSize: 16, lineHeight: 1 }}>−</button>
            <button onClick={resetView} title="Reset to 100%" style={{ background: "transparent", border: "none", color: C.mut, minWidth: 44, height: 26, borderRadius: 5, cursor: "pointer", fontSize: 11, fontFamily: MONO }}>{Math.round(zoom * 100)}%</button>
            <button onClick={() => zoomBy(1.2)} title="Zoom in" style={{ background: "transparent", border: "none", color: C.mut, width: 26, height: 26, borderRadius: 5, cursor: "pointer", fontSize: 16, lineHeight: 1 }}>+</button>
            <div style={{ width: 1, height: 16, background: C.borderSoft, margin: "0 2px" }} />
            <button onClick={fitView} title="Fit all blocks to view" style={{ background: "transparent", border: "none", color: C.mut, width: 26, height: 26, borderRadius: 5, cursor: "pointer", fontSize: 13 }}>⊡</button>
            <button onClick={tidyLayout} title="Tidy — auto-arrange the graph left → right" style={{ background: "transparent", border: "none", color: C.mut, height: 26, borderRadius: 5, cursor: "pointer", fontSize: 11, fontFamily: MONO, padding: "0 8px" }}>⤬ Tidy</button>
          </div>
          {multiSel.size > 0 && (
            <div onPointerDown={(e) => e.stopPropagation()} style={{ position: "absolute", left: 12, bottom: 50, display: "flex", alignItems: "center", gap: 8, background: C.panel, border: `1px solid ${C.tool}`, borderRadius: 8, padding: "5px 10px", fontSize: 11, fontFamily: MONO, color: C.tool, boxShadow: "0 4px 14px rgba(0,0,0,.3)", zIndex: 20 }}>
              {selGroupIds().length} selected
              <button onClick={() => duplicateSelection()} title="Duplicate (⌘D)" style={{ background: "transparent", border: `1px solid ${C.borderSoft}`, color: C.mut, borderRadius: 4, padding: "2px 7px", fontSize: 10.5, cursor: "pointer", fontFamily: MONO }}>Duplicate</button>
              <button onClick={() => deleteSelected()} title="Delete (⌫)" style={{ background: "transparent", border: `1px solid ${C.borderSoft}`, color: C.output, borderRadius: 4, padding: "2px 7px", fontSize: 10.5, cursor: "pointer", fontFamily: MONO }}>Delete</button>
            </div>
          )}

          {/* minimap (not transformed) */}
          {nodes.length > 0 && (() => {
            const MW = 176, MH = 116, pad = 24;
            const vL = (0 - pan.x) / zoom, vT = (0 - pan.y) / zoom, vR = (viewport.w - pan.x) / zoom, vB = (viewport.h - pan.y) / zoom;
            let minX = Math.min(vL, ...nodes.map((n) => n.x)) - pad, minY = Math.min(vT, ...nodes.map((n) => n.y)) - pad;
            let maxX = Math.max(vR, ...nodes.map((n) => n.x + NODE_W)) + pad, maxY = Math.max(vB, ...nodes.map((n) => n.y + NODE_H)) + pad;
            const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
            const s = Math.min(MW / bw, MH / bh);
            const ox = (MW - bw * s) / 2, oy = (MH - bh * s) / 2;   // center the content
            const toMap = (wx, wy) => ({ x: ox + (wx - minX) * s, y: oy + (wy - minY) * s });
            const recenter = (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const wx = (e.clientX - r.left - ox) / s + minX, wy = (e.clientY - r.top - oy) / s + minY;
              setPan({ x: viewport.w / 2 - wx * zoom, y: viewport.h / 2 - wy * zoom });
            };
            const vp = toMap(vL, vT), vpBR = toMap(vR, vB);
            return (
              <div onPointerDown={(e) => { e.stopPropagation(); recenter(e); }} title="Minimap — click to recenter"
                style={{ position: "absolute", right: 12, bottom: 12, width: MW, height: MH, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 4px 14px rgba(0,0,0,.3)", overflow: "hidden", cursor: "pointer", zIndex: 20 }}>
                <svg width={MW} height={MH} style={{ display: "block" }}>
                  {notes.map((nt) => { const p = toMap(nt.x, nt.y); const cc = noteColors(nt.color); return <rect key={nt.id} x={p.x} y={p.y} width={nt.w * s} height={nt.h * s} rx={1.5} fill={cc.bg} stroke={cc.bd} strokeWidth={0.5} opacity={0.75} />; })}
                  {nodes.map((n) => { const p = toMap(n.x, n.y); return <rect key={n.id} x={p.x} y={p.y} width={NODE_W * s} height={NODE_H * s} rx={2} fill={selected === n.id ? typeColor(n.type) : C.panel2} stroke={typeColor(n.type)} strokeWidth={0.6} opacity={0.9} />; })}
                  <rect x={vp.x} y={vp.y} width={Math.max(0, vpBR.x - vp.x)} height={Math.max(0, vpBR.y - vp.y)} fill={C.agent} fillOpacity={0.1} stroke={C.agent} strokeWidth={1} />
                </svg>
              </div>
            );
          })()}

          {/* inline quick-edit popover (screen-space, crisp at any zoom) */}
          {nodeEdit && nodeEdit.field !== "name" && (() => {
            const en = nodes.find((n) => n.id === nodeEdit.id); if (!en) return null;
            const qf = QUICK_FIELD[en.type]; if (!qf) return null;
            const sx = en.x * zoom + pan.x, sy = (en.y + NODE_H) * zoom + pan.y + 10;
            const left = Math.max(8, Math.min(sx, viewport.w - 296)), top = Math.max(8, Math.min(sy, viewport.h - 170));
            return (
              <div onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
                style={{ position: "absolute", left, top, width: 288, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.4)", padding: 10, zIndex: 25 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: typeColor(en.type), display: "flex", alignItems: "center", gap: 5 }}><NodeIcon type={en.type} color={typeColor(en.type)} size={12} />{qf.label}</div>
                  <button onClick={() => { setSelected(en.id); setNodeEdit(null); }} title="Open the full inspector for every setting" style={{ background: "transparent", border: "none", color: C.mut, cursor: "pointer", fontSize: 10.5, fontFamily: MONO }}>inspector ↗</button>
                </div>
                <textarea autoFocus rows={qf.rows} spellCheck={!qf.mono}
                  value={en.config[qf.field] ?? ""} onChange={(e) => updateConfig(en.id, { [qf.field]: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Escape") setNodeEdit(null); else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) setNodeEdit(null); }}
                  style={{ ...(qf.mono ? monoInput : inputStyle), width: "100%", resize: "vertical", boxSizing: "border-box" }} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                  <span style={{ fontSize: 9.5, color: C.faint, fontFamily: MONO }}>⌘↵ or Esc to close</span>
                  <button onClick={() => setNodeEdit(null)} style={{ background: C.panel2, border: `1px solid ${C.borderSoft}`, color: C.text, borderRadius: 5, padding: "3px 12px", fontSize: 11, cursor: "pointer" }}>Done</button>
                </div>
              </div>
            );
          })()}

          {/* per-node output viewer (screen-space) */}
          {outputPanel && (() => {
            const en = nodes.find((n) => n.id === outputPanel.nodeId); if (!en || nodeOutputs[en.id] == null) return null;
            const sx = (en.x + NODE_W) * zoom + pan.x + 14, sy = en.y * zoom + pan.y;
            const left = Math.max(8, Math.min(sx, viewport.w - 324)), top = Math.max(8, Math.min(sy, viewport.h - 260));
            const nm = en.type === "agent" || en.type === "customtool" ? en.config.name : NODE_TYPES[en.type].label;
            return (
              <div onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
                style={{ position: "absolute", left, top, width: 316, maxHeight: 300, display: "flex", flexDirection: "column", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.4)", zIndex: 25 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 12px 7px", borderBottom: `1px solid ${C.borderSoft}` }}>
                  <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: C.tool }}>⤷ Output · <span style={{ color: C.text }}>{nm}</span></div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => navigator.clipboard?.writeText(nodeOutputs[en.id])} style={{ background: "transparent", border: "none", color: C.mut, cursor: "pointer", fontSize: 10.5, fontFamily: MONO }}>Copy</button>
                    <button aria-label="Close" onClick={() => setOutputPanel(null)} style={{ background: "transparent", border: "none", color: C.faint, cursor: "pointer", fontSize: 14 }}>✕</button>
                  </div>
                </div>
                <div style={{ overflowY: "auto", padding: "9px 12px", whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.5, color: C.text }}>{nodeOutputs[en.id] || "(empty)"}</div>
              </div>
            );
          })()}

          {/* live cursors — other viewers' pointers, screen-space, smoothed */}
          {collabOn && collabViewers.filter((v) => v.cursor).map((v) => {
            const sx = v.cursor.x * zoom + pan.x, sy = v.cursor.y * zoom + pan.y;
            if (sx < -40 || sy < -40 || sx > viewport.w + 40 || sy > viewport.h + 40) return null;  // off-screen
            const col = userColor(v.id), name = String(v.email || "").replace(/@.*/, "") || "viewer";
            return (
              <div key={`cur-${v.id}`} style={{ position: "absolute", left: 0, top: 0, transform: `translate(${sx}px, ${sy}px)`, transition: "transform .18s linear", pointerEvents: "none", zIndex: 30, willChange: "transform" }}>
                <svg width="18" height="18" viewBox="0 0 18 18" style={{ display: "block", filter: "drop-shadow(0 1px 1px rgba(0,0,0,.4))" }}>
                  <path d="M2 2 L2 14 L5.5 10.5 L8 16 L10.5 15 L8 9.5 L13 9.5 Z" fill={col} stroke={C.bg} strokeWidth="1" strokeLinejoin="round" />
                </svg>
                <div style={{ position: "absolute", left: 14, top: 14, background: col, color: "#0D1410", fontFamily: MONO, fontSize: 10.5, fontWeight: 700, padding: "1px 6px", borderRadius: 6, whiteSpace: "nowrap", boxShadow: "0 2px 6px rgba(0,0,0,.35)" }}>{name}</div>
              </div>
            );
          })}

          {/* insert-on-edge menu (splice a block into a flow connection; screen-space) */}
          {edgeInsert && (() => {
            if (!edges.some((e) => e.id === edgeInsert.edgeId && e.kind === "flow")) return null;
            const left = Math.max(8, Math.min(edgeInsert.sx - 94, viewport.w - 196));
            const top = Math.max(8, Math.min(edgeInsert.sy + 16, viewport.h - 150));
            const opts = [["agent", "Agent", "a model step"], ["parallel", "Parallel", "fan-out workers"]];
            return (
              <div onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
                style={{ position: "absolute", left, top, width: 188, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.4)", zIndex: 26, overflow: "hidden" }}>
                <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: C.faint, padding: "9px 12px 6px" }}>Insert on connection</div>
                {opts.map(([type, label, desc]) => (
                  <button key={type} onClick={() => insertNodeOnEdge(edgeInsert.edgeId, type)}
                    style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", background: "transparent", border: "none", borderTop: `1px solid ${C.borderSoft}`, padding: "9px 12px", cursor: "pointer", color: C.text }}>
                    <NodeIcon type={type} color={typeColor(type)} size={15} />
                    <span><span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
                      <span style={{ display: "block", fontSize: 10.5, color: C.mut }}>{desc}</span></span>
                  </button>
                ))}
              </div>
            );
          })()}

          {/* comment thread popover (collaboration; screen-space) */}
          {collabOn && commentPanel && (() => {
            const en = nodes.find((n) => n.id === commentPanel.nodeId); if (!en) return null;
            const list = comments.filter((c) => c.nodeId === commentPanel.nodeId);
            const nm = en.type === "agent" || en.type === "customtool" ? en.config.name : NODE_TYPES[en.type].label;
            const sx = (en.x + NODE_W) * zoom + pan.x + 14, sy = en.y * zoom + pan.y;
            const left = Math.max(8, Math.min(sx, viewport.w - 308)), top = Math.max(8, Math.min(sy, viewport.h - 320));
            const fmt = (t) => { try { return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
            return (
              <div onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
                style={{ position: "absolute", left, top, width: 300, maxHeight: 340, display: "flex", flexDirection: "column", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.4)", zIndex: 25 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px 8px", borderBottom: `1px solid ${C.borderSoft}` }}>
                  <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: C.faint }}>💬 Comments · <span style={{ color: C.text }}>{nm}</span></div>
                  <button aria-label="Close comments" onClick={() => setCommentPanel(null)} style={{ background: "transparent", border: "none", color: C.faint, cursor: "pointer", fontSize: 14 }}>✕</button>
                </div>
                <div style={{ overflowY: "auto", padding: "8px 12px", flex: 1, minHeight: 40 }}>
                  {!list.length && <div style={{ fontSize: 11.5, color: C.faint, padding: "6px 0" }}>No comments yet. Start the thread below.</div>}
                  {list.map((c) => (
                    <div key={c.id} style={{ marginBottom: 10, opacity: c.resolved ? 0.55 : 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                        <span style={{ width: 16, height: 16, borderRadius: "50%", background: userColor(c.authorId || c.authorEmail), color: "#0D1410", fontSize: 8, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, flexShrink: 0 }}>{initials(c.authorEmail)}</span>
                        <span style={{ fontSize: 11, color: C.mut, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(c.authorEmail || "unknown").replace(/@.*/, "")}</span>
                        <span style={{ fontSize: 9.5, color: C.faint, marginLeft: "auto", flexShrink: 0 }}>{fmt(c.createdAt)}</span>
                      </div>
                      <div style={{ fontSize: 12, lineHeight: 1.45, color: C.text, whiteSpace: "pre-wrap", textDecoration: c.resolved ? "line-through" : "none" }}>{c.body}</div>
                      {canManageComment(c) && (
                        <div style={{ display: "flex", gap: 10, marginTop: 3 }}>
                          <button onClick={() => toggleResolveComment(c)} style={{ background: "transparent", border: "none", color: c.resolved ? C.mut : C.input, cursor: "pointer", fontSize: 10, fontFamily: MONO, padding: 0 }}>{c.resolved ? "reopen" : "resolve"}</button>
                          <button onClick={() => removeComment(c)} style={{ background: "transparent", border: "none", color: C.output, cursor: "pointer", fontSize: 10, fontFamily: MONO, padding: 0 }}>delete</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ padding: "8px 12px", borderTop: `1px solid ${C.borderSoft}`, display: "flex", gap: 6, alignItems: "flex-end" }}>
                  <textarea rows={2} placeholder="Add a comment…" value={commentDraft} onChange={(e) => setCommentDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { postComment(commentPanel.nodeId, commentDraft); } else if (e.key === "Escape") setCommentPanel(null); }}
                    style={{ ...inputStyle, fontSize: 12, resize: "none", flex: 1, boxSizing: "border-box" }} />
                  <button onClick={() => postComment(commentPanel.nodeId, commentDraft)} disabled={!commentDraft.trim()}
                    style={{ background: commentDraft.trim() ? C.run : C.panel2, border: "none", color: commentDraft.trim() ? C.onAccent : C.faint, borderRadius: 5, padding: "7px 12px", fontSize: 11.5, fontWeight: 700, cursor: commentDraft.trim() ? "pointer" : "default" }}>Post</button>
                </div>
              </div>
            );
          })()}
        </div>

        {/* inspector */}
        <div style={{ width: 312, borderLeft: `1px solid ${C.border}`, background: C.panel, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {!selNode ? (
            <div style={{ color: C.faint, fontSize: 12.5, lineHeight: 1.7, padding: 16 }}>
              <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase", marginBottom: 10 }}>Inspector</div>
              Select a block to configure its harness.<br /><br />
              Agents carry the full feature set: iteration limits, compaction budgets, todo & memory, scoped files, approval rules, modes, looping, browser control — plus SDK-only extras (shell, skills, sub-agents, OTel) that export straight into Python.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px 8px" }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: typeColor(selNode.type), display: "flex", alignItems: "center", gap: 7 }}><NodeIcon type={selNode.type} color={typeColor(selNode.type)} size={16} />{NODE_TYPES[selNode.type].label}</div>
                <button onClick={deleteSelected} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.output, borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>Delete</button>
              </div>
              {RUNNABLE_TYPES.has(selNode.type) && (
                <div style={{ display: "flex", gap: 6, padding: "0 16px 10px" }}>
                  <button onClick={() => runOnlyNode(selNode)} disabled={running} title="Run just this block, fed by its upstream block's last output (or the task)"
                    style={{ background: "transparent", border: `1px solid ${C.border}`, color: running ? C.faint : C.run, borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: running ? "default" : "pointer", fontFamily: MONO }}>▶ Run only</button>
                  <button onClick={() => runFromNode(selNode)} disabled={running} title="Run from this block onward"
                    style={{ background: "transparent", border: `1px solid ${C.border}`, color: running ? C.faint : C.mut, borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: running ? "default" : "pointer", fontFamily: MONO }}>▶ Run from here</button>
                </div>
              )}
              {nodeOutputs[selNode.id] != null && (
                <div style={{ padding: "0 16px 10px" }}>
                  <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: C.faint, marginBottom: 5, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    Last output
                    <button onClick={() => navigator.clipboard?.writeText(nodeOutputs[selNode.id])} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 4, padding: "2px 8px", fontSize: 10, cursor: "pointer", fontFamily: MONO }}>Copy</button>
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.5, color: C.text, background: C.panel2, border: `1px solid ${C.borderSoft}`, borderRadius: 6, padding: "8px 10px", maxHeight: 220, overflowY: "auto" }}>{nodeOutputs[selNode.id] || "(empty)"}</div>
                </div>
              )}
              {selNode.type === "agent" && (
                <div style={{ display: "flex", gap: 2, padding: "0 16px", borderBottom: `1px solid ${C.borderSoft}` }}>
                  {["core", "context", "memory", "safety", "advanced"].map((t) => (
                    <button key={t} onClick={() => setTab(t)} style={{ background: "transparent", border: "none", borderBottom: `2px solid ${tab === t ? C.agent : "transparent"}`, color: tab === t ? C.text : C.faint, padding: "6px 7px", fontSize: 11, cursor: "pointer", fontFamily: MONO }}>{t}</button>
                  ))}
                </div>
              )}
              <div style={{ overflowY: "auto", padding: 16, flex: 1 }}>
                {selNode.type === "input" && (
                  <Field label="Task / user message">
                    <textarea rows={6} style={{ ...inputStyle, resize: "vertical" }} value={selNode.config.message} onChange={(e) => updateConfig(selNode.id, { message: e.target.value })} />
                  </Field>
                )}
                {selNode.type === "output" && (
                  outputs[selNode.id] ? (
                    <div>
                      <div style={{ fontSize: 11, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase", color: C.faint, marginBottom: 6 }}>Final answer</div>
                      <div style={{ whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.55, color: C.text, background: C.panel2, border: `1px solid ${C.borderSoft}`, borderRadius: 6, padding: "9px 11px", maxHeight: 320, overflowY: "auto" }}>{outputs[selNode.id]}</div>
                      <button onClick={() => navigator.clipboard?.writeText(outputs[selNode.id])} style={{ marginTop: 8, background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: "pointer", fontFamily: MONO }}>Copy</button>
                    </div>
                  ) : (
                    <div style={{ color: C.mut, fontSize: 12.5, lineHeight: 1.6 }}>The final answer lands here and in the run trace after a run. Nothing to configure.</div>
                  )
                )}

                {selNode.type === "router" && (() => { const c = selNode.config, u = (patch) => updateConfig(selNode.id, patch); return (<>
                  <Field label="Router name"><input style={inputStyle} value={c.name} onChange={(e) => u({ name: e.target.value })} /></Field>
                  <Field label="Category labels (comma-separated)">
                    <input style={monoInput} value={c.labels} onChange={(e) => u({ labels: e.target.value })} />
                  </Field>
                  <Field label="Classifier instruction">
                    <textarea rows={3} style={{ ...inputStyle, resize: "vertical" }} value={c.instruction} onChange={(e) => u({ instruction: e.target.value })} />
                  </Field>
                  <Field label="Classifier provider">
                    <select style={inputStyle} value={c.provider} onChange={(e) => u({ provider: e.target.value, model: { openai: "gpt-4o", ollama: "llama3.1", gemini: "gemini-2.0-flash", bedrock: "anthropic.claude-3-5-sonnet-20240620-v1:0" }[e.target.value] || "claude-sonnet-4-6" })}>
                      <option value="anthropic">Anthropic</option><option value="openai">OpenAI-compatible</option>
                      <option value="ollama">Ollama</option>
                      <option value="gemini">Gemini</option><option value="bedrock">Bedrock</option>
                    </select>
                  </Field>
                  <div style={{ fontSize: 11.5, color: C.faint, lineHeight: 1.5 }}>Drag the bottom port to the agents you're routing to. The chosen agent is the one whose <b style={{ color: C.mut }}>name matches the picked label</b> (else by position).</div>
                </>); })()}

                {selNode.type === "conditional" && (() => { const c = selNode.config, u = (patch) => updateConfig(selNode.id, patch); return (<>
                  <Field label="Conditional name"><input style={inputStyle} value={c.name} onChange={(e) => u({ name: e.target.value })} /></Field>
                  <Field label="Rules — one per line: <test> <value> -> <label>">
                    <textarea rows={5} spellCheck={false} style={{ ...monoInput, resize: "vertical" }} value={c.rules} onChange={(e) => u({ rules: e.target.value })} />
                  </Field>
                  <div style={{ fontSize: 11.5, color: C.faint, lineHeight: 1.6 }}>
                    Tests: <b style={{ color: C.mut, fontFamily: MONO }}>contains</b> word · <b style={{ color: C.mut, fontFamily: MONO }}>regex</b> pattern · <b style={{ color: C.mut, fontFamily: MONO }}>longer_than</b> / <b style={{ color: C.mut, fontFamily: MONO }}>shorter_than</b> N. First match wins; add <b style={{ color: C.mut, fontFamily: MONO }}>else -&gt; label</b> for the fallback. Decided by plain rules — <b style={{ color: C.mut }}>no model call</b>. Drag the bottom port to the agents; each label dispatches to the agent of that name. Exports to <span style={{ fontFamily: MONO }}>branch()</span>.
                  </div>
                </>); })()}

                {selNode.type === "parallel" && (() => { const c = selNode.config, u = (patch) => updateConfig(selNode.id, patch); return (<>
                  <Field label="Parallel node name"><input style={inputStyle} value={c.name} onChange={(e) => u({ name: e.target.value })} /></Field>
                  <Toggle label="Join results with a model" value={c.join} onChange={(v) => u({ join: v })} hint="On: a final model call merges the workers' outputs. Off: their labelled outputs are concatenated." />
                  {c.join && (<>
                    <Field label="Join instruction"><textarea rows={3} style={{ ...inputStyle, resize: "vertical" }} value={c.joinPrompt} onChange={(e) => u({ joinPrompt: e.target.value })} /></Field>
                    <Field label="Joiner provider">
                      <select style={inputStyle} value={c.provider} onChange={(e) => u({ provider: e.target.value, model: { openai: "gpt-4o", ollama: "llama3.1", gemini: "gemini-2.0-flash", bedrock: "anthropic.claude-3-5-sonnet-20240620-v1:0" }[e.target.value] || "claude-sonnet-4-6" })}>
                        <option value="anthropic">Anthropic</option><option value="openai">OpenAI-compatible</option>
                        <option value="ollama">Ollama</option>
                        <option value="gemini">Gemini</option><option value="bedrock">Bedrock</option>
                      </select>
                    </Field>
                  </>)}
                  <div style={{ fontSize: 11.5, color: C.faint, lineHeight: 1.5 }}>Drag the bottom port to each worker agent. They all receive the same input and run concurrently in the preview.</div>
                </>); })()}

                {selNode.type === "customtool" && (
                  <>
                    <Field label="Tool name (snake_case)"><input style={monoInput} value={selNode.config.name} onChange={(e) => updateConfig(selNode.id, { name: e.target.value })} /></Field>
                    <Field label="Description (what the agent reads)"><textarea rows={3} style={{ ...inputStyle, resize: "vertical" }} value={selNode.config.description} onChange={(e) => updateConfig(selNode.id, { description: e.target.value })} /></Field>
                    <Field label="Behavior">
                      <select style={inputStyle} value={selNode.config.mode} onChange={(e) => updateConfig(selNode.id, { mode: e.target.value })}>
                        <option value="simulate">Simulated by Claude (prototype)</option>
                        <option value="javascript">Real JavaScript (runs in preview)</option>
                        <option value="http">HTTP endpoint (calls a real API)</option>
                      </select>
                    </Field>
                    {selNode.config.mode === "javascript" && (
                      <Field label="Function body — (input) => string">
                        <textarea rows={8} spellCheck={false} style={{ ...monoInput, resize: "vertical" }} value={selNode.config.js} onChange={(e) => updateConfig(selNode.id, { js: e.target.value })} />
                      </Field>
                    )}
                    {selNode.config.mode === "http" && (<>
                      <Field label="Endpoint URL">
                        <input style={monoInput} placeholder="https://api.example.com/lookup" value={selNode.config.url || ""} onChange={(e) => updateConfig(selNode.id, { url: e.target.value })} />
                      </Field>
                      <Field label="Method">
                        <select style={inputStyle} value={selNode.config.httpMethod || "POST"} onChange={(e) => updateConfig(selNode.id, { httpMethod: e.target.value })}>
                          <option value="POST">POST — body {"{ input }"}</option>
                          <option value="GET">GET — input as ?input=</option>
                        </select>
                      </Field>
                      <Field label="Headers (one per line, Key: Value)">
                        <textarea rows={3} spellCheck={false} placeholder={"Authorization: Bearer ...\nContent-Type: application/json"} style={{ ...monoInput, resize: "vertical" }} value={selNode.config.headers || ""} onChange={(e) => updateConfig(selNode.id, { headers: e.target.value })} />
                      </Field>
                      {!IN_CLAUDE_ARTIFACT && signedIn && (
                        <Field label="Connection (optional — supplies base URL + credential)">
                          <select style={inputStyle} value={selNode.config.connectionId || ""} onChange={(e) => updateConfig(selNode.id, { connectionId: e.target.value || null })}>
                            <option value="">— none (use the URL / headers above) —</option>
                            {connList.map((c) => <option key={c.id} value={c.id}>{c.name} · {connectorName(c.connectorId)}</option>)}
                          </select>
                          {selNode.config.connectionId
                            ? <div style={{ fontSize: 10.5, color: C.tool, marginTop: 5, lineHeight: 1.5 }}>🔒 This tool uses the <b>{(connList.find((c) => c.id === selNode.config.connectionId) || {}).name || "selected"}</b> connection. Its credential stays encrypted on the server and is injected at run time — never baked into the harness or the export.</div>
                            : (!connList.length && <div style={{ fontSize: 10.5, color: C.faint, marginTop: 5 }}>No saved connections. Add one in <span style={{ fontFamily: MONO }}>⋯ → Connectors</span> to avoid hardcoding secrets.</div>)}
                        </Field>
                      )}
                      <div style={{ fontSize: 10.5, color: C.faint, lineHeight: 1.5 }}>
                        The preview calls this through the dev proxy (avoids CORS). POST sends <span style={{ fontFamily: MONO }}>{"{\"input\": \"…\"}"}</span>; GET appends <span style={{ fontFamily: MONO }}>?input=…</span>. Exports to Python as a <span style={{ fontFamily: MONO }}>requests</span> call. Prefer a <b>connection</b> over inline headers so secrets stay out of a shared harness.
                      </div>
                    </>)}
                  </>
                )}

                {selNode.type === "agent" && (() => {
                  const c = selNode.config, u = (patch) => updateConfig(selNode.id, patch);
                  if (tab === "core") return (<>
                    <Field label="Agent name"><input style={inputStyle} value={c.name} onChange={(e) => u({ name: e.target.value })} /></Field>
                    {(() => {
                      const pid = c.providerId || c.provider || "anthropic";
                      const pentry = providerCatalog.find((x) => x.prefix === pid) || null;
                      const opts = modelOpts[pid] || [];
                      const kind = pentry ? pentry.kind : c.provider;
                      return (<>
                        <Field label="Provider">
                          <select style={inputStyle} value={pid}
                            onChange={(e) => {
                              const entry = providerCatalog.find((x) => x.prefix === e.target.value);
                              u({ providerId: entry.prefix, provider: entry.kind, baseUrl: entry.baseUrl || "", model: "" });
                            }}>
                            {providerCatalog.map((p) => (
                              <option key={p.prefix} value={p.prefix}>
                                {p.label}{p.hostedSearch ? " — hosted search" : ""}{p.local ? " — local" : ""}{!p.configured && !p.local ? " — no key" : ""}
                              </option>
                            ))}
                          </select>
                        </Field>
                        {pentry && !pentry.configured && !pentry.local && !IN_CLAUDE_ARTIFACT && (
                          <div style={{ fontSize: 10.5, color: C.output, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                            <span>⚠ No API key for {pentry.label}.</span>
                            <button onClick={() => setKeysOpen(true)} style={{ background: "transparent", border: `1px solid ${C.link}`, color: C.link, borderRadius: 4, padding: "1px 8px", fontSize: 11, cursor: "pointer", fontFamily: MONO }}>Add key</button>
                          </div>
                        )}
                        <Field label="Model">
                          <div style={{ display: "flex", gap: 6 }}>
                            <input style={{ ...monoInput, flex: 1 }} value={c.model} list={`models-${selNode.id}`}
                              placeholder={kind === "anthropic" ? "claude-sonnet-4-6" : kind === "gemini" ? "gemini-2.0-flash" : "pick or type a model id"}
                              onChange={(e) => u({ model: e.target.value })} />
                            {!pentry?.noModelList && (
                              <button onClick={() => loadModelsFor(pid)} title="Fetch the provider's live model list"
                                style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 6, padding: "0 10px", fontSize: 11, cursor: "pointer", fontFamily: MONO, whiteSpace: "nowrap" }}>⟳ load</button>
                            )}
                          </div>
                          <datalist id={`models-${selNode.id}`}>
                            {opts.map((m) => <option key={m} value={m} />)}
                          </datalist>
                          {modelMsg[pid] && <div style={{ fontSize: 10, color: C.faint, marginTop: 4 }}>{modelMsg[pid]}</div>}
                        </Field>
                        {kind === "openai" && (
                          <Field label="Base URL (prefilled from provider; override for self-hosted)">
                            <input style={monoInput} placeholder="https://api.openai.com/v1" value={c.baseUrl}
                              onChange={(e) => u({ baseUrl: e.target.value })} />
                          </Field>
                        )}
                        {pid === "bedrock" && (
                          <Field label="AWS region (exported Python)">
                            <input style={monoInput} placeholder="us-east-1" value={c.baseUrl}
                              onChange={(e) => u({ baseUrl: e.target.value })} />
                          </Field>
                        )}
                      </>);
                    })()}
                    <Field label="System prompt"><textarea rows={6} style={{ ...inputStyle, resize: "vertical" }} value={c.system} onChange={(e) => u({ system: e.target.value })} /></Field>
                    <Field label="Mode — structures how the agent works">
                      <select style={inputStyle} value={c.mode} onChange={(e) => u({ mode: e.target.value })}>
                        <option value="plan">plan (read-only, writes a todo plan)</option>
                        <option value="execute">execute (works the todo list)</option>
                        <option value="custom">custom…</option>
                      </select>
                    </Field>
                    {c.mode === "custom" && <Field label="Custom mode name"><input style={monoInput} value={c.customMode} onChange={(e) => u({ customMode: e.target.value })} /></Field>}
                    <Field label="Max tool-loop iterations"><input type="number" min={1} max={12} style={inputStyle} value={c.maxIterations} onChange={(e) => u({ maxIterations: e.target.value })} /></Field>
                  </>);
                  if (tab === "context") return (<>
                    <Toggle label="Context compaction" value={c.compaction} onChange={(v) => u({ compaction: v })} hint="When the estimated context exceeds the budget, older turns are summarized into a recap so long tool loops never overflow." />
                    {c.compaction && <Field label="Token budget"><input type="number" min={2000} step={1000} style={inputStyle} value={c.tokenBudget} onChange={(e) => u({ tokenBudget: e.target.value })} /></Field>}
                    <div style={{ fontSize: 11.5, color: C.faint, lineHeight: 1.55 }}>History persists after <b style={{ color: C.mut }}>every individual model call</b> (see the Sessions tab below) — crash a run and resume it from the Sessions tab (↺), exactly like run(..., resume=True) in the SDK.</div>
                  </>);
                  if (tab === "memory") return (<>
                    <Toggle label="Persistent todo list" value={c.todo} onChange={(v) => u({ todo: v })} hint="todo_read / todo_write tools; the agent tracks multi-step plans. Persists across runs — see the Todo tab." />
                    <Toggle label="Session memory (notes)" value={c.memory} onChange={(v) => u({ memory: v })} hint="memory_save / memory_read — notes that persist across turns AND across runs." />
                    <Toggle label="File tools (scoped)" value={c.files} onChange={(v) => u({ files: v })} hint="read/write/list jailed to a working directory. Virtual in the preview; real on disk in the SDK." />
                    {c.files && <Field label="Working directory"><input style={monoInput} value={c.workingDir} onChange={(e) => u({ workingDir: e.target.value })} /></Field>}
                  </>);
                  if (tab === "safety") return (<>
                    <Toggle label="Internet access (web search)" value={c.allowInternet} onChange={(v) => u({ allowInternet: v })} hint="Hosted web search (Anthropic; Gemini via Google Search grounding) is added by default; the kill switch removes it entirely. OpenAI-compatible and Bedrock have no hosted search — attach a custom search tool instead." />
                    <Field label="Approval policy">
                      <select style={inputStyle} value={c.approvalMode} onChange={(e) => u({ approvalMode: e.target.value })}>
                        <option value="interactive">interactive — ask me for risky tools</option>
                        <option value="heuristic">unattended — heuristics + standing rules only</option>
                      </select>
                    </Field>
                    <Field label='Standing rules: always allow (comma-sep)'>
                      <input style={monoInput} placeholder="write_file, run_shell" value={c.alwaysAllow} onChange={(e) => u({ alwaysAllow: e.target.value })} />
                    </Field>
                    <div style={{ fontSize: 11.5, color: C.faint, lineHeight: 1.55 }}>Read-only tools auto-approve heuristically; plan mode freezes mutating tools; recognizably dangerous shell input is always blocked in the SDK.</div>
                  </>);
                  return (<>
                    <Toggle label="Loop until complete" value={c.loopEnabled} onChange={(v) => u({ loopEnabled: v })} hint="Re-invoke the agent until it emits the completion marker." />
                    {c.loopEnabled && (<>
                      <Field label="Completion marker"><input style={monoInput} value={c.loopMarker} onChange={(e) => u({ loopMarker: e.target.value })} /></Field>
                      <Field label="Max rounds"><input type="number" min={1} max={5} style={inputStyle} value={c.maxRounds} onChange={(e) => u({ maxRounds: e.target.value })} /></Field>
                    </>)}
                    <Toggle label="Background sub-agents" sdkOnly value={c.subagents} onChange={(v) => u({ subagents: v })} hint="delegate_parallel fans independent subtasks out to workers." />
                    <Toggle label="Shell environment" sdkOnly value={c.shell} onChange={(v) => u({ shell: v })} hint="run_shell + probe_environment (OS/shell/cwd), jailed to the working directory." />
                    <Toggle label="Browser control" sdkOnly value={c.browser} onChange={(v) => u({ browser: v })} hint="Playwright-backed navigate/read/find (safe) + click/type/submit (approval-gated). Runs in the standalone app's preview via the proxy (needs `npx playwright install chromium`); in the Claude artifact it's export-only." />
                    {c.browser && (
                      <Toggle label="↳ Allow browser actions unattended" sdkOnly value={c.browserActs} onChange={(v) => u({ browserActs: v })} hint="Off (recommended): click/type/submit require approval. On: adds them to the standing allow-list in the exported code — only for trusted sites." />
                    )}
                    <Field label="Agent Skills directory" sdkOnly>
                      <input style={monoInput} placeholder="./skills (blank = off)" value={c.skillsDir} onChange={(e) => u({ skillsDir: e.target.value })} />
                    </Field>
                    <Toggle label="OpenTelemetry" sdkOnly value={c.otel} onChange={(v) => u({ otel: v })} hint="gen_ai.* semantic-convention spans for every model & tool call — exported to any OTLP backend (Langfuse, Grafana, Honeycomb) via OTEL_EXPORTER_OTLP_ENDPOINT." />
                    <Toggle label="Step checkpoints" sdkOnly value={c.checkpoints} onChange={(v) => u({ checkpoints: v })} hint="Write a numbered, resumable snapshot after every model call, so a crashed run resumes from a step via run(resume_from=…), not just the last message." />
                    <div style={{ fontSize: 11, color: C.faint, lineHeight: 1.5 }}>SDK-only features don't run in the browser preview, but they export into the generated Python.</div>
                  </>);
                })()}
              </div>
            </>
          )}
        </div>
      </div>

      {/* console */}
      <div style={{ borderTop: `1px solid ${C.border}`, background: C.panel, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <button onClick={() => setConsoleOpen((o) => !o)} style={{ background: "transparent", border: "none", color: C.mut, padding: "7px 12px", cursor: "pointer", fontFamily: MONO, fontSize: 11 }}>{consoleOpen ? "▾" : "▸"}</button>
          {["trace", "timeline", "todo", "files", "memory", "sessions"].map((t) => (
            <button key={t} onClick={() => { setConsoleTab(t); setConsoleOpen(true); if (t === "sessions") loadSessions(); }}
              style={{ background: "transparent", border: "none", borderBottom: `2px solid ${consoleTab === t && consoleOpen ? C.agent : "transparent"}`, color: consoleTab === t ? C.text : C.faint, padding: "7px 10px", fontSize: 11, cursor: "pointer", fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase" }}>
              {t}{t === "trace" && trace.length ? ` ${trace.length}` : ""}{t === "timeline" && events.length ? ` ${events.length}` : ""}{t === "todo" && panels.todo.length ? ` ${panels.todo.filter((x) => x.status === "done").length}/${panels.todo.length}` : ""}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {(panels.todo.length > 0 || Object.keys(panels.files).length > 0 || Object.keys(panels.memory).length > 0) && (
            <button onClick={clearWorkspace} disabled={running} title="Reset the persistent todo list, files and memory"
              style={{ background: "transparent", border: "none", color: running ? C.faint : C.output, padding: "7px 12px", fontSize: 10, cursor: running ? "default" : "pointer", fontFamily: MONO, letterSpacing: 1 }}>
              CLEAR WORKSPACE
            </button>
          )}
        </div>
        {consoleOpen && (
          <div style={{ height: 190, overflowY: "auto", padding: "4px 16px 12px", fontFamily: MONO, fontSize: 12, lineHeight: 1.55 }}>
            {consoleTab === "trace" && (<>
              {!trace.length && <div style={{ color: C.faint }}>Press Run preview. Turns, tool calls, approvals, compactions and loops all land here.</div>}
              {trace.map((t, i) => {
                const color = { info: C.faint, agent: C.agent, tool: C.tool, result: C.mut, error: C.output, final: C.input, link: C.link, compact: C.link, loop: C.agent, usage: C.faint, route: C.link, parallel: C.parallel }[t.type] || C.text;
                return t.type === "final" ? (
                  <div key={i} style={{ background: C.panel2, border: `1px solid ${C.borderSoft}`, borderLeft: `3px solid ${C.input}`, borderRadius: 6, padding: "10px 12px", marginTop: 6, whiteSpace: "pre-wrap", color: C.text }}>
                    <span style={{ color: C.input, fontSize: 10, letterSpacing: 1.2 }}>FINAL OUTPUT</span>{"\n"}{t.text}
                  </div>
                ) : <div key={i} style={{ color, whiteSpace: "pre-wrap", marginBottom: 2 }}>{t.text}</div>;
              })}
              <div ref={traceEnd} />
            </>)}
            {consoleTab === "timeline" && (() => {
              if (!events.length) return <div style={{ color: C.faint }}>Run the harness to see a timeline: each model call and tool call with its latency, agent, and token count. Click a row to jump to the message it produced.</div>;
              const maxMs = Math.max(1, ...events.map((e) => e.ms || 0));
              const agentColor = (a) => { let h = 0; for (const c of a || "") h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 60%)`; };
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {viewingSessionKey && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: C.panel2, border: `1px solid ${C.borderSoft}`, borderLeft: `3px solid ${C.tool}`, borderRadius: 6, padding: "6px 10px", marginBottom: 4 }}>
                      <span style={{ color: C.tool, fontSize: 11 }}>Viewing a past run · {new Date(Number(viewingSessionKey.slice(7))).toLocaleString()}</span>
                      <button onClick={() => { eventsRef.current = []; setEvents([]); runHistoryRef.current = []; setViewingSessionKey(null); }} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 4, padding: "2px 8px", fontSize: 10.5, cursor: "pointer", fontFamily: MONO }}>clear</button>
                    </div>
                  )}
                  {events.map((e, i) => {
                    const kindColor = e.kind === "model_call" ? C.agent : e.kind === "tool_call" ? (e.denied ? C.output : C.tool) : C.link;
                    const barPct = Math.max(2, ((e.ms || 0) / maxMs) * 100);
                    const netPct = e.kind === "model_call" && e.ms ? Math.min(100, ((e.networkMs || 0) / e.ms) * 100) : 0;
                    const clickable = Number.isInteger(e.msgIndex) || e.kind === "compaction";
                    const label = e.kind === "model_call" ? `${e.agent} · model`
                      : e.kind === "tool_call" ? `${e.agent} · ${e.tool}${e.denied ? " (denied)" : e.simulated ? " ⚠ simulated" : ""}`
                      : `${e.agent} · compaction`;
                    const meta = e.kind === "model_call" ? `${e.inTok}↓ ${e.outTok}↑ tok${e.nToolCalls ? ` · ${e.nToolCalls} tool` : ""} · ${e.stop}`
                      : e.kind === "tool_call" ? `${(JSON.stringify(e.input) || "").slice(0, 40)}`
                      : `${e.beforeMsgs}→${e.afterMsgs} msgs · ${e.beforeTokens}→${e.afterTokens} tok`;
                    return (
                      <div key={i}
                        onClick={() => { if (e.kind === "compaction") setDiffModal(e); else if (Number.isInteger(e.msgIndex)) setHistoryModal({ index: e.msgIndex }); }}
                        style={{ display: "grid", gridTemplateColumns: "150px 1fr 62px", gap: 8, alignItems: "center", padding: "3px 6px", borderRadius: 4, cursor: clickable ? "pointer" : "default", background: "transparent" }}
                        onMouseEnter={(ev) => (ev.currentTarget.style.background = C.panel2)}
                        onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: agentColor(e.agent), flexShrink: 0 }} />
                          <span style={{ color: kindColor, fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <div style={{ position: "relative", height: 5, width: `${barPct}%`, background: kindColor, borderRadius: 3, opacity: 0.55, flexShrink: 0 }}>
                            {netPct > 0 && <div title="network portion" style={{ position: "absolute", left: 0, top: 0, height: 5, width: `${netPct}%`, background: kindColor, borderRadius: 3, opacity: 0.9 }} />}
                          </div>
                          <span style={{ color: C.faint, fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta}{clickable ? "  ↗" : ""}</span>
                        </div>
                        <div style={{ color: C.mut, fontSize: 11, textAlign: "right" }} title={e.kind === "model_call" && e.networkMs != null ? `${e.networkMs}ms network · ${Math.max(0, (e.ms || 0) - (e.networkMs || 0))}ms overhead` : ""}>{e.ms}ms</div>
                      </div>
                    );
                  })}
                  <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.borderSoft}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <span style={{ color: C.faint, fontSize: 10.5 }}>
                      {events.filter((e) => e.kind === "model_call").length} model calls · {events.filter((e) => e.kind === "tool_call").length} tool calls
                      {events.some((e) => e.kind === "compaction") ? ` · ${events.filter((e) => e.kind === "compaction").length} compaction(s)` : ""}
                      {" · "}total {Math.round(events.reduce((a, e) => a + (e.ms || 0), 0))}ms
                      {events.some((e) => e.kind === "model_call" && e.networkMs != null) ? ` (${Math.round(events.reduce((a, e) => a + (e.networkMs || 0), 0))}ms network)` : ""}
                    </span>
                    <button onClick={exportTimeline} title="Download this run's events as JSONL (matches the SDK's events.jsonl)"
                      style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 5, padding: "3px 9px", fontSize: 10.5, cursor: "pointer", fontFamily: MONO, whiteSpace: "nowrap" }}>
                      ⤓ events.jsonl
                    </button>
                  </div>
                </div>
              );
            })()}
            {consoleTab === "todo" && (panels.todo.length ? panels.todo.map((t, i) => (
              <div key={i} style={{ color: t.status === "done" ? C.faint : t.status === "in_progress" ? C.agent : C.text, textDecoration: t.status === "done" ? "line-through" : "none" }}>
                {t.status === "done" ? "☑" : t.status === "in_progress" ? "◐" : "☐"} {t.text}
              </div>
            )) : <div style={{ color: C.faint }}>The agent's persistent plan appears here once it calls todo_write.</div>)}
            {consoleTab === "files" && (Object.keys(panels.files).length ? Object.entries(panels.files).map(([p, v]) => (
              <details key={p} style={{ marginBottom: 6 }}><summary style={{ color: C.tool, cursor: "pointer" }}>{p} <span style={{ color: C.faint }}>({v.length} chars)</span></summary>
                <pre style={{ whiteSpace: "pre-wrap", color: C.mut, margin: "4px 0 0 14px" }}>{v.slice(0, 3000)}</pre></details>
            )) : <div style={{ color: C.faint }}>The virtual working directory. Enable File tools on an agent and it can write here.</div>)}
            {consoleTab === "memory" && (Object.keys(panels.memory).length ? Object.entries(panels.memory).map(([k, v]) => (
              <details key={k} style={{ marginBottom: 6 }}><summary style={{ color: C.link, cursor: "pointer" }}>{k}</summary>
                <pre style={{ whiteSpace: "pre-wrap", color: C.mut, margin: "4px 0 0 14px" }}>{v.slice(0, 3000)}</pre></details>
            )) : <div style={{ color: C.faint }}>Session memory notes (memory_save) show up here.</div>)}
            {consoleTab === "sessions" && (<>
              <div style={{ color: C.faint, marginBottom: 6 }}>Every run's history is persisted after each model call. ▸ inspects it; ↺ resumes a crashed or stopped run from exactly where it left off.</div>
              {sessions.map((k) => (
                <div key={k} style={{ display: "flex", gap: 10, alignItems: "center", padding: "2px 0" }}>
                  <button onClick={() => openSession(k)} style={{ background: "transparent", border: "none", color: C.tool, cursor: "pointer", fontFamily: MONO, fontSize: 12, padding: 0 }}>
                    ▸ {new Date(Number(k.slice(7))).toLocaleString()} — {k}
                  </button>
                  <button onClick={() => resumeSession(k)} disabled={running}
                    style={{ background: "transparent", border: `1px solid ${C.borderSoft}`, color: running ? C.faint : C.run, borderRadius: 4, padding: "1px 8px", fontSize: 11, cursor: running ? "default" : "pointer", fontFamily: MONO }}>
                    ↺ resume
                  </button>
                </div>
              ))}
              {!sessions.length && <div style={{ color: C.faint }}>(no persisted sessions yet)</div>}
            </>)}
          </div>
        )}
      </div>

      {/* code / session modals */}
      {(codeModal || sessionView) && (
        <div onClick={() => { setCodeModal(null); setSessionView(null); }} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.7)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
          <div className="ergon-modal" onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(860px, 94vw)", maxHeight: "84vh", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: `1px solid ${C.borderSoft}` }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{codeModal ? "Generated Python — Ergon SDK" : `Session ${sessionView.key}`}</div>
              <div style={{ display: "flex", gap: 8 }}>
                {codeModal && <button onClick={() => navigator.clipboard?.writeText(codeModal)} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: "pointer", fontFamily: MONO }}>Copy</button>}
                {sessionView && sessionView.data && (
                  <button onClick={() => resumeSession(sessionView.key)} disabled={running}
                    style={{ background: "transparent", border: `1px solid ${C.run}`, color: running ? C.faint : C.run, borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: running ? "default" : "pointer", fontFamily: MONO }}>
                    ↺ Resume this run
                  </button>
                )}
                <button onClick={() => { setCodeModal(null); setSessionView(null); }} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: "pointer" }}>Close</button>
              </div>
            </div>
            <pre style={{ margin: 0, padding: 16, overflow: "auto", fontFamily: MONO, fontSize: 12, lineHeight: 1.55, color: C.text, whiteSpace: "pre-wrap" }}>
              {codeModal || (sessionView.data ? JSON.stringify(sessionView.data, null, 2).slice(0, 20000) : "(could not load session)")}
            </pre>
          </div>
        </div>
      )}

      {deployModal && (
        <div onClick={() => setDeployModal(null)} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.7)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
          <div className="ergon-modal" onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(860px, 94vw)", maxHeight: "84vh", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: `1px solid ${C.borderSoft}` }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Deploy as an HTTP endpoint</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => navigator.clipboard?.writeText(deployModal)} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: "pointer", fontFamily: MONO }}>Copy</button>
                <button onClick={() => setDeployModal(null)} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: "pointer" }}>Close</button>
              </div>
            </div>
            <pre style={{ margin: 0, padding: 16, overflow: "auto", fontFamily: MONO, fontSize: 12, lineHeight: 1.55, color: C.text, whiteSpace: "pre-wrap" }}>
              {deployModal}
            </pre>
          </div>
        </div>
      )}

      {/* trace click-through: the exact message in history */}
      {historyModal && (() => {
        const hist = runHistoryRef.current;
        const msg = hist[historyModal.index];
        const nav = (d) => setHistoryModal((h) => ({ index: Math.min(hist.length - 1, Math.max(0, h.index + d)) }));
        return (
          <div onClick={() => setHistoryModal(null)} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.7)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
            <div className="ergon-modal" onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(760px, 94vw)", maxHeight: "84vh", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: `1px solid ${C.borderSoft}` }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>History message #{historyModal.index} {msg ? <span style={{ color: C.faint, fontFamily: MONO, fontWeight: 400 }}>· {msg.role}</span> : ""}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => nav(-1)} disabled={historyModal.index <= 0} style={{ background: "transparent", border: `1px solid ${C.border}`, color: historyModal.index <= 0 ? C.faint : C.mut, borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>← prev</button>
                  <button onClick={() => nav(1)} disabled={historyModal.index >= hist.length - 1} style={{ background: "transparent", border: `1px solid ${C.border}`, color: historyModal.index >= hist.length - 1 ? C.faint : C.mut, borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>next →</button>
                  <button onClick={() => setHistoryModal(null)} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: "pointer" }}>Close</button>
                </div>
              </div>
              <pre style={{ margin: 0, padding: 16, overflow: "auto", fontFamily: MONO, fontSize: 12, lineHeight: 1.55, color: C.text, whiteSpace: "pre-wrap" }}>
                {msg ? JSON.stringify(msg, (k, v) => k === "_raw" ? "…(provider raw omitted)" : v, 2).slice(0, 20000) : "(message not in the current run's history)"}
              </pre>
            </div>
          </div>
        );
      })()}

      {/* compaction before/after diff */}
      {diffModal && (
        <div onClick={() => setDiffModal(null)} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.7)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
          <div className="ergon-modal" onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(920px, 96vw)", maxHeight: "86vh", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: `1px solid ${C.borderSoft}` }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Compaction · {diffModal.agent} <span style={{ color: C.faint, fontFamily: MONO, fontWeight: 400 }}>· {diffModal.beforeMsgs}→{diffModal.afterMsgs} msgs · {diffModal.beforeTokens}→{diffModal.afterTokens} tok · saved {diffModal.beforeTokens - diffModal.afterTokens}</span></div>
              <button onClick={() => setDiffModal(null)} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: "pointer" }}>Close</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0, overflow: "hidden", minHeight: 0 }}>
              {[["Before", diffModal.diff.before, C.output], ["After", diffModal.diff.after, C.input]].map(([title, msgs, col], ci) => (
                <div key={title} style={{ overflowY: "auto", padding: 12, borderLeft: ci ? `1px solid ${C.borderSoft}` : "none" }}>
                  <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", color: col, marginBottom: 8 }}>{title} · {msgs.length} msgs</div>
                  {msgs.map((m, i) => (
                    <div key={i} style={{ marginBottom: 6, borderLeft: `2px solid ${C.borderSoft}`, paddingLeft: 8 }}>
                      <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.faint, textTransform: "uppercase" }}>{m.role}</div>
                      <div style={{ fontSize: 11.5, color: C.mut, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.preview}{m.preview.length >= 400 ? "…" : ""}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {keysOpen && !IN_CLAUDE_ARTIFACT && <KeysModal catalog={providerCatalog} onClose={() => setKeysOpen(false)} onChanged={refreshCatalog} />}
      {orgsOpen && !IN_CLAUDE_ARTIFACT && <OrgsModal currentHarnessId={currentId} currentOrgId={currentOrgId} onClose={() => setOrgsOpen(false)} onMoved={setCurrentOrgId} onChanged={() => loadLibrary(true)} />}
      {runsOpen && !IN_CLAUDE_ARTIFACT && <RunsModal currentOrgId={currentOrgId} onClose={() => setRunsOpen(false)} />}
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} onAuthed={onAuthed} />}

      {connOpen && (() => {
        const grouped = {};
        (catalog || []).filter((c) => { const q = connSearch.trim().toLowerCase(); return !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.category.toLowerCase().includes(q); })
          .forEach((c) => { (grouped[c.category] = grouped[c.category] || []).push(c); });
        const kindTag = (k) => k === "mcp" ? "MCP" : k === "http" ? "REST" : "DB";
        const tabBtn = (id, label) => (
          <button onClick={() => { setConnTab(id); setConnectDraft(null); }} style={{ background: connTab === id ? C.accentSoft : "transparent", color: connTab === id ? C.text : C.faint, border: "none", borderBottom: `2px solid ${connTab === id ? C.accent : "transparent"}`, padding: "8px 14px", fontSize: 12.5, fontWeight: connTab === id ? 700 : 500, cursor: "pointer", fontFamily: MONO }}>{label}</button>
        );
        return (
          <div onClick={() => setConnOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.7)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 28 }}>
            <div className="ergon-modal" onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(860px, 96vw)", height: "min(640px, 88vh)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 18px 0" }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>🔌 Connectors</div>
                <button aria-label="Close" onClick={() => setConnOpen(false)} style={{ background: "transparent", border: "none", color: C.faint, cursor: "pointer", fontSize: 16 }}>✕</button>
              </div>
              <div style={{ display: "flex", gap: 2, padding: "6px 14px 0", borderBottom: `1px solid ${C.borderSoft}` }}>
                {tabBtn("catalog", "Catalog")}
                {tabBtn("connections", `Connections${connList.length ? ` · ${connList.length}` : ""}`)}
              </div>
              {connErr && <div style={{ padding: "8px 18px", fontSize: 12, color: C.output }}>{connErr}</div>}
              {!connMgmtOrg && <div style={{ padding: "8px 18px", fontSize: 11.5, color: C.agent }}>Save this harness to an organization first — connections are stored per-org.</div>}

              {/* CONNECT FORM (overlays either tab) */}
              {connectDraft ? (
                <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>
                  <button onClick={() => setConnectDraft(null)} style={{ background: "transparent", border: "none", color: C.link, cursor: "pointer", fontSize: 12, padding: 0, marginBottom: 12 }}>← catalog</button>
                  <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 2 }}>Connect {connectDraft.connector.name}</div>
                  <div style={{ fontSize: 12, color: C.mut, marginBottom: 16, lineHeight: 1.5 }}>{connectDraft.connector.description}</div>
                  {connectDraft.connector.oauthFlow && (
                    <div style={{ marginBottom: 16 }}>
                      <button onClick={() => startOAuth(connectDraft.connector)} disabled={!connMgmtOrg} style={{ background: C.tool, border: "none", color: C.onAccent, borderRadius: 6, padding: "9px 16px", fontSize: 12.5, fontWeight: 700, cursor: connMgmtOrg ? "pointer" : "default" }}>Connect with {connectDraft.connector.name} ↗</button>
                      <div style={{ fontSize: 10.5, color: C.faint, marginTop: 6 }}>Opens {connectDraft.connector.name} in a popup to authorize. Tokens are stored encrypted and refreshed automatically.</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0 4px", color: C.faint, fontSize: 10.5 }}>
                        <span style={{ flex: 1, height: 1, background: C.borderSoft }} />OR PASTE A TOKEN<span style={{ flex: 1, height: 1, background: C.borderSoft }} />
                      </div>
                    </div>
                  )}
                  <label style={{ display: "block", fontSize: 11, color: C.faint, marginBottom: 4 }}>Connection name</label>
                  <input value={connectDraft.name} onChange={(e) => setConnectDraft((d) => ({ ...d, name: e.target.value }))} style={{ ...inputStyle, width: "100%", marginBottom: 14, fontSize: 12.5 }} />
                  {(connectDraft.connector.fields || []).map((f) => (
                    <div key={f.key} style={{ marginBottom: 14 }}>
                      <label style={{ display: "block", fontSize: 11, color: C.faint, marginBottom: 4 }}>{f.label}{f.required ? " *" : ""}</label>
                      <input value={connectDraft.config[f.key] || ""} placeholder={f.placeholder || ""} onChange={(e) => setConnectDraft((d) => ({ ...d, config: { ...d.config, [f.key]: e.target.value } }))} style={{ ...inputStyle, width: "100%", fontSize: 12.5, fontFamily: f.type === "url" ? MONO : "inherit" }} />
                    </div>
                  ))}
                  {connectDraft.connector.secret && (
                    <div style={{ marginBottom: 14 }}>
                      <label style={{ display: "block", fontSize: 11, color: C.faint, marginBottom: 4 }}>{connectDraft.connector.secret.label}{connectDraft.connector.secret.required ? " *" : ""}</label>
                      <input type="password" value={connectDraft.secret} placeholder={connectDraft.connector.secret.placeholder || ""} onChange={(e) => setConnectDraft((d) => ({ ...d, secret: e.target.value }))} style={{ ...inputStyle, width: "100%", fontSize: 12.5, fontFamily: MONO }} />
                      <div style={{ fontSize: 10.5, color: C.faint, marginTop: 5 }}>🔒 Encrypted at rest (AES-256-GCM). Only the last 4 characters are ever shown again.</div>
                    </div>
                  )}
                  <button onClick={saveConnect} disabled={!connMgmtOrg} style={{ background: connMgmtOrg ? C.run : C.panel2, border: "none", color: connMgmtOrg ? C.onAccent : C.faint, borderRadius: 6, padding: "9px 18px", fontSize: 12.5, fontWeight: 700, cursor: connMgmtOrg ? "pointer" : "default", marginTop: 4 }}>Save connection</button>
                </div>
              ) : connTab === "catalog" ? (
                <div style={{ flex: 1, overflowY: "auto", padding: "12px 18px" }}>
                  <input value={connSearch} onChange={(e) => setConnSearch(e.target.value)} placeholder="Search connectors…" style={{ ...inputStyle, width: "100%", fontSize: 12.5, marginBottom: 14 }} />
                  {connBusy && <div style={{ fontSize: 12, color: C.faint }}>Loading…</div>}
                  {Object.keys(grouped).map((cat) => (
                    <div key={cat} style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 10, fontFamily: MONO, letterSpacing: 1, textTransform: "uppercase", color: C.faint, marginBottom: 8 }}>{cat}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
                        {grouped[cat].map((c) => (
                          <div key={c.id} style={{ border: `1px solid ${C.borderSoft}`, borderRadius: 8, padding: "11px 12px", background: C.panel2, display: "flex", flexDirection: "column", gap: 6 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{c.name}</span>
                              <span style={{ fontSize: 9, fontFamily: MONO, color: C.faint, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 5px" }}>{kindTag(c.kind)}</span>
                            </div>
                            <div style={{ fontSize: 11, color: C.mut, lineHeight: 1.4, flex: 1 }}>{c.description}</div>
                            <button onClick={() => beginConnectorSetup(c)} disabled={!connMgmtOrg} style={{ alignSelf: "flex-start", background: "transparent", border: `1px solid ${connMgmtOrg ? C.tool : C.border}`, color: connMgmtOrg ? C.tool : C.faint, borderRadius: 5, padding: "4px 12px", fontSize: 11.5, cursor: connMgmtOrg ? "pointer" : "default", fontFamily: MONO, marginTop: 2 }}>Connect</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
                  {!connList.length && <div style={{ fontSize: 12.5, color: C.faint }}>No connections yet. Add one from the <b style={{ color: C.text }}>Catalog</b> tab — it's stored encrypted for this organization and reusable across harnesses.</div>}
                  {connList.map((c) => (
                    <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, border: `1px solid ${C.borderSoft}`, borderRadius: 7, padding: "10px 12px", marginBottom: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, display: "flex", alignItems: "center", gap: 7 }}>{c.name} <span style={{ color: C.faint, fontWeight: 400, fontSize: 11 }}>· {connectorName(c.connectorId)}</span>{c.authType === "oauth" && <span style={{ fontSize: 9, fontFamily: MONO, color: C.link, border: `1px solid ${C.link}`, borderRadius: 4, padding: "0 4px" }}>OAuth</span>}</div>
                        <div style={{ fontSize: 11, color: C.faint, marginTop: 3, fontFamily: MONO }}>{c.configured ? `🔒 ••••${c.last4 || ""}` : "no credential"}{c.authType === "oauth" ? " · auto-refreshed" : ""}{Object.keys(c.config || {}).filter((k) => c.config[k] && k !== "oauth" && k !== "scope").length ? ` · ${Object.entries(c.config).filter(([k, v]) => v && k !== "oauth" && k !== "scope").map(([k, v]) => `${k}=${v}`).join(" · ")}` : ""}</div>
                      </div>
                      <button aria-label="Delete connection" onClick={() => removeConnection(c)} style={{ background: "transparent", border: `1px solid ${C.borderSoft}`, color: C.faint, borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: MONO, flexShrink: 0 }}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {trigOpen && (() => {
        const relTime = (ts) => { if (!ts) return "never"; const s = Math.max(0, (Date.now() - ts) / 1000);
          if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)}m ago`;
          if (s < 86400) return `${Math.floor(s / 3600)}h ago`; try { return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" }); } catch { return ""; } };
        const fmtNext = (ts) => { if (!ts) return "—"; try { return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
        const statusColor = (s) => s === "ok" ? C.run : s === "error" ? C.output : s === "no-runner" ? C.agent : s === "budget" ? C.output : C.faint;
        const canEdit = currentRole !== "view";
        return (
          <div onClick={() => setTrigOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.7)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 28 }}>
            <div className="ergon-modal" onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(760px, 96vw)", height: "min(640px, 88vh)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${C.borderSoft}` }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>⚡ Triggers <span style={{ color: C.faint, fontWeight: 400, fontSize: 12.5 }}>· {currentName}</span></div>
                <button aria-label="Close" onClick={() => setTrigOpen(false)} style={{ background: "transparent", border: "none", color: C.faint, cursor: "pointer", fontSize: 16 }}>✕</button>
              </div>
              <div style={{ padding: "10px 18px", fontSize: 11.5, color: C.mut, lineHeight: 1.5, borderBottom: `1px solid ${C.borderSoft}` }}>
                Triggers start a run without the Studio open. A run executes on this harness's <b style={{ color: C.text }}>deployed runner</b> (Deploy → set an <code style={{ fontFamily: MONO }}>ergon serve</code> target); a trigger on an undeployed harness records a clear “no-runner” outcome. Schedules are evaluated in <b style={{ color: C.text }}>UTC</b>.
              </div>
              {trigErr && <div style={{ padding: "8px 18px", fontSize: 12, color: C.output }}>{trigErr}</div>}
              <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
                {trigBusy && <div style={{ fontSize: 12, color: C.faint }}>Loading…</div>}
                {!trigBusy && !trigList.length && <div style={{ fontSize: 12.5, color: C.faint, padding: "4px 0 14px" }}>No triggers yet. Add a webhook or a schedule below.</div>}
                {trigList.map((t) => (
                  <div key={t.id} style={{ border: `1px solid ${C.borderSoft}`, borderLeft: `3px solid ${t.enabled ? (t.type === "webhook" ? C.tool : C.link) : C.faint}`, borderRadius: 7, padding: "10px 12px", marginBottom: 8, opacity: t.enabled ? 1 : 0.6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: t.type === "webhook" ? C.tool : C.link }}>{t.type === "webhook" ? "▸ Webhook" : "⏱ Schedule"}</span>
                        {t.type === "schedule" && <span style={{ fontFamily: MONO, fontSize: 12, color: C.text }}>{t.cron}</span>}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                        {t.lastStatus && <span style={{ fontSize: 10.5, color: statusColor(t.lastStatus), fontFamily: MONO }}>{t.lastStatus}</span>}
                        {canEdit && <button onClick={() => toggleTrigger(t)} style={{ background: "transparent", border: `1px solid ${C.border}`, color: t.enabled ? C.mut : C.run, borderRadius: 5, padding: "3px 9px", fontSize: 11, cursor: "pointer", fontFamily: MONO }}>{t.enabled ? "Disable" : "Enable"}</button>}
                        {canEdit && <button aria-label="Delete trigger" onClick={() => removeTrigger(t)} style={{ background: "transparent", border: "none", color: C.faint, cursor: "pointer", fontSize: 13 }}>✕</button>}
                      </div>
                    </div>
                    {t.type === "webhook" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                        <code style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11, color: C.mut, background: C.panel2, border: `1px solid ${C.borderSoft}`, borderRadius: 5, padding: "6px 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cloud.webhookUrl(t.token)}</code>
                        <button onClick={() => copyWebhook(t)} style={{ background: copiedTok === t.id ? C.run : "transparent", border: `1px solid ${copiedTok === t.id ? C.run : C.border}`, color: copiedTok === t.id ? C.onAccent : C.mut, borderRadius: 5, padding: "6px 11px", fontSize: 11, cursor: "pointer", fontFamily: MONO, flexShrink: 0 }}>{copiedTok === t.id ? "Copied" : "Copy URL"}</button>
                      </div>
                    )}
                    <div style={{ fontSize: 10.5, color: C.faint, marginTop: 7, display: "flex", gap: 12, flexWrap: "wrap" }}>
                      <span>fired {t.fireCount}×</span>
                      <span>last: {relTime(t.lastFiredAt)}</span>
                      {t.type === "schedule" && t.enabled && <span>next: {fmtNext(t.nextFireAt)} UTC</span>}
                    </div>
                  </div>
                ))}
              </div>
              {canEdit && (
                <div style={{ borderTop: `1px solid ${C.borderSoft}`, padding: "12px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <button onClick={addWebhook} style={{ background: C.tool, border: "none", color: C.onAccent, borderRadius: 6, padding: "8px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>+ Webhook</button>
                    <span style={{ fontSize: 11, color: C.faint }}>A public URL that starts a run when POSTed to. Body <code style={{ fontFamily: MONO }}>{'{"input":"…"}'}</code> or raw text becomes the run input.</span>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <button onClick={addSchedule} style={{ background: C.link, border: "none", color: C.onAccent, borderRadius: 6, padding: "8px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>+ Schedule</button>
                    <input value={trigCron} onChange={(e) => setTrigCron(e.target.value)} placeholder="0 9 * * *" style={{ ...inputStyle, width: 130, fontFamily: MONO, fontSize: 12 }} />
                    <select value={trigCron} onChange={(e) => setTrigCron(e.target.value)} style={{ ...inputStyle, fontSize: 11.5, padding: "6px 8px", cursor: "pointer" }}>
                      <option value={trigCron}>presets…</option>
                      {CRON_PRESETS.map(([c, l]) => <option key={c} value={c}>{l} ({c})</option>)}
                    </select>
                    <input value={trigPayload} onChange={(e) => setTrigPayload(e.target.value)} placeholder="input sent each run (optional)" style={{ ...inputStyle, flex: 1, minWidth: 140, fontSize: 12 }} />
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {histOpen && (() => {
        const relTime = (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000);
          if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)}m ago`;
          if (s < 86400) return `${Math.floor(s / 3600)}h ago`; if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
          try { return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" }); } catch { return ""; } };
        const nm = (g, id) => { const n = (g?.nodes || []).find((x) => x.id === id); return n ? (n.type === "agent" || n.type === "customtool" ? n.config?.name : NODE_TYPES[n.type]?.label) || n.type : "a block"; };
        const dispName = (n) => (n.type === "agent" || n.type === "customtool" ? n.config?.name : NODE_TYPES[n.type]?.label) || n.type;
        const changedKeys = (b, a) => { const ks = new Set([...Object.keys(b.config || {}), ...Object.keys(a.config || {})]); return [...ks].filter((k) => JSON.stringify(b.config?.[k]) !== JSON.stringify(a.config?.[k])); };
        const bId = histSel, aId = histBase || predecessorOf(histSel);
        const bG = histGraphs[bId], aG = aId ? histGraphs[aId] : { nodes: [], edges: [] };
        const ready = !!bG && (!aId || !!aG);
        const d = ready ? diffGraphs(aG, bG) : null;
        const bMeta = histList.find((v) => v.id === bId), aMeta = aId ? histList.find((v) => v.id === aId) : null;
        const chip = (col, label) => <span style={{ fontFamily: MONO, fontSize: 11, color: col, background: `${col}1E`, border: `1px solid ${col}55`, borderRadius: 5, padding: "2px 7px" }}>{label}</span>;
        const row = (col, left, right) => (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 9px", borderLeft: `3px solid ${col}`, background: C.panel2, borderRadius: 5, marginBottom: 5 }}>
            {left}<span style={{ fontSize: 12.5, color: C.text }}>{right}</span>
          </div>
        );
        return (
          <div onClick={() => setHistOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.7)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 28 }}>
            <div className="ergon-modal" onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(940px, 96vw)", height: "min(620px, 86vh)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${C.borderSoft}` }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Version history <span style={{ color: C.faint, fontWeight: 400, fontSize: 12.5 }}>· {currentName}</span></div>
                <button aria-label="Close" onClick={() => setHistOpen(false)} style={{ background: "transparent", border: "none", color: C.faint, cursor: "pointer", fontSize: 16 }}>✕</button>
              </div>
              {histErr && <div style={{ padding: "8px 18px", fontSize: 12, color: C.output }}>{histErr}</div>}
              <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
                {/* timeline */}
                <div style={{ width: 290, flex: "0 0 290px", borderRight: `1px solid ${C.borderSoft}`, overflowY: "auto", padding: "10px 12px" }}>
                  {histBusy && <div style={{ fontSize: 12, color: C.faint, padding: "8px 4px" }}>Loading…</div>}
                  {!histBusy && !histList.length && <div style={{ fontSize: 12, color: C.faint, padding: "8px 4px", lineHeight: 1.5 }}>No saved versions yet. Each save records one — save this harness to start the history.</div>}
                  {histList.map((v, i) => {
                    const isB = v.id === bId, isA = v.id === aId;
                    return (
                      <div key={v.id} onClick={() => { setHistSel(v.id); setHistBase(null); }}
                        style={{ cursor: "pointer", border: `1px solid ${isB ? C.accent : C.borderSoft}`, background: isB ? C.accentSoft : "transparent", borderRadius: 7, padding: "8px 10px", marginBottom: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 600, color: C.text }}>{relTime(v.createdAt)}{i === 0 && <span style={{ color: C.run, fontWeight: 400 }}> · latest</span>}</span>
                          <span style={{ display: "flex", gap: 5 }}>
                            {isA && <span style={{ fontFamily: MONO, fontSize: 9, color: C.mut, border: `1px solid ${C.border}`, borderRadius: 4, padding: "0 4px" }}>base</span>}
                            {!isB && !isA && <button onClick={(e) => { e.stopPropagation(); setHistBase(v.id); }} title="Use as comparison baseline" style={{ fontFamily: MONO, fontSize: 9, color: C.faint, background: "transparent", border: `1px solid ${C.borderSoft}`, borderRadius: 4, padding: "0 4px", cursor: "pointer" }}>set base</button>}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: C.faint, marginTop: 3 }}>{v.authorEmail ? String(v.authorEmail).replace(/@.*/, "") : "unknown"} · {v.nodeCount} blocks · {v.edgeCount} links</div>
                      </div>
                    );
                  })}
                </div>
                {/* diff */}
                <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
                  {!histSel && <div style={{ fontSize: 12.5, color: C.faint }}>Select a version to see what changed.</div>}
                  {histSel && !ready && <div style={{ fontSize: 12.5, color: C.faint }}>Loading diff…</div>}
                  {histSel && ready && d && (
                    <>
                      <div style={{ fontSize: 12, color: C.mut, marginBottom: 10, lineHeight: 1.5 }}>
                        Comparing <b style={{ color: C.text }}>{aMeta ? relTime(aMeta.createdAt) : "empty / initial"}</b> → <b style={{ color: C.text }}>{bMeta ? relTime(bMeta.createdAt) : ""}</b>
                      </div>
                      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 14 }}>
                        {chip(C.run, `+${d.addedNodes.length} blocks`)}
                        {chip(C.output, `−${d.removedNodes.length} blocks`)}
                        {chip(C.agent, `~${d.changedNodes.length} changed`)}
                        {chip(C.run, `+${d.addedEdges.length} links`)}
                        {chip(C.output, `−${d.removedEdges.length} links`)}
                      </div>
                      {d.changed === 0 && <div style={{ fontSize: 12.5, color: C.faint, padding: "8px 0" }}>No structural changes between these two versions.</div>}
                      {d.addedNodes.map((n) => row(C.run, <NodeIcon type={n.type} color={typeColor(n.type)} size={14} />, <><b>Added</b> {dispName(n)}</>))}
                      {d.changedNodes.map(({ before, after }) => { const ks = changedKeys(before, after); return row(C.agent, <NodeIcon type={after.type} color={typeColor(after.type)} size={14} />, <><b>Changed</b> {dispName(after)}{before.type !== after.type ? ` (type → ${after.type})` : ks.length ? <span style={{ color: C.faint }}> · {ks.slice(0, 5).join(", ")}{ks.length > 5 ? "…" : ""}</span> : ""}</>); })}
                      {d.removedNodes.map((n) => row(C.output, <NodeIcon type={n.type} color={typeColor(n.type)} size={14} />, <><b>Removed</b> {dispName(n)}</>))}
                      {d.addedEdges.map((e, i) => row(C.run, <span style={{ color: C.run, fontFamily: MONO, width: 14, textAlign: "center" }}>→</span>, <><b>Added link</b> {nm(bG, e.from)} → {nm(bG, e.to)}{e.kind !== "flow" ? ` (${e.kind})` : ""}</>))}
                      {d.removedEdges.map((e, i) => row(C.output, <span style={{ color: C.output, fontFamily: MONO, width: 14, textAlign: "center" }}>→</span>, <><b>Removed link</b> {nm(aG, e.from)} → {nm(aG, e.to)}{e.kind !== "flow" ? ` (${e.kind})` : ""}</>))}
                    </>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "12px 18px", borderTop: `1px solid ${C.borderSoft}` }}>
                <div style={{ fontSize: 11, color: C.faint }}>Restoring loads that version onto the canvas — save to keep it as a new version. Undoable.</div>
                <button disabled={!histSel || currentRole === "view"} onClick={() => restoreVersion(histSel)} title={currentRole === "view" ? "You have view-only access" : "Load this version onto the canvas"}
                  style={{ background: histSel && currentRole !== "view" ? C.accent : C.panel2, border: `1px solid ${C.border}`, color: histSel && currentRole !== "view" ? C.onAccent : C.faint, borderRadius: 6, padding: "8px 16px", fontSize: 12.5, fontWeight: 700, cursor: histSel && currentRole !== "view" ? "pointer" : "default" }}>
                  ⟲ Restore this version
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {conflict && (
        <div onClick={() => setConflict(null)} style={{ position: "fixed", inset: 0, background: "rgba(6,8,12,.7)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
          <div className="ergon-modal" onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.output}`, borderRadius: 10, width: "min(440px, 94vw)", padding: 22 }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>This harness changed on the server</div>
            <div style={{ color: C.mut, fontSize: 12.5, marginBottom: 16, lineHeight: 1.55 }}>
              Someone else saved “{conflict.name}” since you opened it{conflict.updated_at ? ` (${new Date(conflict.updated_at).toLocaleString()})` : ""}. Saving now would overwrite their changes. How do you want to resolve it?
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button onClick={() => saveHarness(false, true)} style={{ background: C.output, border: "none", color: C.onAccent, borderRadius: 6, padding: "9px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                Overwrite with my version
              </button>
              <button onClick={reloadFromConflict} style={{ background: "transparent", border: `1px solid ${C.link}`, color: C.link, borderRadius: 6, padding: "9px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                Discard mine &amp; load theirs
              </button>
              <button onClick={() => setConflict(null)} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.mut, borderRadius: 6, padding: "8px", fontSize: 12, cursor: "pointer" }}>
                Cancel (keep editing, don't save)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
