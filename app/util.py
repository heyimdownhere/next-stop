"""Small helpers shared by every part of the server.

One copy of the things each transit system needs: safe file writes, reading
a secret from the environment, short-lived caches, reading a cached schedule
without running code from it, and JSON/CSV responses.
"""

from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import logging
import os
import pickle
import re
import threading
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable

import orjson
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

USER_AGENT = "next-stop/1.0 (self-hosted)"
NO_STORE = {"Cache-Control": "no-store"}
_MISSING = object()


# ---- files -------------------------------------------------------------------------
def atomic_write(path: Path, content: bytes) -> None:
    """Write a file so a crash never leaves it half-written."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(content)
    os.replace(tmp, path)


def read_secret(name: str, warnings: list[str], fallback: str) -> str | None:
    """NAME, or the contents of the file named by NAME_FILE (for Docker/compose
    secrets). The variable wins if both are set. `fallback` says what happens
    without it, for the warning."""
    value = os.environ.get(name, "").strip()
    if value:
        return value
    path = os.environ.get(f"{name}_FILE", "").strip()
    if not path:
        return None
    try:
        return Path(path).read_text().strip() or None
    except OSError as exc:
        warnings.append(f"{name}_FILE={path!r} could not be read ({exc}); {fallback}")
        return None


def mask(secret: str | None, unset: str) -> str:
    """How a secret is shown in the startup log: never the value itself."""
    if not secret:
        return unset
    return f"set ({len(secret)} chars)"


# ---- values from outside feeds that end up in the page ------------------------------
_HEX_COLOR = re.compile(r"#?([0-9A-Fa-f]{6})")


def hex_color(value: str | None, default: str) -> str:
    """A colour from a schedule as '#RRGGBB', or `default` if it isn't one.
    Colours go into style attributes in the page, so nothing else gets through."""
    m = _HEX_COLOR.fullmatch((value or "").strip())
    return "#" + m.group(1).upper() if m else default


def safe_url(value: str | None) -> str | None:
    """An http(s) link from a transit agency, or None. Keeps javascript: and
    other schemes out of the page's links."""
    v = (value or "").strip()
    return v if re.match(r"https?://", v, re.IGNORECASE) else None


# Unpacked size a schedule zip may have. CTA's whole feed (buses included) is
# well under 1 GB; anything bigger is a broken or hostile file.
MAX_UNZIPPED = 1024 * 1024 * 1024


def check_zip_size(zf, limit: int = MAX_UNZIPPED) -> None:
    """Refuse a zip that would unpack to more than `limit` bytes (a zip bomb)."""
    total = sum(i.file_size for i in zf.infolist())
    if total > limit:
        raise ValueError(f"it would unpack to {total >> 20} MB (limit {limit >> 20} MB)")


class _AllowListUnpickler(pickle.Unpickler):
    def __init__(self, file, allowed: frozenset[tuple[str, str]]):
        super().__init__(file)
        self._allowed = allowed

    def find_class(self, module: str, name: str):
        if (module, name) not in self._allowed:
            raise pickle.UnpicklingError(f"{module}.{name} is not allowed in a schedule cache")
        return super().find_class(module, name)


# What a cached schedule is made of besides plain lists, dicts, strings and numbers.
_PLAIN = frozenset({("datetime", "date"), ("builtins", "frozenset"), ("builtins", "set")})


def load_cache_file(path: Path, classes: Iterable[type], extra: set[tuple[str, str]] | None = None) -> Any:
    """Read a schedule cache written by this app.

    Only the given classes (plus dates and sets) may be created while reading,
    so a tampered file in /config can't make the server run code.
    """
    allowed = _PLAIN | {(c.__module__, c.__qualname__) for c in classes} | (extra or set())
    with path.open("rb") as fh:
        return _AllowListUnpickler(fh, frozenset(allowed)).load()


# ---- caches ------------------------------------------------------------------------
class TTLCache:
    """Values that are reused for `ttl` seconds. Old entries are dropped once
    there are more than `max_items`."""

    def __init__(self, ttl: float, max_items: int = 512):
        self.ttl = ttl
        self.max_items = max_items
        self._items: dict[Any, tuple[float, Any]] = {}

    def get(self, key: Any, default: Any = None) -> Any:
        hit = self._items.get(key)
        if hit is None or time.monotonic() >= hit[0]:
            return default
        return hit[1]

    def put(self, key: Any, value: Any, ttl: float | None = None) -> Any:
        now = time.monotonic()
        self._items[key] = (now + (self.ttl if ttl is None else ttl), value)
        if len(self._items) > self.max_items:
            for k, (expires, _) in list(self._items.items()):
                if expires <= now:
                    self._items.pop(k, None)
        return value

    def clear(self) -> None:
        self._items.clear()

    def __len__(self) -> int:
        return len(self._items)


