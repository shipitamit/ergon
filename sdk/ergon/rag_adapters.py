"""RAG adapters — production embedding providers and managed vector stores.

These extend the pluggable RAG layer in `rag.py` with drop-in adapters for the
services people actually run in production, without adding hard dependencies:

  Embedders (conform to `Embedder.embed(texts) -> list[list[float]]`):
    - CohereEmbedder   (Cohere /v1/embed)
    - VoyageEmbedder   (Voyage /v1/embeddings)
    - plus OpenAIEmbedder / FakeEmbedder from rag.py, via make_embedder()

  Vector stores (conform to `VectorStore.add(chunks)` / `search(vector, k)`):
    - QdrantStore      (Qdrant REST)
    - ChromaStore      (Chroma REST)
    - PineconeStore    (Pinecone data-plane REST)
    - plus InMemoryStore / PgVectorStore from rag.py, via make_vector_store()

Design, mirroring the rest of Ergon:
  * No new hard dependencies. Every adapter talks plain REST through an
    injectable HTTP transport that defaults to the standard library (urllib),
    so nothing here needs `requests` or a vendor SDK installed.
  * The transport is injectable (`http=`), exactly like PgVectorStore's `conn=`,
    so the request-shaping and response-parsing logic is unit-tested offline
    against a fake transport — no network, no account, no live service.

    NOTE: as with PgVectorStore, only the *wiring* is exercised offline. Real
    embedding quality and a live vector database must be validated against the
    actual services before you rely on them.
"""
from __future__ import annotations

import json as _json
import uuid
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .rag import Chunk, Embedder, VectorStore

# An HTTP transport is any callable with this shape, returning parsed JSON:
#   http(method, url, *, headers=None, json=None, params=None) -> dict
Http = Callable[..., Dict[str, Any]]


def default_http(method: str, url: str, *, headers: Optional[Dict[str, str]] = None,
                 json: Any = None, params: Optional[Dict[str, Any]] = None,
                 timeout: float = 30.0) -> Dict[str, Any]:
    """Dependency-free JSON-over-HTTP transport built on urllib.

    Sends `json` as a JSON body, returns the parsed JSON response. Raises on a
    non-2xx status (the body is included in the error for debuggability).
    """
    import urllib.request
    import urllib.parse
    import urllib.error

    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    data = _json.dumps(json).encode("utf-8") if json is not None else None
    req = urllib.request.Request(url, data=data, method=method.upper())
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:  # pragma: no cover - network path
        detail = ""
        try:
            detail = e.read().decode("utf-8")
        except Exception:
            pass
        raise RuntimeError(f"HTTP {e.code} from {url}: {detail}") from e
    return _json.loads(body) if body else {}


def _new_id() -> str:
    return uuid.uuid4().hex


# ── embedders ──

class CohereEmbedder(Embedder):
    """Cohere embeddings (`/v1/embed`).

    Cohere distinguishes document vs query embeddings via `input_type`; this
    adapter uses one `input_type` for both add and search (default
    "search_document"). For best retrieval quality, embed queries with a store
    built for "search_query" — or keep the default, which is fine for most uses.
    """
    def __init__(self, model: str = "embed-english-v3.0",
                 api_key: Optional[str] = None, *,
                 base_url: str = "https://api.cohere.com",
                 input_type: str = "search_document",
                 http: Optional[Http] = None):
        self.model = model
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._input_type = input_type
        self._http = http or default_http

    def embed(self, texts: Sequence[str]) -> List[List[float]]:
        resp = self._http(
            "POST", f"{self._base_url}/v1/embed",
            headers={"Authorization": f"Bearer {self._api_key}"},
            json={"model": self.model, "texts": list(texts),
                  "input_type": self._input_type},
        )
        return resp["embeddings"]


class VoyageEmbedder(Embedder):
    """Voyage AI embeddings (`/v1/embeddings`)."""
    def __init__(self, model: str = "voyage-3",
                 api_key: Optional[str] = None, *,
                 base_url: str = "https://api.voyageai.com",
                 http: Optional[Http] = None):
        self.model = model
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._http = http or default_http

    def embed(self, texts: Sequence[str]) -> List[List[float]]:
        resp = self._http(
            "POST", f"{self._base_url}/v1/embeddings",
            headers={"Authorization": f"Bearer {self._api_key}"},
            json={"model": self.model, "input": list(texts)},
        )
        return [row["embedding"] for row in resp["data"]]


