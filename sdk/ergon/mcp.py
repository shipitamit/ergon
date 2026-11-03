"""MCP (Model Context Protocol) client — let an Ergon agent use any MCP server's tools.

Instead of hand-writing an integration per service, point the agent at an MCP
server and inherit its whole tool set. One integration, not four hundred.

    from ergon import Agent, MCPClient, mcp_tools

    with MCPClient.stdio("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/data"]) as mcp:
        agent = Agent("fs", tools=mcp_tools(mcp),
                      system="Use the filesystem tools to answer.")
        print(agent.run("List the files in /data and summarize README.md").text)

Transports:
  * MCPClient.stdio(command, args)   — launch a local server process (most servers)
  * MCPClient.http(url)              — connect to a remote streamable-HTTP server

Safety. A remote MCP server's tools can do anything — write files, hit APIs,
spend money — and the server is third-party code describing its own tools. So
every MCP tool is treated as **unsafe** by default: an unattended ApprovalPolicy
denies it unless you allow it (via `safe_tools=` here, a standing allow-rule, or
interactive approval). A server may annotate a tool read-only
(`annotations.readOnlyHint`); set `trust_readonly_hint=True` to treat those as
safe, but that trusts the server's self-description, so it's opt-in.

The `mcp` package is an optional dependency:

    pip install ergon[mcp]
"""
from __future__ import annotations

import asyncio
import threading
from typing import Any, Dict, List, Optional

from .tools import Tool


class MCPError(RuntimeError):
    """An MCP transport or protocol failure."""


class MCPOAuth:
    """OAuth 2.1 configuration for an HTTP MCP server.

    Many hosted/commercial MCP servers require OAuth rather than a static token.
    Pass an instance to `MCPClient.http(url, auth=...)` and the client runs the
    authorization-code flow (with PKCE) on connect, via the `mcp` SDK's
    OAuthClientProvider.

        from ergon import MCPClient, MCPOAuth, mcp_tools

        oauth = MCPOAuth(
            client_name="ergon-agent",
            redirect_uri="http://localhost:8765/callback",
            scopes=["mcp:tools"],
            # how the user approves + where tokens live (defaults: open a browser,
            # cache tokens in-memory for the session)
        )
        with MCPClient.http("https://mcp.vendor.com/sse", auth=oauth) as mcp:
            ...

    `redirect_handler` is called with the authorization URL (default: open the
    system browser). `callback_handler` returns the (code, state) the server
    redirected back with (default: run a tiny localhost server to catch it).
    `token_store` is a dict-like with get()/set() for persisting tokens across
    runs (default: in-memory, so each process re-authorizes). All are injectable
    so the flow is testable and so you can store tokens in your own vault.

    NOTE: the OAuth flow's *logic and wiring* are unit-tested offline against a
    fake provider, but have NOT been exercised against a live OAuth MCP server
    in this build — validate with a real server before relying on it.
    """

    def __init__(self, *, client_name: str = "ergon",
                 redirect_uri: str = "http://localhost:8765/callback",
                 scopes: Optional[List[str]] = None,
                 token_store: Optional[Any] = None,
                 redirect_handler: Optional[Any] = None,
                 callback_handler: Optional[Any] = None):
        self.client_name = client_name
        self.redirect_uri = redirect_uri
        self.scopes = scopes or []
        self.token_store = token_store if token_store is not None else _InMemoryTokenStore()
        self.redirect_handler = redirect_handler
        self.callback_handler = callback_handler

    def _build_provider(self, server_url: str):
        """Construct the mcp SDK's OAuthClientProvider from this config.

        Imported lazily so the base package never requires the auth extras, and
        so the rest of the client works without OAuth installed.
        """
        try:
            from mcp.client.auth import OAuthClientProvider
            from mcp.shared.auth import OAuthClientMetadata
        except ImportError as e:
            raise MCPError(
                "OAuth for MCP needs the auth parts of the `mcp` package. "
                "Install with: pip install ergon[mcp]"
            ) from e

        metadata = OAuthClientMetadata(
            client_name=self.client_name,
            redirect_uris=[self.redirect_uri],
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
            scope=" ".join(self.scopes) if self.scopes else None,
        )
        return OAuthClientProvider(
            server_url=server_url,
            client_metadata=metadata,
            storage=self.token_store,
            redirect_handler=self.redirect_handler or _default_redirect,
            callback_handler=self.callback_handler or _default_callback,
        )


