"""The Agent: an automatic tool-calling loop with persistence, compaction,
modes, approval, telemetry, skills, sub-agents and agent-to-agent links —
running on any Provider (Anthropic, OpenAI-compatible, or your own).
"""
from __future__ import annotations

import json
import time
import uuid
import warnings
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Union

from .approval import ApprovalDenied, ApprovalPolicy
from .compaction import TokenBudget, estimate_tokens
from .persistence import SessionStore
from .providers import ModelResponse, ToolCall, _stream_via_complete, make_provider
from .retry import RetryPolicy, with_retry, NO_RETRY
from .errors import ProviderError, classify_provider_exception
from .skills import SkillLibrary
from .telemetry import Telemetry
from .tools import Tool, file_tools, memory_tools, shell_tools, todo_tools, tool
from .streaming import CancelToken, Cancelled, NULL_CANCEL, StreamEvent
from .usage import Usage

MODE_PREAMBLES = {
    "plan": (
        "You are in PLAN mode. Investigate with read-only tools, write a "
        "step-by-step plan to the todo list via todo_write, and present it. "
        "Do NOT modify files or run commands — mutating tools are blocked."
    ),
    "execute": (
        "You are in EXECUTE mode. Keep the todo list current: mark items "
        "in_progress before starting them and done immediately after. Work "
        "through the plan step by step."
    ),
}


@dataclass
class AgentResult:
    text: str
    messages: List[Dict[str, Any]] = field(default_factory=list)
    iterations: int = 0
    stopped_because: str = "end"
    usage: Usage = field(default_factory=Usage)

    def __str__(self) -> str:
        return self.text


def _trim_for_log(messages: List[Dict[str, Any]], per_msg: int = 400) -> List[Dict[str, Any]]:
    """Compact snapshot of a message list for the compaction event: keep roles
    and truncated content so the app can render a before/after diff without
    bloating events.jsonl with full tool outputs."""
    out = []
    for m in messages:
        c = m.get("content")
        if isinstance(c, list):
            text = json.dumps(c, default=str)
        else:
            text = str(c)
        out.append({"role": m.get("role", "?"), "preview": text[:per_msg]})
    return out


