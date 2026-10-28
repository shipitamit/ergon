"""RAG adapters: embedding providers, managed vector stores, document loaders.

Every network adapter is driven through an injected fake HTTP transport (the
same pattern as PgVectorStore's fake connection), so request-shaping and
response-parsing are verified offline — no network, no account, no live service.
Loaders run against real temp files and an injected URL fetcher.
"""
import os
import tempfile

from ergon import (KnowledgeBase, FakeEmbedder, Chunk,
                   CohereEmbedder, VoyageEmbedder, make_embedder,
                   QdrantStore, ChromaStore, PineconeStore,
                   WeaviateStore, MilvusStore, make_vector_store)
from ergon import loaders


# ── a fake HTTP transport (records calls, returns canned JSON by route) ──

class FakeHttp:
    """Records every call; returns the first matching canned response.

    routes: list of (method, url_substring, response_or_callable). A callable
    receives the request's json body and returns the response dict.
    """
    def __init__(self, routes=None):
        self.calls = []
        self.routes = list(routes or [])

    def __call__(self, method, url, *, headers=None, json=None, params=None):
        self.calls.append({"method": method, "url": url,
                           "headers": headers or {}, "json": json, "params": params})
        for m, sub, resp in self.routes:
            if m == method and sub in url:
                return resp(json) if callable(resp) else resp
        return {}

    def find(self, method, url_substr):
        return [c for c in self.calls
                if c["method"] == method and url_substr in c["url"]]


# ── embedders ──

def test_cohere_embedder_request_and_parse():
    http = FakeHttp([("POST", "/v1/embed",
                      lambda body: {"embeddings": [[0.1, 0.2]] * len(body["texts"])})])
    emb = CohereEmbedder(model="embed-english-v3.0", api_key="sk-co", http=http)
    out = emb.embed(["a", "b"])
    assert out == [[0.1, 0.2], [0.1, 0.2]]
    call = http.find("POST", "/v1/embed")[0]
    assert call["url"] == "https://api.cohere.com/v1/embed"
    assert call["headers"]["Authorization"] == "Bearer sk-co"
    assert call["json"]["model"] == "embed-english-v3.0"
    assert call["json"]["texts"] == ["a", "b"]
    assert call["json"]["input_type"] == "search_document"


def test_voyage_embedder_request_and_parse():
    http = FakeHttp([("POST", "/v1/embeddings",
                      lambda body: {"data": [{"embedding": [0.3]} for _ in body["input"]]})])
    emb = VoyageEmbedder(model="voyage-3", api_key="sk-vo", http=http)
    out = emb.embed(["x"])
    assert out == [[0.3]]
    call = http.find("POST", "/v1/embeddings")[0]
    assert call["url"] == "https://api.voyageai.com/v1/embeddings"
    assert call["headers"]["Authorization"] == "Bearer sk-vo"
    assert call["json"] == {"model": "voyage-3", "input": ["x"]}


def test_make_embedder_factory():
    assert isinstance(make_embedder("cohere", api_key="k"), CohereEmbedder)
    assert isinstance(make_embedder("voyage", api_key="k"), VoyageEmbedder)
    assert isinstance(make_embedder("fake", dim=8), FakeEmbedder)
    # ollama is OpenAI-compatible with a local default base_url
    oll = make_embedder("ollama")
    assert oll._base_url == "http://localhost:11434/v1"
    try:
        make_embedder("nope")
        assert False, "expected ValueError"
    except ValueError:
        pass


# ── Qdrant ──

def test_qdrant_add_creates_collection_and_upserts():
    http = FakeHttp()
    store = QdrantStore("http://q:6333/", collection="kb", dim=3, api_key="qk", http=http)
    store.add([Chunk(text="hello", metadata={"source": "a"}, embedding=[0.1, 0.2, 0.3])])
    # collection created once (cosine, right dim)
    create = http.find("PUT", "/collections/kb")
    create = [c for c in create if not c["url"].endswith("/points")]
    assert create and create[0]["json"]["vectors"] == {"size": 3, "distance": "Cosine"}
    assert create[0]["headers"]["api-key"] == "qk"
    # points upserted with payload carrying text + metadata
    up = [c for c in http.find("PUT", "/collections/kb/points")]
    assert up and up[0]["params"] == {"wait": "true"}
    pt = up[0]["json"]["points"][0]
    assert pt["vector"] == [0.1, 0.2, 0.3]
    assert pt["payload"] == {"text": "hello", "metadata": {"source": "a"}}


