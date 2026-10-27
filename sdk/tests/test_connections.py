"""Runner-side connection resolver (ergon.connection). Uses an injected fetcher,
so no network — mirrors how the control plane's resolve endpoint responds."""
import pytest

from ergon.connections import connection, Connection, ConnectionError


def _fetcher_factory(captured, payload):
    def _fetch(url, *, method, headers, body):
        captured["url"] = url
        captured["method"] = method
        captured["headers"] = headers
        return {"connection": payload}
    return _fetch


def test_resolves_bearer_material_and_builds_urls():
    cap = {}
    fetch = _fetcher_factory(cap, {
        "id": "conn_1", "connectorId": "slack", "name": "Acme", "authType": "oauth",
        "baseUrl": "https://slack.com/api", "authHeaders": {"Authorization": "Bearer at-fresh"},
    })
    c = connection("conn_1", server="https://ctl.example/", api_key="esk_x", org_id="o_1", fetcher=fetch)
    assert isinstance(c, Connection)
    assert c.auth_type == "oauth"
    assert c.auth_headers() == {"Authorization": "Bearer at-fresh"}
    assert c.url("chat.postMessage") == "https://slack.com/api/chat.postMessage"
    assert c.url() == "https://slack.com/api"
    # the request hit the resolve endpoint with the service-account bearer
    assert cap["url"] == "https://ctl.example/api/orgs/o_1/connections/conn_1/resolve"
    assert cap["method"] == "POST"
    assert cap["headers"]["authorization"] == "Bearer esk_x"


def test_db_connector_exposes_a_connection_string():
    fetch = _fetcher_factory({}, {
        "id": "conn_2", "connectorId": "postgres", "name": "Warehouse", "authType": "static",
        "connectionString": "postgres://u:p@h/db", "authHeaders": {},
    })
    c = connection("conn_2", server="https://ctl", api_key="esk_x", org_id="o_1", fetcher=fetch)
    assert c.connection_string == "postgres://u:p@h/db"
    assert c.auth_headers() == {}


def test_auth_headers_returns_a_copy():
    fetch = _fetcher_factory({}, {"id": "c", "connectorId": "http", "name": "n", "authHeaders": {"Authorization": "Bearer t"}})
    c = connection("c", server="s", api_key="k", org_id="o", fetcher=fetch)
    h = c.auth_headers()
    h["X"] = "mutated"
    assert "X" not in c.auth_headers(), "caller can't mutate the connection's headers"


def test_missing_config_raises():
    with pytest.raises(ConnectionError):
        connection("c", server="", api_key="k", org_id="o", fetcher=lambda *a, **k: {})
    with pytest.raises(ConnectionError):
        connection("c", server="s", api_key=None, org_id="o", fetcher=lambda *a, **k: {})
    with pytest.raises(ConnectionError):
        connection("c", server="s", api_key="k", org_id=None, fetcher=lambda *a, **k: {})


def test_empty_response_raises():
    with pytest.raises(ConnectionError):
        connection("c", server="s", api_key="k", org_id="o", fetcher=lambda *a, **k: {})
