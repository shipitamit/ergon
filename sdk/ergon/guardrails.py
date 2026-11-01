"""Guardrails — drop-in safety checks for what goes into and comes out of an agent.

Three deterministic, dependency-free guards that attach to an Agent (or run
standalone):

    PIIGuard         detect + redact emails, phones, cards, SSNs, IPs, keys
    ModerationGuard  block/flag content by pattern (or an injected classifier)
    SchemaGuard      validate that output parses + matches a JSON shape

Each guard implements `check(text, stage) -> GuardResult`. Attach them to an
Agent via `input_guards=[...]` (run on the prompt before the model sees it) and
`output_guards=[...]` (run on the final answer). A guard's `action` decides what
a finding does:

    "redact"  replace the matched spans, keep going (PII default)
    "flag"    annotate findings but allow the text through
    "block"   stop: the input is refused / the output is withheld

Everything here is offline and deterministic, so it's fully unit-tested. The
moderation default is pattern-based; pass `classifier=` to back it with a model.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple


@dataclass
class Finding:
    type: str                 # e.g. "email", "credit_card", "profanity", "schema"
    category: str = "pii"     # "pii" | "moderation" | "schema"
    value: str = ""           # the matched text (already safe to log for moderation; truncated for PII)
    detail: str = ""


@dataclass
class GuardResult:
    ok: bool                  # False only when a guard blocks
    text: str                 # possibly redacted
    findings: List[Finding] = field(default_factory=list)
    action: str = "allow"     # the strongest action taken: allow | flag | redact | block
    reason: str = ""


# ── PII detection ──

PII_PATTERNS: Dict[str, re.Pattern] = {
    "email": re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    # 13–16 digit card numbers, optionally grouped by spaces/hyphens
    "credit_card": re.compile(r"\b(?:\d[ -]*?){13,16}\b"),
    "ssn": re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    "phone": re.compile(r"(?<!\d)(?:\+?\d{1,2}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}(?!\d)"),
    "ip": re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b"),
    # common secret shapes: sk-..., ghp_..., AKIA..., long base64-ish tokens
    "api_key": re.compile(r"\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b"),
}
# order matters: match the most specific/structured first so a card isn't eaten
# by the phone matcher, etc.
_PII_ORDER = ["email", "api_key", "credit_card", "ssn", "ip", "phone"]


def _luhn_ok(digits: str) -> bool:
    ds = [int(c) for c in digits if c.isdigit()]
    if not (13 <= len(ds) <= 19):
        return False
    total, parity = 0, len(ds) % 2
    for i, d in enumerate(ds):
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def find_pii(text: str, types: Optional[Sequence[str]] = None) -> List[Tuple[str, int, int]]:
    """Return (type, start, end) spans, de-overlapped, most-specific-first.
    Credit-card candidates are Luhn-checked to cut false positives."""
    wanted = list(types) if types else _PII_ORDER
    spans: List[Tuple[str, int, int]] = []
    taken: List[Tuple[int, int]] = []

    def overlaps(a, b):
        return any(not (b <= s or a >= e) for s, e in taken)

    for t in _PII_ORDER:
        if t not in wanted:
            continue
        for m in PII_PATTERNS[t].finditer(text):
            s, e = m.start(), m.end()
            if t == "credit_card" and not _luhn_ok(m.group()):
                continue
            if overlaps(s, e):
                continue
            spans.append((t, s, e))
            taken.append((s, e))
    spans.sort(key=lambda x: x[1])
    return spans


def redact_pii(text: str, types: Optional[Sequence[str]] = None) -> Tuple[str, List[Finding]]:
    """Replace detected PII with typed placeholders. Returns (redacted, findings)."""
    spans = find_pii(text, types)
    findings: List[Finding] = []
    out, last = [], 0
    for t, s, e in spans:
        out.append(text[last:s])
        out.append(f"[REDACTED:{t}]")
        raw = text[s:e]
        # keep only a short, non-recoverable hint in the finding
        hint = raw[:2] + "…" if len(raw) > 3 else "…"
        findings.append(Finding(type=t, category="pii", value=hint))
        last = e
    out.append(text[last:])
    return "".join(out), findings


# ── guards ──

class Guard:
    name = "guard"
    stages = ("input", "output")

    def check(self, text: str, stage: str = "input") -> GuardResult:
        raise NotImplementedError


class PIIGuard(Guard):
    """Detect PII; redact (default), flag, or block."""
    name = "pii"

    def __init__(self, types: Optional[Sequence[str]] = None, action: str = "redact"):
        if action not in ("redact", "flag", "block"):
            raise ValueError("PIIGuard action must be redact, flag, or block.")
        self.types = types
        self.action = action

    def check(self, text: str, stage: str = "input") -> GuardResult:
        if self.action == "redact":
            redacted, findings = redact_pii(text, self.types)
            if not findings:
                return GuardResult(ok=True, text=text)
            return GuardResult(ok=True, text=redacted, findings=findings, action="redact")
        spans = find_pii(text, self.types)
        findings = [Finding(type=t, category="pii") for t, _, _ in spans]
        if not findings:
            return GuardResult(ok=True, text=text)
        if self.action == "block":
            return GuardResult(ok=False, text=text, findings=findings, action="block",
                               reason=f"Blocked: contains {len(findings)} PII item(s).")
        return GuardResult(ok=True, text=text, findings=findings, action="flag")


DEFAULT_BLOCKLIST = [
    # a deliberately small, generic default — real deployments pass their own
    # list or a model-backed classifier.
    r"\bkill yourself\b", r"\bmake a bomb\b", r"\bchild p[o0]rn\b",
]


class ModerationGuard(Guard):
    """Flag or block disallowed content. Pattern-based by default; pass a
    `classifier(text) -> list[str]` (category labels) to use a model instead."""
    name = "moderation"

    def __init__(self, blocklist: Optional[Sequence[str]] = None,
                 classifier: Optional[Callable[[str], Sequence[str]]] = None,
                 action: str = "block"):
        if action not in ("flag", "block"):
            raise ValueError("ModerationGuard action must be flag or block.")
        self.patterns = [re.compile(p, re.IGNORECASE) for p in (blocklist if blocklist is not None else DEFAULT_BLOCKLIST)]
        self.classifier = classifier
        self.action = action

    def check(self, text: str, stage: str = "input") -> GuardResult:
        findings: List[Finding] = []
        if self.classifier is not None:
            for cat in (self.classifier(text) or []):
                findings.append(Finding(type=str(cat), category="moderation"))
        else:
            for pat in self.patterns:
                if pat.search(text):
                    findings.append(Finding(type="blocklist", category="moderation", detail=pat.pattern))
        if not findings:
            return GuardResult(ok=True, text=text)
        if self.action == "block":
            return GuardResult(ok=False, text=text, findings=findings, action="block",
                               reason=f"Blocked by moderation ({len(findings)} match).")
        return GuardResult(ok=True, text=text, findings=findings, action="flag")


class SchemaGuard(Guard):
    """Validate that (output) text parses as JSON and matches a shape. `flag`
    annotates a mismatch; `block` withholds non-conforming output. Output stage."""
    name = "schema"
    stages = ("output",)

    def __init__(self, schema: Dict[str, Any], action: str = "flag"):
        if action not in ("flag", "block"):
            raise ValueError("SchemaGuard action must be flag or block.")
        self.schema = schema
        self.action = action

    def check(self, text: str, stage: str = "output") -> GuardResult:
        errors: List[str] = []
        try:
            data = json.loads(text)
        except (ValueError, TypeError):
            errors = ["output is not valid JSON"]
        else:
            errors = validate_schema(data, self.schema)
        if not errors:
            return GuardResult(ok=True, text=text)
        findings = [Finding(type="schema", category="schema", detail=e) for e in errors]
        if self.action == "block":
            return GuardResult(ok=False, text=text, findings=findings, action="block",
                               reason="Output did not match the required schema.")
        return GuardResult(ok=True, text=text, findings=findings, action="flag")


def validate_schema(data: Any, schema: Dict[str, Any], path: str = "$") -> List[str]:
    """A tiny JSON-schema-ish validator: type, required, properties, items, enum.
    Dependency-free and deliberately minimal (not a full JSON Schema engine)."""
    errors: List[str] = []
    t = schema.get("type")
    _types = {"object": dict, "array": list, "string": str, "boolean": bool, "null": type(None)}
    if t == "number":
        if isinstance(data, bool) or not isinstance(data, (int, float)):
            errors.append(f"{path}: expected number")
    elif t == "integer":
        if isinstance(data, bool) or not isinstance(data, int):
            errors.append(f"{path}: expected integer")
    elif t in _types and not isinstance(data, _types[t]):
        errors.append(f"{path}: expected {t}")
    if "enum" in schema and data not in schema["enum"]:
        errors.append(f"{path}: not one of {schema['enum']}")
    if t == "object" and isinstance(data, dict):
        for req in schema.get("required", []):
            if req not in data:
                errors.append(f"{path}.{req}: required")
        for key, sub in (schema.get("properties") or {}).items():
            if key in data:
                errors += validate_schema(data[key], sub, f"{path}.{key}")
    if t == "array" and isinstance(data, list) and "items" in schema:
        for idx, item in enumerate(data):
            errors += validate_schema(item, schema["items"], f"{path}[{idx}]")
    return errors


def apply_guards(text: str, guards: Sequence[Guard], stage: str = "input") -> GuardResult:
    """Run guards in order. Redactions accumulate; findings aggregate; the first
    block short-circuits with ok=False. A guard that doesn't run at this stage is
    skipped."""
    cur = text
    all_findings: List[Finding] = []
    strongest = "allow"
    rank = {"allow": 0, "flag": 1, "redact": 2, "block": 3}
    for g in guards or []:
        if stage not in getattr(g, "stages", ("input", "output")):
            continue
        res = g.check(cur, stage)
        all_findings.extend(res.findings)
        if rank.get(res.action, 0) > rank[strongest]:
            strongest = res.action
        if not res.ok:
            return GuardResult(ok=False, text=cur, findings=all_findings, action="block", reason=res.reason)
        cur = res.text
    return GuardResult(ok=True, text=cur, findings=all_findings, action=strongest)
