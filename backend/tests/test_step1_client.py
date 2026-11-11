import httpx
import pytest

from app.config import get_settings
from app.integrations.step1.client import HttpStep1Client, Step1Unavailable, client_from_settings


def make_client(handler) -> HttpStep1Client:
    return HttpStep1Client("http://step1.test/", "s3cret", transport=httpx.MockTransport(handler))


def test_register_sends_auth_and_include_superseded():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"project": {}, "rows": [{"record_number": "INV-00001"}]})

    rows = make_client(handler).register("P1")
    assert rows == [{"record_number": "INV-00001"}]
    request = seen[0]
    assert request.headers["authorization"] == "Bearer s3cret"
    assert request.headers["x-user-name"] == "pcx-sync"
    assert str(request.url) == "http://step1.test/api/projects/P1/register?includeSuperseded=true"


def test_projects_returns_the_list():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/projects"
        return httpx.Response(200, json=[{"id": "P1"}, {"id": "P2"}])

    assert make_client(handler).projects() == [{"id": "P1"}, {"id": "P2"}]


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(401, json={"error": "unauthorized"}),
        httpx.Response(500, text="boom"),
        httpx.Response(200, text="<html>not json</html>"),
        httpx.Response(200, json={"rows": "oops"}),
    ],
    ids=["401", "500", "non-json", "rows-not-list"],
)
def test_bad_responses_raise_unavailable_without_leaking_the_password(response):
    client = make_client(lambda request: response)
    with pytest.raises(Step1Unavailable) as exc:
        client.register("P1")
    assert "s3cret" not in str(exc.value)
    assert "s3cret" not in repr(client)


def test_projects_with_wrong_shape_raises_unavailable():
    client = make_client(lambda request: httpx.Response(200, json={"not": "a list"}))
    with pytest.raises(Step1Unavailable):
        client.projects()


def test_timeout_raises_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    with pytest.raises(Step1Unavailable) as exc:
        make_client(handler).projects()
    assert "s3cret" not in str(exc.value)


def test_client_from_settings_is_none_when_unset(monkeypatch):
    monkeypatch.setenv("PCX_STEP1_BASE_URL", "")
    monkeypatch.setenv("PCX_STEP1_APP_PASSWORD", "")
    get_settings.cache_clear()
    try:
        assert client_from_settings() is None
        monkeypatch.setenv("PCX_STEP1_BASE_URL", "http://step1.test")
        get_settings.cache_clear()
        assert client_from_settings() is None
    finally:
        get_settings.cache_clear()


def test_client_from_settings_returns_http_client_when_set(monkeypatch):
    monkeypatch.setenv("PCX_STEP1_BASE_URL", "http://step1.test")
    monkeypatch.setenv("PCX_STEP1_APP_PASSWORD", "s3cret")
    get_settings.cache_clear()
    try:
        client = client_from_settings()
        assert isinstance(client, HttpStep1Client)
        assert "s3cret" not in repr(client)
    finally:
        get_settings.cache_clear()


def test_fake_client_returns_copies_and_can_fail():
    from tests.step1_support import FakeStep1Client, reg_row

    row = reg_row()
    fake = FakeStep1Client([{"id": "S1-P1"}], {"S1-P1": [row]})
    assert fake.projects() == [{"id": "S1-P1"}]
    fake.register("S1-P1")[0]["record_number"] = "changed"
    assert fake.registers["S1-P1"][0]["record_number"] == "INV-00001"
    assert fake.register("unknown") == []
    assert reg_row()["inventory_record_id"] != reg_row()["inventory_record_id"]
    fake.fail = True
    with pytest.raises(Step1Unavailable, match="Step 1 unavailable"):
        fake.projects()
    with pytest.raises(Step1Unavailable):
        fake.register("S1-P1")
