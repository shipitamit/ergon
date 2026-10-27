"""Tool primitives and built-in tools.

A Tool is a plain dataclass; the @tool decorator builds one from a typed
Python function. `safe=True` marks a tool as eligible for heuristic
auto-approval (see approval.py).
"""
from __future__ import annotations

import inspect
import json
import os
import platform
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

_PY_TO_JSON = {str: "string", int: "integer", float: "number", bool: "boolean"}

# Anthropic-hosted web search — added to every agent by default.
# Removed entirely when the agent's internet kill switch is off.
WEB_SEARCH = {"type": "web_search_20250305", "name": "web_search"}


@dataclass
class Tool:
    name: str
    description: str
    input_schema: Dict[str, Any]
    fn: Callable[..., Any]
    safe: bool = False  # read-only / side-effect free → heuristic auto-approve

    def to_api(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }

    def __call__(self, **kwargs) -> str:
        return str(self.fn(**kwargs))


def tool(description: str, safe: bool = False, name: Optional[str] = None):
    """Decorator: turn a typed function into a Tool.

        @tool("Add two numbers.", safe=True)
        def add(a: int, b: int) -> str: ...
    """

    def wrap(fn: Callable) -> Tool:
        sig = inspect.signature(fn)
        props, required = {}, []
        for pname, param in sig.parameters.items():
            ann = param.annotation if param.annotation is not inspect.Parameter.empty else str
            props[pname] = {"type": _PY_TO_JSON.get(ann, "string")}
            if param.default is inspect.Parameter.empty:
                required.append(pname)
        return Tool(
            name=name or fn.__name__,
            description=description,
            input_schema={"type": "object", "properties": props, "required": required},
            fn=fn,
            safe=safe,
        )

    return wrap


# ─────────────────────────── file tools (scoped) ───────────────────────────

def _scoped(root: Path, rel: str) -> Path:
    p = (root / rel).resolve()
    if root.resolve() not in p.parents and p != root.resolve():
        raise PermissionError(f"path escapes working directory: {rel}")
    return p


def file_tools(working_dir: str) -> List[Tool]:
    """read/write/list tools jailed to `working_dir`."""
    root = Path(working_dir)
    root.mkdir(parents=True, exist_ok=True)

    @tool("Read a text file inside the working directory.", safe=True)
    def read_file(path: str) -> str:
        return _scoped(root, path).read_text(errors="replace")[:50_000]

    @tool("Write text to a file inside the working directory (creates parents).")
    def write_file(path: str, content: str) -> str:
        p = _scoped(root, path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        return f"wrote {len(content)} chars to {p.relative_to(root.resolve())}"

    @tool("List files under a directory inside the working directory.", safe=True)
    def list_files(path: str = ".") -> str:
        p = _scoped(root, path)
        out = []
        for f in sorted(p.rglob("*")):
            if f.is_file():
                out.append(str(f.relative_to(root.resolve())))
            if len(out) >= 500:
                break
        return "\n".join(out) or "(empty)"

    return [read_file, write_file, list_files]


# ─────────────────────────── todo list tools ───────────────────────────

def todo_tools(todo_path: Path) -> List[Tool]:
    """A persistent todo list the agent uses to track multi-step plans.
    Stored as JSON so it survives crashes and is human-inspectable."""
    todo_path.parent.mkdir(parents=True, exist_ok=True)

    def _load() -> List[Dict]:
        if todo_path.exists():
            return json.loads(todo_path.read_text() or "[]")
        return []

    @tool("Read the current todo list (items with status pending/in_progress/done).", safe=True)
    def todo_read() -> str:
        items = _load()
        if not items:
            return "(todo list is empty)"
        return "\n".join(f"[{i['status']:^11}] {n}. {i['text']}" for n, i in enumerate(items, 1))

    @tool(
        "Replace the todo list. Pass items_json: a JSON array of "
        '{"text": str, "status": "pending"|"in_progress"|"done"}.'
    )
    def todo_write(items_json: str) -> str:
        items = json.loads(items_json)
        todo_path.write_text(json.dumps(items, indent=2))
        done = sum(1 for i in items if i.get("status") == "done")
        return f"todo list saved: {len(items)} items, {done} done"

    return [todo_read, todo_write]


# ─────────────────────────── session memory tools ───────────────────────────

def memory_tools(memory_dir: Path) -> List[Tool]:
    """File-based session memory: notes & artifacts persisting across turns/runs."""
    memory_dir.mkdir(parents=True, exist_ok=True)

    @tool("Save a named note to session memory (persists across turns and runs).")
    def memory_save(key: str, content: str) -> str:
        safe_key = "".join(c for c in key if c.isalnum() or c in "-_")[:64]
        (memory_dir / f"{safe_key}.md").write_text(content)
        return f"saved note '{safe_key}'"

    @tool("Read a note from session memory by key, or list all keys with key='*'.", safe=True)
    def memory_read(key: str) -> str:
        if key == "*":
            keys = [f.stem for f in memory_dir.glob("*.md")]
            return "\n".join(keys) or "(no notes)"
        f = memory_dir / f"{key}.md"
        return f.read_text() if f.exists() else f"(no note named '{key}')"

    return [memory_save, memory_read]


# ─────────────────────────── shell tools (optional) ───────────────────────────

def shell_tools(working_dir: str, timeout: int = 60) -> List[Tool]:
    """Shell command execution plus OS/shell/working-directory probing."""
    root = str(Path(working_dir).resolve())

    @tool("Probe the execution environment: OS, shell, python, cwd.", safe=True)
    def probe_environment() -> str:
        return json.dumps(
            {
                "os": platform.platform(),
                "shell": os.environ.get("SHELL") or os.environ.get("COMSPEC", "unknown"),
                "python": platform.python_version(),
                "cwd": root,
                "path_has": {t: bool(shutil.which(t)) for t in ("git", "node", "python3")},
            },
            indent=2,
        )

    @tool("Run a shell command in the working directory. Returns stdout+stderr.")
    def run_shell(command: str) -> str:
        try:
            r = subprocess.run(
                command, shell=True, cwd=root, capture_output=True, text=True, timeout=timeout
            )
            out = (r.stdout + ("\n" + r.stderr if r.stderr else "")).strip()
            return f"[exit {r.returncode}]\n{out[:20_000]}"
        except subprocess.TimeoutExpired:
            return f"[timeout after {timeout}s]"

    return [probe_environment, run_shell]


# ─────────────── search fallback for providers without hosted search ───────────────

def web_search_tool(search_fn: Callable[[str], Any], name: str = "web_search") -> Tool:
    """Wrap any search backend (Tavily, Brave, SerpAPI, your own) into the
    agent's web_search tool. Used with providers that lack hosted search:

        Agent("x", provider="openai", search_tool=web_search_tool(my_search))
    """

    @tool("Search the web. Input a search query; returns result snippets.", safe=True, name=name)
    def _search(query: str) -> str:
        return str(search_fn(query))[:20_000]

    return _search