def test_qdrant_search_parses_results():
    http = FakeHttp([("POST", "/points/search", {"result": [
        {"score": 0.91, "payload": {"text": "doc one", "metadata": {"source": "a"}}},
        {"score": 0.42, "payload": {"text": "doc two", "metadata": {}}},
    ]})])
    store = QdrantStore("http://q:6333", collection="kb", dim=3, http=http)
    hits = store.search([0.1, 0.2, 0.3], k=2)
    assert [h[0].text for h in hits] == ["doc one", "doc two"]
    assert abs(hits[0][1] - 0.91) < 1e-9
    assert hits[0][0].metadata == {"source": "a"}
    body = http.find("POST", "/points/search")[0]["json"]
    assert body == {"vector": [0.1, 0.2, 0.3], "limit": 2, "with_payload": True}


# ── Chroma ──

def test_chroma_add_and_search():
    http = FakeHttp([
        ("POST", "/query", {"documents": [["d1", "d2"]],
                            "distances": [[0.1, 0.5]],
                            "metadatas": [[{"source": "a"}, None]]}),
        ("POST", "/collections/col-123/add", {}),
        ("POST", "/collections", {"id": "col-123"}),
    ])
    store = ChromaStore("http://c:8000", collection="kb", http=http)
    store.add([Chunk(text="d1", metadata={"source": "a"}, embedding=[0.1]),
               Chunk(text="d2", metadata={}, embedding=[0.2])])
    add = [c for c in http.calls if c["url"].endswith("/add")][0]
    assert add["json"]["documents"] == ["d1", "d2"]
    assert add["json"]["embeddings"] == [[0.1], [0.2]]
    # empty metadata is sent as None (Chroma rejects {})
    assert add["json"]["metadatas"] == [{"source": "a"}, None]
    hits = store.search([0.1], k=2)
    assert [h[0].text for h in hits] == ["d1", "d2"]
    # cosine distance → score = 1 - distance
    assert abs(hits[0][1] - 0.9) < 1e-9 and abs(hits[1][1] - 0.5) < 1e-9
    assert hits[0][0].metadata == {"source": "a"}


# ── Pinecone ──

def test_pinecone_add_stores_text_in_metadata():
    http = FakeHttp()
    store = PineconeStore("https://idx.pinecone.io/", api_key="pk",
                          namespace="ns", dim=2, http=http)
    store.add([Chunk(text="hello", metadata={"source": "a"}, embedding=[0.1, 0.2])])
    up = http.find("POST", "/vectors/upsert")[0]
    assert up["headers"]["Api-Key"] == "pk"
    assert up["json"]["namespace"] == "ns"
    v = up["json"]["vectors"][0]
    assert v["values"] == [0.1, 0.2]
    assert v["metadata"] == {"source": "a", "text": "hello"}


def test_pinecone_search_lifts_text_out_of_metadata():
    http = FakeHttp([("POST", "/query", {"matches": [
        {"score": 0.88, "metadata": {"text": "doc one", "source": "a"}},
    ]})])
    store = PineconeStore("https://idx.pinecone.io", api_key="pk", http=http)
    hits = store.search([0.1, 0.2], k=1)
    assert hits[0][0].text == "doc one"
    assert hits[0][0].metadata == {"source": "a"}  # text popped back out
    assert abs(hits[0][1] - 0.88) < 1e-9
    body = http.find("POST", "/query")[0]["json"]
    assert body["topK"] == 1 and body["includeMetadata"] is True


# ── Weaviate ──

