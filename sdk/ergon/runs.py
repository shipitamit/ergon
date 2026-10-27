"""Run records — a structured, persistable history of a single harness run.

A RunRecorder consumes the progress events a run emits (the dicts from
`Harness.run_stream`, or `Agent` StreamEvents) and assembles one RunRecord: the
input, the step/tool timeline with relative timings, the final output, token &
cost usage, latency, and an outcome status. The record is JSON-serializable, so
the serving layer, a headless run, or the Studio can store and replay it.

    from ergon import load_harness
    from ergon.runs import run_and_record

    rec, text = run_and_record(load_harness("harness.json"), "Where is order 1?")
    store(rec.as_dict())      # -> {"input","output","status","steps",[...],"usage",...}
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional


def _now_ms() -> int:
    return int(time.time() * 1000)


def _truncate(v: Any, n: int = 500) -> Any:
    if isinstance(v, str) and len(v) > n:
        return v[:n] + "…"
    return v


def _compact(data: Any) -> Any:
    """Keep step detail small and serializable (tool outputs can be huge)."""
    if isinstance(data, dict):
        return {k: _truncate(data[k]) for k in data}
    return _truncate(data)


def _status_from(stop: Optional[str]) -> str:
    if stop == "cancelled":
        return "cancelled"
    if stop == "over_budget":
        return "error"
    return "ok"   # end, max_iterations, etc. all completed without failure


@dataclass
class RunStep:
    kind: str                       # node_start | node_done | tool_start | tool_result | iteration | compaction | error
    node: Optional[str] = None
    at_ms: int = 0                  # ms since run start
    detail: Any = None

    def as_dict(self) -> Dict[str, Any]:
        return {"kind": self.kind, "node": self.node, "at_ms": self.at_ms, "detail": self.detail}


@dataclass
class RunRecord:
    input: str = ""
    output: str = ""
    status: str = "ok"              # ok | error | cancelled
    harness: Optional[str] = None
    started_at: int = 0             # epoch ms
    finished_at: int = 0
    latency_ms: int = 0
    steps: List[RunStep] = field(default_factory=list)
    usage: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "input": self.input,
            "output": self.output,
            "status": self.status,
            "harness": self.harness,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "latency_ms": self.latency_ms,
            "steps": [s.as_dict() for s in self.steps],
            "usage": self.usage,
        }


class RunRecorder:
    """Assemble a RunRecord from a run's event stream.

    Accepts the dict events from `Harness.run_stream` ({"event","node","data"})
    or `Agent`/flow StreamEvents (objects with .kind/.data/.agent).
    """

    def __init__(self, *, harness: Optional[str] = None, input_text: str = ""):
        self.harness = harness
        self.input = input_text

    @staticmethod
    def _norm(ev: Any):
        if isinstance(ev, dict):
            return ev.get("event"), ev.get("node"), ev.get("data")
        # a StreamEvent-like object
        return getattr(ev, "kind", None), getattr(ev, "agent", None) or None, getattr(ev, "data", None)

    def record(self, events: Iterable[Any]) -> RunRecord:
        t0 = _now_ms()
        steps: List[RunStep] = []
        output, usage, status = "", {}, "ok"
        for ev in events:
            kind, node, data = self._norm(ev)
            if kind == "result":
                data = data or {}
                output = data.get("text", output)
                usage = data.get("usage", usage)
                status = _status_from(data.get("stopped_because"))
            elif kind in ("done", "cancelled"):
                # StreamEvent final: data is an AgentResult
                output = getattr(data, "text", output)
                u = getattr(data, "usage", None)
                if u is not None and hasattr(u, "as_dict"):
                    usage = u.as_dict()
                status = _status_from(getattr(data, "stopped_because", None) or ("cancelled" if kind == "cancelled" else None))
            elif kind == "error":
                status = "error"
                output = output or (data.get("error") if isinstance(data, dict) else str(data))
                steps.append(RunStep("error", node, _now_ms() - t0, _compact(data)))
            elif kind == "text":
                continue   # token deltas aren't stored individually; output comes from the result
            else:
                steps.append(RunStep(kind or "event", node, _now_ms() - t0, _compact(data)))
        end = _now_ms()
        return RunRecord(input=self.input, output=output, status=status, harness=self.harness,
                         started_at=t0, finished_at=end, latency_ms=end - t0, steps=steps, usage=usage)


def run_and_record(harness, task: Optional[str] = None, *, name: Optional[str] = None):
    """Run a harness via its stream and return (RunRecord, output_text)."""
    rec = RunRecorder(harness=name, input_text=task if task is not None else "")
    record = rec.record(harness.run_stream(task))
    return record, record.output
