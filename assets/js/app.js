/* Community Map dashboard.
 *
 * The product question is "who has gone quiet, and who is near them", so the
 * side panel always answers both halves at once: the quiet people in view, and
 * the active people nearest each of them.
 */
(function () {
  "use strict";

  var STATUS = ["active", "new", "slowing", "dormant", "inactive", "unknown"];
  var EDIT_KEY = "community-map-overrides";

  /* Role definitions. The team mixed these up live on the 2026-08-05 call, so
   * they travel with the data rather than living in a doc nobody opens.
   * Source: 04-Knowledge/work/comet/community-supporter-track.md */
  var ROLES = {
    "Event Supporter":   "Mentor. Meets assigned event organizers bi-weekly and checks on dormant meetups. Can vet meetup applications. No tracker or Help Scout access.",
    "Program Supporter": "Reviews WordCamp and Meetup applications, interviews lead organizers, and works the Help Scout queue. Full tracker + Help Scout access.",
    "Program Manager":   "Everything a Program Supporter does, plus the extra steps — including creating sites on WordCamp.org.",
    "Community member":  "In #community-events or #community-team on Make WordPress Slack, with no official Community Team role on record.",
    "Not on roster":     "Doing supporter work — vetting applications or answering organizers — but absent from the official roster page."
  };
  function roleDef(r) { return ROLES[r] || ""; }
  function roleHTML(r) {
    var d = roleDef(r);
    return d ? '<span class="def" tabindex="0" data-def="' + esc(d) + '">' + esc(r) + "</span>" : esc(r);
  }
  var state = {
    data: null, view: "map", region: "us", pop: "all", q: "",
    country: "", status: "", rows: 50, page: 0,
    map: null, layer: null, selected: null
  };

  /* The team's edit surface. The in-page editor used to write to localStorage,
   * which looked like a save and reached nobody -- three people correcting
   * three different contributors produced three private copies. The Sheet is
   * the one path that actually reaches the dataset: build/sync_sheet.py merges
   * it into overrides.json, which wins over every source at build time. */
  var SHEET_URL = "https://docs.google.com/spreadsheets/d/13DAShMlFl57xbUqB9Hwhp7iRdXp_A2Hr6EkooL1yO2I/edit";

  var $ = function (id) { return document.getElementById(id); };

  /* --- local overrides ---------------------------------------------------
   * The host is static, so edits land in localStorage and are exported as a
   * overrides.json patch. Nothing is written back to a server, and the panel
   * says so rather than implying the edit is shared. */
  function loadEdits() {
    try { return JSON.parse(localStorage.getItem(EDIT_KEY) || "{}"); }
    catch (e) { return {}; }
  }
  function saveEdits(e) { localStorage.setItem(EDIT_KEY, JSON.stringify(e)); }
  function keyOf(p) { return p.org || p.slack || p.name; }

  function applyEdits(people) {
    var e = loadEdits();
    people.forEach(function (p) {
      var o = e[keyOf(p)];
      if (!o) return;
      Object.keys(o).forEach(function (k) {
        if (k === "by" || k === "at" || k === "why") return;
        p[k] = o[k];
      });
      p.locallyEdited = true;
    });
  }

  /* --- helpers ----------------------------------------------------------- */

  function inUS(p) {
    if (p.country) return /united states|usa|u\.s\./i.test(p.country);
    if (p.lat != null) return p.lat > 24 && p.lat < 50 && p.lng < -66 && p.lng > -125;
    if (p.tz) return /^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Indiana|Kentucky|Boise|Juneau)/.test(p.tz);
    return false;
  }

  function visible() {
    var d = state.data ? state.data.people : [];
    var q = state.q.trim().toLowerCase();
    return d.filter(function (p) {
      if (state.pop === "roster" && p.tier === "community") return false;
      if (state.region === "us" && !inUS(p)) return false;
      if (state.country && p.country !== state.country) return false;
      if (state.status && p.status !== state.status) return false;
      if (q) {
        var hay = (p.name + " " + (p.city || "") + " " + (p.country || "") + " " +
                   (p.slack || "") + " " + (p.org || "") + " " + (p.employer || "")).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function km(n) { return n.toLocaleString() + " km / " + Math.round(n * 0.621371).toLocaleString() + " mi"; }

  function distance(a, b) {
    var R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    var la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(la1) * Math.cos(la2);
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
  }

  /* Closest active people to a given person, nearest first.
   * The list view already showed a single nearest name; the detail view needs
   * a few, because "who do I ask to reach this person" usually has more than
   * one answer and the second choice matters when the first is a stranger. */
  function nearestActive(p, list, n) {
    if (p.lat == null) return [];
    return list
      .filter(function (a) {
        return a.status === "active" && a.lat != null && keyOf(a) !== keyOf(p);
      })
      .map(function (a) { return { p: a, d: distance(p, a) }; })
      .sort(function (x, y) { return x.d - y.d; })
      .slice(0, n || 3);
  }

  function slackLink(p) {
    return p.slack_id ? "https://wordpress.slack.com/team/" + encodeURIComponent(p.slack_id) : "";
  }
  function orgLink(p) {
    return p.org ? "https://profiles.wordpress.org/" + encodeURIComponent(p.org) + "/" : "";
  }
  function link(href, text) {
    return href ? '<a href="' + href + '" target="_blank" rel="noopener">' + esc(text) + "</a>"
                : esc(text);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* --- counters ---------------------------------------------------------- */

  function renderCounters(list) {
    var n = { active: 0, new: 0, slowing: 0, dormant: 0, inactive: 0, unknown: 0 };
    list.forEach(function (p) { n[p.status] = (n[p.status] || 0) + 1; });
    var mapped   = list.filter(function (p) { return p.lat != null; }).length;
    var unplaced = list.length - mapped;

    $("counters").innerHTML =
      cell("in view",    list.length,  "", "")        +
      cell("active",     n.active,     "is-active",  "active")  +
      cell("new",        n.new,        "is-new",     "new")     +
      cell("slowing",    n.slowing,    "is-slowing", "slowing") +
      cell("dormant",    n.dormant,    "is-dormant", "dormant") +
      cell("unknown",    n.unknown,    "is-unknown", "unknown") +
      cell("on the map", mapped,       "", "")        +
      cell("no location", unplaced,    "is-muted",   "", "These people are counted but cannot be placed: no location on their .org profile, or their profile has not been read yet.");

    Array.prototype.forEach.call($("counters").children, function (el) {
      if (!el.dataset.status) return;
      el.onclick = function () {
        state.status = (state.status === el.dataset.status) ? "" : el.dataset.status;
        state.page = 0;
        if ($("f-status")) $("f-status").value = state.status;
        render();
      };
    });
  }

  function cell(k, v, cls, status, title) {
    var on = status && state.status === status;
    return '<' + (status ? "button" : "div") + ' class="counter ' + cls +
      (status ? " is-clickable" : "") + (on ? " is-on" : "") + '"' +
      (status ? ' data-status="' + status + '" aria-pressed="' + on + '"' : "") +
      (title ? ' title="' + esc(title) + '"' : "") + ">" +
      '<span class="n tabular">' + v.toLocaleString() + '</span><span class="k">' + k + "</span></" +
      (status ? "button" : "div") + ">";
  }

  /* --- map --------------------------------------------------------------- */

  function initMap() {
    state.map = L.map("map", { worldCopyJump: true, zoomControl: true })
                 .setView([39.5, -98.35], 4);
    // Basemap follows the viewer's theme; a light map under dark chrome glares.
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var tiles = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/" + (dark ? "dark_all" : "light_all") + "/{z}/{x}/{y}{r}.png",
      { attribution: "&copy; OpenStreetMap &copy; CARTO", maxZoom: 18 });
    tiles.addTo(state.map);
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function (e) {
        tiles.setUrl("https://{s}.basemaps.cartocdn.com/" +
          (e.matches ? "dark_all" : "light_all") + "/{z}/{x}/{y}{r}.png");
      });
    }
    state.layer = L.layerGroup().addTo(state.map);
  }

  function renderMap(list) {
    if (!state.map) initMap();
    state.layer.clearLayers();
    var placed = list.filter(function (p) { return p.lat != null; });

    placed.forEach(function (p) {
      var size = p.tier === "roster" ? 13 : 10;
      var m = L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: "",
          html: '<div class="pin ' + p.status + (p.tier === "roster" ? " is-roster" : "") +
                '" style="width:' + size + "px;height:" + size + 'px"></div>',
          iconSize: [size, size], iconAnchor: [size / 2, size / 2]
        }),
        title: p.name
      });
      m.on("click", function () { select(p, list); });
      m.bindPopup(
        "<strong>" + esc(p.name) + "</strong><br>" +
        esc(p.role) + (roleDef(p.role) ? '<br><span class="popup-def">' + esc(roleDef(p.role)) + "</span>" : "") +
        "<br>" + esc(p.city || p.country || "") +
        (p.precision === "country" ? " <em>(country only)</em>" : "") +
        '<br><span class="tag ' + p.status + '">' + p.status + "</span>"
      );
      state.layer.addLayer(m);
    });

    if (placed.length) {
      state.map.fitBounds(L.latLngBounds(placed.map(function (p) { return [p.lat, p.lng]; })).pad(0.15));
    }
  }

  /* --- side panel: quiet people, and who is near them --------------------- */

  function renderSide(list) {
    var side = $("side");

    if (state.selected) {
      side.innerHTML = detailHTML(state.selected, list) +
        (state.editing ? editorHTML(state.selected) : "") + pendingHTML();
      wireDetail(state.selected, list);
      wirePending();
      return;
    }
    /* Re-engagement ranking, not a dormancy leaderboard.
     * Someone quiet for 4 months is reachable; someone gone since 2014 is not.
     * So: people who hold a supporter role first, then the MOST RECENTLY quiet,
     * because recoverability falls off with time. Sorting by longest-gone put
     * 2014 accounts at the top, which is the opposite of actionable. */
    var quiet = list.filter(function (p) {
      return p.status === "dormant" || p.status === "inactive";
    }).sort(function (a, b) {
      var ar = a.tier === "community" ? 1 : 0, br = b.tier === "community" ? 1 : 0;
      if (ar !== br) return ar - br;
      var ad = a.status === "inactive" ? 1 : 0, bd = b.status === "inactive" ? 1 : 0;
      if (ad !== bd) return ad - bd;
      return (a.days || 0) - (b.days || 0);
    });

    if (!list.length) {
      side.innerHTML = '<div class="state"><strong>Nothing matches</strong>' +
        "No one fits these filters. Widen the region, switch to Everyone, or clear the search.</div>";
      return;
    }

    var actives = list.filter(function (p) { return p.status === "active" && p.lat != null; });
    var reachable = quiet.filter(function (p) { return p.status === "dormant"; }).length;
    var html = pendingHTML() +
      '<p class="label">Gone quiet — ' + quiet.length + "</p>" +
      '<p class="hint">' + reachable + " went quiet within the last year, listed first. " +
      "Supporters with a role rank above general members.</p>";

    if (!quiet.length) {
      html += '<div class="state">No dormant people in this view.</div>';
    } else {
      html += quiet.slice(0, 60).map(function (p) {
        var near = null, d = null;
        if (p.lat != null) {
          actives.forEach(function (a) {
            var dd = distance(p, a);
            if (near === null || dd < d) { near = a; d = dd; }
          });
        }
        return '<div class="row" data-name="' + esc(p.name) + '">' +
          '<div class="nm">' + esc(p.name) + ' <span class="tag ' + p.status + '">' + p.status + "</span></div>" +
          '<div class="meta">' + roleHTML(p.role) +
            (p.last_seen ? " · last seen " + esc(p.last_seen) : " · no signal on record") +
          "</div>" +
          (near ? '<div class="meta">Nearest active: <strong>' + esc(near.name) + "</strong> · " + km(d) + "</div>"
                : '<div class="meta">No mapped active person nearby</div>') +
          "</div>";
      }).join("");
      if (quiet.length > 60) {
        html += '<div class="state">Showing the 60 most recoverable of ' + quiet.length +
          ". Use the table for the full list.</div>";
      }
    }

    html += legend();
    side.innerHTML = html;
    wirePending();
    Array.prototype.forEach.call(side.querySelectorAll(".row"), function (el) {
      el.onclick = function () {
        var nm = el.dataset.name;
        var hit = list.filter(function (x) { return x.name === nm; })[0];
        if (hit) select(hit, list);
      };
    });
  }

  function pendingHTML() {
    var n = Object.keys(loadEdits()).length;
    if (!n) return "";
    return '<div class="pending">' + n + " local edit" + (n === 1 ? "" : "s") +
      ", saved in this browser only. " +
      '<button class="btn" id="do-export" style="margin-left:.4rem">Export</button></div>';
  }
  function wirePending() {
    var x = $("do-export");
    if (x) x.onclick = exportEdits;
  }

  function legend() {
    var m = state.data.meta;
    var rows = STATUS.map(function (s) {
      return "<dt><span class='dot pin " + s + "'></span>" + s + "</dt><dd>" + esc(m.buckets[s]) + "</dd>";
    }).join("");
    return '<div class="legend"><p class="label">What the colours mean</p><dl>' + rows + "</dl>" +
      '<p class="meta" style="font-size:var(--t-small);color:var(--faint);margin-top:var(--s-3)">' +
      esc(m.caveats[1]) + "</p></div>";
  }

  /* --- table ------------------------------------------------------------- */

  var COLS = [
    ["name", "Name"], ["role", "Role"], ["status", "Status"], ["last_seen", "Last seen"],
    ["messages", "Messages"], ["posts", "Supporter ch."], ["vetting", "Vetting"], ["checkins", "Check-ins"],
    ["city", "Location"], ["country", "Country"], ["employer", "Employer"],
    ["slack", "Slack"], ["org", ".org"]
  ];
  var sortKey = "messages", sortDir = -1;

  function renderTable(list) {
    $("thead").innerHTML = "<th>#</th>" + COLS.map(function (c) {
      return "<th data-k='" + c[0] + "'>" + c[1] + "</th>";
    }).join("");

    var all = list.slice().sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey];
      if (typeof x === "string" || typeof y === "string") {
        return String(x || "").localeCompare(String(y || "")) * sortDir;
      }
      return ((x || 0) - (y || 0)) * sortDir;
    });

    var per = state.rows;
    var pages = Math.max(1, Math.ceil(all.length / per));
    if (state.page >= pages) state.page = pages - 1;
    if (state.page < 0) state.page = 0;
    var start = state.page * per;
    var rows = all.slice(start, start + per);

    $("do-csv").textContent = "Export " + all.length.toLocaleString() + " rows";
    $("tcount").textContent = all.length.toLocaleString() + " contributors" +
      (all.length > per ? " · showing " + (start + 1) + "–" + Math.min(start + per, all.length) : "");
    $("pg-label").textContent = (state.page + 1) + " / " + pages;

    $("tbody").innerHTML = rows.map(function (p, i) {
      return "<tr>" +
        "<td class='tabular num'>" + (start + i + 1) + "</td>" +
        "<td>" + esc(p.name) + "</td>" +
        "<td>" + roleHTML(p.role) + "</td>" +
        '<td><span class="tag ' + p.status + '">' + p.status + "</span></td>" +
        "<td class='tabular'>" + esc(p.last_seen || "—") + "</td>" +
        "<td class='tabular'>" + (p.messages || 0) + "</td>" +
        "<td class='tabular'>" + p.posts + "</td>" +
        "<td class='tabular'>" + p.vetting + "</td>" +
        "<td class='tabular'>" + p.checkins + "</td>" +
        "<td>" + esc(p.city || "—") + "</td>" +
        "<td>" + esc(p.country || "—") + "</td>" +
        "<td>" + esc(p.employer || "—") + "</td>" +
        "<td>" + (p.slack ? link(slackLink(p), "@" + p.slack) : "—") + "</td>" +
        "<td>" + (p.org ? link(orgLink(p), p.org) : "—") + "</td>" +
        "</tr>";
    }).join("");

    Array.prototype.forEach.call($("thead").children, function (th) {
      if (!th.dataset.k) return;
      th.onclick = function () {
        var k = th.dataset.k;
        state.page = 0;
        sortDir = (k === sortKey) ? -sortDir : 1;
        sortKey = k;
        renderTable(visible());
      };
    });
  }

  /* --- orchestration ----------------------------------------------------- */

  function detailHTML(p, list) {
    var src = [];
    if (p.messages) src.push(p.messages.toLocaleString() + " message" + (p.messages === 1 ? "" : "s") + " across all channels");
    if (p.posts)    src.push(p.posts + " in the supporter channel");
    if (p.vetting)  src.push(p.vetting + " vetting action" + (p.vetting === 1 ? "" : "s"));
    if (p.checkins) src.push(p.checkins + " check-in repl" + (p.checkins === 1 ? "y" : "ies"));
    if (p.joined)   src.push("joined " + p.joined);
    if (p.last_channel) src.push("last seen in #" + p.last_channel);

    return '<div class="detail">' +
      "<h2>" + esc(p.name) + "</h2>" +
      '<p class="meta">' + roleHTML(p.role) +
        (p.employer ? " · " + esc(p.employer) : "") + "</p>" +
      '<p style="margin-top:var(--s-2)"><span class="tag ' + p.status + '">' + p.status + "</span>" +
        (p.locallyEdited ? ' <span class="edited">· edited locally</span>' :
         p.override ? ' <span class="edited">· corrected</span>' : "") + "</p>" +
      "<dl>" +
        "<dt>Location</dt><dd>" + esc(p.city || p.country || "not on record") +
          (p.precision === "country" ? " <em>(country only)</em>" : "") + "</dd>" +
        "<dt>Last seen</dt><dd>" + esc(p.last_seen || "no signal on record") + "</dd>" +
        "<dt>Evidence</dt><dd>" + (src.length ? esc(src.join(" · ")) : "nothing in the sources we read") + "</dd>" +
        (p.slack ? "<dt>Slack</dt><dd>" + link(slackLink(p), "@" + p.slack) + "</dd>" : "") +
        (p.org ? "<dt>.org</dt><dd>" + link(orgLink(p), p.org) + "</dd>" : "") +
        (p.override && p.override.why ? "<dt>Why corrected</dt><dd>" + esc(p.override.why) + "</dd>" : "") +
      "</dl>" +
      nearHTML(p, list) +
      '<div class="btnrow">' +
        '<button class="btn primary" id="do-edit">Suggest a correction</button>' +
        '<button class="btn" id="do-back">Back to list</button>' +
      "</div>" +
    "</div>";
  }

  function nearHTML(p, list) {
    if (p.lat == null) {
      return '<p class="label">Who is nearby</p>' +
        '<div class="state">This person has no location on record, so proximity ' +
        "cannot be worked out. Correcting their location puts them on the map.</div>";
    }
    var near = nearestActive(p, list, 3);
    if (!near.length) {
      return '<p class="label">Who is nearby</p>' +
        '<div class="state">No active person in this view has a location. ' +
        "Widen the filters to search a bigger pool.</div>";
    }
    return '<p class="label">Closest active people</p>' +
      '<p class="hint">Nearest first. Any of these is a plausible person to make ' +
      "the reintroduction.</p>" +
      '<div class="nearlist">' + near.map(function (h) {
        return '<div class="row near" data-name="' + esc(h.p.name) + '">' +
          '<div class="nm">' + esc(h.p.name) +
            ' <span class="tag ' + h.p.status + '">' + h.p.status + "</span></div>" +
          '<div class="meta">' + roleHTML(h.p.role) +
            (h.p.employer ? " · " + esc(h.p.employer) : "") + "</div>" +
          '<div class="meta">' + esc(h.p.city || h.p.country || "location not on record") +
            " · <strong>" + km(h.d) + "</strong> away</div>" +
        "</div>";
      }).join("") + "</div>";
  }

  function editorHTML(p) {
    var key = keyOf(p);
    return '<div class="editor">' +
      "<h3>Suggest a correction</h3>" +
      '<p class="hint">Corrections are made in the shared Google Sheet, not on ' +
      "this page. That is deliberate: the Sheet is the only place an edit reaches " +
      "everyone. Anything typed here would live in your browser alone.</p>" +
      '<ol class="steps">' +
        "<li>Open the Sheet and find the row with <code>" + esc(key) + "</code> in the " +
          "<strong>key</strong> column.</li>" +
        "<li>Fill in <strong>SET STATUS</strong> or <strong>SET LOCATION</strong> " +
          "(or both).</li>" +
        "<li>Put your name in <strong>BY</strong>, and say what you know in " +
          "<strong>WHY</strong>. A correction with no reason is skipped, because " +
          "six months from now it is indistinguishable from a mistake.</li>" +
      "</ol>" +
      '<div class="btnrow">' +
        '<a class="btn primary" href="' + SHEET_URL + '" target="_blank" ' +
          'rel="noreferrer noopener">Open the Sheet</a>' +
        '<button class="btn" id="e-cancel">Close</button>' +
      "</div></div>";
  }

  /* Zoom close enough to read the surroundings, not so close the neighbours
   * fall off the screen -- the point of selecting someone is seeing who is
   * around them. Never zooms out if the viewer is already closer in. */
  var FOCUS_ZOOM = 8;

  function focusOnMap(p) {
    if (!state.map || p.lat == null) return;
    state.map.flyTo([p.lat, p.lng], Math.max(state.map.getZoom(), FOCUS_ZOOM),
                    { duration: 0.6 });
  }

  function select(p, list) {
    state.selected = p;
    state.editing = false;
    focusOnMap(p);
    renderSide(list);
  }

  function wireDetail(p, list) {
    Array.prototype.forEach.call(document.querySelectorAll("#side .row.near"), function (el) {
      el.onclick = function () {
        var hit = null;
        list.forEach(function (q) { if (q.name === el.dataset.name) hit = q; });
        if (hit) select(hit, list);
      };
    });

    var b = $("do-back"), e = $("do-edit");
    if (b) b.onclick = function () { state.selected = null; state.editing = false; renderSide(visible()); };
    if (e) e.onclick = function () { state.editing = true; renderSide(visible()); };

    var cancel = $("e-cancel");
    if (cancel) cancel.onclick = function () { state.editing = false; renderSide(visible()); };
  }

  function exportCSV() {
    var list = visible();
    var cols = ["#"].concat(COLS.map(function (c) { return c[1]; }));
    var lines = [cols.map(q).join(",")];
    list.forEach(function (p, i) {
      lines.push([i + 1].concat(COLS.map(function (c) { return p[c[0]]; })).map(q).join(","));
    });
    download(lines.join("\n"), "community-map.csv", "text/csv");
  }
  function q(v) {
    var s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function download(text, name, type) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportEdits() {
    var edits = loadEdits();
    var blob = new Blob([JSON.stringify({ people: edits }, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "overrides-patch.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function render() {
    var list = visible();
    renderCounters(list);
    if (state.view === "map") {
      $("map").hidden = false; $("side").hidden = false; $("tablewrap").hidden = true;
      $("stage").classList.remove("is-table");
      renderMap(list); renderSide(list);
      if (state.map) setTimeout(function () { state.map.invalidateSize(); }, 30);
    } else {
      $("map").hidden = true; $("side").hidden = true; $("tablewrap").hidden = false;
      $("stage").classList.add("is-table");
      renderTable(list);
    }
  }

  function toggle(aId, bId, key, aVal, bVal) {
    function set(v) {
      state[key] = v;
      $(aId).setAttribute("aria-pressed", String(v === aVal));
      $(bId).setAttribute("aria-pressed", String(v === bVal));
      render();
    }
    $(aId).onclick = function () { set(aVal); };
    $(bId).onclick = function () { set(bVal); };
  }

  function boot(data) {
    state.data = data;
    applyEdits(data.people);
    document.title = "Community Map — " + data.meta.counts.total.toLocaleString() + " people";
    toggle("v-map", "v-table", "view", "map", "table");
    toggle("r-us", "r-global", "region", "us", "global");
    toggle("p-roster", "p-all", "pop", "roster", "all");
    // country list, most-populated first, so the useful ones are at the top
    var counts = {};
    data.people.forEach(function (p) { if (p.country) counts[p.country] = (counts[p.country] || 0) + 1; });
    var sorted = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    $("f-country").innerHTML = '<option value="">All countries</option>' +
      sorted.map(function (c) {
        return '<option value="' + esc(c) + '">' + esc(c) + " (" + counts[c] + ")</option>";
      }).join("");
    $("f-status").innerHTML = '<option value="">All statuses</option>' +
      STATUS.map(function (x) { return '<option value="' + x + '">' + x + "</option>"; }).join("");

    $("f-country").onchange = function (e) { state.country = e.target.value; state.page = 0; render(); };
    $("f-status").onchange  = function (e) { state.status  = e.target.value; state.page = 0; render(); };
    $("f-rows").onchange    = function (e) { state.rows = parseInt(e.target.value, 10); state.page = 0; render(); };
    $("pg-prev").onclick    = function () { state.page--; renderTable(visible()); };
    $("pg-next").onclick    = function () { state.page++; renderTable(visible()); };
    $("do-csv").onclick     = exportCSV;

    var t;
    $("q").oninput = function (e) {
      clearTimeout(t);
      var v = e.target.value;
      t = setTimeout(function () { state.q = v; state.page = 0; render(); }, 160);
    };
    render();
  }

  /* Data loading. Two shapes:
   *  - plain people.json (local dev, Spacefast behind its own access gate)
   *  - people.enc: AES-256-CTR + HMAC-SHA256, PBKDF2(200k). The passphrase is
   *    the actual protection on the public fallback host, not a curtain --
   *    without it the file is noise. */
  function gate(msg) {
    $("side-state").innerHTML =
      "<strong>" + esc(msg || "Team passphrase") + "</strong>" +
      '<div class="editor" style="margin-top:var(--s-2)">' +
      '<input id="pw" class="field" type="password" placeholder="Passphrase" autocomplete="current-password">' +
      '<button class="btn primary" id="pw-go">Open</button></div>';
    function go() { unlock($("pw").value).catch(function () { gate("Wrong passphrase — try again"); }); }
    $("pw-go").onclick = go;
    $("pw").onkeydown = function (e) { if (e.key === "Enter") go(); };
    $("pw").focus();
  }

  function unlock(pass) {
    return fetch("data/people.enc").then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
      var b = new Uint8Array(buf);
      var salt = b.slice(0, 16), iv = b.slice(16, 32),
          ct = b.slice(32, b.length - 32), tag = b.slice(b.length - 32);
      var te = new TextEncoder();
      return crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveBits"])
        .then(function (km) {
          return crypto.subtle.deriveBits(
            { name: "PBKDF2", salt: salt, iterations: 200000, hash: "SHA-256" }, km, 512);
        })
        .then(function (bits) {
          var keys = new Uint8Array(bits);
          var encRaw = keys.slice(0, 32), macRaw = keys.slice(32);
          return crypto.subtle.importKey("raw", macRaw, { name: "HMAC", hash: "SHA-256" }, false, ["verify"])
            .then(function (mk) {
              var signed = new Uint8Array(16 + 16 + ct.length);
              signed.set(salt, 0); signed.set(iv, 16); signed.set(ct, 32);
              return crypto.subtle.verify("HMAC", mk, tag, signed);
            })
            .then(function (ok) {
              if (!ok) throw new Error("bad passphrase");
              return crypto.subtle.importKey("raw", encRaw, { name: "AES-CTR" }, false, ["decrypt"]);
            })
            .then(function (ek) {
              return crypto.subtle.decrypt({ name: "AES-CTR", counter: iv, length: 64 }, ek, ct);
            });
        })
        .then(function (pt) {
          sessionStorage.setItem("cm-pass", pass);
          boot(JSON.parse(new TextDecoder().decode(pt)));
        });
    });
  }

  fetch("data/people.json")
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(boot)
    .catch(function () {
      var saved = sessionStorage.getItem("cm-pass");
      if (saved) { unlock(saved).catch(function () { gate(); }); }
      else { gate(); }
    });
})();
