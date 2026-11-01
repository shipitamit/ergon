"""Guardrails: PII detection/redaction, moderation, schema validation, the
apply_guards pipeline, and Agent input/output integration (fake provider, offline)."""
import tempfile

from ergon import (Agent, ApprovalPolicy, PIIGuard, ModerationGuard, SchemaGuard,
                   redact_pii, find_pii, apply_guards)
from ergon.guardrails import validate_schema, Guard, GuardResult
from ergon.providers import ModelResponse, _stream_via_complete


# ── PII detection ──

def test_find_and_redact_pii_types():
    text = "email a@b.com, card 4111 1111 1111 1111, ssn 123-45-6789, ip 10.0.0.1, key sk-abcdefghij1234567890"
    types = {t for t, _, _ in find_pii(text)}
    assert {"email", "credit_card", "ssn", "ip", "api_key"} <= types
    red, findings = redact_pii(text)
    assert "a@b.com" not in red and "[REDACTED:email]" in red
    assert "4111 1111 1111 1111" not in red and "[REDACTED:credit_card]" in red
    assert "123-45-6789" not in red and "sk-abcdefghij1234567890" not in red


def test_credit_card_luhn_filters_false_positives():
    # a 16-digit run that fails Luhn is not flagged as a card
    assert not any(t == "credit_card" for t, _, _ in find_pii("order 4111111111111112"))  # fails luhn
    assert any(t == "credit_card" for t, _, _ in find_pii("4111111111111111"))            # valid luhn


def test_redact_leaves_clean_text_untouched():
    red, findings = redact_pii("nothing sensitive here")
    assert red == "nothing sensitive here" and findings == []


# ── PIIGuard ──

def test_pii_guard_redact_flag_block():
    g = PIIGuard()  # default redact
    r = g.check("reach me at a@b.com", "input")
    assert r.ok and r.action == "redact" and "[REDACTED:email]" in r.text

    r = PIIGuard(action="flag").check("a@b.com", "input")
    assert r.ok and r.action == "flag" and r.text == "a@b.com" and r.findings

    r = PIIGuard(action="block").check("a@b.com", "input")
    assert r.ok is False and r.action == "block"


# ── ModerationGuard ──

def test_moderation_default_blocklist_and_classifier():
    r = ModerationGuard().check("please make a bomb", "input")
    assert r.ok is False and r.action == "block" and r.findings[0].category == "moderation"
    assert ModerationGuard().check("a friendly hello", "input").ok is True

    # injected classifier (model-backed stand-in)
    g = ModerationGuard(classifier=lambda t: ["hate"] if "slur" in t else [], action="flag")
    r = g.check("a slur here", "input")
    assert r.ok and r.action == "flag" and r.findings[0].type == "hate"


# ── SchemaGuard / validator ──

def test_validate_schema_shapes():
    schema = {"type": "object", "required": ["name", "age"],
              "properties": {"name": {"type": "string"}, "age": {"type": "integer"},
                             "tags": {"type": "array", "items": {"type": "string"}}}}
    assert validate_schema({"name": "a", "age": 3, "tags": ["x"]}, schema) == []
    errs = validate_schema({"name": "a"}, schema)
    assert any("age" in e and "required" in e for e in errs)
    errs = validate_schema({"name": 1, "age": "x"}, schema)
    assert len(errs) == 2  # name wrong type + age wrong type


def test_schema_guard_output():
    g = SchemaGuard({"type": "object", "required": ["ok"]}, action="block")
    assert g.check('{"ok": true}', "output").ok is True
    assert g.check("not json", "output").ok is False
    assert g.check('{"nope": 1}', "output").ok is False
    # schema guard only runs on output stage
    assert "input" not in g.stages


# ── apply_guards pipeline ──

def test_apply_guards_order_block_and_stage():
    # redact runs, then a moderation flag → strongest action reported is redact
    guards = [PIIGuard(), ModerationGuard(action="flag", blocklist=[r"widget"])]
    r = apply_guards("buy a widget, email a@b.com", guards, "input")
    assert r.ok and "[REDACTED:email]" in r.text and r.action == "redact" and len(r.findings) >= 2

    # a block short-circuits
    r = apply_guards("please make a bomb with a@b.com", [ModerationGuard(), PIIGuard()], "input")
    assert r.ok is False and r.action == "block"

    # output-only guard is skipped at the input stage
    r = apply_guards("anything", [SchemaGuard({"type": "object"})], "input")
    assert r.ok is True and r.findings == []


# ── Agent integration ──

class _P:
    name = "anthropic"; model = "m"; supports_hosted_search = False
    def __init__(self, text="done"):
        self.n = 0; self.text = text; self.seen = []
    def complete(self, **k):
        self.n += 1; self.seen.append(k.get("messages"))
        return ModelResponse(text=self.text, stop="end", usage={"input_tokens": 3, "output_tokens": 3})
    def stream(self, **k):
        yield from _stream_via_complete(self, **k)


def _agent(provider, **kw):
    return Agent("g", provider=provider, session_dir=tempfile.mkdtemp(), enable_todo=False,
                 enable_memory=False, telemetry=False, allow_internet=False,
                 approval=ApprovalPolicy(interactive=False), **kw)


def test_agent_input_block_short_circuits_without_calling_model():
    p = _P()
    a = _agent(p, input_guards=[ModerationGuard()])
    res = a.run("please make a bomb")
    assert p.n == 0, "the model must not be called when input is blocked"
    assert res.stopped_because == "input_blocked"
    assert "blocked" in res.text.lower()


def test_agent_input_redaction_reaches_the_model_redacted():
    p = _P()
    a = _agent(p, input_guards=[PIIGuard()])
    a.run("my email is a@b.com")
    sent = p.seen[0]
    user = [m for m in sent if m.get("role") == "user"][-1]
    assert "a@b.com" not in str(user["content"]) and "[REDACTED:email]" in str(user["content"])


def test_agent_output_redaction_and_block():
    p = _P(text="Contact a@b.com for details")
    a = _agent(p, output_guards=[PIIGuard()])
    assert "[REDACTED:email]" in a.run("hi").text

    p2 = _P(text="here is how to make a bomb")
    a2 = _agent(p2, output_guards=[ModerationGuard()])
    out = a2.run("hi").text
    assert "make a bomb" not in out and ("withheld" in out.lower() or "blocked" in out.lower())