def make_embedder(kind: str = "openai", **kwargs: Any) -> Embedder:
    """Factory: build an embedder by name.

        make_embedder("cohere", api_key=...)
        make_embedder("ollama", model="nomic-embed-text")   # local, OpenAI-style

    kinds: openai, ollama, cohere, voyage, fake.
    """
    from .rag import FakeEmbedder, OpenAIEmbedder
    k = (kind or "openai").lower()
    if k == "openai":
        return OpenAIEmbedder(**kwargs)
    if k == "ollama":
        kwargs.setdefault("base_url", "http://localhost:11434/v1")
        kwargs.setdefault("api_key", "ollama")
        kwargs.setdefault("model", "nomic-embed-text")
        return OpenAIEmbedder(**kwargs)
    if k == "cohere":
        return CohereEmbedder(**kwargs)
    if k == "voyage":
        return VoyageEmbedder(**kwargs)
    if k == "fake":
        return FakeEmbedder(**kwargs)
    raise ValueError(f"unknown embedder kind: {kind!r} "
                     "(expected openai, ollama, cohere, voyage, or fake)")


# ── vector stores ──

class QdrantStore(VectorStore):
    """Qdrant vector store over its REST API.

        store = QdrantStore("http://localhost:6333", dim=1536)

    The collection is created on first use (cosine distance). Text and metadata
    ride along in each point's payload and are returned on search.
    """
    def __init__(self, url: str = "http://localhost:6333", *,
                 collection: str = "ergon_chunks", dim: int = 1536,
                 api_key: Optional[str] = None, distance: str = "Cosine",
                 http: Optional[Http] = None):
        self._url = url.rstrip("/")
        self.collection = collection
        self.dim = dim
        self._api_key = api_key
        self._distance = distance
        self._http = http or default_http
        self._ready = False

    def _headers(self) -> Dict[str, str]:
        return {"api-key": self._api_key} if self._api_key else {}

    def _ensure(self) -> None:
        if self._ready:
            return
        # PUT a collection is idempotent enough: Qdrant returns ok if it exists.
        self._http("PUT", f"{self._url}/collections/{self.collection}",
                   headers=self._headers(),
                   json={"vectors": {"size": self.dim, "distance": self._distance}})
        self._ready = True

    def add(self, chunks: List[Chunk]) -> None:
        self._ensure()
        points = [{
            "id": _new_id(),
            "vector": list(c.embedding or []),
            "payload": {"text": c.text, "metadata": c.metadata or {}},
        } for c in chunks]
        self._http("PUT", f"{self._url}/collections/{self.collection}/points",
                   headers=self._headers(), params={"wait": "true"},
                   json={"points": points})

    def search(self, vector: Sequence[float], k: int) -> List[Tuple[Chunk, float]]:
        self._ensure()
        resp = self._http(
            "POST", f"{self._url}/collections/{self.collection}/points/search",
            headers=self._headers(),
            json={"vector": list(vector), "limit": k, "with_payload": True},
        )
        out: List[Tuple[Chunk, float]] = []
        for row in resp.get("result", []):
            payload = row.get("payload", {}) or {}
            out.append((Chunk(text=payload.get("text", ""),
                              metadata=payload.get("metadata", {}) or {}),
                        float(row.get("score", 0.0))))
        return out


class ChromaStore(VectorStore):
    """Chroma vector store over its REST API.

        store = ChromaStore("http://localhost:8000")

    Targets Chroma's v1 REST API by default (set api_version="v2" for newer
    servers that expose it at the same shape). Cosine distance is assumed, so
    score is reported as 1 - distance (higher is better).
    """
    def __init__(self, url: str = "http://localhost:8000", *,
                 collection: str = "ergon_chunks", api_version: str = "v1",
                 http: Optional[Http] = None):
        self._url = url.rstrip("/")
        self.collection = collection
        self._api = api_version
        self._http = http or default_http
        self._id: Optional[str] = None

    def _ensure(self) -> str:
        if self._id:
            return self._id
        resp = self._http("POST", f"{self._url}/api/{self._api}/collections",
                          json={"name": self.collection, "get_or_create": True})
        self._id = resp.get("id") or self.collection
        return self._id

    def add(self, chunks: List[Chunk]) -> None:
        cid = self._ensure()
        self._http("POST", f"{self._url}/api/{self._api}/collections/{cid}/add",
                   json={
                       "ids": [_new_id() for _ in chunks],
                       "embeddings": [list(c.embedding or []) for c in chunks],
                       "documents": [c.text for c in chunks],
                       # Chroma rejects empty-dict metadata — send None instead.
                       "metadatas": [(c.metadata or None) for c in chunks],
                   })

    def search(self, vector: Sequence[float], k: int) -> List[Tuple[Chunk, float]]:
        cid = self._ensure()
        resp = self._http("POST", f"{self._url}/api/{self._api}/collections/{cid}/query",
                          json={"query_embeddings": [list(vector)], "n_results": k,
                                "include": ["documents", "distances", "metadatas"]})
        docs = (resp.get("documents") or [[]])[0]
        dists = (resp.get("distances") or [[]])[0]
        metas = (resp.get("metadatas") or [[]])[0]
        out: List[Tuple[Chunk, float]] = []
        for i, text in enumerate(docs):
            dist = float(dists[i]) if i < len(dists) else 0.0
            meta = metas[i] if i < len(metas) else {}
            out.append((Chunk(text=text, metadata=meta or {}), 1.0 - dist))
        return out


