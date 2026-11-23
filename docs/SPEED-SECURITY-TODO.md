# Speed and security: to-do

Reviewed 2026-11-23: everything in `app/`, the web app in `web/`, the Dockerfile, the entrypoint and CI. **Nothing here is done yet.** Within each section, items are ordered by value for the effort. I didn't measure the speed items. The order comes from how often each piece of code runs and how much work it does, so time `departures()` (or run `py-spy`) before and after a change to confirm. Tests at review time: 145 passed, 1 skipped.

---

## Security

The app is meant for a home network or Tailscale, with no login. These items keep it safe in that setting.

### Worth doing

- [ ] **Refuse unknown host names by default (DNS rebinding).**
  `app/main.py:103` only turns on the host check when `ALLOWED_HOSTS` is set. It's empty by default and listed as "advanced" in the Unraid template. With it empty, a web page you open at home can point its own domain at the server's LAN address and then use the API as if it were the app: change home/work (`PUT /api/settings`, `PUT /api/cta/settings`), download history CSVs, and use up the CTA daily request budget.
  *Fix:* when it's empty, accept only IP addresses, `localhost` and `*.ts.net`, plus any listed names. Make `ALLOWED_HOSTS=*` the explicit way to accept any name, and log a warning at startup when it's used. Move the setting to "always" in `unraid/next-stop.xml`. *Breaking change:* anyone who opens the app by a custom name (e.g. `nextstop.lan`) has to add that name, so call it out in the release notes.

- [ ] **Check URLs and colours from the feeds before they go into HTML.**
  The Content Security Policy stops scripts from running today, but these are the places where it's doing that job:
  - Alert links: `web/app.js:1789` puts Metra's and CTA's alert `url` into `href` with HTML-escaping only, so a `javascript:` URL would become a link. Allow only `http:` and `https:`, either on the server (`TrackerCore.alerts()`, `CtaTracker.alerts()`) or in the template.
  - Train marker colour: `web/map.js:493` writes `t.color` into a `style` attribute without escaping.
  - CTA run numbers: `tripId()` (`web/cta.js:44`) goes into `data-trip="…"` without escaping at `cta.js:222`, `226`, `255` and `433`. The `rn` value comes straight from Train Tracker.
  - On the server, normalise route colours to `#RRGGBB` when parsing (`static_gtfs.py` routes, `cta_schedule.py` lines), so every template can trust them.

- [ ] **Add `frame-ancestors 'none'` and a few cheap headers.**
  The CSP in `app/web.py:30` has no `frame-ancestors`, so another site can show the app in a frame and trick taps on its buttons (clickjacking). Add these to `SecurityHeaders.HEADERS` (`web.py:99`):
  - `Permissions-Policy: geolocation=(self), camera=(), microphone=()`
  - `Cross-Origin-Opener-Policy: same-origin`

  The CSP is only sent with `index.html`. Also send a strict one with API responses (`default-src 'none'; frame-ancestors 'none'`), and a CSP for `/api/docs`, whose inline script needs a hash.

- [ ] **Reject `inf` and `nan` in `/api/cta/planned?t=`.**
  `app/cta_api.py:135` accepts any float. `t=inf` or `t=nan` makes the JSON encoder fail and the request returns HTTP 500 (I checked this). Add `ge`/`le` bounds, e.g. now ± 2 days.

- [ ] **Hash-pin Python dependencies in the image.**
  The `Dockerfile` installs with `-c requirements-lock.txt`, which pins versions but not file hashes. Generate the lock with hashes (`pip-compile --generate-hashes` or `uv pip compile --generate-hashes`) and install with `--require-hashes`. Then a package replaced on PyPI can't get into the image.

- [ ] **Pin GitHub Actions to commit SHAs.**
  `.github/workflows/ci.yml` uses tags (`actions/checkout@v7`, `docker/build-push-action@v7`, …). A tag can be moved to different code, and the publish job holds `packages: write`. Dependabot keeps SHA pins up to date.

- [ ] **Scan for known vulnerabilities in CI.**
  Add `pip-audit -r requirements-lock.txt` to the `test` job and an image scan (Trivy or Grype) to the `image` job. Optionally set `provenance: true` and `sbom: true` on `docker/build-push-action`.

- [ ] **`chown -h` in the entrypoint.**
  `docker-entrypoint.sh` runs `find "$CONFIG" … -exec chown` as root. Without `-h`, `chown` follows symlinks. If something running as the app user put a symlink in `/config`, the next restart would hand the file it points to (e.g. the entrypoint itself) to the app user. That turns a compromised app into root in the container. Use `chown -h`, or limit `find` to `-type f -o -type d`.

