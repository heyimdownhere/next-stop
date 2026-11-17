/* Schedule page: a line's whole timetable, laid out like Metra's printed (PDF) one.
   Stations down the side, trains across the top, the station names stay put while
   you swipe through the trains. The bar at the top picks the day, the direction and
   a time + station to jump to: the grid scrolls to that station's row and the first
   train there at or after that time. Metra only (CTA runs by frequency, no printed grid). */
(() => {
  const $ = (id) => document.getElementById(id);
  let host = null;
  const st = { route: null, direction: "inbound", day: "weekday", station: null, time: null, data: null, req: 0 };

  const hhmm = (secs) => {
    const h = Math.floor(secs / 3600) % 24, m = Math.floor(secs / 60) % 60;
    return `${(h + 11) % 12 + 1}:${String(m).padStart(2, "0")}`;
  };
  const isPm = (secs) => { const h = Math.floor(secs / 3600) % 24; return h >= 12; };
  // "HH:MM" from the time box to seconds into the service day (after midnight counts as late night).
  function inputSecs(v) {
    const [h, m] = String(v || "").split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    const s = h * 3600 + m * 60;
    return h < 3 ? s + 86400 : s;
  }
  const secsInput = (secs) => {
    const h = Math.floor(secs / 3600) % 24, m = Math.floor(secs / 60) % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };
  const nowSecs = () => (st.data && st.data.today ? host.serverNow() - st.data.service_day_start : null);

  function init(h) {
    host = h;
    $("sch-back").addEventListener("click", close);
    $("sch-line").addEventListener("change", () => { st.route = $("sch-line").value; load(); });
    $("sch-day").addEventListener("change", (e) => { st.day = e.target.value; load(); });
    $("sch-dir").addEventListener("change", (e) => { st.direction = e.target.value; load(); });
    $("sch-time").addEventListener("change", () => { st.time = inputSecs($("sch-time").value); zoom(true); });
    $("sch-station").addEventListener("change", () => { st.station = $("sch-station").value; render(); zoom(true); });
    // Tap a station's name: it becomes the station at the top, and the grid jumps there.
    $("sch-grid").addEventListener("click", (e) => {
      const b = e.target.closest("[data-station]");
      if (!b || b.dataset.station === st.station) return;
      st.station = b.dataset.station;
      $("sch-station").value = st.station;
      render();
      zoom(true);
    });
    $("sch-now").addEventListener("click", () => {
      st.time = null;
      syncTime();
      zoom(true);
    });
    window.addEventListener("hashchange", () => { if (!["#schedule", "#train"].includes(location.hash) && !$("schedule-page").hidden) hide(); });
  }

  // Open on a line (and a direction and station, if known).
  function open({ route, direction, station } = {}) {
    const routes = host.routes();
    if (!routes.length) return;
    st.route = routes.some((r) => r.id === route) ? route : st.route || routes[0].id;
    if (direction) st.direction = direction;
    st.station = station || st.station;
    st.time = null;
    st.day = todayKind();
    $("sch-line").innerHTML = routes.map((r) => `<option value="${host.esc(r.id)}">${host.esc(r.long_name || r.short_name)}</option>`).join("");
    const page = $("schedule-page");
    if (page.hidden) {
      document.body.classList.add("schedule-open");
      window.scrollTo(0, 0);
      host.enter(page);
      if (location.hash !== "#schedule") history.pushState({ schedule: 1 }, "", "#schedule");
    }
    load();
  }
  function close() {
    if (location.hash === "#schedule") history.back(); else hide();
  }
  function hide() {
    host.leave($("schedule-page"), () => document.body.classList.remove("schedule-open"));
  }
  function todayKind() {
    const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: host.tz() }).format(new Date(host.serverNow() * 1000));
    return wd === "Sat" ? "saturday" : wd === "Sun" ? "sunday" : "weekday";
  }

  async function load() {
    const req = ++st.req;
    $("sch-line").value = st.route;
    $("sch-day").querySelector(`input[value="${st.day}"]`).checked = true;
    $("sch-dir").querySelector(`input[value="${st.direction}"]`).checked = true;
    const r = host.routes().find((x) => x.id === st.route) || {};
    $("sch-chip").innerHTML = host.chip(r.short_name || st.route, r.color, r.text_color);
    $("sch-grid").innerHTML = "";
    $("sch-note").textContent = "Loading the schedule…";
    let d;
    try {
      d = await host.api(`/api/schedule?route=${encodeURIComponent(st.route)}&direction=${st.direction}&day=${st.day}`);
    } catch (e) {
      if (req === st.req) $("sch-note").textContent = "Couldn't load the schedule. Try again in a moment.";
      return;
    }
    if (req !== st.req) return;
    st.data = d;
    prepare(d);
    // Station to jump to: the one you were looking at, else your home station, else the far end.
    const ids = d.stations.map((s) => s.id);
    if (!ids.includes(st.station)) st.station = [host.station(), host.homeStation(), host.workStation()].find((x) => ids.includes(x)) || ids[0];
    $("sch-station").innerHTML = d.stations.map((s) => `<option value="${host.esc(s.id)}">${host.esc(s.name)}</option>`).join("");
    $("sch-station").value = st.station;
    syncTime();
    render();
    zoom(false);
  }
  function syncTime() {
    const n = nowSecs();
    $("sch-time").value = secsInput(st.time != null ? st.time : n != null ? n : 6 * 3600);
    $("sch-now").hidden = st.time == null || n == null;
  }

  // Which empty cells are a train passing a station (↓), not just off its route: a
  // station between two of its stops that some other train serves along with both.
  function prepare(d) {
    const served = d.trains.map((t) => t.times.map((x) => x != null));
    d.trains.forEach((t, ti) => {
      const idx = t.times.map((x, i) => (x != null ? i : -1)).filter((i) => i >= 0);
      t.pass = t.times.map(() => false);
      for (let k = 0; k + 1 < idx.length; k++) {
        const a = idx[k], b = idx[k + 1];
        for (let i = a + 1; i < b; i++) t.pass[i] = served.some((s) => s[a] && s[i] && s[b]);
      }
      t.express = t.pass.some(Boolean);
      t.first = idx.length ? t.times[idx[0]] : 0;
      t.last = idx.length ? t.times[idx[idx.length - 1]] : 0;
    });
  }

  function render() {
    const d = st.data;
    if (!d) return;
    const esc = host.esc;
    const si = d.stations.findIndex((s) => s.id === st.station);
    const now = nowSecs();
    // Departed: gone from the chosen station (or, if it doesn't stop there, from its last stop).
    const ref = (t) => (si >= 0 && t.times[si] != null ? t.times[si] : t.last);
    const gone = (t) => now != null && ref(t) < now;
    const next = now == null ? null : d.trains.find((t) => !gone(t) && si >= 0 && t.times[si] != null);
    // Laid out like the printed timetable: AM or PM under each train number (for its time
    // at your station: a train can leave before noon and reach you after), a heavy line
    // where that changes, striped rows, and every time marked a or p.
    const half = d.trains.map((t) => (isPm(ref(t)) ? "PM" : "AM"));
    const cls = (t, j) => [gone(t) ? "gone" : t === next ? "next" : "", j > 0 && half[j] !== half[j - 1] ? "turn" : ""];
    const nums = d.trains.map((t, j) => `<th class="${["h num", ...cls(t, j)].join(" ")}" data-col="${j}" scope="col"><button type="button" data-trip="${esc(t.trip_id)}" aria-label="Train ${esc(t.train || "")}: every stop">${esc(t.train || "—")}</button></th>`).join("");
    const subs = d.trains.map((t, j) => `<th class="${["h sub", ...cls(t, j), t.express ? "x" : ""].join(" ")}" data-col="${j}"${t === next ? ' title="Next train"' : ""}>${half[j]}${t.express ? '<span class="xp">Exp</span>' : ""}</th>`).join("");
    const rows = d.stations.map((s, i) => {
      const cells = d.trains.map((t, j) => {
        const v = t.times[i];
        const c = ["c", ...cls(t, j), v != null && isPm(v) ? "pm" : "", v == null ? "none" : ""].filter(Boolean).join(" ");
        return `<td class="${c}" data-col="${j}">${v != null ? `${hhmm(v)}<span class="ap">${isPm(v) ? "p" : "a"}</span>` : ""}</td>`;
      }).join("");
      const rc = ["r", i === si ? "home" : "", i % 2 ? "z" : "", i === 0 || i === d.stations.length - 1 ? "end" : ""].filter(Boolean).join(" ");
      return `<tr class="${rc}" data-row="${i}"><th class="sn" scope="row"><button type="button" class="sn-pick" data-station="${esc(s.id)}" aria-label="Jump to ${esc(s.name)}" aria-pressed="${i === si}">${esc(s.name)}</button></th>${cells}</tr>`;
    }).join("");
    $("sch-grid").innerHTML = `<thead><tr><th class="corner num" scope="col"></th>${nums}</tr><tr><th class="corner sub" scope="col">Station</th>${subs}</tr></thead><tbody>${rows}</tbody>`;
    const date = new Date(`${d.date}T12:00:00`);
    const dayName = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric" }).format(date);
    $("sch-sub").textContent = `${d.trains.length} trains · ${d.today ? "today, " : ""}${dayName}`;
    $("sch-note").textContent = d.trains.length ? "" : "No trains this way on that day.";
  }

  // Scroll to the chosen station's row and the first train there at or after the chosen
  // time (now, unless you picked one), and ring that time.
  function zoom(smooth) {
    const d = st.data, grid = $("sch-grid"), box = $("sch-scroll");
    if (!d || !d.trains.length) return;
    grid.querySelectorAll(".target, .focus").forEach((x) => x.classList.remove("target", "focus"));
    const si = d.stations.findIndex((s) => s.id === st.station);
    if (si < 0) return;
    const at = st.time != null ? st.time : nowSecs() != null ? nowSecs() : 0;
    let j = d.trains.findIndex((t) => t.times[si] != null && t.times[si] >= at);
    if (j < 0) j = d.trains.length - 1 - [...d.trains].reverse().findIndex((t) => t.times[si] != null);  // last train there
    const row = grid.querySelector(`tr[data-row="${si}"]`);
    if (!row) return;
    row.classList.add("focus");
    grid.querySelectorAll(`[data-col="${j}"]`).forEach((x) => x.classList.add("focus"));
    const cell = row.querySelector(`td[data-col="${j}"]`);
    if (cell) cell.classList.add("target");
    const side = grid.querySelector(".corner").offsetWidth;
    const headH = grid.querySelector("thead").offsetHeight;
    // Leave the train before it in view too, so you can see where AM turns to PM.
    const before = cell && cell.previousElementSibling && cell.previousElementSibling.matches("td") ? cell.previousElementSibling.offsetWidth : 0;
    const left = cell ? Math.max(0, cell.offsetLeft - side - before) : 0;
    const top = Math.max(0, row.offsetTop - headH - (box.clientHeight - headH) / 2 + row.offsetHeight / 2);
    box.scrollTo({ left, top, behavior: smooth && !host.reduceMotion() ? "smooth" : "auto" });
    const t = d.trains[j];
    $("sch-jump-note").textContent = t && t.times[si] != null
      ? `#${t.train || "—"} at ${hhmm(t.times[si])} ${isPm(t.times[si]) ? "PM" : "AM"}${t.express ? " · Express" : ""}`
      : "";
  }

  window.Schedule = { init, open };
})();
