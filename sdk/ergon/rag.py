"""RAG / retrieval — give an agent a knowledge base it can search.

Provider-neutral embeddings + a pluggable vector store + chunked ingestion + a
read-only `retrieve` tool the agent calls. The deliberate parallel to the rest
of Ergon: the embedding backend and the vector store are both swappable, so you
can run it entirely locally (Ollama embeddings + in-memory store) or on your own
Postgres (pgvector), with no vendor lock-in.

    from ergon import Agent, KnowledgeBase, retrieve_tool

    kb = KnowledgeBase()                      # in-memory store, default embedder
    kb.add_texts(["Ergon is an agent harness.", "pgvector stores embeddings."])
    agent = Agent("research", tools=[retrieve_tool(kb)],
                  system="Use `retrieve` to ground answers in the knowledge base.")
    print(agent.run("What stores embeddings?").text)

Embeddings default to an OpenAI-compatible endpoint (also covers Ollama/local via
base_url); pass your own Embedder to use anything. The vector store defaults to
in-memory (cosine, no deps); pass PgVectorStore(dsn=...) to persist in Postgres.

NOTE: the retrieval *logic* (chunking, cosine ranking, top-k, the tool, the
pgvector SQL) is unit-tested offline against a deterministic fake embedder and a
fake pool. Real embedding quality and a live pgvector database are not exercised
here — validate retrieval relevance with real data and a real Postgres before
relying on it.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .tools import Tool


# ── embeddings: provider-neutral ──

class Embedder:
    """Base embedder. Implement embed(texts) -> list[list[float]]."""
    dim: int = 0

    def embed(self, texts: Sequence[str]) -> List[List[float]]:
        raise NotImplementedError


class OpenAIEmbedder(Embedder):
    """OpenAI-compatible embeddings (also Ollama/local via base_url).

    Lazy-imports `openai`, so importing this module never requires it. Works
    against any endpoint that speaks the OpenAI embeddings API.
    """
    def __init__(self, model: str = "text-embedding-3-small",
                 api_key: Optional[str] = None, base_url: Optional[str] = None):
        self.model = model
        self._api_key = api_key
        self._base_url = base_url
        self._client = None

    def _ensure(self):
        if self._client is None:
            from openai import OpenAI
            self._client = OpenAI(api_key=self._api_key, base_url=self._base_url)
        return self._client

    def embed(self, texts: Sequence[str]) -> List[List[float]]:
        client = self._ensure()
        resp = client.embeddings.create(model=self.model, input=list(texts))
        return [d.embedding for d in resp.data]


class FakeEmbedder(Embedder):
    """Deterministic, dependency-free embedder for tests and local use.

    Hashes tokens into a fixed-dim bag-of-words vector. Not semantically smart,
    but stable and good enough to verify chunking, ranking, and top-k wiring
    offline — and to let the whole RAG path run with no network.
    """
    def __init__(self, dim: int = 64):
        self.dim = dim

    def embed(self, texts: Sequence[str]) -> List[List[float]]:
        import hashlib
        out = []
        for t in texts:
            v = [0.0] * self.dim
            for tok in re.findall(r"\w+", t.lower()):
                # stable hash (Python's built-in hash() is randomized per-process,
                # which would make retrieval non-deterministic across runs)
                h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
                v[h % self.dim] += 1.0
            out.append(v)
        return out


# ── vector math ──

def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


@dataclass
class Chunk:
    text: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    embedding: Optional[List[float]] = None


# ── vector stores ──

class VectorStore:
    """Base store. add(chunks) persists; search(vector, k) returns [(Chunk, score)]."""
    def add(self, chunks: List[Chunk]) -> None:
        raise NotImplementedError

    def search(self, vector: Sequence[float], k: int) -> List[Tuple[Chunk, float]]:
        raise NotImplementedError


class InMemoryStore(VectorStore):
    """In-process cosine store — no dependencies, good for local use and tests."""
    def __init__(self):
        self._chunks: List[Chunk] = []

    def add(self, chunks: List[Chunk]) -> None:
        self._chunks.extend(chunks)

    def search(self, vector: Sequence[float], k: int) -> List[Tuple[Chunk, float]]:
        scored = [(c, _cosine(vector, c.embedding or [])) for c in self._chunks]
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:k]

    def __len__(self):
        return len(self._chunks)


class PgVectorStore(VectorStore):
    """Postgres + pgvector store, for persistent/shared knowledge bases.

    Reuses the same Postgres you'd use for the Studio accounts tier. Needs the
    pgvector extension and the `psycopg` driver (lazy-imported). An injectable
    `conn` lets tests drive the SQL against a fake without a live database.

        kb = KnowledgeBase(store=PgVectorStore(dsn="postgres://…", dim=1536))

    The table is created on first use. Search uses pgvector's `<=>` cosine
    distance operator; score is 1 - distance so higher is better.
    """
    def __init__(self, dsn: Optional[str] = None, *, dim: int = 1536,
                 table: str = "ergon_chunks", conn: Any = None):
        self.dsn = dsn
        self.dim = dim
        self.table = table
        self._conn = conn
        self._ready = False

    def _ensure(self):
        if self._conn is None:
            import psycopg
            self._conn = psycopg.connect(self.dsn)
        if not self._ready:
            with self._conn.cursor() as cur:
                cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
                cur.execute(
                    f"CREATE TABLE IF NOT EXISTS {self.table} ("
                    f"id BIGSERIAL PRIMARY KEY, text TEXT NOT NULL, "
                    f"metadata JSONB, embedding vector({self.dim}))")
            self._conn.commit()
            self._ready = True
        return self._conn

    def add(self, chunks: List[Chunk]) -> None:
        import json
        conn = self._ensure()
        with conn.cursor() as cur:
            for c in chunks:
                cur.execute(
                    f"INSERT INTO {self.table} (text, metadata, embedding) VALUES (%s, %s, %s)",
                    (c.text, json.dumps(c.metadata), _to_pgvector(c.embedding or [])))
        conn.commit()

    def search(self, vector: Sequence[float], k: int) -> List[Tuple[Chunk, float]]:
        import json
        conn = self._ensure()
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT text, metadata, 1 - (embedding <=> %s) AS score "
                f"FROM {self.table} ORDER BY embedding <=> %s LIMIT %s",
                (_to_pgvector(vector), _to_pgvector(vector), k))
            rows = cur.fetchall()
        out = []
        for row in rows:
            text, meta, score = row[0], row[1], row[2]
            md = meta if isinstance(meta, dict) else (json.loads(meta) if meta else {})
            out.append((Chunk(text=text, metadata=md), float(score)))
        return out


def _to_pgvector(vector: Sequence[float]) -> str:
    """pgvector's text input format: '[0.1,0.2,...]'."""
    return "[" + ",".join(repr(float(x)) for x in vector) + "]"


