# Examples

Worked harnesses and datasets you can import into the Studio or run through the
SDK bridge. Each harness graph is provider-neutral — set your own provider/model
in the Studio or when you load it.

## Harnesses

| Example | Files | What it shows |
| --- | --- | --- |
| **E-commerce support** | [`ecommerce-support-harness.json`](ecommerce-support-harness.json) · [README](ecommerce-support-README.md) · [eval set](ecommerce-support-eval.jsonl) | A support agent with a custom order-lookup tool and a safety guard, plus an eval dataset to score and gate it. |

### Run one

```bash
# through the SDK (supply real tool implementations as needed)
python -m ergon.run examples/ecommerce-support-harness.json "Where is order 12345?"

# serve it as an HTTP endpoint (REST + SSE)
ergon serve examples/ecommerce-support-harness.json --port 8900

# evaluate + gate against a baseline
python -m ergon.run_eval examples/ecommerce-support-harness.json \
  examples/ecommerce-support-eval.jsonl --save baseline.json
python -m ergon.run_eval examples/ecommerce-support-harness.json \
  examples/ecommerce-support-eval.jsonl --gate --baseline baseline.json
```

Or open the Studio (`npm --prefix studio run dev`) and **Import JSON** to load a
graph onto the canvas.

## Integrations

Ergon talks to models and tools through a few seams; these are the entry points
to wire your own:

- **Providers** — Anthropic, OpenAI-compatible (Groq, Together, Mistral,
  Ollama, …), Gemini, Bedrock, via the unified router (`ergon.router`). See the
  SDK README → *Providers* and *Unified routing*.
- **Tools** — custom Python tools (`tools={...}` on `load_harness`), built-in
  file/shell/memory/todo tools, and web search.
- **MCP** — connect Model Context Protocol servers for tools, resources, and
  prompts (SDK README → *MCP*).
- **RAG** — pgvector or in-memory vector stores (SDK README → *RAG*).
- **Telemetry** — OpenTelemetry export to Langfuse, Grafana, or any OTLP backend
  (SDK README → *Sending traces*).

## Contributing an example

Add your harness JSON (and an optional `*-README.md` and `*-eval.jsonl`) here,
then add a row to the table above. Keep it provider-neutral and free of secrets.
See [CONTRIBUTING.md](../CONTRIBUTING.md).
