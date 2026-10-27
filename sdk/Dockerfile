# Serve an Ergon harness as an HTTP endpoint (REST + SSE).
#
#   docker build -t ergon-serve ./sdk
#   docker run -p 8900:8900 -v $PWD/harness.json:/app/harness.json:ro \
#     -e ANTHROPIC_API_KEY -e ERGON_SERVE_KEY ergon-serve
#
# Override the default CMD to point at a different harness path or flags.
FROM python:3.12-slim

WORKDIR /app

# install the SDK (plus the OpenAI-compatible extra for non-Anthropic providers)
COPY . /app
RUN pip install --no-cache-dir ".[openai]"

# the harness graph is mounted at run time; keep a default path
ENV ERGON_SERVE_HOST=0.0.0.0 \
    PYTHONUNBUFFERED=1
EXPOSE 8900

# ergon serve <harness> --host 0.0.0.0 --port 8900
ENTRYPOINT ["ergon", "serve"]
CMD ["harness.json", "--host", "0.0.0.0", "--port", "8900"]
