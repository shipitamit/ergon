"""Durable flow execution — persist a harness run's progress so it survives a
crash or restart and resumes from the last completed node, not from the start.

Per-agent message checkpoints (see agent.py) already make a single agent
resumable. This adds **flow-level** durability: the Harness walk records each
node's output to a CheckpointStore as the node completes, and a resumed run
replays the walk, returning each already-completed node's stored output instead
of re-executing it — so no duplicate model calls or tool side-effects
(idempotent at the node boundary).

Scope: single-runner durable execution with crash recovery. A shared store (the
SQLite store on a shared path, or a future database store) lets a *different*
process pick up an interrupted run, but distributed exactly-once across a
cluster (leases, fencing) is intentionally out of scope here.

    store = FileCheckpointStore("./.runs")
    h.run("do the thing", store=store, run_id="job-42")     # crashes at node 3
    h.run("do the thing", store=store, run_id="job-42", resume=True)  # finishes
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


# ── run-state schema ────────────────────────────────────────────────────────
# A checkpoint is a plain dict so every store serializes it the same way:
#   { run_id, fingerprint, status, task, payload,
#     completed: { node_id: {text, usage, at} }, order: [node_id, ...],
#     started_at, updated_at, error? }
STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_ERROR = "error"


def graph_fingerprint(nodes: Any, edges: Any) -> str:
    """Stable hash of a graph's shape + node configs. A resumed run must target
    the same graph it started on; a changed fingerprint means the harness was
    edited and the old checkpoint can't be trusted to line up."""
    def _node_key(n: Dict[str, Any]) -> Any:
        return {"id": n.get("id"), "type": n.get("type"), "config": n.get("config", {})}
    nlist = sorted((_node_key(n) for n in (nodes.values() if isinstance(nodes, dict) else nodes)),
                   key=lambda x: str(x["id"]))
    elist = sorted(({"kind": e.get("kind"), "from": e.get("from"), "to": e.get("to"),
                     "fromPort": e.get("fromPort"), "toPort": e.get("toPort")} for e in edges),
                   key=lambda x: json.dumps(x, sort_keys=True, default=str))
    blob = json.dumps({"nodes": nlist, "edges": elist}, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def new_state(run_id: str, fingerprint: str, task: str) -> Dict[str, Any]:
    now = time.time()
    return {"run_id": run_id, "fingerprint": fingerprint, "status": STATUS_RUNNING,
            "task": task, "payload": task, "completed": {}, "order": [],
            "started_at": now, "updated_at": now}


# ── stores ──────────────────────────────────────────────────────────────────
class CheckpointStore:
    """Interface: save/load/list/delete run states. Subclasses must be safe to
    call from the Harness after every node (so keep writes cheap + atomic)."""
    def save(self, run_id: str, state: Dict[str, Any]) -> None: raise NotImplementedError
    def load(self, run_id: str) -> Optional[Dict[str, Any]]: raise NotImplementedError
    def list(self) -> List[Dict[str, Any]]: raise NotImplementedError
    def delete(self, run_id: str) -> None: raise NotImplementedError


class MemoryCheckpointStore(CheckpointStore):
    """In-process store — for tests and ephemeral runs. Not durable across a
    process exit (use File/SQLite for that)."""
    def __init__(self) -> None:
        self._d: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
    def save(self, run_id, state):
        with self._lock:
            self._d[run_id] = json.loads(json.dumps(state, default=str))
    def load(self, run_id):
        with self._lock:
            s = self._d.get(run_id)
            return json.loads(json.dumps(s, default=str)) if s is not None else None
    def list(self):
        with self._lock:
            return [{"run_id": k, "status": v.get("status"), "updated_at": v.get("updated_at")}
                    for k, v in self._d.items()]
    def delete(self, run_id):
        with self._lock:
            self._d.pop(run_id, None)


def _safe_name(run_id: str) -> str:
    return "".join(c if (c.isalnum() or c in "-_.") else "_" for c in str(run_id))[:120] or "run"


class FileCheckpointStore(CheckpointStore):
    """One JSON file per run, written atomically (tmp + rename). Durable across
    restarts; the simplest real store."""
    def __init__(self, directory: str) -> None:
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
    def _path(self, run_id: str) -> Path:
        return self.dir / f"{_safe_name(run_id)}.json"
    def save(self, run_id, state):
        p = self._path(run_id)
        fd, tmp = tempfile.mkstemp(dir=str(self.dir), suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(state, f, default=str)
            os.replace(tmp, p)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    def load(self, run_id):
        p = self._path(run_id)
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text())
        except (ValueError, OSError):
            return None
    def list(self):
        out = []
        for p in sorted(self.dir.glob("*.json")):
            try:
                s = json.loads(p.read_text())
                out.append({"run_id": s.get("run_id"), "status": s.get("status"), "updated_at": s.get("updated_at")})
            except (ValueError, OSError):
                continue
        return out
    def delete(self, run_id):
        try:
            self._path(run_id).unlink()
        except OSError:
            pass


class SQLiteCheckpointStore(CheckpointStore):
    """A single-file SQLite store (stdlib, zero deps). Pointed at a shared path,
    a second process can resume an interrupted run."""
    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.Lock()
        with self._conn() as c:
            c.execute("CREATE TABLE IF NOT EXISTS runs ("
                      "run_id TEXT PRIMARY KEY, status TEXT, updated_at REAL, state_json TEXT)")
    def _conn(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.execute("PRAGMA journal_mode=WAL")
        return conn
    def save(self, run_id, state):
        blob = json.dumps(state, default=str)
        with self._lock, self._conn() as c:
            c.execute("INSERT INTO runs (run_id, status, updated_at, state_json) VALUES (?,?,?,?) "
                      "ON CONFLICT(run_id) DO UPDATE SET status=excluded.status, "
                      "updated_at=excluded.updated_at, state_json=excluded.state_json",
                      (run_id, state.get("status"), state.get("updated_at"), blob))
    def load(self, run_id):
        with self._lock, self._conn() as c:
            row = c.execute("SELECT state_json FROM runs WHERE run_id=?", (run_id,)).fetchone()
        return json.loads(row[0]) if row else None
    def list(self):
        with self._lock, self._conn() as c:
            rows = c.execute("SELECT run_id, status, updated_at FROM runs ORDER BY updated_at DESC").fetchall()
        return [{"run_id": r[0], "status": r[1], "updated_at": r[2]} for r in rows]
    def delete(self, run_id):
        with self._lock, self._conn() as c:
            c.execute("DELETE FROM runs WHERE run_id=?", (run_id,))


def usage_to_jsonable(u: Any) -> Dict[str, Any]:
    """Faithful, JSON-safe snapshot of a Usage (so cost/tokens survive a resume)."""
    return {"input_tokens": getattr(u, "input_tokens", 0),
            "output_tokens": getattr(u, "output_tokens", 0),
            "calls": getattr(u, "calls", 0),
            "by_model": {m: list(v) for m, v in getattr(u, "by_model", {}).items()}}


def usage_from_jsonable(d: Dict[str, Any]):
    """Rebuild a Usage from usage_to_jsonable() output."""
    from .usage import Usage
    u = Usage()
    if d:
        u.input_tokens = int(d.get("input_tokens", 0))
        u.output_tokens = int(d.get("output_tokens", 0))
        u.calls = int(d.get("calls", 0))
        u.by_model = {m: tuple(v) for m, v in (d.get("by_model") or {}).items()}
    return u


def resolve_store(store: Any) -> Optional[CheckpointStore]:
    """Accept a CheckpointStore, a path string (→ FileCheckpointStore), or None."""
    if store is None or isinstance(store, CheckpointStore):
        return store
    if isinstance(store, (str, Path)):
        return FileCheckpointStore(str(store))
    raise TypeError("store must be a CheckpointStore, a directory path, or None")