class PineconeStore(VectorStore):
    """Pinecone vector store over its data-plane REST API.

        store = PineconeStore("https://my-index-abc.svc.us-east1.pinecone.io",
                              api_key=..., dim=1536)

    Pinecone has no separate payload, so the chunk text is stored inside each
    vector's metadata (`text` key) and lifted back out on search.
    """
    def __init__(self, index_host: str, *, api_key: Optional[str] = None,
                 namespace: str = "", dim: int = 1536,
                 http: Optional[Http] = None):
        self._host = index_host.rstrip("/")
        self._api_key = api_key
        self.namespace = namespace
        self.dim = dim
        self._http = http or default_http

    def _headers(self) -> Dict[str, str]:
        return {"Api-Key": self._api_key} if self._api_key else {}

    def add(self, chunks: List[Chunk]) -> None:
        vectors = [{
            "id": _new_id(),
            "values": list(c.embedding or []),
            "metadata": {**(c.metadata or {}), "text": c.text},
        } for c in chunks]
        self._http("POST", f"{self._host}/vectors/upsert",
                   headers=self._headers(),
                   json={"vectors": vectors, "namespace": self.namespace})

    def search(self, vector: Sequence[float], k: int) -> List[Tuple[Chunk, float]]:
        resp = self._http("POST", f"{self._host}/query", headers=self._headers(),
                          json={"vector": list(vector), "topK": k,
                                "includeMetadata": True, "namespace": self.namespace})
        out: List[Tuple[Chunk, float]] = []
        for match in resp.get("matches", []):
            md = dict(match.get("metadata", {}) or {})
            text = md.pop("text", "")
            out.append((Chunk(text=text, metadata=md), float(match.get("score", 0.0))))
        return out


class WeaviateStore(VectorStore):
    """Weaviate vector store (REST for writes, GraphQL `nearVector` for search).

        store = WeaviateStore("http://localhost:8080", dim=1536)

    The class is created on first use with `vectorizer: none` (you bring your own
    vectors). Chunk text goes in a `text` property and metadata is stored as a
    JSON string in `metadata_json`, so arbitrary metadata survives without a
    per-field schema. Cosine distance is assumed, so score is 1 - distance.
    """
    def __init__(self, url: str = "http://localhost:8080", *,
                 class_name: str = "ErgonChunks", dim: int = 1536,
                 api_key: Optional[str] = None, http: Optional[Http] = None):
        self._url = url.rstrip("/")
        # Weaviate class names must start uppercase.
        self.class_name = class_name[:1].upper() + class_name[1:]
        self.dim = dim
        self._api_key = api_key
        self._http = http or default_http
        self._ready = False

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}

    def _ensure(self) -> None:
        if self._ready:
            return
        self._http("POST", f"{self._url}/v1/schema", headers=self._headers(),
                   json={"class": self.class_name, "vectorizer": "none",
                         "properties": [
                             {"name": "text", "dataType": ["text"]},
                             {"name": "metadata_json", "dataType": ["text"]},
                         ]})
        self._ready = True

    def add(self, chunks: List[Chunk]) -> None:
        self._ensure()
        objects = [{
            "class": self.class_name,
            "properties": {"text": c.text, "metadata_json": _json.dumps(c.metadata or {})},
            "vector": list(c.embedding or []),
        } for c in chunks]
        self._http("POST", f"{self._url}/v1/batch/objects",
                   headers=self._headers(), json={"objects": objects})

    def search(self, vector: Sequence[float], k: int) -> List[Tuple[Chunk, float]]:
        self._ensure()
        query = ("{Get{%s(nearVector:{vector:%s},limit:%d)"
                 "{text metadata_json _additional{distance}}}}"
                 % (self.class_name, _json.dumps(list(vector)), k))
        resp = self._http("POST", f"{self._url}/v1/graphql",
                          headers=self._headers(), json={"query": query})
        rows = (((resp.get("data") or {}).get("Get") or {}).get(self.class_name)) or []
        out: List[Tuple[Chunk, float]] = []
        for row in rows:
            meta_raw = row.get("metadata_json") or "{}"
            try:
                meta = _json.loads(meta_raw)
            except (ValueError, TypeError):
                meta = {}
            dist = float((row.get("_additional") or {}).get("distance", 0.0))
            out.append((Chunk(text=row.get("text", ""), metadata=meta), 1.0 - dist))
        return out


