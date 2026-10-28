"""Load an Ergon Studio harness (the app's exported/shared JSON graph)
and run it headless through the SDK.

    from ergon import load_harness

    h = load_harness("harness.json", tools={"lookup_order": my_lookup_fn})
    result = h.run("Where is order 12345?")
    print(result.text, result.usage)

The graph shape matches the Studio's export:
    {"nodes": [{"id","type","x","y","config"}],
     "edges": [{"kind","from","to","fromPort","toPort"}]}
with node types input/agent/customtool/router/parallel/output and edge kinds
flow / tool / link / dispatch. Execution mirrors the Studio's engine and the
Python it generates (flow walk, connect(), route(), parallel()).

Custom tools: the app's tool bodies are either "simulated by Claude" or
browser JavaScript — neither crosses into Python. Supply real implementations
by name via `tools={...}`; any custom tool left unsupplied becomes a stub that
returns a clear placeholder so the run still completes.
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Union

from .agent import Agent, AgentResult
from .approval import ApprovalPolicy
from .flows import parallel as _parallel, route as _route
from .tools import Tool, tool as _tool_decorator


def _make_custom_tool(node_cfg: Dict[str, Any], impl: Optional[Callable]) -> Tool:
    name = (node_cfg.get("name") or "tool").replace(" ", "_")
    desc = node_cfg.get("description") or "A custom tool."
    if impl is not None:
        @_tool_decorator(desc, name=name)
        def _real(input: str, _impl=impl) -> str:
            return str(_impl(input))
        return _real

    @_tool_decorator(desc + " (stub: no Python implementation supplied)", name=name)
    def _stub(input: str) -> str:
        return (f"[stub tool '{name}'] No implementation was supplied for this custom tool. "
                f"Pass tools={{'{name}': fn}} to load_harness. Input was: {input}")
    return _stub


class Harness:
    """A loaded harness: agents wired together, ready to run the flow."""

    def __init__(self, graph: Dict[str, Any], *,
                 tools: Optional[Dict[str, Callable]] = None,
                 search_tools: Optional[Dict[str, Tool]] = None,
                 session_root: str = "./sessions",
                 approval: Optional[ApprovalPolicy] = None,
                 telemetry: Optional[bool] = None,
                 client=None):
        self.graph = graph
        self.nodes = {n["id"]: n for n in graph.get("nodes", [])}
        self.edges = graph.get("edges", [])
        self._tools = tools or {}
        self._search_tools = search_tools or {}
        self._session_root = session_root
        self._approval_override = approval
        self._telemetry_override = telemetry
        self._client = client
        self.agents: Dict[str, Agent] = {}      # node_id -> Agent
        self._build()

    # ── construction ──
    def _build(self) -> None:
        # 1) build every agent node
        for nid, node in self.nodes.items():
            if node["type"] == "agent":
                self.agents[nid] = self._build_agent(node)
        # 2) attach custom tools (tool edges: agent belly → customtool)
        for e in self._edges("tool"):
            agent = self.agents.get(e["from"])
            tnode = self.nodes.get(e["to"])
            if agent and tnode and tnode["type"] == "customtool":
                cfg = tnode.get("config", {})
                impl = self._tools.get(cfg.get("name"))
                t = _make_custom_tool(cfg, impl)
                agent.add_tool(t)
                # A caller-supplied implementation is an explicit authorization,
                # so it may run unattended. Unsupplied stubs are NOT auto-allowed
                # (they'd only emit a placeholder, and shouldn't run silently).
                if impl is not None:
                    agent.approval.always_allow(t.name)
        # 3) peer links (agent ↔ agent): directed from→to becomes ask_<to>
        for e in self._edges("link"):
            a, b = self.agents.get(e["from"]), self.agents.get(e["to"])
            if a and b:
                a.connect(b)

    def _build_agent(self, node: Dict[str, Any]) -> Agent:
        c = node.get("config", {})
        name = c.get("name") or f"agent_{node['id']}"
        provider = c.get("provider", "anthropic")
        kwargs: Dict[str, Any] = dict(
            name=name,
            system=c.get("system", ""),
            provider=provider,
            model=c.get("model") or None,
            mode=(c.get("customMode") if c.get("mode") == "custom" else c.get("mode", "execute")) or "execute",
            max_iterations=int(c.get("maxIterations", 6) or 6),
            allow_internet=bool(c.get("allowInternet", True)),
            session_dir=f"{self._session_root}/{name}",
            telemetry=self._telemetry_override if self._telemetry_override is not None else bool(c.get("otel", True)),
        )
        if provider == "openai" and c.get("baseUrl"):
            kwargs["base_url"] = c["baseUrl"]
        if provider == "bedrock" and c.get("baseUrl"):
            kwargs["base_url"] = c["baseUrl"]           # region
        if c.get("compaction"):
            kwargs["compaction"] = int(c.get("tokenBudget", 30000) or 30000)
        if c.get("files"):
            kwargs["working_dir"] = c.get("workingDir", "./workspace")
        if c.get("shell"):
            kwargs["enable_shell"] = True
            kwargs.setdefault("working_dir", c.get("workingDir", "./workspace"))
        if c.get("subagents"):
            kwargs["enable_subagents"] = True
        if not c.get("todo", True):
            kwargs["enable_todo"] = False
        if not c.get("memory", True):
            kwargs["enable_memory"] = False
        if c.get("skillsDir"):
            kwargs["skills_dir"] = c["skillsDir"]
        # search tool for providers without hosted search
        if self._search_tools.get(name):
            kwargs["search_tool"] = self._search_tools[name]
        # approval: explicit override wins; else map the app's mode + standing rules
        if self._approval_override is not None:
            kwargs["approval"] = self._approval_override
        else:
            interactive = c.get("approvalMode") == "interactive"
            pol = ApprovalPolicy(rules_path=f"{self._session_root}/{name}/approval_rules.json",
                                 interactive=interactive)
            for t in (c.get("alwaysAllow") or "").split(","):
                t = t.strip()
                if t:
                    pol.always_allow(t)
            kwargs["approval"] = pol
        if self._client is not None:
            kwargs["client"] = self._client
        return Agent(**kwargs)

    def _edges(self, kind: str) -> List[Dict[str, Any]]:
        return [e for e in self.edges if e.get("kind") == kind]

    def _next_flow(self, node_id: str) -> Optional[Dict[str, Any]]:
        for e in self._edges("flow"):
            if e["from"] == node_id:
                return self.nodes.get(e["to"])
        return None

    def _dispatch_targets(self, node_id: str) -> List[Dict[str, Any]]:
        ids = [e["to"] for e in self._edges("dispatch") if e["from"] == node_id]
        return [self.nodes[i] for i in ids if i in self.nodes and self.nodes[i]["type"] == "agent"]

    # ── execution: walk the flow, dispatching to SDK helpers ──
    def run(self, task: Optional[str] = None, *, store: Any = None,
            run_id: Optional[str] = None, resume: bool = False) -> AgentResult:
        """Walk the flow and return the final AgentResult.

        Durable execution (optional): pass `store` (a CheckpointStore or a
        directory path) to persist each node's output as it completes. If the
        run crashes, call again with the same `store` + `run_id` and
        `resume=True`: completed nodes return their stored output instead of
        re-executing (no duplicate model calls or tool side-effects), and the
        walk continues from the frontier. Without a store, behavior is unchanged.
        """
        from .usage import Usage
        from . import durable as _d

        store = _d.resolve_store(store)
        inp = next((n for n in self.nodes.values() if n["type"] == "input"), None)
        if inp is None and task is None:
            raise ValueError("Harness has no Input node; pass task=... explicitly.")
        task_text = task if task is not None else inp.get("config", {}).get("message", "")

        # ── durable state (only when a store is given) ──
        state = None
        if store is not None:
            run_id = run_id or f"run_{uuid.uuid4().hex[:12]}"
            fp = _d.graph_fingerprint(self.nodes, self.edges)
            if resume:
                state = store.load(run_id)
                if state is None:
                    raise ValueError(f"resume=True but no checkpoint for run_id={run_id!r}.")
                if state.get("fingerprint") != fp:
                    raise ValueError("Cannot resume: the harness graph changed since this run "
                                     f"started (run_id={run_id!r}). Start a fresh run.")
                if state.get("status") == _d.STATUS_DONE:
                    done = state["completed"].get(state["order"][-1]) if state.get("order") else None
                    r = AgentResult(text=state.get("payload", ""))
                    r.usage = _d.usage_from_jsonable(done.get("usage") if done else None)
                    return r
            else:
                state = _d.new_state(run_id, fp, task_text)
                store.save(run_id, state)

        payload = task_text
        result: Optional[AgentResult] = None
        total = Usage()
        seen = set()
        # On resume, rebuild the accumulated total + payload from completed nodes.
        if state is not None and state.get("completed"):
            for nid in state.get("order", []):
                rec = state["completed"].get(nid)
                if rec is None:
                    continue
                total.merge(_d.usage_from_jsonable(rec.get("usage")))
                payload = rec.get("text", payload)

        cur = inp if inp is not None else None
        if cur is None:
            node = next((n for n in self.nodes.values() if n["type"] == "agent"), None)
        else:
            node = self._next_flow(cur["id"])

        try:
            while node is not None and node["id"] not in seen:
                seen.add(node["id"])
                nid, t = node["id"], node["type"]

                # idempotent replay: a node already completed in a prior attempt
                # returns its stored output; it is not executed again.
                if state is not None and nid in state.get("completed", {}):
                    payload = state["completed"][nid].get("text", payload)
                    node = self._next_flow(nid); continue

                if t == "agent":
                    result = self._run_agent_node(node, payload)
                elif t == "router":
                    result = self._run_router(node, payload)
                elif t == "parallel":
                    result = self._run_parallel(node, payload)
                elif t == "output":
                    break
                else:
                    node = self._next_flow(nid); continue

                total.merge(result.usage)      # accumulate across every flow step
                payload = result.text

                if state is not None:          # persist this node's output durably
                    state["completed"][nid] = {"text": result.text,
                                               "usage": _d.usage_to_jsonable(result.usage),
                                               "at": time.time()}
                    state["order"].append(nid)
                    state["payload"] = payload
                    state["updated_at"] = time.time()
                    store.save(run_id, state)

                node = self._next_flow(nid)
        except Exception as e:
            if state is not None:
                state["status"] = _d.STATUS_ERROR
                state["error"] = str(e)
                state["updated_at"] = time.time()
                store.save(run_id, state)
            raise

        if result is None and not (state and state.get("completed")):
            raise ValueError("Flow produced no result — is an Agent connected to the Input?")
        if result is None:                     # everything was replayed from the store
            result = AgentResult(text=payload)
        result.usage = total                   # final result reflects the whole flow
        if state is not None:
            state["status"] = _d.STATUS_DONE
            state["payload"] = result.text
            state["updated_at"] = time.time()
            store.save(run_id, state)
        return result

    # ── streaming execution: same flow walk, JSON-serializable progress events ──
    def run_stream(self, task: Optional[str] = None):
        """Walk the flow like run(), yielding JSON-serializable progress events:

            {"event": <kind>, "node": <name|None>, "data": <...>}

        Agent nodes stream their own text / tool / iteration events; router and
        parallel nodes emit a coarse node_start / node_done (they fan out
        internally). A looped agent node runs to completion without token
        streaming. The final event is {"event":"result", "data": {...}} with the
        aggregate text and usage — the same result run() would return.
        """
        from .usage import Usage
        inp = next((n for n in self.nodes.values() if n["type"] == "input"), None)
        if inp is None and task is None:
            raise ValueError("Harness has no Input node; pass task=... explicitly.")
        payload = task if task is not None else inp.get("config", {}).get("message", "")

        cur = inp if inp is not None else None
        result: Optional[AgentResult] = None
        total = Usage()
        seen = set()
        if cur is None:
            node = next((n for n in self.nodes.values() if n["type"] == "agent"), None)
        else:
            node = self._next_flow(cur["id"])

        while node is not None and node["id"] not in seen:
            seen.add(node["id"])
            t = node["type"]
            name = (node.get("config", {}) or {}).get("name") or node["id"]
            if t == "agent":
                c = node.get("config", {})
                yield {"event": "node_start", "node": name, "data": {"type": "agent"}}
                if c.get("loopEnabled"):
                    result = self._run_agent_node(node, payload)   # looped: run whole
                else:
                    for ev in self.agents[node["id"]].run_stream(payload):
                        if ev.kind in ("done", "cancelled"):
                            result = ev.data
                        elif ev.kind == "text":
                            yield {"event": "text", "node": name, "data": ev.data}
                        elif ev.kind in ("tool_start", "tool_result", "iteration", "compaction"):
                            yield {"event": ev.kind, "node": name, "data": ev.data}
                yield {"event": "node_done", "node": name,
                       "data": {"stopped_because": result.stopped_because if result else "end"}}
            elif t == "router":
                yield {"event": "node_start", "node": name, "data": {"type": "router"}}
                result = self._run_router(node, payload)
                yield {"event": "node_done", "node": name, "data": {}}
            elif t == "parallel":
                yield {"event": "node_start", "node": name, "data": {"type": "parallel"}}
                result = self._run_parallel(node, payload)
                yield {"event": "node_done", "node": name, "data": {}}
            elif t == "output":
                break
            else:
                node = self._next_flow(node["id"]); continue
            total.merge(result.usage)
            payload = result.text
            node = self._next_flow(node["id"])

        if result is None:
            raise ValueError("Flow produced no result — is an Agent connected to the Input?")
        result.usage = total
        yield {"event": "result", "node": None, "data": {
            "text": result.text, "iterations": result.iterations,
            "stopped_because": result.stopped_because, "usage": total.as_dict()}}

    def _run_agent_node(self, node: Dict[str, Any], payload: str) -> AgentResult:
        agent = self.agents[node["id"]]
        c = node.get("config", {})
        if c.get("loopEnabled"):
            return agent.run_until(payload, condition=c.get("loopMarker", "DONE"),
                                   max_rounds=int(c.get("maxRounds", 3) or 3))
        return agent.run(payload)

    def _run_router(self, node: Dict[str, Any], payload: str) -> AgentResult:
        c = node.get("config", {})
        labels = [x.strip() for x in (c.get("labels") or "").split(",") if x.strip()]
        targets = self._dispatch_targets(node["id"])
        # map each label to the agent whose name matches (else by position) — same as the app
        routes: Dict[str, Agent] = {}
        for i, lab in enumerate(labels):
            match = next((t for t in targets if (t["config"].get("name") or "").lower() == lab.lower()), None)
            if match is None and i < len(targets):
                match = targets[i]
            if match is not None:
                routes[lab] = self.agents[match["id"]]
        # a lightweight classifier agent (mirrors the app's inline router agent)
        classifier = Agent(
            name=(c.get("name") or "router"),
            system=c.get("instruction", "Classify the request; reply with only the category word."),
            provider=c.get("provider", "anthropic"),
            model=c.get("model") or None,
            allow_internet=False,
            session_dir=f"{self._session_root}/{c.get('name') or 'router'}",
            telemetry=False,
            approval=ApprovalPolicy(interactive=False),
            enable_todo=False, enable_memory=False,
            client=self._client,
        )
        return _route(payload, classifier, routes)

    def _run_parallel(self, node: Dict[str, Any], payload: str) -> AgentResult:
        c = node.get("config", {})
        workers = [self.agents[t["id"]] for t in self._dispatch_targets(node["id"])]
        if not workers:
            raise ValueError(f"Parallel node '{c.get('name')}' has no worker agents.")
        joiner = None
        if c.get("join"):
            joiner = Agent(
                name=(c.get("name") or "join") + "_joiner",
                system=c.get("joinPrompt", "Combine these parallel results into one coherent answer."),
                provider=c.get("provider", "anthropic"),
                model=c.get("model") or None,
                allow_internet=False,
                session_dir=f"{self._session_root}/{c.get('name') or 'join'}_joiner",
                telemetry=False,
                approval=ApprovalPolicy(interactive=False),
                enable_todo=False, enable_memory=False,
                client=self._client,
            )
        return _parallel(payload, workers, joiner)


def load_harness(source: Union[str, Path, Dict[str, Any]], **kwargs) -> Harness:
    """Load a Studio harness from a JSON file path, a JSON string, or a dict.

    Accepts either a raw graph ({"nodes","edges"}) or the app's wrapped export
    ({"version","nodes","edges"}) — they share the same node/edge shape.
    """
    if isinstance(source, dict):
        graph = source
    else:
        s = str(source)
        is_path = len(s) < 4096 and not s.lstrip().startswith("{")
        text = Path(s).read_text() if (is_path and Path(s).exists()) else s
        graph = json.loads(text)
    if "nodes" not in graph or "edges" not in graph:
        raise ValueError("Not a harness graph: expected 'nodes' and 'edges'.")
    return Harness(graph, **kwargs)
