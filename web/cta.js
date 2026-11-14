/* CTA 'L' side of Next Stop: shown when the Metra | CTA switch is on CTA.
 *
 * Kept apart from Metra: CTA station ids, its own home/work (saved on the
 * server in cta-settings.json) and its own choices on this device (cta.*).
 * It shares the page with app.js: the same tabs, board, map and train sheet.
 * app.js calls CTA.init(host) with the helpers it shares, and checks
 * CTA.active() to stand aside while CTA is showing.
 */
(function () {
  "use strict";
  const KEY = { system: "next.system", station: "cta.station", dest: "cta.dest" };
  const st = {
    active: localStorage.getItem(KEY.system) === "cta",
    loaded: false,
    stations: [], byId: new Map(), lines: [], geo: null,
    station: localStorage.getItem(KEY.station), dest: localStorage.getItem(KEY.dest),
    profile: {}, board: null, timetable: null, trains: null, alerts: [],
    timers: [],
  };
  let host = null;
  const $ = (id) => document.getElementById(id);

  // ---------- small helpers ----------
  const esc = (s) => host.esc(s);
  const lineOf = (rid) => st.lines.find((l) => l.id === rid) || { id: rid, short_name: rid, color: "#565a5c", text_color: "#fff" };
  const chipFor = (rid) => { const l = lineOf(rid); return host.chip(l.short_name, l.color, l.text_color); };
  const minsText = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ""}`);
  function untilHtml(x, now) {
    const m = Math.max(0, Math.round((x.time - now) / 60));
    if (x.due || m === 0) return "<b>Due</b>";
    return m < 60 ? `<b>${m}</b><small>min</small>` : `<b>${Math.floor(m / 60)}</b><small>hr${m % 60 ? ` ${m % 60}m` : ""}</small>`;
  }
  const badge = (x) => (x.delayed ? '<span class="badge cancel" title="CTA says this train is delayed">Delayed</span>'
    : x.live ? '<span class="badge live">Live</span>' : '<span class="badge sched">Scheduled</span>');
  const dayWord = { weekday: "weekdays", saturday: "Saturdays", sunday: "Sundays" };
  function historyHtml(h) {
    if (!h) return "";
    const parts = [`<b>${h.on_time_pct}% on time</b>`, `every ${h.avg_gap_min} min (scheduled ${h.sched_gap_min})`];
    if (h.long_waits) parts.push(`longest wait ${h.longest_wait_min} min`);
    if (h.delays_7d) parts.push(`${h.delays_7d} delay${h.delays_7d === 1 ? "" : "s"} this week`);
    const title = `Last ${h.days} days, ${dayWord[h.day_type] || h.day_type} around this time. On time = no wait more than twice the scheduled gap.`;
    return `<div class="cta-hist" title="${esc(title)}">${parts.join(" · ")}</div>`;
  }
  const tripId = (run) => `cta:${run}`;

  // CTA names stations like "Belmont (Red/Brown/Purple)". Show "Belmont" with
  // coloured dots for its lines instead; keep any words that aren't line names
  // ("Harlem (O'Hare Branch)", "Lake (Subway)") since the dots can't tell those apart.
  const LINE_WORDS = new Set(["red", "blue", "brown", "green", "orange", "purple", "pink", "yellow"]);
  function cleanName(name) {
    const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(name || "");
    if (!m) return name || "";
    const rest = m[2].split(/\/| - /).map((x) => x.trim()).filter((x) => x && !LINE_WORDS.has(x.toLowerCase()));
    return rest.length ? `${m[1]} (${rest.join(", ")})` : m[1];
  }
  const nameOf = (id, fallback) => { const s = st.byId.get(id); return s ? s.display : cleanName(fallback || id); };
  function dotsHtml(routes) {
    if (!routes || !routes.length) return "";
    const names = routes.map((r) => lineOf(r).short_name);
    return `<span class="cta-dots" role="img" aria-label="${esc(names.join(", "))} Line${names.length > 1 ? "s" : ""}" title="${esc(names.join(", "))}">${routes.map((r) => `<i style="background:${esc(lineOf(r).color)}"></i>`).join("")}</span>`;
  }
  const stationHtml = (s) => `${esc(s.display)}${dotsHtml(s.routes)}`;

  // ---------- data ----------
  async function load() {
    if (st.loaded) return true;
    try {
      const [stations, lines, profile] = await Promise.all([
        host.api("/api/cta/stations"), host.api("/api/cta/lines"), host.api("/api/cta/settings")]);
      st.stations = stations.map((x) => ({ ...x, display: cleanName(x.name) }));
      st.byId = new Map(st.stations.map((s) => [s.id, s]));
      st.lines = lines.lines;
      st.geo = lines.geojson;
      st.profile = profile;
      st.loaded = true;
    } catch (e) {
      console.warn(e);
      host.showEmpty("CTA isn't available yet: the server is still downloading CTA's schedule, or CTA is turned off.");
      return false;
    }
    if (st.station && !st.byId.has(st.station)) st.station = null;
    if (st.dest && !st.byId.has(st.dest)) st.dest = null;
    const leg = st.profile.leg;
    if (leg && st.byId.has(leg.from) && !sessionStorage.getItem("cta.opened")) {
      // Opens on the commute leg for right now, like the Metra side.
      st.station = leg.from;
      st.dest = leg.to || null;
    }
    sessionStorage.setItem("cta.opened", "1");
    return true;
  }

  async function refreshBoard() {
    if (!st.active || !st.station) { st.board = null; return; }
    const id = st.station;
    const q = `station=${encodeURIComponent(id)}${st.dest ? `&to=${encodeURIComponent(st.dest)}` : ""}&limit=4`;
    try {
      const d = await host.api(`/api/cta/arrivals?${q}`);
      if (id === st.station) st.board = d;
    } catch (e) { console.warn(e); }
  }
  async function refreshTimetable() {
    if (st.active && st.ttLine) return refreshLine();
    if (!st.active || !st.station) { st.timetable = null; return; }
    const id = st.station, q = `station=${encodeURIComponent(id)}${st.dest ? `&to=${encodeURIComponent(st.dest)}` : ""}`;
    try {
      const d = await host.api(`/api/cta/timetable?${q}`);
      if (id === st.station) st.timetable = d;
    } catch (e) { console.warn(e); }
  }
  async function refreshTrains() {
    if (!st.active || host.tab() === "timetable") return;
    let d;
    try { d = await host.api("/api/cta/trains"); } catch (e) { console.warn(e); return; }
    st.trains = d;
    const focus = host.mapView.lineFocus;
    // Only trains going on to "Going to", when one is picked.
    const reach = st.board && st.dest ? new Set(st.board.groups.map((g) => g.route_id)) : null;
    const list = d.trains.filter((t) => !reach || reach.has(t.route_id)).map((t) => ({
      ...t, system: "cta", id: tripId(t.run), trip_id: tripId(t.run), train: t.run,
      live: true, delay: t.delayed ? 360 : 0, next_stop: nameOf(t.next_station_id, t.next_station),
    }));
    host.mapView.updateTrains({ trains: list });
    const n = focus ? list.filter((t) => t.route_id === focus).length : list.length;
    const note = $("map-note");
    note.textContent = d.source === "live"
      ? `${n} ${focus ? `${lineOf(focus).short_name} ` : ""}train${n === 1 ? "" : "s"} · live from CTA`
      : "No live CTA trains (add CTA_TRAIN_TRACKER_KEY on the server)";
    note.hidden = false;
    $("map-data").textContent = "Data provided by CTA. Not affiliated with or endorsed by CTA.";
    setAttribution(true);
    $("map-data").hidden = false;
  }
  async function refreshAlerts() {
    try { st.alerts = await host.api("/api/cta/alerts"); } catch (e) { console.warn(e); return; }
    host.setAlerts(alertsForBell());
  }
  // In the shape the bell and banner already use for Metra.
  function alertsForBell() {
    return st.alerts.map((a) => ({
      id: `cta-${a.id}`, header: a.headline, description: a.description, url: a.url,
      schedule_change: a.major || /reroute|no service|suspend|single-track|bus shuttle/i.test(`${a.impact} ${a.headline}`),
      routes: a.routes.map((r) => { const l = lineOf(r); return { id: l.id, short_name: l.short_name, color: l.color, text_color: l.text_color }; }),
      stations: a.stations,
    }));
  }

  // ---------- rendering ----------
  function renderTitle() {
    const from = st.byId.get(st.station), to = st.byId.get(st.dest);
    $("board-title").innerHTML = from
      ? `${stationHtml(from)}${to ? ` <span class="arrow">→</span> ${stationHtml(to)}` : ""}`
      : "Choose a CTA station";
    $("board-swap").hidden = !(from && to);
    $("clear-btn").hidden = !(st.station || st.dest);
    const p = st.profile;
    const tag = from && to && st.station === p.home_station && st.dest === p.work_station ? "TO WORK"
      : from && to && st.station === p.work_station && st.dest === p.home_station ? "TO HOME"
      : st.station && st.station === p.home_station && !st.dest ? "HOME" : "";
    $("board-tag").hidden = !tag;
    $("board-tag").textContent = tag;
    const goHome = $("go-home-btn"), goWork = $("go-work-btn");
    $("go-home-text").textContent = p.home_station ? "Home" : "Set home";
    $("go-work-text").textContent = p.work_station ? "Work" : "Set work";
    goHome.classList.toggle("is-on", tag === "TO HOME" || tag === "HOME");
    goWork.classList.toggle("is-on", tag === "TO WORK");
    $("cta-home-btn-text").textContent = p.home_station ? "Home" : "Set as home";
    $("cta-work-btn-text").textContent = p.work_station ? "Work" : "Set as work";
  }

  // The status pill at the top: CTA's live data, not Metra's.
  function updatePill() {
    const pill = $("mode-pill");
    // Whichever the open tab last loaded: the board, the timetable, or the map's trains.
    const shown = host.tab() === "timetable" ? st.timetable : st.board;
    const src = (shown && shown.source) || (st.trains && st.trains.source);
    const error = shown && shown.error;
    pill.classList.remove("live", "warn");
    if (src === "live") { pill.textContent = "Live"; pill.classList.add("live"); pill.title = "Live from CTA Train Tracker"; }
    else if (src) {
      pill.textContent = "Schedule only";
      pill.title = error ? `CTA live data unavailable: ${error}` : "No CTA key on the server; showing the schedule.";
      if (error) pill.classList.add("warn");
    } else { pill.textContent = "CTA"; pill.title = ""; }
  }

  function renderBoard() {
    if (!st.active) return;
    updatePill();
    renderTitle();
    const d = st.board, list = $("board-list");
    const now = host.serverNow();
    const upd = $("board-updated");
    if (!st.station) {
      list.innerHTML = "";
      host.showEmpty("Pick a CTA station (or tap one on the map).");
      upd.textContent = "";
      return;
    }
    if (!d) { list.innerHTML = ""; host.showEmpty("Loading…"); return; }
    host.showEmpty(d.groups.length ? "" : st.dest ? "No direct trains to that station soon." : "No trains in the next few hours.");
    upd.textContent = d.source === "live" ? `CTA · ${host.fmtTime(d.as_of)}` : "CTA schedule";
    const sel = host.selectedTrip();
    list.innerHTML = d.groups.map((g) => {
      const x = g.trains[0];
      const arrives = (t) => (t.arrives ? ` · arrives ${esc(host.fmtTime(t.arrives))}` : "");
      const later = g.trains.slice(1).map((t) => `<button type="button" class="lc-pill${t.delayed ? " late" : ""}${sel === tripId(t.run) ? " selected" : ""}"${t.run ? ` data-trip="${tripId(t.run)}" data-route="${esc(g.route_id)}"` : ""}><b>${Math.max(0, Math.round((t.time - now) / 60))} min</b> · ${esc(host.fmtTime(t.time))}${g.destinations.length > 1 ? ` · ${esc(t.destination)}` : ""}</button>`).join("");
      const dest = g.destinations.length > 1 ? x.destination : g.label;
      return `<li class="lc cta-lc${sel && sel === tripId(x.run) ? " selected" : ""}" style="--line:${esc(g.color)}">
        <div class="lc-top">${host.chip(g.route_short, g.color, g.text_color)}<span class="lc-name">${esc(g.route_name)}</span><span class="lc-dir">${esc(g.platform || "")}</span></div>
        <button type="button" class="lc-next"${x.run ? ` data-trip="${tripId(x.run)}" data-route="${esc(g.route_id)}"` : ""} title="Show this train on the map">
          <span class="lc-time">${host.bigTime(x.time)}</span>
          <span class="lc-main"><span class="lc-dest">${esc(dest)}</span>
            <span class="lc-status">${badge(x)}${x.run ? ` <span class="muted">#${esc(x.run)}</span>` : ""}${arrives(x)}</span></span>
          <span class="lc-in">${untilHtml(x, now)}</span>
        </button>
        ${later ? `<div class="lc-later"><span class="muted">Then</span>${later}</div>` : ""}
        ${historyHtml(g.history)}
      </li>`;
    }).join("");
    const dl = $("data-line");
    dl.hidden = false;
    dl.textContent = d.source === "live" ? d.credit
      : `${d.error ? "Live CTA data unavailable, showing the schedule. " : "CTA schedule (no live data). "}${d.credit}`;
  }

  // Timetable tab: every train still to come today, laid out like Metra's (direction
  // switch, one row per train). The next few trains of each line have live times.
  st.ttDir = null;
  function defaultDir() {
    const p = st.profile || {};
    const hm = new Date(host.serverNow() * 1000).toTimeString().slice(0, 5);
    if (st.station && st.station === p.work_station) return "outbound";
    return hm < (p.switch_time || "12:00") ? "inbound" : "outbound";
  }
  // The line chips above the timetable, like Metra's: "Station" (that station's trains)
  // or a line (its own page: trains on the way now, then still to start today).
  st.ttLine = null;
  st.lineDir = null;
  st.lineData = null;
  function renderTtHead() {
    const chip = (id, label, color) => `<button type="button" class="line-chip${st.ttLine === id ? " on" : ""}" data-route="${esc(id || "")}" role="tab" aria-selected="${st.ttLine === id}">${color ? `<i style="background:${esc(color)}"></i>` : ""}${esc(label)}</button>`;
    $("tt-line-pin").innerHTML = chip(null, "📍 Station", null);
    $("tt-line-chips").innerHTML = st.lines.map((l) => chip(l.id, l.short_name, l.color)).join("");
    const on = $("tt-line-chips").querySelector(".line-chip.on");
    if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function setTtLine(rid) {
    if ((rid || null) === st.ttLine) return;
    st.ttLine = rid || null;
    st.lineData = null;
    renderTtHead();
    render();
    if (st.ttLine) refreshLine().then(render);
  }
  // In a line's page the station boxes and board title go away, as on Metra.
  function syncLineMode() {
    document.body.classList.toggle("cta-line-mode", !!(st.active && st.ttLine && host.tab() === "timetable"));
  }
  async function refreshLine() {
    const rid = st.ttLine;
    if (!rid) return;
    const dir = st.lineDir ? `&direction=${encodeURIComponent(st.lineDir)}` : "";
    try {
      const d = await host.api(`/api/cta/line?route=${encodeURIComponent(rid)}${dir}`);
      if (rid === st.ttLine) { st.lineData = d; st.lineDir = d.direction; }
    } catch (e) { console.warn(e); }
  }
  // Like Metra's "How far along" bar: time since the train started over its whole run.
  function renderLine() {
    const tt = $("tt"), d = st.lineData, now = host.serverNow();
    const l = lineOf(st.ttLine);
    renderTtHead();
    $("board-updated").textContent = d && d.source === "live" ? `CTA ${host.fmtDateTime(d.as_of)}` : "CTA schedule";
    if (!d) { tt.innerHTML = ""; host.showEmpty("Loading…"); return; }
    host.showEmpty("");
    const running = d.trains.filter((t) => t.running);
    const later = d.trains.filter((t) => !t.running);
    const counts = [running.length ? `${running.length} on the way` : "", later.length ? `${later.length} more today` : ""]
      .filter(Boolean).join(" · ") || "No more trains today";
    const html = [`<div class="lt-hero" style="--line:${esc(l.color)}">
        <div class="lt-name">${host.chip(l.short_name, l.color, l.text_color)}<b>${esc(d.route_name || l.name || "")}</b></div>
        <div class="lt-sub">${esc(counts)}${d.as_of ? ` · <span title="When CTA last updated this data">CTA data ${esc(host.fmtDateTime(d.as_of))}</span>` : ""}</div>
      </div>
      <div class="lt-dir" role="group" aria-label="Direction">${d.directions.map((x) =>
        `<button type="button" data-cta-ldir="${esc(x.id)}" aria-pressed="${x.id === d.direction}">${esc(x.label)}</button>`).join("")}</div>`];
    const label = (d.directions.find((x) => x.id === d.direction) || {}).label || "";
    if (!d.trains.length) {
      html.push(`<p class="muted tt-none">No more ${esc(l.short_name)} Line trains ${esc(label.toLowerCase())} today.</p>`);
      tt.innerHTML = html.join("");
      return;
    }
    // CTA doesn't say how late a train is: Live (green) or Delayed (red), where Metra says "3 min late".
    const status = (t) => (t.delayed ? '<span class="delay late" title="CTA says this train is delayed">Delayed</span>'
      : t.live ? '<span class="delay ontime" title="Live from CTA Train Tracker">Live</span>' : '<span class="tt-sched">Scheduled</span>');
    const sel = host.selectedTrip();
    if (running.length) {
      html.push('<h3 class="lt-head"><span class="lt-live"></span>On the way now</h3><div class="lt-cards">');
      for (const t of running) {
        const span = Math.max(60, t.dest_time - t.origin_time);
        const pct = Math.max(3, Math.min(97, ((now - t.origin_time) / span) * 100));
        html.push(`<div class="lt-card${sel === t.trip_id ? " selected" : ""}" data-trip="${esc(t.trip_id)}" data-route="${esc(st.ttLine)}">
          <div class="lt-card-top"><b>#${esc(t.train)} to ${esc(t.destination || "")}</b>${status(t)}</div>
          <div class="lt-bar ${t.delayed ? "late" : "ontime"}"><span style="width:${pct.toFixed(1)}%"></span></div>
          <div class="lt-card-foot">
            <span class="muted">${esc(t.origin === "Loop" ? "Loop" : nameOf(t.origin_id, t.origin))} ${esc(host.fmtTime(t.origin_time))}</span>
            ${t.next_stop ? `<span class="lt-next"><span class="muted">Next</span> <b>${esc(nameOf(t.next_id, t.next_stop))}</b></span>` : ""}
            <b class="lt-arr" title="Arrives ${esc(t.destination || "")}">${esc(host.fmtTime(t.dest_time))}</b>
          </div>
        </div>`);
      }
      html.push("</div>");
    }
    if (later.length) {
      html.push(`<h3 class="lt-head">${running.length ? "Later today" : "Still to come today"}</h3><ol class="lt-list">`);
      for (const t of later) {
        const m = Math.round((t.origin_time - now) / 60);
        const from = t.origin === "Loop" ? "Loop" : nameOf(t.origin_id, t.origin);
        html.push(`<li class="lt-row">
          <span class="lt-time">${host.bigTime(t.origin_time)}</span>
          <span class="lt-main"><span>${esc(t.destination || "")} <span class="muted small">from ${esc(from)}</span></span>
            <span class="muted small">${t.dest_time ? `arrives <b>${esc(host.fmtTime(t.dest_time))}</b>` : ""}</span></span>
          <span class="lt-in">${m > 0 ? host.untilText(m) : ""}</span>
        </li>`);
      }
      html.push("</ol>");
    }
    tt.innerHTML = html.join("");
    const dl = $("data-line");
    dl.hidden = false;
    dl.textContent = d.source === "live" ? d.credit
      : `${d.error ? "Live CTA data unavailable, showing the schedule. " : "CTA schedule (no live data). "}${d.credit}`;
  }
  function renderTimetable() {
    if (!st.active) return;
    updatePill();
    renderTitle();
    syncLineMode();
    if (st.ttLine) return renderLine();
    const tt = $("tt"), d = st.timetable;
    const now = host.serverNow();
    $("board-updated").textContent = d && d.source === "live" ? `CTA · ${host.fmtTime(d.as_of)}` : "CTA schedule";
    if (!st.station) { tt.innerHTML = ""; host.showEmpty("Pick a CTA station to see today's trains."); return; }
    if (!d) { tt.innerHTML = ""; host.showEmpty("Loading…"); return; }
    host.showEmpty("");
    renderTtHead();
    const from = nameOf(st.station);
    // Downtown (in the Loop) "toward downtown" means nothing: one list.
    const split = !d.downtown && d.departures.some((r) => r.direction);
    const dir = split ? (st.ttDir || (st.ttDir = defaultDir())) : null;
    const rows = d.departures.filter((r) => !split || r.direction === dir);
    // The station's lines (as Metra's summary shows them): chips when there are one or two.
    const here = (st.byId.get(st.station) || {}).routes || [];
    const lines = here.map(lineOf);
    const many = new Set(rows.map((r) => r.route_id)).size > 1;
    const color = (lines[0] && lines[0].color) || "var(--accent)";
    const left = rows.length;
    const counts = left ? `${left} train${left === 1 ? "" : "s"} left today · last ${host.fmtTime(rows[left - 1].time)}` : "No more trains today";
    const html = [`<div class="lt-hero" style="--line:${esc(color)}">
        <div class="lt-sub lt-sub-only">${lines.length <= 2 ? lines.map((l) => host.chip(l.short_name, l.color, l.text_color)).join("") + " " : ""}${esc(counts)}${d.as_of ? ` · <span title="When CTA last updated this data">CTA data ${esc(host.fmtDateTime(d.as_of))}</span>` : ""}</div>
      </div>`];
    if (split) {
      html.push(`<div class="lt-dir" role="group" aria-label="Direction">
        <button type="button" data-cta-dir="inbound" aria-pressed="${dir === "inbound"}">Toward downtown</button>
        <button type="button" data-cta-dir="outbound" aria-pressed="${dir === "outbound"}">Away from downtown</button>
      </div>`);
    }
    if (!rows.length) {
      const where = split ? ` ${dir === "inbound" ? "toward" : "away from"} downtown` : "";
      html.push(`<p class="muted tt-none">No more trains${where} from ${esc(from)} today${st.dest ? ` to ${esc(nameOf(st.dest))}` : ""}.</p>`);
    } else {
      const sel = host.selectedTrip();
      const next = rows[0];
      html.push('<ol class="lt-list tt-list">');
      for (const r of rows) {
        const mins = Math.round((r.time - now) / 60);
        // Like Metra's "On time" / "9 min late". CTA doesn't say how late, only whether a
        // train is tracked live or flagged as delayed.
        const status = r.delayed ? '<span class="delay late" title="CTA says this train is delayed">Delayed</span>'
          : r.live ? '<span class="delay ontime" title="Live from CTA Train Tracker">Live</span>' : "";
        const end = st.dest ? r.arrival : r.final_arrival;
        const arr = end ? `arrives ${esc(host.fmtTime(end))}` : "";
        const trip = r.run ? ` data-trip="${tripId(r.run)}" data-route="${esc(r.route_id)}"` : "";
        html.push(`<li class="lt-row${r === next ? " next" : ""}${r.run && sel === tripId(r.run) ? " selected" : ""}"${trip}>
          <span class="lt-time">${host.bigTime(r.time)}</span>
          <span class="lt-main"><span>${many ? host.chip(r.route_short, r.color, r.text_color) + " " : ""}${esc(r.destination || r.route_name)}${r.run ? ` <span class="muted small">#${esc(r.run)}</span>` : ""}</span>
            <span class="muted small">${[arr, status].filter(Boolean).join(" · ")}</span></span>
          <span class="lt-in">${r.due || mins <= 0 ? "Now" : host.untilText(mins)}</span>
        </li>`);
      }
      html.push("</ol>");
    }
    tt.innerHTML = html.join("");
    const dl = $("data-line");
    dl.hidden = false;
    dl.textContent = d.source === "live" ? d.credit
      : `${d.error ? "Live CTA data unavailable, showing the schedule. " : "CTA schedule (no live data). "}${d.credit}`;
  }
  $("tt").addEventListener("click", (e) => {
    if (!st.active) return;
    const b = e.target.closest("[data-cta-dir]");
    if (b) { st.ttDir = b.dataset.ctaDir; renderTimetable(); return; }
    const l = e.target.closest("[data-cta-ldir]");
    if (l && l.dataset.ctaLdir !== st.lineDir) {
      st.lineDir = l.dataset.ctaLdir;
      st.lineData = null;
      renderTimetable();
      refreshLine().then(renderTimetable);
    }
  });

  function render() {
    if (!st.active) return;
    syncLineMode();
    renderPicker();
    if (host.tab() === "timetable") renderTimetable(); else renderBoard();
  }

  // ---------- station picker (From / Going to) ----------
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
  function matches(q, onlyIds) {
    const raw = q.trim().toLowerCase(), nq = norm(q);
    const lineIds = new Set(st.lines.filter((l) => nq && (norm(l.id) === nq || norm(l.short_name).startsWith(nq) || norm(l.name).startsWith(nq))).map((l) => l.id));
    const out = [];
    for (const s of st.stations) {
      if (onlyIds && !onlyIds.has(s.id)) continue;
      const name = s.display.toLowerCase();
      let score = !nq ? 1 : name.startsWith(raw) ? 0 : (name.includes(raw) || norm(s.name).includes(nq)) ? 1 : s.routes.some((r) => lineIds.has(r)) ? 2 : -1;
      if (score >= 0) out.push([score, s]);
    }
    out.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
    return out.map((x) => x[1]);
  }
  function pickerFor(inputId, listId, getValue, onSelect, allowClear) {
    const input = $(inputId), list = $(listId);
    let items = [];
    const current = () => (st.byId.get(getValue()) || {}).display || "";
    const dots = $(`${inputId}-dots`);
    const syncDots = () => { if (dots) dots.innerHTML = dotsHtml((st.byId.get(getValue()) || {}).routes); };
    function render() {
      items = matches(input.value).slice(0, 80);
      list.innerHTML = (allowClear && getValue() ? '<li role="option" data-id="" class="clear-opt">Any destination</li>' : "")
        + (items.length ? items.map((s) => `<li role="option" data-id="${esc(s.id)}"><span>${stationHtml(s)}</span></li>`).join("")
          : '<li class="empty">No matching stations</li>');
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }
    function choose(id) { list.hidden = true; input.blur(); onSelect(id); input.value = current(); syncDots(); }
    input.addEventListener("focus", () => { input.select(); render(); if (dots) dots.hidden = true; });
    input.addEventListener("input", render);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); if (allowClear && !input.value.trim()) choose(""); else if (items[0]) choose(items[0].id); }
      else if (e.key === "Escape") { list.hidden = true; input.value = current(); input.blur(); }
    });
    input.addEventListener("search", () => { if (allowClear && !input.value) choose(""); });
    list.addEventListener("mousedown", (e) => { const li = e.target.closest("li[data-id]"); if (li) { e.preventDefault(); choose(li.dataset.id); } });
    input.addEventListener("blur", () => setTimeout(() => {
      list.hidden = true; input.setAttribute("aria-expanded", "false"); input.value = current();
      if (dots) { dots.hidden = false; syncDots(); }
    }, 120));
    return { sync: () => { if (document.activeElement !== input) input.value = current(); syncDots(); } };
  }
  let fromPick, toPick;
  function renderPicker() {
    const show = !st.station || host.pickersShown();
    $("cta-picker").hidden = !show;
    if (fromPick) { fromPick.sync(); toPick.sync(); }
  }

  // ---------- actions ----------
  function save() {
    if (st.station) localStorage.setItem(KEY.station, st.station); else localStorage.removeItem(KEY.station);
    if (st.dest) localStorage.setItem(KEY.dest, st.dest); else localStorage.removeItem(KEY.dest);
  }
  async function refreshAll() {
    if (host.tab() === "timetable") await refreshTimetable(); else await refreshBoard();
    render();
    refreshTrains();
    syncPlaces();
  }
  function selectStation(id, opts = {}) {
    if (!st.byId.has(id)) return;
    st.station = id;
    if (st.dest === id) st.dest = null;
    save();
    st.board = null; st.timetable = null;
    render();
    if (opts.pan !== false) { const s = st.byId.get(id); host.mapView.flyTo(s.lat, s.lon); }
    refreshAll();
  }
  function selectDest(id) {
    st.dest = id && st.byId.has(id) && id !== st.station ? id : null;
    save();
    st.board = null;
    render();
    refreshAll();
  }
  function clear() {
    st.station = null; st.dest = null; save();
    st.board = null; st.timetable = null;
    host.mapView.clearSelection(false);
    render();
    syncPlaces();
    host.mapView.fitLines();
  }
  function swap() {
    if (!st.station || !st.dest) return;
    [st.station, st.dest] = [st.dest, st.station];
    save(); st.board = null; render(); refreshAll();
  }
  async function saveProfile(values, what) {
    try {
      const r = await fetch("/api/cta/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      st.profile = await r.json();
      host.toast(`CTA ${what} saved`);
    } catch (e) { alert(`Couldn't save the CTA ${what}: ${e.message}`); }
    render(); syncPlaces();
  }
  // Home / Work on the board: the commute that way, or set it from the current station.
  function goTrip(kind) {
    const p = st.profile;
    const target = kind === "home" ? p.home_station : p.work_station;
    const other = kind === "home" ? p.work_station : p.home_station;
    if (!target) {
      if (!st.station) { $("cta-from").focus(); return; }
      if (st.station === other) { alert(`That's your CTA ${kind === "home" ? "work" : "home"} station.`); return; }
      saveProfile(kind === "home" ? { home_station: st.station } : { work_station: st.station }, `${kind} station`);
      return;
    }
    if (other) { st.station = other; st.dest = target; } else { st.station = target; st.dest = null; }
    save(); st.board = null; st.timetable = null; render(); refreshAll();
  }
  function syncPlaces() {
    if (!st.active) return;
    const pick = (id) => { const s = id && st.byId.get(id); return s ? { id: s.id, name: s.display, lat: s.lat, lon: s.lon } : null; };
    host.mapView.setPlaces({ home: pick(st.profile.home_station), work: pick(st.profile.work_station), current: pick(st.station) });
  }

  // ---------- train sheet (double-tap): CTA's follow data in the sheet's shape ----------
  function toTrip(d) {
    const passed = (d.passed || []).map((s) => ({ station_id: s.station_id, name: nameOf(s.station_id, s.name), time: s.time, scheduled: null, passed: true }));
    const ahead = d.stops.map((s) => ({ station_id: s.station_id, name: nameOf(s.station_id, s.name), time: s.time, scheduled: null }));
    const delays = d.delays_today || [];
    return {
      trip_id: tripId(d.run), train: d.run, route_short: d.route_short, color: d.color, text_color: d.text_color,
      destination: d.destination, stops: passed.concat(ahead), next_index: passed.length, running: true, live: true,
      delay: d.delayed ? 360 : null, cta: true,
      status_html: d.delayed ? '<span class="badge cancel">Delayed</span>'
        : delays.length ? `<span class="muted">Delayed ${delays.length}× today</span>` : "On the move",
      source_note: passed.some((s) => s.source === "estimated") ? "From CTA Train Tracker · earlier stops estimated" : "From CTA Train Tracker",
    };
  }
  const tripPath = (id) => `/api/cta/follow?run=${encodeURIComponent(id.slice(4))}`;

  function popup(t) {
    const rows = [["Run", `#${esc(t.run)}`], ["To", esc(t.destination || "—")], ["Next", t.next_station_id && st.byId.has(t.next_station_id) ? stationHtml(st.byId.get(t.next_station_id)) : esc(t.next_station || "—")],
      ["Status", t.delayed ? '<span class="badge cancel">Delayed</span>' : t.due ? "Arriving" : "Live"]];
    const row = st.board && st.board.groups.flatMap((g) => g.trains).find((x) => x.run === t.run);
    const foot = row ? `<div class="popup-board"><span>At ${esc(nameOf(st.board.station.id))} <b>${esc(host.fmtTime(row.time))}</b></span></div>` : "";
    return `<div class="popup"><h3>${chipFor(t.route_id)} ${esc(lineOf(t.route_id).name || "")}</h3><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>${foot}<p class="muted small">Double-tap for every stop</p></div>`;
  }

  // The map's corner credit names whose data is on it.
  function setAttribution(cta) {
    for (const el of document.querySelectorAll(".maplibregl-ctrl-attrib-inner")) {
      el.innerHTML = cta ? el.innerHTML.replace("Data: Metra", "Data: CTA") : el.innerHTML.replace("Data: CTA", "Data: Metra");
    }
  }

  // ---------- switching ----------
  function startTimers() {
    stopTimers();
    st.timers = [
      setInterval(() => { if (document.visibilityState === "visible") refreshAll(); }, 30000),
      setInterval(() => { if (document.visibilityState === "visible") refreshAlerts(); }, 120000),
      setInterval(() => { if (document.visibilityState === "visible" && host.tab() !== "timetable") renderBoard(); }, 15000),
    ];
  }
  function stopTimers() { st.timers.forEach(clearInterval); st.timers = []; }

  async function setActive(on) {
    st.active = on;
    localStorage.setItem(KEY.system, on ? "cta" : "metra");
    document.body.classList.toggle("sys-cta", on);
    document.querySelectorAll(".sys-switch [data-sys]").forEach((b) => b.setAttribute("aria-selected", String((b.dataset.sys === "cta") === on)));
    host.mapView.closePopups();
    host.mapView.clearSelection(false);
    if (host.mapView.lineFocus) host.mapView.setLineFocus(null, { fit: false });
    if (!on) { document.body.classList.remove("cta-line-mode"); stopTimers(); setAttribution(false); host.onMetra(); return; }
    $("board-list").innerHTML = ""; $("tt").innerHTML = "";
    $("board-notice").hidden = true;
    host.applyView();
    if (!(await load())) return;
    host.mapView.updateTrains({ trains: [] });
    host.mapView.setStations(st.stations.map((x) => ({ ...x, name: x.display })));
    await host.mapView.setLines(st.geo);
    host.renderMapHead();
    render();
    refreshAlerts();
    startTimers();
    await refreshAll();
  }

  function init(h) {
    host = h;
    fromPick = pickerFor("cta-from", "cta-from-list", () => st.station, (id) => selectStation(id), false);
    toPick = pickerFor("cta-to", "cta-to-list", () => st.dest, (id) => selectDest(id), true);
    $("cta-swap").addEventListener("click", swap);
    $("cta-home-btn").addEventListener("click", () => {
      const p = st.profile;
      if (p.home_station) selectStation(p.home_station);
      else if (st.station) saveProfile({ home_station: st.station }, "home station");
    });
    $("cta-work-btn").addEventListener("click", () => {
      const p = st.profile;
      if (p.work_station) selectStation(p.work_station);
      else if (st.station) saveProfile({ work_station: st.station }, "work station");
    });
    document.querySelectorAll(".sys-switch [data-sys]").forEach((b) => b.addEventListener("click", () => {
      const on = b.dataset.sys === "cta";
      if (on !== st.active) setActive(on);
    }));
    // One tap on a CTA train: show it on the map (two taps open its stops; app.js handles that).
    $("board-list").addEventListener("click", (e) => {
      if (!st.active) return;
      const b = e.target.closest("[data-trip]");
      if (b && b.closest(".cta-lc")) host.pickTrain(b.dataset.trip, b.dataset.route);
    });
    document.addEventListener("visibilitychange", () => { if (st.active && document.visibilityState === "visible") { refreshAll(); refreshAlerts(); } });
    document.body.classList.toggle("sys-cta", st.active);
    document.querySelectorAll(".sys-switch [data-sys]").forEach((b) => b.setAttribute("aria-selected", String((b.dataset.sys === "cta") === st.active)));
  }

  window.CTA = {
    init, setActive, render, refreshAll, refreshTrains,
    active: () => st.active,
    profile: () => st.profile,
    updatePill,
    start: () => (st.active ? setActive(true) : null),
    routes: () => st.lines.map((l) => ({ id: l.id, short_name: l.short_name, long_name: l.name, color: l.color, text_color: l.text_color })),
    stations: () => st.stations,
    myLines: () => new Set([st.station, st.dest, st.profile.home_station, st.profile.work_station]
      .map((id) => st.byId.get(id)).filter(Boolean).flatMap((s) => s.routes)),
    selectStation, clear, swap, goTrip, popup, toTrip, tripPath,
    renderTtHead, setTtLine,
    tabChanged: () => { st.board = null; st.timetable = null; render(); refreshAll(); },
  };
})();
