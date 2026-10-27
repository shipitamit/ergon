"""Ground an agent's answers in a knowledge base (RAG).

    pip install ergon[rag] anthropic   # rag extra = openai embeddings client
    export ANTHROPIC_API_KEY=sk-ant-...
    export OPENAI_API_KEY=sk-...        # for embeddings (or use a local endpoint)
    python examples/rag_retrieval.py

Uses OpenAI embeddings + an in-memory store. For persistence, swap in
PgVectorStore(dsn="postgres://…") — same code, data lives in Postgres.
"""
from ergon import Agent, KnowledgeBase, OpenAIEmbedder, retrieve_tool

kb = KnowledgeBase(embedder=OpenAIEmbedder())   # default in-memory store
kb.add_texts([
    "Ergon is a provider-neutral agent harness with an SDK and a visual Studio.",
    "Ergon's RAG layer uses pluggable embeddings and a pgvector or in-memory store.",
    "MCP support lets an Ergon agent inherit any MCP server's tools and resources.",
], metadata={"source": "ergon-docs"})

agent = Agent(
    "research",
    system="Answer using the `retrieve` tool to ground facts in the knowledge base. Cite sources.",
    model="claude-sonnet-4-6",
    tools=[retrieve_tool(kb)],
)
print(agent.run("What does Ergon's RAG layer use for storage?").text)
