"""Streaming events and cancellation.

`run_stream()` yields StreamEvent objects as a run unfolds; `run()` consumes
that same generator and returns the final AgentResult, so there is one loop.
A CancelToken lets a caller stop a run at the next safe checkpoint.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Optional


class Cancelled(Exception):
    """Raised internally when a run is cancelled; surfaced as stopped_because='cancelled'."""


class CancelToken:
    """Thread-safe cancellation flag.

        tok = CancelToken()
        # ... in another thread / signal handler ...
        tok.cancel()

    Optionally auto-cancels after `deadline_seconds`.
    """
    def __init__(self, deadline_seconds: Optional[float] = None):
        self._event = threading.Event()
        self._deadline = (time.monotonic() + deadline_seconds) if deadline_seconds else None

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        if self._event.is_set():
            return True
        if self._deadline is not None and time.monotonic() >= self._deadline:
            self._event.set()
            return True
        return False

    def check(self) -> None:
        if self.cancelled:
            raise Cancelled()


# A token whose .cancelled is always False — the default when the caller passes none.
class _NullToken(CancelToken):
    def __init__(self):
        super().__init__()
    @property
    def cancelled(self) -> bool:
        return False
    def check(self) -> None:
        pass


NULL_CANCEL = _NullToken()


@dataclass
class StreamEvent:
    """One event in a streamed run.

    kind:
      "text"        — a text delta from the model (data=str)
      "message"     — an assistant message completed (data=the message dict)
      "tool_start"  — a tool is about to run (data={"name","input"})
      "tool_result" — a tool finished (data={"name","output","denied","ms"})
      "iteration"   — a new loop iteration began (data=int index)
      "compaction"  — context was compacted (data=the compaction event dict)
      "done"        — run finished (data=the final AgentResult)
      "cancelled"   — run was cancelled (data=the partial AgentResult)
    """
    kind: str
    data: Any = None
    agent: str = ""

    @property
    def text(self) -> str:
        return self.data if self.kind == "text" and isinstance(self.data, str) else ""