def test_weaviate_add_creates_class_and_batches():
    http = FakeHttp()
    store = WeaviateStore("http://w:8080/", class_name="kb", dim=3,
                          api_key="wk", http=http)
    store.add([Chunk(text="hello", metadata={"source": "a"}, embedding=[0.1, 0.2, 0.3])])
    # class name is uppercased; schema created once with vectorizer none
    schema = http.find("POST", "/v1/schema")[0]
    assert schema["json"]["class"] == "Kb"
    assert schema["json"]["vectorizer"] == "none"
    assert schema["headers"]["Authorization"] == "Bearer wk"
    # batch carries vector + text + metadata-as-json
    batch = http.find("POST", "/v1/batch/objects")[0]
    obj = batch["json"]["objects"][0]
    assert obj["class"] == "Kb" and obj["vector"] == [0.1, 0.2, 0.3]
    assert obj["properties"]["text"] == "hello"
    assert '"source": "a"' in obj["properties"]["metadata_json"]


def test_weaviate_search_parses_graphql():
    http = FakeHttp([("POST", "/v1/graphql", {"data": {"Get": {"Kb": [
        {"text": "doc one", "metadata_json": '{"source": "a"}',
         "_additional": {"distance": 0.1}},
        {"text": "doc two", "metadata_json": "{}",
         "_additional": {"distance": 0.6}},
    ]}}})])
    store = WeaviateStore("http://w:8080", class_name="kb", dim=3, http=http)
    hits = store.search([0.1, 0.2, 0.3], k=2)
    assert [h[0].text for h in hits] == ["doc one", "doc two"]
    # cosine distance → score = 1 - distance
    assert abs(hits[0][1] - 0.9) < 1e-9
    assert hits[0][0].metadata == {"source": "a"}
    # the GraphQL query embeds the vector, limit, and the capitalized class
    q = http.find("POST", "/v1/graphql")[0]["json"]["query"]
    assert "Kb(nearVector:{vector:[0.1, 0.2, 0.3]},limit:2)" in q


# ── Milvus ──

def test_milvus_add_creates_collection_and_inserts():
    http = FakeHttp()
    store = MilvusStore("http://m:19530/", collection="kb", dim=3,
                        token="mk", http=http)
    store.add([Chunk(text="hello", metadata={"source": "a"}, embedding=[0.1, 0.2, 0.3])])
    create = http.find("POST", "/v2/vectordb/collections/create")[0]
    assert create["json"] == {"collectionName": "kb", "dimension": 3, "metricType": "COSINE"}
    assert create["headers"]["Authorization"] == "Bearer mk"
    ins = http.find("POST", "/v2/vectordb/entities/insert")[0]
    row = ins["json"]["data"][0]
    assert row["vector"] == [0.1, 0.2, 0.3]
    assert row["text"] == "hello" and row["metadata"] == {"source": "a"}


def test_milvus_search_passes_distance_through_as_score():
    http = FakeHttp([("POST", "/v2/vectordb/entities/search", {"code": 0, "data": [
        {"distance": 0.93, "text": "doc one", "metadata": {"source": "a"}},
    ]})])
    store = MilvusStore("http://m:19530", collection="kb", dim=3, http=http)
    hits = store.search([0.1, 0.2, 0.3], k=1)
    assert hits[0][0].text == "doc one" and hits[0][0].metadata == {"source": "a"}
    # COSINE similarity is higher-is-better, so it passes straight through
    assert abs(hits[0][1] - 0.93) < 1e-9
    body = http.find("POST", "/v2/vectordb/entities/search")[0]["json"]
    assert body["data"] == [[0.1, 0.2, 0.3]] and body["limit"] == 1
    assert body["annsField"] == "vector"


def test_make_vector_store_factory():
    assert isinstance(make_vector_store("qdrant", url="http://q:6333"), QdrantStore)
    assert isinstance(make_vector_store("chroma"), ChromaStore)
    assert isinstance(make_vector_store("pinecone", index_host="https://x"), PineconeStore)
    assert isinstance(make_vector_store("weaviate", url="http://w:8080"), WeaviateStore)
    assert isinstance(make_vector_store("milvus", url="http://m:19530"), MilvusStore)
    from ergon import InMemoryStore
    assert isinstance(make_vector_store("memory"), InMemoryStore)
    try:
        make_vector_store("nope")
        assert False, "expected ValueError"
    except ValueError:
        pass


