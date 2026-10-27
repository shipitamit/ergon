"""Serve an Ergon harness as a long-running HTTP endpoint.

    python -m ergon.serve harness.json --port 8900 --auth-key $KEY
    # or, via the console entry:
    ergon serve harness.json --port 8900

A served harness exposes a small, native REST + SSE interface (no
OpenAI-compatible shim):

    GET  /healthz          liveness  — always 200 once the process is up
    GET  /readyz           readiness — 200 when the harness graph is loaded
    POST /run              {"input": "..."} -> {"text","usage",...}
    POST /run/stream       same input, streamed as Server-Sent Events

Design notes:
  * Built on the Python standard library only (http.server) — the SDK stays a
    client everywhere else; this is the single, opt-in server entrypoint.
  * Each request builds a fresh Harness from the cached graph under its own
    session directory, so concurrent runs never share session state.
  * A bounded worker pool caps concurrency; over the cap returns 429.
  * Bearer auth (an Ergon API key or any shared secret) guards the run routes
    when a key is configured; the health probes stay open.
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional

from .harness import load_harness


class ServeConfig:
    def __init__(self, graph: Dict[str, Any], *, auth_key: Optional[str] = None,
                 max_concurrency: int = 8, session_root: str = "./serve-sessions",
                 tools: Optional[Dict[str, Any]] = None, record: bool = False):
        self.graph = graph
        self.auth_key = auth_key
        self.session_root = session_root
        self.tools = tools or {}
        self.record = record   # append a RunRecord per run to {session_root}/runs.jsonl
        # a counting semaphore caps in-flight runs; acquire(blocking=False) → 429
        self._slots = threading.BoundedSemaphore(max(1, int(max_concurrency)))

    def acquire(self) -> bool:
        return self._slots.acquire(blocking=False)

    def release(self) -> None:
        try:
            self._slots.release()
        except ValueError:
            pass

    def new_harness(self):
        # fresh build per request, isolated session dir — no cross-run clobber
        rid = uuid.uuid4().hex[:12]
        return load_harness(self.graph, tools=self.tools,
                            session_root=f"{self.session_root}/{rid}")


def _const_eq(a: str, b: str) -> bool:
    import hmac
    return hmac.compare_digest(str(a or ""), str(b or ""))


class Handler(BaseHTTPRequestHandler):
    server_version = "ergon-serve/0.1"
    config: ServeConfig = None   # set on the server instance

    # keep the default logging quiet; the SDK/telemetry own observability
    def log_message(self, *a):  # noqa: D401
        pass

    # ── helpers ──
    def _json(self, code: int, obj: Any):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self) -> bool:
        key = self.config.auth_key
        if not key:
            return True   # auth disabled
        authz = self.headers.get("authorization", "")
        if not authz.startswith("Bearer "):
            return False
        return _const_eq(authz[7:].strip(), key)

    def _read_input(self) -> Optional[str]:
        try:
            n = int(self.headers.get("content-length", 0) or 0)
        except ValueError:
            n = 0
        raw = self.rfile.read(n) if n > 0 else b""
        if not raw:
            return ""
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None   # signals a 400
        if isinstance(body, str):
            return body
        if isinstance(body, dict):
            return body.get("input", body.get("task", ""))
        return None

    # ── routing ──
    def do_GET(self):
        if self.path == "/healthz":
            return self._json(200, {"status": "ok"})
        if self.path == "/readyz":
            ready = self.config is not None and self.config.graph is not None
            return self._json(200 if ready else 503, {"status": "ready" if ready else "unready"})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path not in ("/run", "/run/stream"):
            return self._json(404, {"error": "not found"})
        if not self._authed():
            return self._json(401, {"error": "missing or invalid bearer token"})
        payload = self._read_input()
        if payload is None:
            return self._json(400, {"error": "body must be JSON: {\"input\": \"...\"}"})
        if not self.config.acquire():
            return self._json(429, {"error": "server at capacity, retry shortly"})
        try:
            if path == "/run":
                self._handle_run(payload)
            else:
                self._handle_stream(payload)
        finally:
            self.config.release()

    def _handle_run(self, payload: str):
        try:
            harness = self.config.new_harness()
            if self.config.record:
                from .runs import run_and_record
                record, _ = run_and_record(harness, payload)
                self._append_record(record)
                self._json(200, {
                    "text": record.output,
                    "iterations": None,
                    "stopped_because": record.status,
                    "usage": record.usage,
                    "latency_ms": record.latency_ms,
                })
                return
            result = harness.run(payload)
        except Exception as e:   # noqa: BLE001 — surface a clean error to the client
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})
        self._json(200, {
            "text": result.text,
            "iterations": result.iterations,
            "stopped_because": result.stopped_because,
            "usage": result.usage.as_dict(),
        })

    def _append_record(self, record):
        import json as _json
        import os as _os
        try:
            _os.makedirs(self.config.session_root, exist_ok=True)
            with open(_os.path.join(self.config.session_root, "runs.jsonl"), "a") as f:
                f.write(_json.dumps(record.as_dict()) + "\n")
        except OSError:
            pass   # recording is best-effort; never fail the run over it

    def _handle_stream(self, payload: str):
        # Server-Sent Events: one `event:`/`data:` frame per progress event.
        # Close the connection at the end so the client sees a clean EOF (the
        # stream has no content-length); keep-alive would hang the reader.
        self.close_connection = True
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()

        def emit(event: str, data: Any):
            frame = f"event: {event}\ndata: {json.dumps(data)}\n\n"
            self.wfile.write(frame.encode("utf-8"))
            self.wfile.flush()

        try:
            harness = self.config.new_harness()
            for ev in harness.run_stream(payload):
                emit(ev.get("event", "message"), {"node": ev.get("node"), "data": ev.get("data")})
        except Exception as e:   # noqa: BLE001
            try:
                emit("error", {"error": f"{type(e).__name__}: {e}"})
            except Exception:
                pass


def make_server(config: ServeConfig, host: str = "127.0.0.1", port: int = 8900) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"config": config})
    httpd = ThreadingHTTPServer((host, port), handler)
    return httpd


def serve(source, *, host: str = "127.0.0.1", port: int = 8900,
          auth_key: Optional[str] = None, max_concurrency: int = 8,
          session_root: str = "./serve-sessions", tools: Optional[Dict[str, Any]] = None) -> int:
    """Load a harness and serve it until interrupted. Returns a process exit code."""
    import signal
    harness = load_harness(source)   # validate the graph up front (clear error if bad)
    config = ServeConfig(harness.graph, auth_key=auth_key, max_concurrency=max_concurrency,
                         session_root=session_root, tools=tools)
    httpd = make_server(config, host, port)

    def _shutdown(*_a):
        threading.Thread(target=httpd.shutdown, daemon=True).start()
    for sig in (getattr(signal, "SIGINT", None), getattr(signal, "SIGTERM", None)):
        if sig is not None:
            try:
                signal.signal(sig, _shutdown)
            except (ValueError, OSError):
                pass   # not on the main thread (e.g. tests) — caller drives shutdown

    guarded = " (auth required)" if auth_key else " (no auth — set --auth-key for production)"
    print(f"ergon serve: listening on http://{host}:{port}{guarded}", flush=True)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
    return 0


def main(argv=None) -> int:
    import argparse
    p = argparse.ArgumentParser(prog="ergon serve", description="Serve an Ergon harness over HTTP (REST + SSE).")
    p.add_argument("harness", help="path to the harness JSON (or a raw graph)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8900)
    p.add_argument("--auth-key", default=os.environ.get("ERGON_SERVE_KEY"),
                   help="require Authorization: Bearer <key> (or set ERGON_SERVE_KEY)")
    p.add_argument("--max-concurrency", type=int, default=8)
    p.add_argument("--session-root", default="./serve-sessions")
    args = p.parse_args(argv)
    return serve(args.harness, host=args.host, port=args.port, auth_key=args.auth_key,
                 max_concurrency=args.max_concurrency, session_root=args.session_root)


if __name__ == "__main__":
    raise SystemExit(main())
