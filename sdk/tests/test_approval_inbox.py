"""Human-in-the-loop ApprovalClient: file → poll → decide, via a fake HTTP
transport and a no-op sleep (offline, no server)."""
from ergon import ApprovalClient, ApprovalTimeout


class FakeHttp:
    """Serves a pending request that flips to a decision after N polls."""
    def __init__(self, decide_after=1, final_status="approved"):
        self.calls = []
        self.polls = 0
        self.decide_after = decide_after
        self.final_status = final_status

    def __call__(self, method, url, *, headers=None, json=None, params=None):
        self.calls.append({"method": method, "url": url, "headers": headers or {}, "json": json})
        if method == "POST":
            return {"request": {"id": "apr1", "status": "pending", "title": json.get("title")}}
        # GET
        self.polls += 1
        status = self.final_status if self.polls > self.decide_after else "pending"
        return {"request": {"id": "apr1", "status": status, "decisionNote": "ok" if status != "pending" else None}}


def _client(http):
    return ApprovalClient("https://ergon.example", "esk_key", "org1", http=http, sleep=lambda s: None)


def test_request_posts_with_auth_and_body():
    http = FakeHttp()
    c = _client(http)
    req = c.request("Refund $500", detail={"amount": 500}, harness_id="h1")
    assert req["id"] == "apr1" and req["status"] == "pending"
    post = http.calls[0]
    assert post["url"] == "https://ergon.example/api/orgs/org1/approvals"
    assert post["headers"]["Authorization"] == "Bearer esk_key"
    assert post["json"]["title"] == "Refund $500" and post["json"]["detail"] == {"amount": 500}
    assert post["json"]["harnessId"] == "h1"


def test_wait_polls_until_decided():
    http = FakeHttp(decide_after=2, final_status="approved")
    c = _client(http)
    final = c.wait("apr1", poll_interval=0.01, timeout=10)
    assert final["status"] == "approved"
    assert http.polls == 3  # two pending, then approved


def test_request_and_wait_returns_bool():
    ok, req = _client(FakeHttp(decide_after=0, final_status="approved")).request_and_wait("x")
    assert ok is True and req["status"] == "approved"
    ok, req = _client(FakeHttp(decide_after=0, final_status="rejected")).request_and_wait("y")
    assert ok is False and req["status"] == "rejected"


def test_wait_times_out_when_never_decided():
    http = FakeHttp(decide_after=9999)
    c = _client(http)
    try:
        c.wait("apr1", poll_interval=1, timeout=2)
        assert False, "expected ApprovalTimeout"
    except ApprovalTimeout:
        pass


def test_from_env_reads_runner_vars():
    env = {"ERGON_API_URL": "https://e.example", "ERGON_API_KEY": "esk_k", "ERGON_ORG_ID": "orgZ"}
    c = ApprovalClient.from_env(env, http=FakeHttp(), sleep=lambda s: None)
    assert c.base_url == "https://e.example" and c.org_id == "orgZ" and c.api_key == "esk_k"
