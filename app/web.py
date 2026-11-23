"""The web side that isn't data: the page itself, static files, and the small
safety layers every response goes through."""

from __future__ import annotations

import base64
import gzip
import hashlib
import hmac
import ipaddress
import json
import re
import threading
import time
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.types import ASGIApp, Message, Receive, Scope, Send

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

# Outside servers the page may load map pictures and styles from. Only the
# optional online backgrounds use them (see web/map.js); the default map,
# its fonts and all train data come from this server.
ONLINE_MAP_HOSTS = "https://tiles.openfreemap.org https://server.arcgisonline.com https://*.tiles.openrailwaymap.org"

# index.html links each script/stylesheet as "file?v=<content hash>", so the browser
# can keep those files for a year and only fetches one again after it changes.
ASSET_REF = re.compile(r'(?P<attr>(?:src|href))="(?P<path>[^"?#:]+\.(?:m?js|css))"')
INLINE_SCRIPT = re.compile(r"<script>(.*?)</script>", re.DOTALL)
# A bundled library (web/vendor/<name>/, with a VERSION file) is linked as
# vendor/<name>@<stamp>/file instead: the stamp is in the path, so the files it
# loads itself by relative address (MapLibre's modules and its worker) carry it
# too, and all of them can be cached for good.
VENDOR_REF = re.compile(r"vendor/(?P<lib>[A-Za-z0-9_-]+)/(?P<rest>.+)")
VENDOR_PATH = re.compile(r"vendor/(?P<lib>[A-Za-z0-9_-]+)@[0-9a-f]{1,40}/(?P<rest>.+)")


def vendor_stamp(lib_dir: Path) -> str:
    """Changes whenever any file in a vendor library's folder does."""
    h = hashlib.sha1()
    for f in sorted(lib_dir.iterdir()):
        if f.is_file():
            st = f.stat()
            h.update(f"{f.name}:{st.st_size}:{st.st_mtime_ns};".encode())
    return h.hexdigest()[:10]


def _script_hashes(page: str) -> str:
    return " ".join(
        "'sha256-" + base64.b64encode(hashlib.sha256(m.group(1).encode()).digest()).decode() + "'"
        for m in INLINE_SCRIPT.finditer(page))


# Sent with every response that doesn't set its own policy (JSON, files, errors):
# nothing may load, and no site may show it in a frame.
DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'"


def docs_security_policy(page: str) -> str:
    """For /api/docs: Swagger UI's own files plus its one inline script."""
    return "; ".join([
        "default-src 'self'",
        f"script-src 'self' {_script_hashes(page)}".rstrip(),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
    ])