class _InMemoryTokenStore:
    """Minimal per-process token storage for OAuth (tokens() / set_tokens()).

    Matches the mcp SDK's TokenStorage shape. Swap for a durable store to keep
    tokens across runs. In-memory means each process re-authorizes.
    """
    def __init__(self):
        self._tokens = None
        self._client_info = None

    async def get_tokens(self):
        return self._tokens

    async def set_tokens(self, tokens):
        self._tokens = tokens

    async def get_client_info(self):
        return self._client_info

    async def set_client_info(self, info):
        self._client_info = info


async def _default_redirect(authorization_url: str) -> None:
    """Default: open the authorization URL in the system browser."""
    import webbrowser
    webbrowser.open(authorization_url)


async def _default_callback():
    """Default: catch the OAuth redirect on localhost and return (code, state).

    Runs a one-shot HTTP server on the redirect_uri's port, waits for the
    provider to redirect the browser back with ?code=&state=, and returns them.
    """
    import urllib.parse
    from http.server import BaseHTTPRequestHandler, HTTPServer

    captured = {}

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            q = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(q)
            captured["code"] = (params.get("code") or [None])[0]
            captured["state"] = (params.get("state") or [None])[0]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"Authorization complete. You can close this tab.")

        def log_message(self, *a):  # silence
            pass

    server = HTTPServer(("localhost", 8765), _Handler)
    server.handle_request()   # serve exactly one request, then stop
    server.server_close()
    return captured.get("code"), captured.get("state")