- [ ] **Cap the Metra schedule download and both zip readers.**
  `app/tracker_core.py:182` reads the whole Metra schedule into memory with no size limit. CTA's download streams to disk with a 400 MB cap (`app/cta.py:49`); Metra's doesn't. Neither `parse_gtfs_zip` (`static_gtfs.py:304`) nor `parse_cta_zip` (`cta_schedule.py:170`) checks how big the files are once unpacked. The sources are HTTPS from Metra and CTA, so the risk is low, but a broken file or a wrong `*_STATIC_URL` could fill memory or disk.
  *Fix:* stream Metra's download the same way CTA's does, with a cap. Before parsing, reject a zip whose total `ZipInfo.file_size` is over about 1 GB.

### Lower priority

- [ ] **Optional write token.** Any device on the network can change the shared home/work settings. An optional `ADMIN_TOKEN`, required only for the `PUT` routes, would stop that if the app is ever shared more widely than your own devices.
- [ ] **Limits on expensive reads.** These accept up to 3650 days with no other limit: `/api/history/station?days=` (`history.py:186`), `/api/cta/history/station?days=` and the CSV exports. That's fine on a home network. If the app is ever reachable more widely, cap `days` at the retention period and add a small per-client rate limit.
- [ ] **Confirm redirects don't leak the Metra token.** The Metra client uses `follow_redirects=True` and sends `Authorization: Bearer …`. Upstream httpx drops that header when a redirect goes to another site. `httpx2` is a fork, so add a test that it does the same, or turn redirects off for the realtime feed.
- [ ] **Show less of each key in the startup log.** `util.mask` shows the last 4 characters. Showing only the length is enough to tell it's set.
- [ ] **TODO.md housekeeping.** "Run the container as a non-root user" is already done: the entrypoint switches to `PUID:PGID` with `--no-new-privs`, and CI checks it. Tick it off.

### Already in good shape (checked)

- Pickled schedule caches are read with an allow-list unpickler, so a tampered file can't run code.
- The Train Tracker key is removed from logs and error messages.
- Inline scripts are blocked by the CSP (hash-only `script-src`).
- Request bodies are capped at 64 KB.
- Map asset paths are checked against a strict pattern, so there's no path traversal.
- SQL uses parameters. The f-string parts are constants.
- The container drops root with `setpriv --no-new-privs`, and the base image is pinned by digest.
- External links use `rel="noopener noreferrer"`.

---

## Speed

### Worth doing

- [ ] **Stop counting the whole history table every few minutes.**
  The app asks for `/api/status` every 60 s (`web/app.js:1996`). That calls `history.stats()` (`tracker_core.py:617` → `history.py:218`), which runs `SELECT COUNT(*), MIN(scheduled)` over up to a year of rows. It's cached for 5 minutes, so it runs about every 5 minutes while anyone has the app open. It also holds the same lock the 30-second recorder needs.
  *Fix:* leave the count out of `/api/status` (only the About panel shows it), or keep a running count that's updated on insert and prune. `MIN(scheduled)` on its own is a quick index lookup.

- [ ] **Give reads their own SQLite connection.**
  `SqliteStore._query` (`sqlite_store.py:66`) runs every read on the writer's connection while holding the write lock. So a slow read (board stats, `/history/station`, status) holds up recording, and recording holds up reads. WAL mode already lets readers run alongside the writer. Keep one read-only connection for `_query`; the `_read_only()` helper already exists for exports.

- [ ] **Don't scan 36 hours of departures to show 5 trains.**
  `_iter_departures` (`tracker_boards.py:24`, window at line 33) goes through every departure from 4 h ago to 36 h ahead at each of the station's stops, for each of 3 service dates. It works out a prediction for every one, and with a Going-to station an arrival too. `departures()` then sorts them all and keeps `limit`. This is the busiest code path: every open board every 30 s, plus `/api/next`, `/api/commute` and `/api/home`, `/api/work`, `/api/now`.
  *Fix:* start with a short window (e.g. 3 h) and widen it only if fewer than `limit` trains come back. Or stop once there are `limit` candidates and the scheduled time is past the latest one kept, plus a margin.
  Also pass `until` into `_iter_departures`. Today the Timetable (`timetable()` → `departures(limit=500, until=…)`, line 91) only drops trains after 3 AM after building them (line 182).

- [ ] **Move realtime processing off the event loop.**
  In `refresh_realtime` (`tracker_core.py:254`), only protobuf decoding runs in a thread. Several steps run on the event loop every 30 s:
  - `parse_positions`, `parse_trip_updates` and `parse_alerts`
  - `_reindex_realtime` and `_gps_estimates`
  - `_observation_rows`, which covers every stop of every live trip

  While they run, every request waits, including all the CTA routes. Build the new state in `asyncio.to_thread` and swap it in at the end. That also closes the short window where `rt.trip_updates` is new but `_rt_by_trip` is still old.

