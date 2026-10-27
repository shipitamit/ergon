"""Runner-side connection resolver — the client half of the managed-connection
store in the Ergon control plane.

Exported harnesses reference a connection by id (the Studio writes
``ergon.connection("conn_…")`` into generated tools). At run time this calls the
control plane's resolve endpoint, which decrypts the credential (refreshing an
OAuth token if it has expired) and returns run-time material — a base URL and
ready-to-use auth headers, or a database connection string — so the secret never
lives in the harness file or the environment of the exported code.

Configuration (environment):
    ERGON_SERVER     base URL of the Ergon control plane (e.g. https://studio.acme.dev)
    ERGON_API_KEY    a service-account key (esk_…) scoped to the connection's org
    ERGON_ORG_ID     the org that owns the connection

No third-party dependency: this uses the standard library (urllib). The HTTP call
is injectable (``fetcher=``) so it is unit-testable without a network.
"""
from __future__ import annotations

import json
import os
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional

from .errors import ErgonError


class ConnectionError(ErgonError):
    """A managed connection could not be resolved."""


def _default_fetcher(url: str, *, method: str, headers: Dict[str, str], body: Optional[bytes]) -> Dict[str, Any]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 (trusted control-plane URL)
        raw = resp.read().decode("utf-8")
    return json.loads(raw) if raw else {}


@dataclass
class Connection:
    """Resolved run-time material for a managed connection."""

    id: str
    connector_id: str
    name: str
    auth_type: str = "static"           # "static" | "oauth"
    base_url: Optional[str] = None
    connection_string: Optional[str] = None
    _headers: Dict[str, str] = field(default_factory=dict)

    def auth_headers(self) -> Dict[str, str]:
        """Headers to attach to an outbound request (e.g. Authorization)."""
        return dict(self._headers)

    def url(self, path: str = "") -> str:
        """Join the connection's base URL with a path."""
        base = (self.base_url or "").rstrip("/")
        if not path:
            return base
        return base + "/" + str(path).lstrip("/")

    @classmethod
    def _from_payload(cls, d: Dict[str, Any]) -> "Connection":
        return cls(
            id=d.get("id", ""),
            connector_id=d.get("connectorId", ""),
            name=d.get("name", ""),
            auth_type=d.get("authType", "static"),
            base_url=d.get("baseUrl"),
            connection_string=d.get("connectionString"),
            _headers=dict(d.get("authHeaders") or {}),
        )


def connection(
    connection_id: str,
    *,
    server: Optional[str] = None,
    api_key: Optional[str] = None,
    org_id: Optional[str] = None,
    fetcher: Optional[Callable[..., Dict[str, Any]]] = None,
) -> Connection:
    """Resolve a managed connection by id from the Ergon control plane.

    Reads ERGON_SERVER / ERGON_API_KEY / ERGON_ORG_ID when the matching argument
    is not given. Raises ConnectionError on misconfiguration or a failed resolve.
    """
    server = (server or os.environ.get("ERGON_SERVER") or "").rstrip("/")
    api_key = api_key or os.environ.get("ERGON_API_KEY")
    org_id = org_id or os.environ.get("ERGON_ORG_ID")
    if not server:
        raise ConnectionError("ERGON_SERVER is not set — point it at your Ergon control plane.")
    if not api_key:
        raise ConnectionError("ERGON_API_KEY is not set — a service-account key is required to resolve connections.")
    if not org_id:
        raise ConnectionError("ERGON_ORG_ID is not set — the connection's organization is required.")

    url = f"{server}/api/orgs/{org_id}/connections/{connection_id}/resolve"
    headers = {"authorization": f"Bearer {api_key}", "content-type": "application/json"}
    call = fetcher or _default_fetcher
    try:
        data = call(url, method="POST", headers=headers, body=b"{}")
    except Exception as e:  # pragma: no cover - network/urllib error surface
        raise ConnectionError(f"Could not resolve connection {connection_id}: {e}") from e

    payload = data.get("connection") if isinstance(data, dict) else None
    if not payload:
        raise ConnectionError(f"Connection {connection_id} was not resolved (empty response).")
    return Connection._from_payload(payload)