class SingleFlight:
    """Async cache for calls to someone else's server.

    For each key only one request runs at a time (others wait for its answer),
    answers are reused for `ttl` seconds, and a failure is remembered for
    `fail_ttl` seconds so a server that is down is asked once, not by every
    caller. Nothing is kept per key once its entry has expired.
    """

    def __init__(self, fail_ttl: float = 30.0, max_items: int = 500,
                 failures: tuple[type[BaseException], ...] = (Exception,),
                 forget: tuple[type[BaseException], ...] = ()):
        self.fail_ttl = fail_ttl
        self.failures = failures
        self.forget = forget  # failures that are passed on but not remembered
        self._items = TTLCache(0, max_items)
        self._flights: dict[str, asyncio.Future] = {}

    async def get(self, key: str, ttl: float, fetch: Callable[[], Awaitable[Any]]) -> Any:
        hit = self._items.get(key, _MISSING)
        if hit is not _MISSING:
            ok, value = hit
            if ok:
                return value
            raise value
        flight = self._flights.get(key)
        if flight is None:
            flight = self._flights[key] = asyncio.ensure_future(self._run(key, ttl, fetch))
            # If every waiter goes away, don't warn about an unread error.
            flight.add_done_callback(lambda f: f.cancelled() or f.exception())
        return await asyncio.shield(flight)

    async def _run(self, key: str, ttl: float, fetch: Callable[[], Awaitable[Any]]) -> Any:
        try:
            value = await fetch()
        except self.failures as exc:
            if not isinstance(exc, self.forget):
                self._items.put(key, (False, exc), self.fail_ttl)
            raise
        else:
            self._items.put(key, (True, value), ttl)
            return value
        finally:
            self._flights.pop(key, None)

    def clear(self) -> None:
        self._items.clear()

    def __len__(self) -> int:
        return len(self._items)


# ---- logging -----------------------------------------------------------------------
class RedactSecrets(logging.Filter):
    """Blank API keys out of log lines.

    CTA's Train Tracker takes the key in the address (?key=...), and HTTP
    libraries log addresses. Attached to the log handlers, so it covers every
    logger, whatever wrote the line.
    """

    PATTERN = re.compile(r"([?&]key=)[^&\s\"']+")

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if "key=" in msg:
            record.msg, record.args = self.PATTERN.sub(r"\1***", msg), ()
        return True


def install_redaction() -> None:
    """Put the filter on every handler in use now (ours and uvicorn's)."""
    names = ["", "uvicorn", "uvicorn.error", "uvicorn.access", "httpx2", "httpcore2"]
    for name in names:
        logger = logging.getLogger(name)
        for target in (logger, *logger.handlers):
            if not any(isinstance(f, RedactSecrets) for f in target.filters):
                target.addFilter(RedactSecrets())


# ---- responses ---------------------------------------------------------------------
class FastJSONResponse(JSONResponse):
    """JSONResponse written with orjson: several times faster for the big
    answers (timetables, a line's trains, every train on the map). Keys that
    aren't strings are turned into strings, as the standard library does."""

    def render(self, content: Any) -> bytes:
        return orjson.dumps(content, option=orjson.OPT_NON_STR_KEYS)


def json_response(data: Any, status: int = 200, headers: dict | None = None) -> JSONResponse:
    """JSON that browsers don't keep (live data), unless other headers are given."""
    return FastJSONResponse(data, status_code=status, headers=headers or NO_STORE)


class StaticJson:
    """A JSON answer that only changes when the schedule does.

    It is turned into bytes once. Browsers keep it and ask "still the same?"
    with its ETag; the answer is then an empty 304 instead of the whole body.
    """

    def __init__(self, data: Any, headers: dict | None = None):
        self.body = orjson.dumps(data, option=orjson.OPT_NON_STR_KEYS)
        self.etag = 'W/"' + hashlib.sha1(self.body).hexdigest()[:20] + '"'
        self.headers = {"Cache-Control": "no-cache", "ETag": self.etag, **(headers or {})}

    def response(self, request: Request) -> Response:
        asked = request.headers.get("if-none-match", "")
        if self.etag in [t.strip() for t in asked.split(",")]:
            return Response(status_code=304, headers=self.headers)
        return Response(self.body, media_type="application/json", headers=self.headers)


# CSV exports read a lot of rows: at most this many run at once.
EXPORT_SLOTS = threading.BoundedSemaphore(2)


class _Slot:
    """One export's place, given back once (when the download ends, or when
    it's dropped without ever starting)."""

    def __init__(self, sem: threading.BoundedSemaphore):
        self.sem, self.held = sem, True

    def release(self) -> None:
        if self.held:
            self.held = False
            self.sem.release()

    __del__ = release


def csv_response(filename: str, columns: list[str], rows: Iterable[dict],
                 headers: dict | None = None,
                 slots: threading.BoundedSemaphore | None = EXPORT_SLOTS) -> StreamingResponse:
    """Stream rows as a CSV download, a chunk at a time. Refused (429) while
    the other export slots are in use."""
    if slots is not None and not slots.acquire(blocking=False):
        raise HTTPException(429, "Other exports are running. Try again when they finish.")
    slot = _Slot(slots) if slots is not None else None

    def gen():
        try:
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(columns)
            for row in rows:
                w.writerow([row[c] for c in columns])
                if buf.tell() > 65536:
                    yield buf.getvalue()
                    buf.seek(0)
                    buf.truncate()
            yield buf.getvalue()
        finally:
            if slot is not None:
                slot.release()

    return StreamingResponse(gen(), media_type="text/csv", headers={
        "Content-Disposition": f'attachment; filename="{filename}"', **NO_STORE, **(headers or {})})
