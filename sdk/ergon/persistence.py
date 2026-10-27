"""Session persistence.

Chat history is flushed to disk after *every individual model call*, so a
crashed run can be resumed with Agent.run(..., resume=True) and any live run
can be inspected mid-flight (history.json is always current).
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


# Patterns for secrets embedded in free text (defense-in-depth for prompt content).
_SECRET_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{8,}"),           # Anthropic keys
    re.compile(r"sk-[A-Za-z0-9]{20,}"),                  # OpenAI-style keys
    re.compile(r"AIza[A-Za-z0-9_\-]{20,}"),              # Google API keys
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{10,}"),    # bearer tokens
    re.compile(r"(?i)aws_secret_access_key\s*[=:]\s*\S+"),
    re.compile(r"AKIA[0-9A-Z]{16}"),                     # AWS access key IDs
]

# Field names whose *values* are redacted wholesale, regardless of format. This
# catches any secret placed in a sensitive field even if its shape matches none
# of the patterns above (new key formats, opaque tokens, etc.). Matched on the
# normalized key: lowercased with spaces/hyphens folded to underscores, so
# "API Key", "api-key", and "apiKey" all hit.
_SECRET_FIELDS = frozenset({
    "api_key", "apikey", "authorization", "auth", "token", "access_token",
    "refresh_token", "id_token", "secret", "client_secret", "password", "passwd",
    "pwd", "aws_secret_access_key", "aws_access_key_id", "session_secret",
    "private_key", "x_api_key", "bearer", "credential", "credentials",
})


def _sensitive_field(key: Any) -> bool:
    if not isinstance(key, str):
        return False
    norm = key.strip().lower().replace("-", "_").replace(" ", "_")
    if norm in _SECRET_FIELDS:
        return True
    # substring guard for composed names like "openai_api_key", "user_password",
    # "auth_token". Kept precise so counting fields (token_count, tokens_used,
    # n_tool_calls) and the like are NOT swept up.
    if any(marker in norm for marker in ("api_key", "secret", "password")):
        return True
    if "token" in norm:
        # a credential token, not a count: allow *_token / token_* but not
        # token_count / tokens_used / *_tokens.
        if norm.endswith("_count") or norm.endswith("_used") or norm.endswith("tokens"):
            return False
        return norm.endswith("_token") or norm.startswith("token") or norm == "token" or "auth_token" in norm
    if "authorization" in norm:
        return True
    return False


def _redact(obj: Any) -> Any:
    """Recursively redact secrets before anything reaches disk. Two layers:
    (1) any dict value under a sensitive field name (api_key, authorization,
    token, secret, password, …) is replaced wholesale, regardless of format;
    (2) secret-looking substrings in free text are pattern-scrubbed. Best-effort
    defense-in-depth, not a substitute for keeping secrets out of prompts."""
    if isinstance(obj, str):
        s = obj
        for pat in _SECRET_PATTERNS:
            s = pat.sub("[REDACTED]", s)
        return s
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if _sensitive_field(k) and v not in (None, "", {}, []):
                out[k] = "[REDACTED]"       # redact the value wholesale, any format
            else:
                out[k] = _redact(v)
        return out
    if isinstance(obj, (list, tuple)):
        return [_redact(v) for v in obj]
    return obj


class SessionStore:
    def __init__(self, session_dir: str):
        self.dir = Path(session_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.history_path = self.dir / "history.json"
        self.events_path = self.dir / "events.jsonl"
        self.checkpoints_dir = self.dir / "checkpoints"

    # ── history (crash recovery) ──
    def save_history(self, messages: List[Dict[str, Any]], meta: Optional[Dict] = None) -> None:
        tmp = self.history_path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"saved_at": time.time(), "meta": _redact(meta or {}), "messages": _redact(messages)}, default=str)
        )
        tmp.replace(self.history_path)  # atomic: a crash never corrupts history

    def load_history(self) -> Optional[List[Dict[str, Any]]]:
        if not self.history_path.exists():
            return None
        return json.loads(self.history_path.read_text()).get("messages")

    def clear(self) -> None:
        for p in (self.history_path, self.events_path):
            if p.exists():
                p.unlink()
        if self.checkpoints_dir.exists():
            for p in self.checkpoints_dir.glob("*.json"):
                p.unlink()

    # ── step checkpoints (resume a crashed run from a named step, not just the
    #    last message; the durable base layer for rollback/replay) ──
    def save_checkpoint(self, messages: List[Dict[str, Any]], *,
                        label: Optional[str] = None, meta: Optional[Dict] = None) -> Dict[str, Any]:
        """Persist a numbered, resumable snapshot of the run. Returns {seq, label}.

        Each checkpoint is a full message list plus metadata, written atomically
        so a crash never corrupts one. Sequence numbers increase monotonically;
        `label` is an optional human name (e.g. "step-3") for `resume_from=`.
        """
        self.checkpoints_dir.mkdir(parents=True, exist_ok=True)
        seq = len(list(self.checkpoints_dir.glob("*.json"))) + 1
        rec = {"seq": seq, "label": label, "saved_at": time.time(),
               "meta": _redact(meta or {}), "messages": _redact(messages)}
        path = self.checkpoints_dir / f"{seq:04d}.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(rec, default=str))
        tmp.replace(path)
        return {"seq": seq, "label": label}

    def list_checkpoints(self) -> List[Dict[str, Any]]:
        """Return checkpoint metadata (no message bodies), oldest first."""
        if not self.checkpoints_dir.exists():
            return []
        out = []
        for p in sorted(self.checkpoints_dir.glob("*.json")):
            try:
                rec = json.loads(p.read_text())
                out.append({"seq": rec.get("seq"), "label": rec.get("label"),
                            "saved_at": rec.get("saved_at"), "meta": rec.get("meta", {})})
            except (json.JSONDecodeError, OSError):
                continue
        return sorted(out, key=lambda r: r.get("seq") or 0)

    def load_checkpoint(self, ref: Any) -> Optional[List[Dict[str, Any]]]:
        """Load a checkpoint's messages by sequence number, label, or 'latest'."""
        if not self.checkpoints_dir.exists():
            return None
        files = sorted(self.checkpoints_dir.glob("*.json"))
        if not files:
            return None
        chosen = None
        if ref in ("latest", None):
            chosen = files[-1]
        elif isinstance(ref, int) or (isinstance(ref, str) and ref.isdigit()):
            seq = int(ref)
            chosen = next((p for p in files if p.name == f"{seq:04d}.json"), None)
        else:
            # match by label
            for p in files:
                try:
                    if json.loads(p.read_text()).get("label") == ref:
                        chosen = p
                        break
                except (json.JSONDecodeError, OSError):
                    continue
        if chosen is None:
            return None
        return json.loads(chosen.read_text()).get("messages")

    # ── event log (inspection) ──
    def log_event(self, kind: str, **data: Any) -> None:
        with self.events_path.open("a") as f:
            f.write(json.dumps(_redact({"t": time.time(), "kind": kind, **data}), default=str) + "\n")

    def events(self) -> List[Dict[str, Any]]:
        if not self.events_path.exists():
            return []
        return [json.loads(l) for l in self.events_path.read_text().splitlines() if l.strip()]