- [ ] **Work out a trip's predictions in one pass.**
  `_predict` (`tracker_core.py`) goes through all of a trip's stop updates for each stop it's asked about. `_observation_rows`, `trip_detail`, `line_trains` and `_next_stop_delay` ask stop by stop, so the work grows with stops × updates. Stops and updates are both in sequence order, so a `_predict_trip(trip_id, base)` that walks them together once gives every stop's prediction in linear time. Reuse the result until the next poll.

- [ ] **Faster web server packages.**
  `requirements.txt` has plain `uvicorn`, which uses a pure-Python HTTP parser and the standard asyncio loop. `uvicorn[standard]` adds `uvloop` and `httptools`, which noticeably speed up lots of small JSON requests with no code changes. Optionally, use `orjson` in `json_response` (`util.py`), which turns the big changing answers (timetable, line, trains) into JSON several times faster. *Check first* that both have wheels for Python 3.15.

- [ ] **Cache answers that only change with the schedule.**
  - `/api/schedule` (`line_schedule`, `tracker_boards.py:557`) rebuilds a line's whole timetable on every request and sends it as `no-store`. It only depends on route, direction, day type, date and schedule version, so build it once into a `StaticJson` with an ETag, like `/api/stations`.
  - `line_schedule` and `line_trains` (line 612) go through every trip in the schedule to find one line's trips. Index trips by route once per schedule (`_once`).
  - CTA `timetable()` (`cta.py:489`) rebuilds and re-sorts every departure for the station on each call, and `timetable_live` builds on top of it. The schedule part only depends on station, `to` and service date: cache it and only re-filter by the current time.

- [ ] **Speed up CTA history queries.**
  - `run_today` (`cta_history.py:238`) filters a whole service day (about 47,000 rows) by run number using the time index. It runs every time a CTA train sheet opens or refreshes (every 30 s). Add an index on `(run, t)`, or only look back a few hours.
  - `board_stats` loads 30 days of a station's rows into Python and filters them by hour and day type there (`_station_rows`, line 169). Busy stations return tens of thousands of rows. The result is cached for 10 minutes, but a daily summary table would make this and `/api/cta/history/station` near-instant. That's the same work as TODO.md's "Shrink old history" idea.

### Smaller wins

- [ ] `find_station` (`tracker_stations.py:128`) normalises every station name with a regex on every `/api/next` and `/api/commute` call. Build the normalised-name lookup once per schedule (`_once`).
- [ ] `record_alerts` (`history.py:134`) writes each alert in its own transaction. Use `_write_many` so each poll's alerts are saved in one commit.
- [ ] The history database never shrinks: pruning deletes rows but the file stays the same size. Turn on `auto_vacuum=INCREMENTAL` (a one-time `VACUUM` switches it on) and run `PRAGMA incremental_vacuum` after each prune. Run `PRAGMA optimize` now and then to keep query planning good.
- [ ] `StaticData.tz` (`static_gtfs.py:140`) looks up the `ZoneInfo` on every call, and `service_day_start` calls it constantly. Look it up once and keep it.
- [ ] **Precompress static files.** `GZipMiddleware` compresses the 1.1 MB map library and its 550 KB worker again on every full (non-304) download. Build `.gz` and `.br` copies in the Dockerfile and serve those directly. Brotli also makes JavaScript about 20% smaller than gzip does.
- [ ] `web/vendor/maplibre/global.mjs` imports `maplibre-gl.mjs` without a `?v=` version, so the map library and its worker get a 304 check on every open instead of being cached for good. Version that import too (`IndexPage` could rewrite it), or cache `vendor/` for a long time, since each library has a `VERSION` file.
- [ ] On phones, load the map library only when the Map tab is first opened. Most opens are for the board.
- [ ] Metra's `_read_csv` (`static_gtfs.py`) loads every `stop_times` row into a list of dicts before using any. Reading row by row, as the CTA parser does, lowers peak memory during a schedule update.
- [ ] `_snap_to_shape` (`tracker_map.py:93`) checks every point of the line's shape for each train. That's fine today because the train list is cached for 10 s. If shapes get more detailed, remember each train's last segment and search near it.
- [ ] `BaseMap._open` checks the map file's timestamp on every tile request. Checking at most once a second would save a system call per tile.
- [ ] (Already in TODO.md "Ideas") A service worker for an instant, offline start.
