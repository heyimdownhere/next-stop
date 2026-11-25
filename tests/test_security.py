"""The safety layers: host names, headers, the admin token, and what is let
through from outside feeds and files."""

from __future__ import annotations

import asyncio
import io
import zipfile

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.util import EXPORT_SLOTS, check_zip_size, csv_response, hex_color, safe_url
from app.web import HostCheck


def _app(tmp_path, **kw):
    s = Settings(api_token=None, config_dir=tmp_path, static_url="", published_url="", realtime_base="",
                 realtime_interval=30, static_check_interval=300, port=8080, map_download=False,
                 cta_enabled=False, **kw)
    return create_app(s)


def _get(app, host, path="/api/systems"):
    return TestClient(app, base_url=f"http://{host}").get(path)


# ---- host names (DNS rebinding) ---------------------------------------------------------
def test_by_default_only_addresses_localhost_and_tailscale_names_are_answered(tmp_path):
    app = _app(tmp_path)
    for host in ("192.168.1.20:8080", "10.0.0.5", "[fd7a:115c:a1e0::1]:8080", "localhost:8080", "127.0.0.1",
                 "nextstop.tail1234.ts.net"):
        assert _get(app, host).status_code == 200, host
    for host in ("evil.example.com", "nextstop.lan", "192.168.1.20.nip.io", "ts.net.evil.com"):
        r = _get(app, host)
        assert r.status_code == 400 and "ALLOWED_HOSTS" in r.json()["detail"], host


def test_listed_names_wildcards_and_star(tmp_path):
    app = _app(tmp_path, allowed_hosts=("nextstop.lan", "*.home.arpa"))
    assert _get(app, "nextstop.lan:8080").status_code == 200
    assert _get(app, "pi.home.arpa").status_code == 200
    assert _get(app, "127.0.0.1").status_code == 200       # the container's health check
    assert _get(app, "192.168.1.20").status_code == 400    # not listed
    assert _get(app, "evil.example.com").status_code == 400
    assert _get(_app(tmp_path, allowed_hosts=("*",)), "evil.example.com").status_code == 200


def test_host_name_parsing():
    assert HostCheck.host_name("Example.COM:8080") == "example.com"
    assert HostCheck.host_name("[::1]:8080") == "::1"
    assert HostCheck.host_name("::1") == "::1"


# ---- headers ---------------------------------------------------------------------------
def test_every_response_has_the_safety_headers(tmp_path):
    c = TestClient(_app(tmp_path, allowed_hosts=("*",)))
    page = c.get("/")
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    assert "script-src 'self' 'sha256-" in page.headers["content-security-policy"]
    for r in (page, c.get("/api/systems"), c.get("/app.js"), c.get("/nope")):
        assert r.headers["x-frame-options"] == "DENY"
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["cross-origin-opener-policy"] == "same-origin"
        assert "geolocation=(self)" in r.headers["permissions-policy"]
    assert c.get("/api/systems").headers["content-security-policy"] == "default-src 'none'; frame-ancestors 'none'"
    docs = c.get("/api/docs").headers["content-security-policy"]
    assert "script-src 'self' 'sha256-" in docs and "frame-ancestors 'none'" in docs


def test_the_map_worker_may_fetch_tiles(tmp_path):
    # A worker runs under its own script's policy: with "default-src 'none'"
    # MapLibre's worker could fetch no tiles and the map had no background.
    c = TestClient(_app(tmp_path, allowed_hosts=("*",)))
    for gz in ("gzip", "identity"):
        r = c.get("/vendor/maplibre/maplibre-gl-worker.mjs", headers={"Accept-Encoding": gz})
        assert r.status_code == 200
        csp = r.headers["content-security-policy"]
        assert "connect-src 'self' https://tiles.openfreemap.org" in csp and "frame-ancestors 'none'" in csp
    assert "connect-src 'self'" in c.get("/app.js").headers["content-security-policy"]
    assert c.get("/style.css").headers["content-security-policy"] == "default-src 'none'; frame-ancestors 'none'"


def test_static_text_files_are_sent_compressed_from_one_copy(tmp_path):
    app = _app(tmp_path, allowed_hosts=("*",))
    c = TestClient(app)
    a = c.get("/app.js", headers={"Accept-Encoding": "gzip"})
    assert a.headers["content-encoding"] == "gzip" and a.headers["cache-control"] == "no-cache"
    from app.web import WEB_DIR
    assert a.content == (WEB_DIR / "app.js").read_bytes()  # the client un-gzips it
    assert c.get("/app.js", headers={"Accept-Encoding": "identity"}).headers.get("content-encoding") is None
    etag = a.headers["etag"]
    assert c.get("/app.js", headers={"If-None-Match": etag, "Accept-Encoding": "gzip"}).status_code == 304


# ---- admin token -----------------------------------------------------------------------
def test_with_an_admin_token_changes_need_it(tmp_path):
    c = TestClient(_app(tmp_path, allowed_hosts=("*",), admin_token="s3cret-token"))
    assert c.put("/api/settings", json={"switch_time": "13:00"}).status_code == 401
    assert c.put("/api/settings", json={"switch_time": "13:00"}, headers={"X-Admin-Token": "wrong"}).status_code == 401
    # With the token it gets through to the route (503: no schedule in this test app).
    assert c.put("/api/settings", json={"switch_time": "13:00"}, headers={"X-Admin-Token": "s3cret-token"}).status_code == 503
    assert c.get("/api/settings").status_code in (200, 503)   # reading needs nothing


