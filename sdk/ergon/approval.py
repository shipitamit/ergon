"""Tool approval.

Three layers, checked in order:
  1. Standing rules — "don't ask again" decisions persisted to disk.
  2. Heuristics — safe (read-only) tools auto-approve; recognizably
     dangerous inputs auto-deny in unattended mode.
  3. Interactive prompt — y / n / a (always allow → becomes a standing rule).

With interactive=False the policy is suitable for unattended execution:
only rules + heuristics apply, everything else is denied.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from .tools import Tool

_SAFE_NAME = re.compile(r"^(read_|list_|get_|probe_|todo_read|memory_read|search)")
_DANGEROUS_INPUT = re.compile(
    r"(rm\s+-rf\s+/|sudo\s|mkfs|:\(\)\{|>\s*/dev/sd|shutdown|curl[^|]*\|\s*(ba)?sh)", re.I
)


class ApprovalDenied(Exception):
    pass


class ApprovalPolicy:
    def __init__(
        self,
        rules_path: Optional[str] = None,
        interactive: bool = True,
        heuristics: bool = True,
        always_allow: Optional[list] = None,
    ):
        self.interactive = interactive
        self.heuristics = heuristics
        self.rules_path = Path(rules_path) if rules_path else None
        self._rules = set()
        if self.rules_path and self.rules_path.exists():
            self._rules = set(json.loads(self.rules_path.read_text()).get("always_allow", []))
        for t in (always_allow or []):
            self._rules.add(t)   # standing allow-rules supplied at construction

    def always_allow(self, tool_name: str) -> None:
        self._rules.add(tool_name)
        if self.rules_path:
            self.rules_path.parent.mkdir(parents=True, exist_ok=True)
            self.rules_path.write_text(json.dumps({"always_allow": sorted(self._rules)}, indent=2))

    def check(self, tool: Tool, tool_input: dict, plan_mode: bool = False) -> bool:
        """Return True to run the tool; raise ApprovalDenied otherwise."""
        text = json.dumps(tool_input, default=str)

        # plan mode: mutating tools are frozen regardless of rules
        if plan_mode and not (tool.safe or _SAFE_NAME.match(tool.name)):
            raise ApprovalDenied(f"'{tool.name}' blocked: agent is in plan mode (read-only)")

        if self.heuristics and _DANGEROUS_INPUT.search(text):
            raise ApprovalDenied(f"'{tool.name}' blocked by safety heuristic: {text[:120]}")

        if tool.name in self._rules:
            return True
        if self.heuristics and (tool.safe or _SAFE_NAME.match(tool.name)):
            return True

        if not self.interactive:
            raise ApprovalDenied(f"'{tool.name}' requires approval (unattended mode, no standing rule)")

        ans = input(f"\n[approval] {tool.name}({text[:200]})  — allow? [y/n/a=always] ").strip().lower()
        if ans == "a":
            self.always_allow(tool.name)
            return True
        if ans == "y":
            return True
        raise ApprovalDenied(f"user denied '{tool.name}'")
