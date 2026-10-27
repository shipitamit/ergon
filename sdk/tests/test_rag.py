"""RAG / retrieval: chunking, embeddings, vector stores, the retrieve tool.

Runs against a deterministic fake embedder and (for pgvector) a fake psycopg
connection, so chunking, cosine ranking, top-k, the tool, and the pgvector SQL
are verified offline. Real embedding quality and a live pgvector database are
not exercised here (see the module docstring).
"""
import json
import tempfile

from ergon import (KnowledgeBase, retrieve_tool, FakeEmbedder, InMemoryStore,
                   PgVectorStore, Chunk, chunk_text, Agent, ApprovalPolicy)
from ergon.rag import _cosine, _to_pgvector
from ergon.providers import ModelResponse, ToolCall, _stream_via_complete


# ── chunking ──

def test_short_text_kept_whole():
    assert chunk_text("short") == ["short"]
    assert chunk_text("") == []


def test_long_text_split_with_overlap():
    chunks = chunk_text("word " * 500, chunk_size=200, overlap=40)
    assert len(chunks) > 1
    assert all(len(c) <= 200 for c in chunks)


# ── vector math ──

def test_cosine():
    assert abs(_cosine([1, 0], [1, 0]) - 1.0) < 1e-9
    assert abs(_cosine([1, 0], [0, 1])) < 1e-9
    assert _cosine([0, 0], [1, 1]) == 0.0


def test_to_pgvector_format():
    assert _to_pgvector([0.1, 0.2, 0.3]) == "[0.1,0.2,0.3]"


# ── end-to-end retrieval (in-memory) ──

def test_retrieval_ranks_relevant_first():
    # The FakeEmbedder is bag-of-words (tests plumbing/ranking, not semantics),
    # so the query shares literal tokens with the target chunk.
    kb = KnowledgeBase()
    assert kb.add_texts([
        "The capital of France is Paris.",
        "pgvector stores embeddings in Postgres for similarity search.",
        "Ergon is a provider-neutral agent harness.",
    ]) == 3
    hits = kb.search("pgvector embeddings Postgres", k=2)
    assert hits and "pgvector" in hits[0][0].text


def test_metadata_and_k_limit():
    kb = KnowledgeBase()
    kb.add_texts(["Paris is in France."], metadata={"source": "geo"})
    kb.add_texts(["Postgres has pgvector."], metadata={"source": "db"})
    top = kb.search("pgvector", k=1)
    assert len(top) == 1 and top[0][0].metadata.get("source") == "db"


# ── retrieve tool ──

def test_retrieve_tool_is_safe_and_formats():
    kb = KnowledgeBase()
    kb.add_texts(["Ergon supports MCP and RAG."], metadata={"source": "readme"})
    t = retrieve_tool(kb, k=3)
    assert t.safe is True and t.name == "retrieve"
    out = t.fn(query="what does ergon support")
    assert "Ergon supports MCP and RAG" in out and "[readme]" in out and "score" in out


def test_retrieve_tool_empty_kb():
    assert "No relevant passages" in retrieve_tool(KnowledgeBase()).fn(query="x")


def test_agent_uses_retrieve_unattended():
    kb = KnowledgeBase()
    kb.add_texts(["pgvector stores embeddings."])

    class P:
        name = "anthropic"; model = "m"; supports_hosted_search = False
        def __init__(s): s.n = 0
        def complete(s, **k):
            s.n += 1
            if s.n == 1:
                return ModelResponse(text="", tool_calls=[ToolCall("1", "retrieve", {"query": "embeddings"})],
                                     stop="tool_use", usage={"input_tokens": 5, "output_tokens": 5})
            return ModelResponse(text="answer", stop="end", usage={"input_tokens": 3, "output_tokens": 3})
        def stream(s, **k): yield from _stream_via_complete(s, **k)

    a = Agent("r", provider=P(), tools=[retrieve_tool(kb)], session_dir=tempfile.mkdtemp(),
              enable_todo=False, enable_memory=False, telemetry=False, allow_internet=False,
              approval=ApprovalPolicy(interactive=False))
    a.run("use retrieval")
    ev = [e for e in a.session.events() if e.get("tool") == "retrieve"]
    assert ev and ev[0]["denied"] is False and "pgvector" in ev[0]["output"]


# ── pgvector store (fake connection) ──

def _fake_conn():
    class FakeCursor:
        def __init__(s, store): s.store = store; s.rows = []
        def __enter__(s): return s
        def __exit__(s, *a): pass
        def execute(s, sql, params=None):
            s.store["sql"].append((" ".join(sql.split()), params))
            if "ORDER BY embedding" in sql:
                s.rows = [("pgvector doc", json.dumps({"source": "db"}), 0.95)]
        def fetchall(s): return s.rows
    class FakeConn:
        def __init__(s): s.store = {"sql": []}; s.commits = 0
        def cursor(s): return FakeCursor(s.store)
        def commit(s): s.commits += 1
    return FakeConn()


def test_pgvector_add_creates_schema_and_inserts():
    conn = _fake_conn()
    store = PgVectorStore(dim=4, conn=conn)
    store.add([Chunk(text="pgvector doc", metadata={"source": "db"}, embedding=[0.1, 0.2, 0.3, 0.4])])
    sqls = [s for s, _ in conn.store["sql"]]
    assert any("CREATE EXTENSION IF NOT EXISTS vector" in s for s in sqls)
    assert any("CREATE TABLE IF NOT EXISTS ergon_chunks" in s and "vector(4)" in s for s in sqls)
    ins = [(s, p) for s, p in conn.store["sql"] if s.startswith("INSERT INTO ergon_chunks")]
    assert ins and ins[0][1][0] == "pgvector doc" and "%s" in ins[0][0]
    assert conn.commits >= 1


def test_pgvector_search_uses_cosine_operator():
    conn = _fake_conn()
    store = PgVectorStore(dim=4, conn=conn)
    hits = store.search([0.1, 0.2, 0.3, 0.4], k=2)
    search_sql = [s for s, _ in conn.store["sql"] if "ORDER BY embedding" in s][0]
    assert "embedding <=>" in search_sql and "1 - (embedding <=>" in search_sql and "LIMIT %s" in search_sql
    assert hits[0][0].text == "pgvector doc" and abs(hits[0][1] - 0.95) < 1e-9
    assert hits[0][0].metadata.get("source") == "db"


def test_pgvector_all_values_parameterized():
    conn = _fake_conn()
    store = PgVectorStore(dim=4, conn=conn)
    store.add([Chunk(text="x", embedding=[0.0, 0.0, 0.0, 0.0])])
    store.search([0.0, 0.0, 0.0, 0.0], k=1)
    value_sqls = [s for s, p in conn.store["sql"] if p]
    assert all("%s" in s for s in value_sqls)