# ── KnowledgeBase wired to an adapter store (fake transport, real embedder) ──

def test_knowledgebase_over_qdrant_wiring():
    http = FakeHttp([("POST", "/points/search", {"result": [
        {"score": 0.77, "payload": {"text": "pgvector stores embeddings", "metadata": {}}},
    ]})])
    kb = KnowledgeBase(embedder=FakeEmbedder(dim=16),
                       store=QdrantStore("http://q:6333", dim=16, http=http))
    n = kb.add_texts(["pgvector stores embeddings in Postgres."])
    assert n == 1
    # the embedder produced a 16-dim vector that went into the upsert
    up = http.find("PUT", "/collections/ergon_chunks/points")[0]
    assert len(up["json"]["points"][0]["vector"]) == 16
    hits = kb.search("embeddings", k=1)
    assert hits[0][0].text == "pgvector stores embeddings"


# ── loaders ──

def test_load_text_and_markdown_frontmatter():
    d = tempfile.mkdtemp()
    tp = os.path.join(d, "a.txt")
    with open(tp, "w") as f:
        f.write("plain text body")
    assert loaders.load_file(tp) == "plain text body"

    mp = os.path.join(d, "b.md")
    with open(mp, "w") as f:
        f.write("---\ntitle: X\n---\n# Heading\n\nBody text.")
    md = loaders.load_file(mp)
    assert md.startswith("# Heading") and "Body text." in md and "title: X" not in md


def test_load_csv_pairs_header_with_values():
    d = tempfile.mkdtemp()
    cp = os.path.join(d, "data.csv")
    with open(cp, "w") as f:
        f.write("name,role\nAda,engineer\nGrace,admiral\n")
    out = loaders.load_file(cp)
    assert "name: Ada; role: engineer" in out
    assert "name: Grace; role: admiral" in out


def test_strip_html_drops_tags_scripts_entities():
    markup = "<html><head><style>x{}</style></head><body><h1>Hi</h1>" \
             "<script>bad()</script><p>A &amp; B</p></body></html>"
    text = loaders.strip_html(markup)
    assert "Hi" in text and "A & B" in text
    assert "bad()" not in text and "x{}" not in text and "<" not in text


def test_load_url_with_injected_fetch():
    text = loaders.load_url("https://ex.com", http_get=lambda u: "<p>Hello <b>world</b></p>")
    assert text == "Hello world"


def test_iter_files_finds_supported():
    d = tempfile.mkdtemp()
    for name in ("a.txt", "b.md", "c.pdf", "skip.bin"):
        with open(os.path.join(d, name), "w") as f:
            f.write("x")
    found = {os.path.basename(p) for p in loaders.iter_files(d)}
    assert found == {"a.txt", "b.md", "c.pdf"}


# ── KnowledgeBase ingestion convenience ──

def test_knowledgebase_add_file_sets_source():
    d = tempfile.mkdtemp()
    fp = os.path.join(d, "doc.txt")
    with open(fp, "w") as f:
        f.write("pgvector stores embeddings for similarity search.")
    kb = KnowledgeBase()
    assert kb.add_file(fp) == 1
    hits = kb.search("embeddings similarity", k=1)
    assert hits and hits[0][0].metadata.get("source") == fp


def test_knowledgebase_add_url_injected():
    kb = KnowledgeBase()
    n = kb.add_url("https://ex.com/post",
                   fetch=lambda u: "<p>Ergon is an agent harness.</p>")
    assert n == 1
    hits = kb.search("agent harness", k=1)
    assert hits and hits[0][0].metadata.get("source") == "https://ex.com/post"
    assert "Ergon is an agent harness." in hits[0][0].text


def test_knowledgebase_add_path_ingests_directory():
    d = tempfile.mkdtemp()
    with open(os.path.join(d, "one.txt"), "w") as f:
        f.write("first document about retrieval")
    with open(os.path.join(d, "two.md"), "w") as f:
        f.write("# Two\n\nsecond document about embeddings")
    kb = KnowledgeBase()
    total = kb.add_path(d)
    assert total == 2
    assert len(kb.store) == 2
