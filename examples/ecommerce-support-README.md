# E-commerce order-support harness (example)

A worked Ergon example: a customer-support triage harness that routes
incoming messages to specialized agents, each backed by real store-API tools.

## The graph

```
input → triage router ─┬─ order_status agent → lookup_order (GET /orders)
                       ├─ returns agent      → check_return_eligibility (GET)
                       │                      → create_return_label (POST, gated)
                       └─ technical agent     (no external tools)
                                            → output
```

- **Router** classifies each message into `order_status` / `returns` / `technical`
  and dispatches to the matching agent.
- **order_status** looks up live tracking by order number via an HTTP tool.
- **returns** checks eligibility, then can issue a prepaid label — but that tool
  is **mutating** (costs money), so the returns agent uses **interactive
  approval**: `check_return_eligibility` is auto-allowed, `create_return_label`
  needs a human OK. That's the guardrail that makes this safe to run.
- **technical** handles site/checkout issues and escalates when stuck.

## Try it

1. **In the Studio**: Import `ecommerce-support-harness.json` (☰ → Import).
   Click any node to see its config in the inspector. Press ▶ Run preview —
   the preview runs on Claude and *simulates* the HTTP tools (they're marked
   ⚠ simulated in the trace, since the endpoints are placeholders).

2. **Real tools, headless via the SDK**:
   ```python
   from ergon import load_harness
   import requests

   def lookup_order(order_id):
       r = requests.get(f"https://api.yourstore.com/orders/{order_id}",
                        headers={"Authorization": f"Bearer {TOKEN}"})
       return r.text

   h = load_harness("ecommerce-support-harness.json",
                    tools={"lookup_order": lookup_order,
                           "check_return_eligibility": ...,
                           "create_return_label": ...})
   print(h.run("Where is my order #4821?").text)
   ```
   (The Studio's HTTP-tool URLs are placeholders — point them at your real API,
   or supply Python implementations by name as above.)

3. **Evaluate it**: score the harness against the sample tickets:
   ```bash
   python -m ergon.run_eval ecommerce-support-harness.json \
       ecommerce-support-eval.jsonl
   ```
   Edit `ecommerce-support-eval.jsonl` to add your own real past tickets with
   their correct resolutions, then compare two router prompts by diffing the
   pass rates — that's how "we improved triage" becomes a measured claim.

## Before production
- Replace the placeholder `api.yourstore.com` URLs with your real endpoints and
  set `STORE_API_TOKEN`.
- Keep `create_return_label` behind approval (or a standing rule scoped to
  low-value returns only).
- Set a spend budget (⛔ Budget) so no single conversation runs away.