class MCPClient:
    """A connection to one MCP server, driving its async SDK from sync code.

    The MCP Python SDK is async-only; the Ergon agent loop calls tools
    synchronously. So this client owns a background event loop on its own thread
    and marshals each call onto it. Use as a context manager so the server
    process / connection is always cleaned up.

    Construct via the transport classmethods, not directly:
        MCPClient.stdio(command, args=[...], env={...})
        MCPClient.http(url, headers={...})
    """

    def __init__(self, _transport: str, **config):
        self._transport = _transport
        self._config = config
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._session = None
        self._exit_stack = None
        self._tools_cache: Optional[List[Dict[str, Any]]] = None
        self._resources_cache: Optional[List[Dict[str, Any]]] = None
        self._prompts_cache: Optional[List[Dict[str, Any]]] = None

    # ── transports ──
    @classmethod
    def stdio(cls, command: str, args: Optional[List[str]] = None,
              env: Optional[Dict[str, str]] = None, elicitation=None) -> "MCPClient":
        """Launch a local MCP server as a subprocess and talk to it over stdio.

        `elicitation` is an optional handler for servers that ask the user for
        input mid-operation (see MCPElicitation / the module docs). Omitted →
        such requests are auto-declined, the safe default for unattended runs.
        """
        return cls("stdio", command=command, args=args or [], env=env, elicitation=elicitation)

    @classmethod
    def http(cls, url: str, headers: Optional[Dict[str, str]] = None,
             auth: Optional["MCPOAuth"] = None, elicitation=None) -> "MCPClient":
        """Connect to a remote MCP server over streamable HTTP.

        `headers` carries static auth you already hold (a bearer token or API
        key). `auth` is for servers that require the interactive OAuth 2.1 flow
        the MCP spec recommends — pass an `MCPOAuth(...)` and the client runs the
        authorization-code flow on connect, caching tokens via its callbacks.
        `elicitation` handles server requests for user input (default: decline).
        """
        return cls("http", url=url, headers=headers or {}, auth=auth, elicitation=elicitation)

    # ── lifecycle: a background loop on its own thread ──
    def _start_loop(self):
        if self._loop is not None:
            return
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
        self._thread.start()

    def _run(self, coro, timeout: float = 60.0):
        """Run a coroutine on the background loop and block for the result."""
        if self._loop is None:
            raise MCPError("client is not connected (use it as a context manager)")
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return fut.result(timeout=timeout)
        except Exception as e:  # noqa: BLE001 — normalize to MCPError
            raise MCPError(f"{type(e).__name__}: {e}") from e

    async def _connect(self):
        try:
            from mcp import ClientSession
            from contextlib import AsyncExitStack
        except ImportError as e:
            raise MCPError(
                "MCP tools need the `mcp` package. Install with: pip install ergon[mcp]"
            ) from e
        self._exit_stack = AsyncExitStack()
        if self._transport == "stdio":
            from mcp import StdioServerParameters
            from mcp.client.stdio import stdio_client
            params = StdioServerParameters(
                command=self._config["command"],
                args=self._config["args"],
                env=self._config["env"],
            )
            read, write = await self._exit_stack.enter_async_context(stdio_client(params))
        else:
            from mcp.client.streamable_http import streamablehttp_client
            kwargs = {"headers": self._config["headers"]}
            oauth = self._config.get("auth")
            if oauth is not None:
                kwargs["auth"] = oauth._build_provider(self._config["url"])
            res = await self._exit_stack.enter_async_context(
                streamablehttp_client(self._config["url"], **kwargs))
            read, write = res[0], res[1]
        session_kwargs = {}
        handler = self._config.get("elicitation")
        if handler is not None:
            # wrap the user's simple handler in the SDK's expected callback shape
            session_kwargs["elicitation_callback"] = _make_elicitation_callback(handler)
        self._session = await self._exit_stack.enter_async_context(
            ClientSession(read, write, **session_kwargs))
        await self._session.initialize()

    async def _disconnect(self):
        if self._exit_stack is not None:
            await self._exit_stack.aclose()
            self._exit_stack = None
            self._session = None

    def connect(self) -> "MCPClient":
        self._start_loop()
        self._run(self._connect())
        return self

    def close(self):
        if self._loop is not None:
            try:
                self._run(self._disconnect(), timeout=10.0)
            except Exception:
                pass
            self._loop.call_soon_threadsafe(self._loop.stop)
            if self._thread:
                self._thread.join(timeout=5.0)
            self._loop = None
            self._thread = None

    def __enter__(self):
        return self.connect()

    def __exit__(self, *exc):
        self.close()

    # ── protocol operations ──
    def list_tools(self) -> List[Dict[str, Any]]:
        """Return the server's tools as dicts: {name, description, input_schema, annotations}."""
        if self._tools_cache is not None:
            return self._tools_cache
        result = self._run(self._session.list_tools())
        out = []
        for t in result.tools:
            out.append({
                "name": t.name,
                "description": t.description or "",
                "input_schema": t.inputSchema or {"type": "object", "properties": {}},
                "annotations": _annotations_dict(getattr(t, "annotations", None)),
            })
        self._tools_cache = out
        return out

    def call_tool(self, name: str, arguments: Dict[str, Any],
                  *, poll_interval: float = 1.0, max_wait: float = 300.0) -> str:
        """Invoke a server tool and return its text content.

        Supports the MCP Tasks extension transparently: if a server returns a
        durable task handle instead of an immediate result (for a long-running
        call), this polls the task to completion and returns the final content.
        Ordinary immediate results are returned as-is. `max_wait` caps the total
        poll time; `poll_interval` is the gap between status checks.
        """
        result = self._run(self._session.call_tool(name, arguments or {}))
        task = _task_handle(result)
        if task is None:
            return _flatten_content(result)
        return self._await_task(task, poll_interval=poll_interval, max_wait=max_wait)

    def _await_task(self, task_id: str, *, poll_interval: float, max_wait: float) -> str:
        """Poll a Tasks-extension handle until it completes (or times out)."""
        import time as _time
        deadline = _time.monotonic() + max_wait
        getter = getattr(self._session, "get_task_result", None) or getattr(self._session, "get_task", None)
        if getter is None:
            return f"[task {task_id} started, but this client can't poll it — the mcp SDK lacks task support]"
        while True:
            status = self._run(getter(task_id))
            state = getattr(status, "status", None) or getattr(status, "state", None)
            if state in ("completed", "complete", "succeeded", None):
                return _flatten_content(status)
            if state in ("failed", "error", "cancelled", "canceled"):
                return f"[task {task_id} {state}] {_flatten_content(status)}"
            if _time.monotonic() > deadline:
                return f"[task {task_id} still running after {max_wait:.0f}s — gave up waiting]"
            _time.sleep(poll_interval)

    def list_resources(self) -> List[Dict[str, Any]]:
        """Return the server's resources as dicts: {uri, name, description, mime_type}.

        Resources are readable data the server exposes (files, records, docs),
        addressed by URI — the data half of MCP, alongside tools.
        """
        if self._resources_cache is not None:
            return self._resources_cache
        result = self._run(self._session.list_resources())
        out = []
        for r in getattr(result, "resources", []) or []:
            out.append({
                "uri": str(getattr(r, "uri", "")),
                "name": getattr(r, "name", "") or "",
                "description": getattr(r, "description", "") or "",
                "mime_type": getattr(r, "mimeType", None),
            })
        self._resources_cache = out
        return out

    def read_resource(self, uri: str) -> str:
        """Read a resource by URI and return its text content."""
        result = self._run(self._session.read_resource(uri))
        return _flatten_resource(result)

    def list_prompts(self) -> List[Dict[str, Any]]:
        """Return the server's prompt templates as dicts: {name, description, arguments}.

        Prompts are reusable, parameterized interaction templates the server
        author wrote (system prompts, few-shot examples) — the third MCP server
        primitive alongside tools and resources.
        """
        if self._prompts_cache is not None:
            return self._prompts_cache
        result = self._run(self._session.list_prompts())
        out = []
        for p in getattr(result, "prompts", []) or []:
            args = []
            for a in getattr(p, "arguments", []) or []:
                args.append({
                    "name": getattr(a, "name", ""),
                    "description": getattr(a, "description", "") or "",
                    "required": bool(getattr(a, "required", False)),
                })
            out.append({
                "name": getattr(p, "name", ""),
                "description": getattr(p, "description", "") or "",
                "arguments": args,
            })
        self._prompts_cache = out
        return out

    def get_prompt(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> str:
        """Render a server prompt template with arguments, returning its text."""
        result = self._run(self._session.get_prompt(name, arguments or {}))
        return _flatten_prompt(result)

    # ── listChanged: pick up a server that added/removed tools mid-session ──
    def refresh(self) -> None:
        """Drop the cached tool/resource/prompt lists so the next list_* call
        re-fetches from the server.

        MCP servers can change their advertised lists at runtime and signal it
        with a listChanged notification. An autonomous agent has no persistent
        notification stream, so rather than subscribe, it calls refresh() when it
        wants the current list — e.g. a long-running agent re-reading tools
        between tasks, or after an action it knows changes the server's offerings.
        To rebuild an agent's tool set afterward, call mcp_tools(client) again.
        """
        self._tools_cache = None
        self._resources_cache = None
        self._prompts_cache = None

    def supports_list_changed(self, primitive: str = "tools") -> bool:
        """Whether the server advertised listChanged for a primitive
        ('tools' / 'resources' / 'prompts'). Reads the capabilities captured at
        connect; returns False if unknown."""
        caps = getattr(self._session, "server_capabilities", None) if self._session else None
        node = getattr(caps, primitive, None) if caps else None
        return bool(getattr(node, "listChanged", False)) if node else False


def _annotations_dict(ann) -> Dict[str, Any]:
    if ann is None:
        return {}
    if isinstance(ann, dict):
        return ann
    # pydantic model → dict of set fields
    out = {}
    for key in ("readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint", "title"):
        val = getattr(ann, key, None)
        if val is not None:
            out[key] = val
    return out


def _task_handle(result) -> Optional[str]:
    """Return a Tasks-extension task id if the tool result is a deferred task,
    else None. The extension marks a result as a task and carries an id/handle;
    we check the common shapes without hard-coding one SDK's field name."""
    # explicit task object
    task = getattr(result, "task", None)
    if task is not None:
        tid = getattr(task, "id", None) or getattr(task, "taskId", None)
        if tid:
            return str(tid)
    # result typed as a task
    rtype = getattr(result, "resultType", None) or getattr(result, "type", None)
    if rtype in ("task", "deferred"):
        tid = getattr(result, "taskId", None) or getattr(result, "id", None)
        if tid:
            return str(tid)
    return None


def _flatten_content(result) -> str:
    """Turn an MCP CallToolResult into a plain string for the model."""
    content = getattr(result, "content", None)
    if content is None:
        return str(result)
    parts = []
    for block in content:
        text = getattr(block, "text", None)
        if text is not None:
            parts.append(text)
        else:
            parts.append(str(getattr(block, "data", block)))
    joined = "\n".join(parts) if parts else ""
    if getattr(result, "isError", False):
        return f"[tool error] {joined}"
    return joined


def _flatten_resource(result) -> str:
    """Turn an MCP ReadResourceResult into a plain string.

    A resource read returns `contents`, each with `text` (text resources) or
    `blob` (binary); we surface text directly and note binary blobs rather than
    dumping raw bytes into the model's context.
    """
    contents = getattr(result, "contents", None)
    if contents is None:
        return str(result)
    parts = []
    for c in contents:
        text = getattr(c, "text", None)
        if text is not None:
            parts.append(text)
            continue
        blob = getattr(c, "blob", None)
        if blob is not None:
            mime = getattr(c, "mimeType", None) or "application/octet-stream"
            parts.append(f"[binary resource: {mime}, {len(blob)} bytes — not shown]")
        else:
            parts.append(str(c))
    return "\n".join(parts) if parts else ""


def _flatten_prompt(result) -> str:
    """Turn an MCP GetPromptResult into plain text.

    A prompt renders to `messages`, each with `role` and `content` (text or
    other blocks); we join them as "role: text" lines so the rendered template
    is usable as a string.
    """
    messages = getattr(result, "messages", None)
    if messages is None:
        return str(result)
    parts = []
    for m in messages:
        role = getattr(m, "role", "") or ""
        content = getattr(m, "content", None)
        text = getattr(content, "text", None)
        if text is None and content is not None:
            text = str(getattr(content, "data", content))
        parts.append(f"{role}: {text}" if role else str(text))
    return "\n".join(parts) if parts else ""


def _make_elicitation_callback(handler):
    """Adapt a simple user handler to the mcp SDK's elicitation callback.

    The user handler receives (message: str, schema: dict) and returns either
    None/False to decline, or a dict of the requested fields to accept. We map
    that onto the SDK's ElicitResult (action accept/decline + content).
    """
    async def _callback(context, params):
        message = getattr(params, "message", "") or ""
        schema = getattr(params, "requestedSchema", None) or getattr(params, "requested_schema", None) or {}
        try:
            result = handler(message, schema)
            if asyncio.iscoroutine(result):
                result = await result
        except Exception:
            result = None
        # Normalize the handler result into (action, optional content).
        if result in (None, False):
            action, content = "decline", None
        elif result is True:
            action, content = "accept", {}
        else:
            action, content = "accept", dict(result)
        try:
            from mcp.types import ElicitResult
        except ImportError:
            # mcp SDK not installed (zero-dep path): mirror ElicitResult as a plain dict.
            return {"action": action} if content is None else {"action": action, "content": content}
        return ElicitResult(action=action) if content is None else ElicitResult(action=action, content=content)
    return _callback


def mcp_tools(client: MCPClient, *, safe_tools: Optional[List[str]] = None,
              trust_readonly_hint: bool = False,
              prefix: str = "") -> List[Tool]:
    """Build Ergon Tools from an MCP server's advertised tools.

    Each server tool becomes a Tool carrying the server's name, description, and
    JSON input schema, with an fn that calls the server.

    Safety: MCP tools are unsafe (approval-gated) by default — a third-party
    server's tools can do anything. Opt specific tools into safe/auto-approve:
      * safe_tools=[...]          — explicit allowlist of tool names
      * trust_readonly_hint=True  — trust the server's readOnlyHint annotation

    `prefix` namespaces the tool names (e.g. "fs_") when composing several
    servers whose tool names might collide.
    """
    allow = set(safe_tools or [])
    tools: List[Tool] = []
    for spec in client.list_tools():
        name = spec["name"]
        is_safe = name in allow
        if trust_readonly_hint and spec["annotations"].get("readOnlyHint") is True:
            is_safe = True

        # bind name via default arg so the closure captures the right value
        def _make_fn(tool_name: str):
            def _fn(**kwargs: Any) -> str:
                return client.call_tool(tool_name, kwargs)
            return _fn

        tools.append(Tool(
            name=prefix + name,
            description=spec["description"],
            input_schema=spec["input_schema"],
            fn=_make_fn(name),
            safe=is_safe,
        ))
    return tools


def mcp_resource_tools(client: MCPClient, *, prefix: str = "") -> List[Tool]:
    """Expose an MCP server's resources to the agent as two read-only tools.

    Resources are data, not actions, so these are always safe (no approval):
      * mcp_list_resources()      → the available resources (uri, name, desc)
      * mcp_read_resource(uri)    → the content of one resource

    This lets an agent discover and pull a server's data (files, records, docs)
    the same way it uses the server's tools. `prefix` namespaces the tool names
    when composing multiple servers.
    """
    def _list(**_: Any) -> str:
        res = client.list_resources()
        if not res:
            return "No resources available on this server."
        lines = []
        for r in res:
            mime = f" ({r['mime_type']})" if r.get("mime_type") else ""
            desc = f" — {r['description']}" if r.get("description") else ""
            lines.append(f"- {r['uri']}{mime}: {r['name']}{desc}")
        return "\n".join(lines)

    def _read(uri: str) -> str:
        return client.read_resource(uri)

    return [
        Tool(
            name=prefix + "mcp_list_resources",
            description="List the data resources this MCP server exposes (returns their URIs).",
            input_schema={"type": "object", "properties": {}},
            fn=_list,
            safe=True,
        ),
        Tool(
            name=prefix + "mcp_read_resource",
            description="Read the content of an MCP resource by its URI.",
            input_schema={"type": "object", "properties": {"uri": {"type": "string"}}, "required": ["uri"]},
            fn=_read,
            safe=True,
        ),
    ]


def mcp_prompt_tools(client: MCPClient, *, prefix: str = "") -> List[Tool]:
    """Expose an MCP server's prompt templates to the agent as two read-only tools.

    Prompts are templates, not actions, so these are always safe (no approval):
      * mcp_list_prompts()              → available prompts (name, args)
      * mcp_get_prompt(name, arguments) → the rendered prompt text

    Useful when a server ships curated prompts (system prompts, few-shot
    examples) the agent can pull. `prefix` namespaces the tool names.
    """
    def _list(**_: Any) -> str:
        ps = client.list_prompts()
        if not ps:
            return "No prompts available on this server."
        lines = []
        for p in ps:
            args = ", ".join(
                f"{a['name']}{'*' if a.get('required') else ''}" for a in p.get("arguments", [])
            )
            sig = f"({args})" if args else "()"
            desc = f" — {p['description']}" if p.get("description") else ""
            lines.append(f"- {p['name']}{sig}{desc}")
        return "\n".join(lines)

    def _get(name: str, arguments: Optional[Dict[str, Any]] = None) -> str:
        return client.get_prompt(name, arguments or {})

    return [
        Tool(
            name=prefix + "mcp_list_prompts",
            description="List the prompt templates this MCP server offers (name and arguments; * = required).",
            input_schema={"type": "object", "properties": {}},
            fn=_list,
            safe=True,
        ),
        Tool(
            name=prefix + "mcp_get_prompt",
            description="Render an MCP prompt template by name, passing any arguments as an object.",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "arguments": {"type": "object"},
                },
                "required": ["name"],
            },
            fn=_get,
            safe=True,
        ),
    ]