class MilvusStore(VectorStore):
    """Milvus vector store over its v2 REST API (Milvus 2.4+ / Zilliz Cloud).

        store = MilvusStore("http://localhost:19530", dim=1536, token=...)

    Uses quick-setup collection creation (an auto id + `vector` field + dynamic
    fields), so `text` and `metadata` ride along as dynamic fields. COSINE metric
    is used; Milvus returns a similarity in `distance` (higher is closer), which
    is passed straight through as the score.
    """
    def __init__(self, url: str = "http://localhost:19530", *,
                 collection: str = "ergon_chunks", dim: int = 1536,
                 token: Optional[str] = None, metric_type: str = "COSINE",
                 http: Optional[Http] = None):
        self._url = url.rstrip("/")
        self.collection = collection
        self.dim = dim
        self._token = token
        self._metric = metric_type
        self._http = http or default_http
        self._ready = False

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"} if self._token else {}

    def _ensure(self) -> None:
        if self._ready:
            return
        try:
            self._http("POST", f"{self._url}/v2/vectordb/collections/create",
                       headers=self._headers(),
                       json={"collectionName": self.collection, "dimension": self.dim,
                             "metricType": self._metric})
        except Exception:
            # an already-existing collection is fine; other errors surface on use
            pass
        self._ready = True

    def add(self, chunks: List[Chunk]) -> None:
        self._ensure()
        data = [{
            "vector": list(c.embedding or []),
            "text": c.text,
            "metadata": c.metadata or {},
        } for c in chunks]
        self._http("POST", f"{self._url}/v2/vectordb/entities/insert",
                   headers=self._headers(),
                   json={"collectionName": self.collection, "data": data})

    def search(self, vector: Sequence[float], k: int) -> List[Tuple[Chunk, float]]:
        self._ensure()
        resp = self._http("POST", f"{self._url}/v2/vectordb/entities/search",
                          headers=self._headers(),
                          json={"collectionName": self.collection,
                                "data": [list(vector)], "annsField": "vector",
                                "limit": k, "outputFields": ["text", "metadata"]})
        out: List[Tuple[Chunk, float]] = []
        for row in resp.get("data", []) or []:
            out.append((Chunk(text=row.get("text", ""),
                              metadata=row.get("metadata", {}) or {}),
                        float(row.get("distance", 0.0))))
        return out


def make_vector_store(kind: str = "memory", **kwargs: Any) -> VectorStore:
    """Factory: build a vector store by name.

        make_vector_store("qdrant", url="http://localhost:6333", dim=1536)
        make_vector_store("pgvector", dsn="postgres://…", dim=1536)

    kinds: memory, pgvector, qdrant, chroma, pinecone, weaviate, milvus.
    """
    from .rag import InMemoryStore, PgVectorStore
    k = (kind or "memory").lower()
    if k in ("memory", "inmemory", "in_memory"):
        return InMemoryStore()
    if k in ("pgvector", "postgres", "pg"):
        return PgVectorStore(**kwargs)
    if k == "qdrant":
        return QdrantStore(**kwargs)
    if k == "chroma":
        return ChromaStore(**kwargs)
    if k == "pinecone":
        return PineconeStore(**kwargs)
    if k == "weaviate":
        return WeaviateStore(**kwargs)
    if k == "milvus":
        return MilvusStore(**kwargs)
    raise ValueError(f"unknown vector store kind: {kind!r} (expected memory, "
                     "pgvector, qdrant, chroma, pinecone, weaviate, or milvus)")