def content_security_policy(page: str) -> str:
    """What the page is allowed to load and run.

    Scripts: only this server's own files, plus the one small script written
    into index.html (allowed by its hash). So if text from a transit agency
    (an alert, a station name) ever slipped through unescaped, the browser
    still would not run it.
    """
    hashes = _script_hashes(page)
    return "; ".join([
        "default-src 'self'",
        f"script-src 'self' {hashes}".rstrip(),
        "style-src 'self' 'unsafe-inline'",
        f"img-src 'self' data: blob: {ONLINE_MAP_HOSTS}",
        f"connect-src 'self' {ONLINE_MAP_HOSTS}",
        "font-src 'self'",
        "worker-src 'self' blob:",
        "child-src blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ])


class IndexPage:
    """index.html with versioned asset links and its security policy, rebuilt
    only when a file changes."""

    def __init__(self, web_dir: Path = WEB_DIR):
        self.dir = web_dir
        self._key: tuple | None = None
        self._body = b""
        self._csp = ""

    def response(self) -> Response:
        page_path = self.dir / "index.html"
        page = page_path.read_text()
        files = [page_path] + [self.dir / m.group("path") for m in ASSET_REF.finditer(page)]
        libs = {self.dir / "vendor" / v.group("lib") for m in ASSET_REF.finditer(page)
                if (v := VENDOR_REF.fullmatch(m.group("path")))}
        key = (tuple((f, f.stat().st_mtime_ns) for f in files if f.exists()),
               tuple((d, vendor_stamp(d)) for d in sorted(libs) if d.is_dir()))
        if key != self._key:
            def stamp(m: re.Match) -> str:
                f = self.dir / m.group("path")
                if not f.is_file():
                    return m.group(0)
                v = VENDOR_REF.fullmatch(m.group("path"))
                if v:
                    lib = vendor_stamp(self.dir / "vendor" / v.group("lib"))
                    return f'{m.group("attr")}="vendor/{v.group("lib")}@{lib}/{v.group("rest")}"'
                digest = hashlib.sha1(f.read_bytes()).hexdigest()[:10]
                return f'{m.group("attr")}="{m.group("path")}?v={digest}"'
            self._body, self._csp, self._key = ASSET_REF.sub(stamp, page).encode(), content_security_policy(page), key
        return Response(self._body, media_type="text/html; charset=utf-8",
                        headers={"Cache-Control": "no-cache", "Content-Security-Policy": self._csp})


# Text files worth compressing. Each is compressed once (at the best level) and
# kept in memory, instead of again on every download.
COMPRESSIBLE = (".js", ".mjs", ".css", ".svg", ".json", ".webmanifest", ".txt")
class WebFiles(StaticFiles):
    """Static files.

    Versioned links (file?v=... and vendor/<lib>@<stamp>/file, see VENDOR_REF)
    are cached for a year; anything else is re-checked. Text files go out
    gzip-compressed from a copy made once.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._gz: dict[str, tuple[int, bytes]] = {}
        self._gz_lock = threading.Lock()

    def _compressed(self, file: str) -> bytes:
        stamp = Path(file).stat().st_mtime_ns
        hit = self._gz.get(file)
        if hit is None or hit[0] != stamp:
            with self._gz_lock:
                hit = self._gz.get(file)
                if hit is None or hit[0] != stamp:
                    hit = self._gz[file] = (stamp, gzip.compress(Path(file).read_bytes(), 9, mtime=0))
        return hit[1]

    async def get_response(self, path, scope):
        stamped = VENDOR_PATH.fullmatch(path.replace("\\", "/"))
        if stamped:
            path = f"vendor/{stamped.group('lib')}/{stamped.group('rest')}"
        response = await super().get_response(path, scope)
        if response.status_code in (200, 304):
            versioned = bool(stamped) or b"v=" in scope.get("query_string", b"")
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if versioned else "no-cache"
        if (response.status_code == 200 and isinstance(response, FileResponse)
                and str(response.path).endswith(COMPRESSIBLE)
                and b"gzip" in dict(scope["headers"]).get(b"accept-encoding", b"")):
            headers = {k: v for k, v in response.headers.items()
                       if k.lower() in ("cache-control", "etag", "last-modified")}
            body = self._compressed(str(response.path))
            # Already compressed: GZipMiddleware leaves it alone.
            return Response(body, media_type=response.media_type, headers={
                **headers, "Content-Encoding": "gzip", "Vary": "Accept-Encoding"})
        return response


# ---- safety layers (plain ASGI: no per-request overhead to speak of) ---------------------
class SecurityHeaders:
    """Headers every response gets: browsers must not guess content types, the
    app's address isn't passed on to other sites when a link is followed, no
    other site may frame it, and only it may ask for your location (the map's
    "where am I" button)."""

    HEADERS = [
        (b"x-content-type-options", b"nosniff"),
        (b"referrer-policy", b"same-origin"),
        (b"x-frame-options", b"DENY"),
        (b"cross-origin-opener-policy", b"same-origin"),
        (b"permissions-policy", b"geolocation=(self), camera=(), microphone=(), payment=(), usb=()"),
    ]

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", [])) + self.HEADERS
                if not any(k.lower() == b"content-security-policy" for k, _ in headers):
                    headers.append((b"content-security-policy", DEFAULT_CSP.encode()))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_with_headers)


class BodyLimit:
    """Refuse request bodies over `max_bytes`. The only thing a client ever
    sends is a few settings, so anything large is a mistake or an attack."""

    def __init__(self, app: ASGIApp, max_bytes: int = 64 * 1024):
        self.app = app
        self.max_bytes = max_bytes

    async def _too_large(self, send: Send) -> None:
        body = json.dumps({"detail": f"Request body too large (limit {self.max_bytes // 1024} KB)"}).encode()
        await send({"type": "http.response.start", "status": 413, "headers": [
            (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
            (b"connection", b"close")]})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            await self.app(scope, receive, send)
            return
        declared = dict(scope["headers"]).get(b"content-length", b"")
        if declared.isdigit() and int(declared) > self.max_bytes:
            await self._too_large(send)
            return
        seen = 0

        async def limited_receive() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    # No length was declared (chunked): stop reading. The route
                    # turns this into a 413 answer.
                    raise HTTPException(413, f"Request body too large (limit {self.max_bytes // 1024} KB)")
            return message

        await self.app(scope, limited_receive, send)



def _plain_response(status: int, detail: str, extra: list | None = None) -> tuple[dict, dict]:
    body = json.dumps({"detail": detail}).encode()
    start = {"type": "http.response.start", "status": status, "headers": [
        (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), *(extra or [])]}
    return start, {"type": "http.response.body", "body": body}


class HostCheck:
    """Refuse requests for host names the app isn't opened by.

    This is what stops DNS rebinding: a web page you visit pointing its own
    name at the server's address, so your browser treats the app as part of
    that site. Such requests carry the page's name, not yours.

    `allowed` empty: IP addresses, localhost and Tailscale (*.ts.net) names.
    Names listed: those (a leading "*." matches any subdomain) plus localhost.
    "*": anything.
    """

    LOCAL = ("localhost", "127.0.0.1", "::1")

    def __init__(self, app: ASGIApp, allowed: tuple[str, ...] = ()):
        self.app = app
        self.any = "*" in allowed
        self.names = {h for h in allowed if not h.startswith("*.")}
        self.suffixes = tuple(h[1:] for h in allowed if h.startswith("*."))
        self.default = not allowed

    @staticmethod
    def host_name(raw: str) -> str:
        raw = raw.strip().lower()
        if raw.startswith("["):  # [IPv6]:port
            return raw[1:raw.find("]")] if "]" in raw else raw
        return raw.rsplit(":", 1)[0] if raw.count(":") == 1 else raw

    def allows(self, host: str) -> bool:
        if self.any or host in self.LOCAL:
            return True
        if self.default:
            try:
                ipaddress.ip_address(host)
                return True
            except ValueError:
                return host.endswith(".ts.net")
        return host in self.names or host.endswith(self.suffixes)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket") or self.any:
            await self.app(scope, receive, send)
            return
        raw = dict(scope["headers"]).get(b"host", b"").decode("latin-1")
        if self.allows(self.host_name(raw)):
            await self.app(scope, receive, send)
            return
        start, body = _plain_response(400, "Unknown host name. Add the name you open the app by to ALLOWED_HOSTS.")
        await send(start)
        await send(body)


class AdminToken:
    """With ADMIN_TOKEN set, changing anything (PUT/POST/DELETE under /api/)
    needs the token in an X-Admin-Token header. Reading needs nothing."""

    def __init__(self, app: ASGIApp, token: str):
        self.app = app
        self.token = token.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS")
                or not scope["path"].startswith("/api/")):
            await self.app(scope, receive, send)
            return
        given = dict(scope["headers"]).get(b"x-admin-token", b"")
        if hmac.compare_digest(given, self.token):
            await self.app(scope, receive, send)
            return
        start, body = _plain_response(401, "This server needs its admin token to change settings.")
        await send(start)
        await send(body)


class ClientLimit:
    """Spam protection: each client (IP address) may make at most `per_minute`
    API requests a minute, in bursts of up to a fifth of that. Beyond it,
    requests are refused with 429 until the allowance refills.

    Ordinary use never gets near it: the app's page makes about 7 requests when
    it opens and 3 every 30 seconds after. It only stops something hitting the
    server over and over (a stuck script, a reload loop, a flood).

    Only /api/ and the map's fonts and icons count: map tiles and the app's
    files are cheap, and one map view asks for dozens of tiles at once.

    Behind a reverse proxy that this server doesn't trust for X-Forwarded-For,
    every device shares the proxy's address and so shares one allowance.
    """

    PREFIXES = ("/api/", "/map/assets/", "/openapi.json")
    FORGET_AFTER = 300  # seconds before an idle client's numbers are dropped

    def __init__(self, app: ASGIApp, per_minute: int = 600):
        self.app = app
        self.rate = per_minute / 60.0
        self.burst = max(1.0, per_minute / 5)
        self._clients: dict[str, list[float]] = {}  # ip -> [tokens left, last seen]
        self._checked = time.monotonic()

    def allow(self, key: str, now: float) -> bool:
        if now - self._checked > 60:  # forget clients that have gone quiet
            self._checked = now
            for k in [k for k, (_, seen) in self._clients.items() if now - seen > self.FORGET_AFTER]:
                del self._clients[k]
        c = self._clients.get(key)
        if c is None:
            c = self._clients[key] = [self.burst, now]
        c[0] = min(self.burst, c[0] + (now - c[1]) * self.rate)
        c[1] = now
        if c[0] < 1:
            return False
        c[0] -= 1
        return True

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (scope["type"] != "http" or not scope["path"].startswith(self.PREFIXES)
                or self.allow((scope.get("client") or ("unknown",))[0], time.monotonic())):
            await self.app(scope, receive, send)
            return
        start, body = _plain_response(429, "Too many requests. Slow down and try again in a moment.",
                                      [(b"retry-after", b"1")])
        await send(start)
        await send(body)
