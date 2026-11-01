"""Human-in-the-loop approvals — let a running agent pause for a person.

A deployed agent (or any code) files an approval request to the Studio server
and waits; a person approves or rejects it in the Studio inbox, and the agent
proceeds or aborts. This is the counterpart to `ApprovalPolicy` (which gates
tool calls in-process): here the decision is made by a human, out of band.

    from ergon.approvals import ApprovalClient

    appr = ApprovalClient.from_env()            # uses ERGON_API_URL/KEY/ORG_ID
    ok, req = appr.request_and_wait("Refund $500 to customer 123",
                                    detail={"amount": 500, "customer": "123"})
    if not ok:
        raise RuntimeError(f"refund not approved: {req['status']}")

A managed runner already boots with those env vars (see managed hosting), so
`from_env()` just works there. HTTP and sleep are injectable, so the file→poll→
decide loop is unit-tested offline with no server.
"""
from __future__ import annotations

import os
import time
from typing import Any, Callable, Dict, Optional

from .rag_adapters import default_http


class ApprovalTimeout(RuntimeError):
    """Raised when a request isn't decided within the wait timeout."""


class ApprovalClient:
    def __init__(self, base_url: str, api_key: str, org_id: str, *,
                 http: Optional[Callable[..., Dict[str, Any]]] = None,
                 sleep: Optional[Callable[[float], None]] = None):
        if not (base_url and org_id):
            raise ValueError("ApprovalClient needs base_url and org_id.")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.org_id = org_id
        self._http = http or default_http
        self._sleep = sleep or time.sleep

    @classmethod
    def from_env(cls, env: Optional[Dict[str, str]] = None, **kw) -> "ApprovalClient":
        e = env or os.environ
        return cls(e.get("ERGON_API_URL", ""), e.get("ERGON_API_KEY", ""), e.get("ERGON_ORG_ID", ""), **kw)

    def _url(self, suffix: str = "") -> str:
        return f"{self.base_url}/api/orgs/{self.org_id}/approvals{suffix}"

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}

    def request(self, title: str, *, detail: Any = None, harness_id: Optional[str] = None,
                run_id: Optional[str] = None, expires_at: Optional[int] = None) -> Dict[str, Any]:
        """File a pending approval request; returns the created request."""
        body = {"title": title, "detail": detail, "harnessId": harness_id,
                "runId": run_id, "expiresAt": expires_at}
        return self._http("POST", self._url(), headers=self._headers(), json=body)["request"]

    def get(self, request_id: str) -> Dict[str, Any]:
        return self._http("GET", self._url(f"/{request_id}"), headers=self._headers())["request"]

    def wait(self, request_id: str, *, poll_interval: float = 3.0, timeout: float = 300.0) -> Dict[str, Any]:
        """Poll until the request leaves 'pending'. Raises ApprovalTimeout past
        `timeout` seconds. Returns the final request dict."""
        waited = 0.0
        while True:
            req = self.get(request_id)
            if req.get("status") != "pending":
                return req
            if waited >= timeout:
                raise ApprovalTimeout(f"approval {request_id} not decided within {timeout}s")
            self._sleep(poll_interval)
            waited += poll_interval

    def request_and_wait(self, title: str, *, poll_interval: float = 3.0, timeout: float = 300.0,
                         **kw) -> "tuple[bool, Dict[str, Any]]":
        """File + wait. Returns (approved, request)."""
        req = self.request(title, **kw)
        final = self.wait(req["id"], poll_interval=poll_interval, timeout=timeout)
        return final.get("status") == "approved", final
