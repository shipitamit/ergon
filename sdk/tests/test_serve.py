"""Serving a harness over HTTP — offline, against the scriptable FakeProvider.

Starts the real stdlib server on an ephemeral port in a background thread,
drives it with urllib, and shuts it down per test. No network, no keys.
"""
import json
import tempfile
import threading
import urllib.request
import urllib.error

import ergon.agent as agent_mod
from ergon.providers import ModelResponse
from ergon.serve import ServeConfig, make_server
from .conftest import FakeProvider


def _fake_make_provider(provider, model, api_key, base_url, client=None):
    return FakeProvider([ModelResponse(text="handled", stop="end",
                                       usage={"input_tokens": 5, "output_tokens": 5})])


def _graph():
    return {
        "version": 2,
        "nodes": [
            {"id": "in", "type": "input", "config": {"message": "hello"}},
            {"id": "a", "type": "agent",
             "config": {"name": "solver", "provider": "anthropic", "mode": "execute",
                        "maxIterations": 4, "allowInternet": False, "todo": False,
                        "memory": False, "approvalMode": "heuristic", "otel": False}},
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"kind": "flow", "from": "in", "to": "a"},
            {"kind": "flow", "from": "a", "to": "out"},
        ],
    }


class _Server:
    def __init__(self, **cfg_kw):
        self.config = ServeConfig(_graph(), session_root=tempfile.mkdtemp(), **cfg_kw)
        self.httpd = make_server(self.config, host="127.0.0.1", port=0)
        self.port = self.httpd.server_address[1]
        self.t = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.t.start()
        return self

    def __exit__(self, *a):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.t.join(timeout=5)

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"


def _req(url, *, method="GET", body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def test_health_and_ready(monkeypatch):
    monkeypatch.setattr(agent_mod, "make_provider", _fake_make_provider)
    with _Server() as s:
        code, body = _req(s.url("/healthz"))
        assert code == 200 and json.loads(body)["status"] == "ok"
        code, body = _req(s.url("/readyz"))
        assert code == 200 and json.loads(body)["status"] == "ready"


def test_run_returns_result_and_usage(monkeypatch):
    monkeypatch.setattr(agent_mod, "make_provider", _fake_make_provider)
    with _Server() as s:
        code, body = _req(s.url("/run"), method="POST", body={"input": "where is my order?"},
                          headers={"content-type": "application/json"})
        assert code == 200, body
        data = json.loads(body)
        assert data["text"] == "handled"
        assert data["usage"]["total_tokens"] > 0
        assert data["stopped_because"] == "end"


def test_bad_body_is_400(monkeypatch):
    monkeypatch.setattr(agent_mod, "make_provider", _fake_make_provider)
    with _Server() as s:
        # raw non-JSON body
        req = urllib.request.Request(s.url("/run"), data=b"not json", method="POST")
        try:
            urllib.request.urlopen(req, timeout=10)
            code = 200
        except urllib.error.HTTPError as e:
            code = e.code
        assert code == 400


def test_unknown_path_is_404(monkeypatch):
    monkeypatch.setattr(agent_mod, "make_provider", _fake_make_provider)
    with _Server() as s:
        assert _req(s.url("/nope"))[0] == 404


def test_auth_required_when_key_set(monkeypatch):
    monkeypatch.setattr(agent_mod, "make_provider", _fake_make_provider)
    with _Server(auth_key="s3cret") as s:
        # no token → 401
        assert _req(s.url("/run"), method="POST", body={"input": "x"},
                    headers={"content-type": "application/json"})[0] == 401
        # wrong token → 401
        assert _req(s.url("/run"), method="POST", body={"input": "x"},
                    headers={"content-type": "application/json", "authorization": "Bearer nope"})[0] == 401
        # right token → 200
        code, _ = _req(s.url("/run"), method="POST", body={"input": "x"},
                       headers={"content-type": "application/json", "authorization": "Bearer s3cret"})
        assert code == 200


def test_stream_emits_sse_frames_with_result(monkeypatch):
    monkeypatch.setattr(agent_mod, "make_provider", _fake_make_provider)
    with _Server() as s:
        req = urllib.request.Request(s.url("/run/stream"), data=json.dumps({"input": "hi"}).encode(),
                                     method="POST", headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            assert r.headers.get("content-type") == "text/event-stream"
            raw = r.read().decode()
        # frames look like "event: <kind>\ndata: <json>\n\n"
        events = [ln[len("event: "):] for ln in raw.splitlines() if ln.startswith("event: ")]
        assert "result" in events
        # the final result frame carries the aggregate text
        result_frame = raw.split("event: result", 1)[1]
        data_line = next(ln for ln in result_frame.splitlines() if ln.startswith("data: "))
        payload = json.loads(data_line[len("data: "):])
        assert payload["data"]["text"] == "handled"


def test_concurrency_cap_semaphore():
    # unit-level: the bounded pool hands out exactly `max_concurrency` slots
    cfg = ServeConfig(_graph(), max_concurrency=2, session_root=tempfile.mkdtemp())
    assert cfg.acquire() is True
    assert cfg.acquire() is True
    assert cfg.acquire() is False      # at capacity
    cfg.release()
    assert cfg.acquire() is True       # a slot freed up