class Agent:
    def __init__(
        self,
        name: str,
        system: str = "",
        model: Optional[str] = None,
        tools: Optional[List[Tool]] = None,
        *,
        # provider: "anthropic" (default), "openai" (any /chat/completions-
        # compatible endpoint via base_url), or a Provider instance:
        provider: Union[str, Any] = "anthropic",
        base_url: Optional[str] = None,
        # 2) hosted web search on by default (kill switch). On providers
        # without hosted search, pass search_tool= to supply your own:
        allow_internet: bool = True,
        search_tool: Optional[Tool] = None,
        # 3) automatic tool loop with configurable limit:
        max_iterations: int = 10,
        # 5) compaction: int budget, a strategy object, or None (off):
        compaction: Union[int, Any, None] = None,
        # spend caps: stop the run once cumulative usage crosses either limit
        # (checked after each model call). None = no cap.
        max_total_tokens: Optional[int] = None,
        max_cost: Optional[float] = None,
        # 4/6/8) persistence root (history, todo, memory, approval rules):
        session_dir: Optional[str] = None,
        # 9) file tools jailed here (also cwd for the shell):
        working_dir: Optional[str] = None,
        # 7) plan / execute / custom mode string:
        mode: str = "execute",
        # 10) approval policy (defaults to interactive+heuristics):
        approval: Optional[ApprovalPolicy] = None,
        # guardrails: safety checks on the prompt (input_guards) and the final
        # answer (output_guards). Each is a list of ergon.guardrails.Guard. A
        # guard may redact, flag, or block; a block refuses the input / withholds
        # the output. Default: none (behavior unchanged).
        input_guards: Optional[List[Any]] = None,
        output_guards: Optional[List[Any]] = None,
        # 12) optional skills directory:
        skills_dir: Optional[str] = None,
        # 14) optional shell:
        enable_shell: bool = False,
        # 13) optional background sub-agents:
        enable_subagents: bool = False,
        enable_todo: bool = True,
        enable_memory: bool = True,
        # 11) OTel observability:
        telemetry: bool = True,
        # write a numbered, resumable checkpoint after every model call, so a
        # crashed run can resume from a specific step via run(resume_from=…),
        # not just the last message. Off by default (extra small writes).
        checkpoints: bool = False,
        max_tokens: int = 4096,
        # retry policy for transient provider failures (rate limits, 5xx,
        # timeouts). None = a sensible default (3 attempts, exp backoff). Pass
        # NO_RETRY or RetryPolicy(max_attempts=1) to disable.
        retry: Optional[Any] = None,
        api_key: Optional[str] = None,
        client=None,  # back-compat: an anthropic.Anthropic instance
    ):
        # ── fail fast on invalid configuration (mirrors the Studio's graph
        #    validation: catch mistakes here rather than at request time) ──
        if not str(name).strip():
            raise ValueError("Agent name must be a non-empty string.")
        if not isinstance(max_iterations, int) or max_iterations < 1:
            raise ValueError(f"[{name}] max_iterations must be an integer >= 1, got {max_iterations!r}.")
        if not isinstance(max_tokens, int) or max_tokens < 1:
            raise ValueError(f"[{name}] max_tokens must be a positive integer, got {max_tokens!r}.")
        if isinstance(compaction, int) and compaction < 1000:
            raise ValueError(f"[{name}] compaction token budget looks too small ({compaction}); expected >= 1000, or pass a strategy object / None.")
        if compaction is not None and not isinstance(compaction, int) \
                and not (hasattr(compaction, "over_budget") and hasattr(compaction, "compact")):
            raise TypeError(f"[{name}] compaction must be an int budget, None, or an object with over_budget()/compact().")
        if max_total_tokens is not None and (not isinstance(max_total_tokens, int) or max_total_tokens < 1):
            raise ValueError(f"[{name}] max_total_tokens must be a positive integer or None, got {max_total_tokens!r}.")
        if max_cost is not None and (not isinstance(max_cost, (int, float)) or max_cost <= 0):
            raise ValueError(f"[{name}] max_cost must be a positive number (USD) or None, got {max_cost!r}.")

        self.name = name
        self.system = system
        self.mode = mode
        self.input_guards = list(input_guards or [])
        self.output_guards = list(output_guards or [])
        self.max_iterations = max_iterations
        self.retry = retry if retry is not None else RetryPolicy()
        self.checkpoints_enabled = checkpoints
        self.max_tokens = max_tokens
        self.max_total_tokens = max_total_tokens
        self.max_cost = max_cost
        self.allow_internet = allow_internet
        self.provider = make_provider(provider, model, api_key, base_url, client=client)
        self.model = self.provider.model

        self.session_dir = Path(session_dir or f".ergon/{name}-{uuid.uuid4().hex[:6]}")
        self.session = SessionStore(str(self.session_dir))
        self.approval = approval or ApprovalPolicy(
            rules_path=str(self.session_dir / "approval_rules.json")
        )
        self.telemetry = Telemetry(enabled=telemetry)
        self.compaction = TokenBudget(compaction) if isinstance(compaction, int) else compaction

        self.tools: Dict[str, Tool] = {}
        for t in tools or []:
            self.add_tool(t)
        if enable_todo:
            for t in todo_tools(self.session_dir / "todo.json"):
                self.add_tool(t)
        if enable_memory:
            for t in memory_tools(self.session_dir / "memory"):
                self.add_tool(t)
        if working_dir:
            for t in file_tools(working_dir):
                self.add_tool(t)
        if enable_shell:
            if not working_dir:
                raise ValueError("enable_shell requires working_dir")
            for t in shell_tools(working_dir):
                self.add_tool(t)

        # hosted-search fallback for providers without one
        self._use_hosted_search = False
        if self.allow_internet:
            if getattr(self.provider, "supports_hosted_search", False):
                self._use_hosted_search = True
            elif search_tool is not None:
                self.add_tool(search_tool)
            else:
                warnings.warn(
                    f"[{name}] provider '{self.provider.name}' has no hosted web search; "
                    "pass search_tool=web_search_tool(fn) to enable search, or set allow_internet=False.",
                    stacklevel=2,
                )

        self.skills = SkillLibrary(skills_dir) if skills_dir else None
        if self.skills and self.skills.skills:
            self.add_tool(self.skills.load_tool())

        if enable_subagents:
            self.add_tool(self._subagent_tool())

        self._peers: Dict[str, "Agent"] = {}

    # ── 1) connect to other agents ──
    def connect(self, *agents: "Agent") -> "Agent":
        """Expose each peer as an ask_<peer> tool this agent can call."""
        for peer in agents:
            self._peers[peer.name] = peer
            p = peer

            @tool(
                f"Ask agent '{p.name}' to handle a task and return its answer. "
                f"Peer's role: {p.system[:200] or 'general assistant'}",
                safe=True,
                name=f"ask_{p.name}",
            )
            def ask(prompt: str, _peer=p) -> str:
                return _peer.run(prompt).text

            self.add_tool(ask)
        return self

    # ── 13) background sub-agents (inherit this agent's provider) ──
    def _subagent_tool(self) -> Tool:
        parent = self

        @tool(
            "Delegate independent subtasks to parallel background sub-agents. "
            'Pass tasks_json: a JSON array of task strings. Returns all results.',
        )
        def delegate_parallel(tasks_json: str) -> str:
            tasks = json.loads(tasks_json)[:6]

            def _run(i_task):
                i, task = i_task
                sub = Agent(
                    name=f"{parent.name}-sub{i}",
                    system=f"You are a focused sub-agent of {parent.name}. Complete the task and report back concisely.",
                    provider=parent.provider,
                    allow_internet=parent.allow_internet and parent._use_hosted_search,
                    max_iterations=parent.max_iterations,
                    session_dir=str(parent.session_dir / f"sub{i}"),
                    approval=ApprovalPolicy(interactive=False),
                    enable_todo=False, enable_memory=False, telemetry=parent.telemetry.enabled,
                )
                return f"### sub-task {i}: {task}\n{sub.run(task).text}"

            with ThreadPoolExecutor(max_workers=len(tasks)) as pool:
                return "\n\n".join(pool.map(_run, enumerate(tasks)))

        return delegate_parallel

    def add_tool(self, t: Tool) -> None:
        if t.name in self.tools:
            warnings.warn(
                f"[{self.name}] a tool named '{t.name}' already exists and will be overwritten; "
                "tool names must be unique.", stacklevel=2,
            )
        self.tools[t.name] = t

    def set_mode(self, mode: str) -> None:
        self.mode = mode

    # ── system prompt assembly (mode + skills metadata) ──
    def _system(self) -> str:
        parts = [self.system] if self.system else []
        parts.append(MODE_PREAMBLES.get(self.mode, f"You are in {self.mode.upper()} mode."))
        if self.skills:
            meta = self.skills.metadata_prompt()
            if meta:
                parts.append(meta)
        return "\n\n".join(parts)

    # ── the loop ──
    def checkpoints(self):
        """List this agent's saved step checkpoints (oldest first): each is
        {seq, label, saved_at, meta}. Resume from one with run(resume_from=…)."""
        return self.session.list_checkpoints()

    def run(self, prompt: str, *, resume: bool = False, resume_from: Optional[Any] = None,
            cancel: Optional[CancelToken] = None, max_wall_seconds: Optional[float] = None) -> AgentResult:
        """Run the tool-calling loop to completion and return the AgentResult.

        Implemented by consuming run_stream(), so there is a single loop. Pass a
        CancelToken (or max_wall_seconds) to stop mid-run; the returned result
        has stopped_because='cancelled' and whatever was produced so far.
        `resume_from` re-enters at a saved checkpoint (seq, label, or 'latest');
        it needs checkpoints=True on the agent that produced them.
        """
        result: Optional[AgentResult] = None
        for ev in self.run_stream(prompt, resume=resume, resume_from=resume_from,
                                  cancel=cancel, max_wall_seconds=max_wall_seconds):
            if ev.kind in ("done", "cancelled"):
                result = ev.data
        return result

    def run_stream(self, prompt: str, *, resume: bool = False, resume_from: Optional[Any] = None,
                   cancel: Optional[CancelToken] = None, max_wall_seconds: Optional[float] = None):
        """3) Automatic tool-calling loop, capped at max_iterations, as a generator.
        4) History is persisted after every model call (crash recovery).
        5) Compaction runs whenever a strategy says we're over budget.

        Yields StreamEvent objects: text deltas, tool_start/tool_result,
        iteration/compaction boundaries, and a final done/cancelled event whose
        data is the AgentResult. run() is a thin consumer of this."""
        tok = cancel or (CancelToken(deadline_seconds=max_wall_seconds) if max_wall_seconds else NULL_CANCEL)
        if max_wall_seconds and cancel is not None:
            # honor both: wrap so whichever trips first wins
            base = cancel
            class _Either(CancelToken):
                def __init__(s): super().__init__(deadline_seconds=max_wall_seconds)
                @property
                def cancelled(s): return base.cancelled or super().cancelled
            tok = _Either()

        if resume_from is not None:
            # re-enter at a specific saved checkpoint (crash recovery from a step)
            messages = self.session.load_checkpoint(resume_from) or []
            if not messages:
                raise ValueError(f"[{self.name}] no checkpoint found for resume_from={resume_from!r} "
                                 f"(enable checkpoints=True; see agent.checkpoints()).")
        elif resume:
            messages = self.session.load_history() or []
        else:
            messages = []
            self.session.clear()
        messages = list(messages)   # don't mutate the loaded snapshot in place

        # input guardrails: redact / flag / block the prompt before the model
        # (and before it's persisted) sees it.
        input_blocked = None
        if self.input_guards:
            from .guardrails import apply_guards
            gres = apply_guards(prompt, self.input_guards, "input")
            if gres.findings:
                self.session.log_event("guardrail", stage="input", action=gres.action,
                                        ok=gres.ok, findings=[f.type for f in gres.findings])
            if not gres.ok:
                input_blocked = gres.reason or "Request blocked by an input guardrail."
            else:
                prompt = gres.text

        messages.append({"role": "user", "content": prompt})
        self.session.log_event("run_start", agent=self.name, provider=self.provider.name,
                               model=self.model, prompt=prompt[:500], mode=self.mode)

        tool_defs = [t.to_api() for t in self.tools.values()]
        usage = Usage()
        final_text, stop = "", "max_iterations"
        i = 0

        def _finish(stop_reason):
            nonlocal final_text
            # output guardrails: redact / flag / block the final answer.
            if self.output_guards and stop_reason not in ("input_blocked",):
                from .guardrails import apply_guards
                gres = apply_guards(final_text, self.output_guards, "output")
                if gres.findings:
                    self.session.log_event("guardrail", stage="output", action=gres.action,
                                            ok=gres.ok, findings=[f.type for f in gres.findings])
                final_text = gres.text if gres.ok else (gres.reason or "Output withheld by a guardrail.")
            self.session.log_event("run_end", agent=self.name, stop=stop_reason, iterations=i + 1,
                                   total_tokens=usage.total_tokens, cost=usage.cost())
            return AgentResult(final_text, messages, i + 1, stop_reason, usage)

        if input_blocked is not None:
            final_text = input_blocked
            yield StreamEvent("done", _finish("input_blocked"), self.name)
            return

        for i in range(self.max_iterations):
            if tok.cancelled:
                yield StreamEvent("cancelled", _finish("cancelled"), self.name)
                return
            yield StreamEvent("iteration", i, self.name)

            if self.compaction and self.compaction.over_budget(messages):
                before = list(messages)
                t0 = time.perf_counter()
                messages = self.compaction.compact(messages, self.provider)
                comp = dict(
                    agent=self.name, iteration=i,
                    duration_ms=round((time.perf_counter() - t0) * 1000, 1),
                    before_msgs=len(before), after_msgs=len(messages),
                    before_tokens=estimate_tokens(before), after_tokens=estimate_tokens(messages),
                    before=_trim_for_log(before), after=_trim_for_log(messages),
                )
                self.session.log_event("compaction", **comp)
                yield StreamEvent("compaction", comp, self.name)

            if tok.cancelled:
                yield StreamEvent("cancelled", _finish("cancelled"), self.name)
                return

            # ── streamed model call ──
            t0 = time.perf_counter()
            resp: Optional[ModelResponse] = None
            # A custom provider only has to implement complete(); if it has no
            # native stream(), wrap it so the loop's interface stays uniform.
            _stream = getattr(self.provider, "stream", None)
            if _stream is None:
                _stream = lambda **kw: _stream_via_complete(self.provider, **kw)
            with self.telemetry.model_call(self.model, self.name, self.provider.name) as span:
                # Consume the stream inside a retryable closure. Text deltas are
                # buffered and only emitted after the call succeeds, so a
                # transient failure mid-stream can be retried cleanly without
                # double-emitting partial text to the caller.
                def _do_call():
                    buffered_text = []
                    final = None
                    for kind, payload in _stream(
                        system=self._system(), messages=messages, tools=tool_defs,
                        max_tokens=self.max_tokens, use_hosted_search=self._use_hosted_search,
                    ):
                        if kind == "text":
                            buffered_text.append(payload)
                        elif kind == "final":
                            final = payload
                    return buffered_text, final

                # attach a per-call logging callback to the policy
                _log_retry = lambda attempt, delay, err: self.session.log_event(
                    "provider_retry", agent=self.name, iteration=i,
                    attempt=attempt, delay_s=round(delay, 3),
                    error=type(err).__name__, status=err.status_code,
                )
                _policy = replace(self.retry, on_retry=_log_retry)
                text_chunks, resp = with_retry(
                    _do_call, _policy, provider=self.provider.name,
                )
                # replay buffered text as stream events now that the call succeeded
                for chunk in text_chunks:
                    if tok.cancelled:
                        yield StreamEvent("cancelled", _finish("cancelled"), self.name)
                        return
                    yield StreamEvent("text", chunk, self.name)
                if resp is None:
                    resp = ModelResponse(text="", stop="end")
                self.telemetry.record_usage(span, resp.usage, resp.stop)
            call_ms = round((time.perf_counter() - t0) * 1000, 1)

            u = resp.usage or {}
            # the model that actually served this call — a Router updates
            # `last_model` per call so a load-balanced pool's cost is attributed
            # to the real deployment; a plain provider's last_model == self.model.
            call_model = getattr(self.provider, "last_model", None) or self.model
            usage.add(call_model, u.get("input_tokens", 0), u.get("output_tokens", 0))

            messages.append({
                "role": "assistant", "content": resp.text,
                "tool_calls": [{"id": c.id, "name": c.name, "input": c.input} for c in resp.tool_calls],
                **({"_raw": resp.raw_content} if resp.raw_content else {}),
            })
            assistant_idx = len(messages) - 1
            self.session.log_event(
                "model_call", agent=self.name, iteration=i, model=call_model,
                provider=self.provider.name, duration_ms=call_ms, network_ms=getattr(resp, "network_ms", 0.0),
                input_tokens=u.get("input_tokens", 0), output_tokens=u.get("output_tokens", 0),
                stop=resp.stop, n_tool_calls=len(resp.tool_calls), message_index=assistant_idx,
            )
            self.session.save_history(messages, meta={"agent": self.name, "iteration": i})
            if self.checkpoints_enabled:
                self.session.save_checkpoint(messages, label=f"step-{i}",
                                             meta={"agent": self.name, "iteration": i, "stop": resp.stop})
            yield StreamEvent("message", messages[-1], self.name)

            final_text = resp.text or final_text

            # spend budget: stop once cumulative usage crosses a cap. Checked
            # here (after usage is aggregated) so we never begin a tool round or
            # another model call we can't afford.
            over = None
            if self.max_total_tokens is not None and usage.total_tokens >= self.max_total_tokens:
                over = f"tokens {usage.total_tokens} >= {self.max_total_tokens}"
            elif self.max_cost is not None and usage.cost() >= self.max_cost:
                over = f"cost ${usage.cost():.4f} >= ${self.max_cost:.4f}"
            if over is not None:
                self.session.log_event("budget_exceeded", agent=self.name, iteration=i,
                                       total_tokens=usage.total_tokens, cost=usage.cost(), detail=over)
                yield StreamEvent("done", _finish("over_budget"), self.name)
                return

            if resp.stop != "tool_use" or not resp.tool_calls:
                stop = resp.stop
                yield StreamEvent("done", _finish(stop), self.name)
                return

            for tc in resp.tool_calls:
                if tok.cancelled:
                    yield StreamEvent("cancelled", _finish("cancelled"), self.name)
                    return
                yield StreamEvent("tool_start", {"name": tc.name, "input": tc.input}, self.name)
                result, meta = self._exec(tc, i)
                messages.append({"role": "tool", "tool_call_id": tc.id, "name": tc.name, "content": result})
                self.session.log_event(
                    "tool_call", agent=self.name, iteration=i, tool=tc.name,
                    input=tc.input, output=str(result)[:1000],
                    duration_ms=meta["duration_ms"], denied=meta["denied"],
                    message_index=len(messages) - 1,
                )
                yield StreamEvent("tool_result", {"name": tc.name, "output": result,
                                                  "denied": meta["denied"], "ms": meta["duration_ms"]}, self.name)
            self.session.save_history(messages, meta={"agent": self.name, "iteration": i})

        yield StreamEvent("done", _finish(stop), self.name)

    def _exec(self, tc: ToolCall, iteration: int = 0):
        """Returns (result_str, meta) where meta carries timing/denial for events."""
        t = self.tools.get(tc.name)
        if t is None:
            return f"unknown tool '{tc.name}'", {"duration_ms": 0.0, "denied": False}
        try:
            self.approval.check(t, tc.input, plan_mode=(self.mode == "plan"))
        except ApprovalDenied as e:
            return f"DENIED: {e}", {"duration_ms": 0.0, "denied": True}
        t0 = time.perf_counter()
        with self.telemetry.tool_call(tc.name, self.name):
            try:
                out = str(t(**tc.input))
            except Exception as e:
                out = f"tool error: {e}"
        return out[:50_000], {"duration_ms": round((time.perf_counter() - t0) * 1000, 1), "denied": False}

    # ── 15) looping until a condition holds ──
    def run_until(
        self,
        prompt: str,
        condition: Union[str, Callable[[AgentResult], bool]],
        max_rounds: int = 5,
    ) -> AgentResult:
        """Re-invoke the agent until `condition` is satisfied.
        condition: a callable on AgentResult, or a substring of the answer
        (e.g. "DONE") the agent is told to emit when finished."""
        if isinstance(condition, str):
            marker = condition
            check = lambda r: marker in r.text
            prompt += f"\n\nWhen the task is fully complete, include the literal marker {marker} in your answer."
        else:
            check = condition

        result = self.run(prompt)
        for _ in range(max_rounds - 1):
            if check(result):
                break
            result = self.run(
                "The completion condition is not yet satisfied. Review the todo "
                "list and your memory notes, then continue the task.",
                resume=True,
            )
        return result