def test_without_an_admin_token_changes_are_open(tmp_path):
    c = TestClient(_app(tmp_path, allowed_hosts=("*",)))
    assert c.put("/api/settings", json={"switch_time": "13:00"}).status_code == 503  # reached the route


# ---- what comes in from outside --------------------------------------------------------
def test_only_web_links_and_hex_colours_get_through():
    assert safe_url("https://metra.com/x") == "https://metra.com/x" and safe_url(" HTTP://a.b ") == "HTTP://a.b"
    for bad in ("javascript:alert(1)", "JaVaScRiPt:x", "data:text/html,x", "//evil.com", "", None):
        assert safe_url(bad) is None, bad
    assert hex_color("112233", "#888888") == "#112233" and hex_color("#abcdef", "#888888") == "#ABCDEF"
    for bad in ("red", '123456"><img src=x>', "#12345", "1234567", None):
        assert hex_color(bad, "#888888") == "#888888", bad


def test_zip_bombs_are_refused():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("stop_times.txt", b"0" * (2 << 20))
    with zipfile.ZipFile(buf) as zf:
        check_zip_size(zf, limit=4 << 20)
        with pytest.raises(ValueError, match="unpack"):
            check_zip_size(zf, limit=1 << 20)


def test_only_two_exports_run_at_once():
    first = csv_response("a.csv", ["x"], iter([{"x": 1}]))
    second = csv_response("b.csv", ["x"], iter([{"x": 1}]))
    with pytest.raises(Exception) as exc:
        csv_response("c.csv", ["x"], iter([]))
    assert getattr(exc.value, "status_code", None) == 429

    async def drain(r):
        return [chunk async for chunk in r.body_iterator]

    asyncio.run(drain(first))                          # a finished download frees its slot
    third = csv_response("c.csv", ["x"], iter([]))
    del second, third                                  # dropped without being sent: slots come back
    import gc
    gc.collect()
    assert EXPORT_SLOTS.acquire(blocking=False) and EXPORT_SLOTS.acquire(blocking=False)
    EXPORT_SLOTS.release()
    EXPORT_SLOTS.release()


def test_metra_schedule_download_is_capped(tmp_path, monkeypatch):
    import app.tracker_core as core
    from app.tracker import Tracker

    s = Settings(api_token=None, config_dir=tmp_path, static_url="https://x/schedule.zip", published_url="pub",
                 realtime_base="", realtime_interval=30, static_check_interval=300, port=8080)
    t = Tracker(s)
    t._client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"x" * 5000)))
    monkeypatch.setattr(core, "MAX_DOWNLOAD", 1000)
    with pytest.raises(ValueError, match="larger than"):
        asyncio.run(t._download_schedule())
    assert not t.cache.new_zip.exists()


# ---- spam protection ---------------------------------------------------------------------
async def _call(mw, path="/api/departures", ip="10.0.0.2"):
    sent = []

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    async def send(m):
        sent.append(m)

    async def receive():
        return {"type": "http.request", "body": b""}

    mw.app = app
    await mw({"type": "http", "path": path, "client": (ip, 1234), "headers": []}, receive, send)
    return sent[0]["status"]


def test_repeated_hits_are_refused_then_allowed_again(monkeypatch):
    import app.web as web
    clock = [1000.0]
    monkeypatch.setattr(web.time, "monotonic", lambda: clock[0])

    async def go():
        mw = web.ClientLimit(None, per_minute=60)               # 1 a second, bursts of 12
        assert [await _call(mw) for _ in range(12)] == [200] * 12
        assert await _call(mw) == 429
        assert await _call(mw, ip="10.0.0.9") == 200            # someone else's allowance
        clock[0] += 3                                            # 3 s later: 3 more
        assert [await _call(mw) for _ in range(4)] == [200, 200, 200, 429]
        clock[0] += 400                                          # quiet clients are forgotten
        assert await _call(mw, ip="10.0.0.7") == 200
        assert set(mw._clients) == {"10.0.0.7"}
    asyncio.run(go())


def test_tiles_and_app_files_are_not_counted():
    async def go():
        from app.web import ClientLimit
        mw = ClientLimit(None, per_minute=5)
        paths = ["/map/tiles/7/32/47.mvt"] * 50 + ["/app.js", "/", "/vendor/x/y.js"]
        assert [await _call(mw, path=p) for p in paths] == [200] * len(paths)
        assert mw._clients == {}
    asyncio.run(go())


def test_the_normal_app_never_gets_near_the_default():
    async def go():
        from app.web import ClientLimit
        mw = ClientLimit(None)                                   # 600 a minute
        # Opening the app in five tabs at once, about 7 requests each.
        assert [await _call(mw) for _ in range(35)] == [200] * 35
    asyncio.run(go())


def test_the_app_wires_in_the_limit(tmp_path):
    c = TestClient(_app(tmp_path, allowed_hosts=("*",), client_requests_per_minute=10))  # bursts of 2
    assert [c.get("/api/systems").status_code for _ in range(3)] == [200, 200, 429]
    assert c.get("/api/systems").headers["retry-after"] == "1"
    assert c.get("/app.js").status_code == 200
    off = TestClient(_app(tmp_path, allowed_hosts=("*",), client_requests_per_minute=0))
    assert {off.get("/api/systems").status_code for _ in range(50)} == {200}