# ── chunking ──

def chunk_text(text: str, *, chunk_size: int = 800, overlap: int = 100) -> List[str]:
    """Split text into overlapping character windows on paragraph/space
    boundaries. Simple and predictable; swap in a smarter splitter if needed."""
    text = text.strip()
    if len(text) <= chunk_size:
        return [text] if text else []
    chunks, start = [], 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        if end < len(text):
            # back off to the last whitespace so we don't cut mid-word
            cut = text.rfind(" ", start, end)
            if cut > start:
                end = cut
        chunks.append(text[start:end].strip())
        if end >= len(text):
            break
        start = max(end - overlap, start + 1)
    return [c for c in chunks if c]


# ── knowledge base: ties embedder + store together ──

class KnowledgeBase:
    """A searchable knowledge base: embed + store + retrieve.

    Defaults to a FakeEmbedder + InMemoryStore so it runs with zero setup and no
    network (good for tests and quick local use). For real use, pass an
    OpenAIEmbedder (or your own) and, for persistence, a PgVectorStore.
    """
    def __init__(self, embedder: Optional[Embedder] = None,
                 store: Optional[VectorStore] = None,
                 *, chunk_size: int = 800, overlap: int = 100):
        self.embedder = embedder or FakeEmbedder()
        self.store = store or InMemoryStore()
        self.chunk_size = chunk_size
        self.overlap = overlap

    def add_texts(self, texts: Sequence[str], metadata: Optional[Dict[str, Any]] = None) -> int:
        """Chunk, embed, and store the given texts. Returns the chunk count."""
        all_chunks: List[Chunk] = []
        for t in texts:
            for piece in chunk_text(t, chunk_size=self.chunk_size, overlap=self.overlap):
                all_chunks.append(Chunk(text=piece, metadata=dict(metadata or {})))
        if not all_chunks:
            return 0
        vectors = self.embedder.embed([c.text for c in all_chunks])
        for c, v in zip(all_chunks, vectors):
            c.embedding = v
        self.store.add(all_chunks)
        return len(all_chunks)

    def search(self, query: str, k: int = 4) -> List[Tuple[Chunk, float]]:
        qv = self.embedder.embed([query])[0]
        return self.store.search(qv, k)


# ── the agent tool ──

def retrieve_tool(kb: KnowledgeBase, *, k: int = 4, name: str = "retrieve") -> Tool:
    """A read-only tool that searches the knowledge base and returns the top-k
    passages (with scores). Safe by default — retrieval has no side effects."""
    def _retrieve(query: str) -> str:
        hits = kb.search(query, k=k)
        if not hits:
            return "No relevant passages found."
        lines = []
        for i, (chunk, score) in enumerate(hits, 1):
            src = chunk.metadata.get("source")
            tag = f" [{src}]" if src else ""
            lines.append(f"[{i}] (score {score:.2f}){tag} {chunk.text}")
        return "\n\n".join(lines)

    return Tool(
        name=name,
        description="Search the knowledge base for passages relevant to a query. "
                    "Returns the top matches to ground your answer.",
        input_schema={"type": "object", "properties": {"query": {"type": "string"}},
                      "required": ["query"]},
        fn=_retrieve,
        safe=True,
    )
