"""Flows (chain/route/parallel), compaction, redaction, and the browser guard."""
import tempfile

from ergon import chain, estimate_tokens, SessionStore, BrowserSession, browser_tools


# ── flows ──

def test_chain_passes_through_and_merges_usage(make_agent, resp):
    a1 = make_agent([resp(text="step1", in_tok=10, out_tok=10)])
    a2 = make_agent([resp(text="step2", in_tok=20, out_tok=20)])
    result = chain("go", a1, a2)
    assert result.text == "step2"
    assert result.usage.total_tokens == 60


# ── compaction helpers ──

def test_estimate_tokens_monotonic():
    short = [{"role": "user", "content": "hi"}]
    long = [{"role": "user", "content": "word " * 500}]
    assert estimate_tokens(long) > estimate_tokens(short)
    assert estimate_tokens([]) == 0 or estimate_tokens([]) >= 0


# ── persistence: secret redaction ──

def test_history_redacts_secrets():
    store = SessionStore(tempfile.mkdtemp())
    store.save_history([{"role": "user", "content": "key sk-ant-api03-SECRET1234567890 here"}])
    on_disk = open(store.history_path).read()
    assert "sk-ant-api03-SECRET1234567890" not in on_disk
    assert "[REDACTED]" in on_disk


def test_events_redact_secrets():
    store = SessionStore(tempfile.mkdtemp())
    store.log_event("tool_call", tool="x", auth="Bearer supersecrettoken123456")
    on_disk = open(store.events_path).read()
    assert "supersecrettoken123456" not in on_disk


def test_redacted_history_still_loads():
    store = SessionStore(tempfile.mkdtemp())
    store.save_history([{"role": "user", "content": "sk-ant-api03-XYZ1234567890 rest"}])
    loaded = store.load_history()
    assert loaded and "[REDACTED]" in loaded[0]["content"]


# ── browser navigation guard (SSRF) ──

def test_browser_blocks_internal_hosts():
    from ergon.browser import _blocked_reason
    assert _blocked_reason("https://example.com") is None
    assert _blocked_reason("http://localhost") is not None
    assert _blocked_reason("http://169.254.169.254/latest") is not None   # cloud metadata
    assert _blocked_reason("http://10.0.0.1") is not None
    assert _blocked_reason("http://192.168.1.1") is not None
    assert _blocked_reason("http://172.16.0.1") is not None
    assert _blocked_reason("http://172.32.0.1") is None                    # outside private range
    assert _blocked_reason("file:///etc/passwd") is not None


def test_browser_tools_safety_flags():
    tools = {t.name: t for t in browser_tools(BrowserSession())}
    assert tools["browser_navigate"].safe is True
    assert tools["browser_read"].safe is True
    assert tools["browser_find"].safe is True
    # act tools must be approval-gated
    assert tools["browser_click"].safe is False
    assert tools["browser_type"].safe is False
    assert tools["browser_submit"].safe is False


def test_browser_allow_hosts_restriction():
    sess = BrowserSession(allow_hosts=["example.com"])
    assert sess._check_nav("https://example.com/x") is None
    assert sess._check_nav("https://evil.com") is not None


# ── field-aware redaction (catches any-format secret in a sensitive field) ──

def test_redacts_any_format_in_sensitive_field():
    from ergon.persistence import _redact
    r = _redact({"api_key": "custom-format-no-pattern-XYZ", "authorization": "OpaqueTok!!"})
    assert r["api_key"] == "[REDACTED]"
    assert r["authorization"] == "[REDACTED]"


def test_redacts_field_name_variants():
    from ergon.persistence import _redact
    for k in ["API Key", "api-key", "x-api-key", "OPENAI_API_KEY", "access_token",
              "client_secret", "password", "session_secret", "private_key"]:
        assert _redact({k: "v"})[k] == "[REDACTED]", k


def test_does_not_over_redact_token_counts():
    from ergon.persistence import _redact
    r = _redact({"input_tokens": 100, "total_tokens": 150, "token_count": 7, "cost": 0.01})
    assert r["input_tokens"] == 100 and r["total_tokens"] == 150 and r["token_count"] == 7


def test_redacts_nested_sensitive_fields():
    from ergon.persistence import _redact
    r = _redact({"headers": {"Authorization": "Bearer secretvalue"}})
    assert r["headers"]["Authorization"] == "[REDACTED]"


def test_empty_sensitive_fields_not_flagged():
    from ergon.persistence import _redact
    r = _redact({"api_key": "", "token": None})
    assert r["api_key"] == "" and r["token"] is None
