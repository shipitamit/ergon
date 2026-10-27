"""Context-window compaction.

Keeps long tool-calling loops from overflowing the context window. Active
whenever the Agent is given a token budget (int) or a custom strategy — any
object with over_budget(messages) and compact(messages, provider).
Messages are in the neutral format (see providers.py).
"""
from __future__ import annotations

import json
from typing import Any, Dict, List


def estimate_tokens(messages: List[Dict[str, Any]]) -> int:
    """Cheap, model-free estimate (~4 chars/token)."""
    return len(json.dumps(messages, default=str)) // 4


class TokenBudget:
    """Default strategy: when estimated tokens exceed `max_tokens`, older
    turns are summarized by the model into a single recap message; the
    `keep_recent` most recent messages are preserved verbatim."""

    def __init__(self, max_tokens: int = 60_000, keep_recent: int = 6):
        self.max_tokens = max_tokens
        self.keep_recent = keep_recent

    def over_budget(self, messages: List[Dict[str, Any]]) -> bool:
        return estimate_tokens(messages) > self.max_tokens

    def compact(self, messages: List[Dict], provider: Any) -> List[Dict]:
        if len(messages) <= self.keep_recent + 1:
            return self._truncate_tool_results(messages)
        cut = len(messages) - self.keep_recent
        # never let the kept tail start with orphaned tool results
        while cut > 0 and messages[cut]["role"] == "tool":
            cut -= 1
        head, tail = messages[:cut], messages[cut:]
        if not head:
            return self._truncate_tool_results(messages)
        try:
            resp = provider.complete(
                system=None,
                messages=[{
                    "role": "user",
                    "content": "Summarize this agent conversation so far — decisions made, "
                    "facts learned, tool results that matter, and what remains to do. "
                    "Be dense and factual:\n\n" + json.dumps(head, default=str)[:100_000],
                }],
                tools=[], max_tokens=800,
            )
            summary = resp.text
        except Exception as e:  # summarization must never kill the run
            summary = f"(summary unavailable: {e}) Earlier turns were truncated."
        recap = [
            {"role": "user", "content": f"[Context was compacted. Summary of earlier turns:]\n{summary}"},
            {"role": "assistant", "content": "Understood — continuing from that summary.", "tool_calls": []},
        ]
        return recap + tail

    @staticmethod
    def _truncate_tool_results(messages: List[Dict]) -> List[Dict]:
        out = []
        for m in messages:
            if m.get("role") == "tool" and len(str(m.get("content", ""))) > 1000:
                out.append({**m, "content": str(m["content"])[:1000] + " …[truncated]"})
            else:
                out.append(m)
        return out
