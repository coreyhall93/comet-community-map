/* Community Map dashboard.
 *
 * The product question is "who has gone quiet, and who is near them", so the
 * side panel always answers both halves at once: the quiet people in view, and
 * the active people nearest each of them.
 */
(function () {
  /* ------------------------------------------------------------------ *
   * CARTO basemap key. Paste the key between the quotes.
   * Leave it empty and the map falls back to OpenStreetMap.
   * Free key, no account needed: https://carto.com/basemaps/apikey/
   * ------------------------------------------------------------------ */
  var CARTO_KEY = "cb1_25m2_1_a5feb9438d0b6a23b6834c0a";

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
    map: null, layer: null, selected: null,
    radiusMi: 100, markers: {}, nearStatus: "",
    showA11n: false, a11nLayer: null, a11n: []
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
  function miles(km) { return km * 0.621371; }

  /* Everyone within the radius, nearest first, whatever their status.
   * This used to return active people only, which answered "who can reach
   * them" but hid the more useful picture: a person surrounded by six other
   * dormant people is a place that has gone quiet, not one person who has.
   * Status is a filter on this list, not a precondition for building it. */
  function nearbyPeople(p, list, statusFilter) {
    if (p.lat == null) return [];
    var out = list
      .filter(function (a) { return a.lat != null && keyOf(a) !== keyOf(p); })
      .map(function (a) { return { p: a, d: distance(p, a) }; })
      .filter(function (h) { return !state.radiusMi || miles(h.d) <= state.radiusMi; })
      .sort(function (x, y) { return x.d - y.d; });
    if (statusFilter) {
      out = out.filter(function (h) { return h.p.status === statusFilter; });
    }
    return out;
  }

  /* The quiet list still asks the narrower question -- "who could reach this
   * person" -- so it wants active people only. Same radius, same self-exclusion. */
  function nearestActive(p, list, n) {
    return nearbyPeople(p, list, "active").slice(0, n || 3);
  }

  /* What the neighbourhood is made of, as counts per status. This is the
   * number that answers "is this a cluster of red dots" without squinting. */
  function nearbyTally(p, list) {
    var t = {};
    nearbyPeople(p, list).forEach(function (h) {
      t[h.p.status] = (t[h.p.status] || 0) + 1;
    });
    return t;
  }

  /* The closest active person regardless of radius, so a "nobody within N
   * miles" message can still say how far the nearest one actually is. */
  function nearestAnywhere(p, list) {
    if (p.lat == null) return null;
    var best = null;
    list.forEach(function (a) {
      if (a.status !== "active" || a.lat == null || keyOf(a) === keyOf(p)) return;
      var dd = distance(p, a);
      if (!best || dd < best.d) best = { p: a, d: dd };
    });
    return best;
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
    // Basemap. CARTO's tiles need an API key now (free, 5M tiles/month) and
    // stamp "API KEY REQUIRED" across every tile without one. The key is
    // domain-restricted and ships in client-side JS by design, the same way
    // every web map key does. With no key set this falls back to OpenStreetMap
    // so the map is never broken, only plainer.
    var carto = CARTO_KEY
      ? L.tileLayer("https://{s}.basemaps.cartocdn.com/" + (dark() ? "dark_all" : "light_all") +
          "/{z}/{x}/{y}{r}.png?key=" + encodeURIComponent(CARTO_KEY),
          { attribution: "&copy; OpenStreetMap &copy; CARTO", subdomains: "abcd", maxZoom: 20 })
      : L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          { attribution: "&copy; OpenStreetMap contributors", maxZoom: 18 });
    carto.addTo(state.map);

    function dark() {
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    }
    function syncTheme(isDark) {
      if (CARTO_KEY) {
        carto.setUrl("https://{s}.basemaps.cartocdn.com/" + (isDark ? "dark_all" : "light_all") +
          "/{z}/{x}/{y}{r}.png?key=" + encodeURIComponent(CARTO_KEY));
      } else {
        // OSM has no dark style, so invert it in CSS instead.
        var pane = state.map.getPane("tilePane");
        if (pane) pane.classList.toggle("is-dark", !!isDark);
      }
    }
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      syncTheme(mq.matches);
      mq.addEventListener("change", function (e) { syncTheme(e.matches); });
    }

    // Clustering. Half this dataset is geocoded to a city or country centroid,
    // so dozens of people land on the exact same pixel and only the top one is
    // clickable. Clustering makes the pile legible: one bubble carrying the
    // count, coloured by whichever status dominates it, so a red cluster reads
    // as a place that has gone quiet at a glance. Clicking drills in, and at
    // full zoom identical coordinates fan out rather than stacking.
    state.layer = L.markerClusterGroup({
      maxClusterRadius: 45,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      // No disableClusteringAtZoom on purpose. Turning clustering off at high
      // zoom would let people geocoded to the same city centroid stack on one
      // pixel again, which is the problem clustering is here to solve. Keeping
      // it on at every zoom means a pile of identical coordinates always stays
      // a countable bubble, and clicking it fans the members out on legs.
      spiderLegPolylineOptions: { weight: 1, color: "#9aa2ad", opacity: 0.7 },
      iconCreateFunction: clusterIcon
    }).addTo(state.map);
  }

  /* Colour by plurality -- whichever status actually dominates the pile. An
   * earlier version ranked "inactive" highest, which made every cluster grey,
   * because with 3,217 inactive people almost every pile contains one. Ties
   * break toward the status that needs attention, so a cluster split evenly
   * between active and dormant reads dormant rather than healthy. */
  var CLUSTER_RANK = ["dormant", "inactive", "slowing", "unknown", "new", "active"];

  function clusterIcon(cluster) {
    var kids = cluster.getAllChildMarkers();
    var tally = {};
    kids.forEach(function (m) {
      var s = m.options.personStatus || "unknown";
      tally[s] = (tally[s] || 0) + 1;
    });
    var dominant = Object.keys(tally).sort(function (a, b) {
      if (tally[b] !== tally[a]) return tally[b] - tally[a];          // most numerous
      return CLUSTER_RANK.indexOf(a) - CLUSTER_RANK.indexOf(b);       // then most urgent
    })[0] || "unknown";
    var n = kids.length;
    var size = n < 10 ? 30 : n < 50 ? 38 : n < 200 ? 46 : 54;
    return L.divIcon({
      className: "",
      html: '<div class="cluster ' + dominant + '" style="width:' + size + "px;height:" + size +
            'px"><span>' + (n < 1000 ? n : Math.round(n / 100) / 10 + "k") + "</span></div>",
      iconSize: [size, size], iconAnchor: [size / 2, size / 2]
    });
  }

  /* Automattician overlay. Distinct SHAPE, not just a distinct colour: three
   * colour-coded layers on one map fail for anyone colour-blind or reading a
   * greyscale screenshot, so these are diamonds and community people are
   * circles. Internal only -- see the note in build_data.py. */
  function a11nKey(a) { return "a11n:" + a.name; }

  function renderA11n() {
    if (!state.map) return;
    if (state.a11nLayer) { state.map.removeLayer(state.a11nLayer); state.a11nLayer = null; }
    if (!state.showA11n || !state.a11n.length) return;

    state.a11nLayer = L.markerClusterGroup({
      maxClusterRadius: 45,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      spiderLegPolylineOptions: { weight: 1, color: "#9aa2ad", opacity: 0.7 },
      iconCreateFunction: function (c) {
        var n = c.getChildCount();
        var size = n < 10 ? 28 : n < 50 ? 34 : 42;
        return L.divIcon({
          className: "",
          html: '<div class="cluster a11n" style="width:' + size + "px;height:" + size +
                'px"><span>' + n + "</span></div>",
          iconSize: [size, size], iconAnchor: [size / 2, size / 2]
        });
      }
    });

    state.a11n.forEach(function (a) {
      var m = L.marker([a.lat, a.lng], {
        icon: L.divIcon({
          className: "",
          html: '<div class="pin a11n"></div>',
          iconSize: [11, 11], iconAnchor: [5.5, 5.5]
        }),
        title: a.name || a.role
      });
      m.bindPopup("<strong>" + esc(a.name || "Name not listed") + "</strong><br>" +
                  esc(a.role) + '<br><span class="popup-def">Automattician</span>');
      state.markers[a11nKey(a)] = m;
      state.a11nLayer.addLayer(m);
    });
    state.a11nLayer.addTo(state.map);
  }

  /* Automatticians within the radius of a given person. This is the payoff the
   * layer exists for: a quiet supporter with an Automattician half an hour away
   * is a specific lead, not a statistic. */
  function nearbyA11n(p) {
    if (p.lat == null || !state.a11n.length) return [];
    return state.a11n
      .map(function (a) { return { p: a, d: distance(p, a) }; })
      .filter(function (h) { return !state.radiusMi || miles(h.d) <= state.radiusMi; })
      .sort(function (x, y) { return x.d - y.d; });
  }

  function renderMap(list) {
    if (!state.map) initMap();
    state.layer.clearLayers();
    state.markers = {};
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
        title: p.name,
        personStatus: p.status
      });
      m.on("click", function () { select(p, list); });
      state.markers[keyOf(p)] = m;
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
      // fitBounds against a pane Leaflet still measures as zero-height silently
      // falls back to zoom 0, which is how a map of 637 United States dots ends
      // up showing the whole globe. Fit once now and again after the browser has
      // settled layout, so the result does not depend on load-timing luck.
      var bounds = L.latLngBounds(placed.map(function (p) { return [p.lat, p.lng]; })).pad(0.15);
      var fit = function () {
        if (!state.map || state.selected) return;   // never fight a selection fly-to
        state.map.invalidateSize(false);
        state.map.fitBounds(bounds);
      };
      fit();
      requestAnimationFrame(fit);
    }
    renderA11n();
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

    var reachable = quiet.filter(function (p) { return p.status === "dormant"; }).length;
    var html = pendingHTML() +
      '<p class="label">Gone quiet — ' + quiet.length + "</p>" +
      '<p class="hint">' + reachable + " went quiet within the last year, listed first. " +
      "Supporters with a role rank above general members.</p>";

    if (!quiet.length) {
      html += '<div class="state">No dormant people in this view.</div>';
    } else {
      html += quiet.slice(0, 60).map(function (p) {
        var near = nearestActive(p, list, 1)[0] || null;
        var reach;
        if (near) {
          reach = '<div class="meta">Nearest active: <strong>' + esc(near.p.name) +
                  "</strong> · " + km(near.d) + "</div>";
        } else if (p.lat == null) {
          reach = '<div class="meta subtle">No location on record</div>';
        } else {
          // Say how far the nearest one actually is, so the radius can be
          // widened deliberately rather than guessed at.
          var far = nearestAnywhere(p, list);
          reach = '<div class="meta subtle">Nobody active within ' + state.radiusMi + " mi" +
                  (far ? " · closest is " + esc(far.p.name) + " at " + km(far.d) : "") + "</div>";
        }
        return '<div class="row" data-name="' + esc(p.name) + '" data-key="' + esc(keyOf(p)) + '">' +
          '<div class="nm">' + esc(p.name) + ' <span class="tag ' + p.status + '">' + p.status + "</span></div>" +
          '<div class="meta">' + roleHTML(p.role) +
            (p.last_seen ? " · last seen " + esc(p.last_seen) : " · no signal on record") +
          "</div>" + reach +
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
      var key = el.dataset.key;
      // Match on the .org key, not the name: 78 names in this dataset are shared
      // by more than one person, so name matching selects the wrong one.
      var hit = null;
      list.forEach(function (x) { if (keyOf(x) === key) hit = x; });
      el.onmouseenter = function () { markMarker(key, "is-hot", true); };
      el.onmouseleave = function () { markMarker(key, "is-hot", false); };
      el.onclick = function () { if (hit) select(hit, list); };
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
      // Exit sits at the top. It was below the whole record, which meant
      // scrolling past everything to get back to the list you came from.
      '<button class="backlink" id="do-back">&larr; All people</button>' +
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
      "</div>" +
    "</div>";
  }

  function radiusSliderHTML() {
    // A slider, not a dropdown: the question is "how far is too far", which is
    // a continuous judgement made by feel rather than picked from a list.
    return '<div class="radius">' +
      '<div class="radius-row">' +
        '<input id="f-radius" type="range" min="25" max="300" step="25" value="' +
          state.radiusMi + '" aria-label="Radius in miles">' +
        '<output class="radius-out" id="f-radius-out">' + state.radiusMi + ' mi</output>' +
      "</div></div>";
  }

  /* Status chips double as the neighbourhood summary: each one carries its own
   * count inside the radius, so the make-up of the area is readable before any
   * filter is applied. Clicking one narrows the list; clicking it again clears. */
  function nearFilterHTML(tally) {
    var order = ["active", "new", "slowing", "dormant", "inactive", "unknown"];
    var total = order.reduce(function (n, s) { return n + (tally[s] || 0); }, 0);
    var chips = '<button class="chip' + (state.nearStatus ? "" : " on") +
                '" data-status="">All ' + total + "</button>";
    chips += order.filter(function (s) { return tally[s]; }).map(function (s) {
      return '<button class="chip ' + s + (state.nearStatus === s ? " on" : "") +
             '" data-status="' + s + '">' + s + " " + tally[s] + "</button>";
    }).join("");
    return '<div class="chips">' + chips + "</div>";
  }

  /* Automatticians near this person, shown only while the layer is on. Kept as
   * its own block rather than mixed into the list above, because they are a
   * different kind of thing: no activity status, and reachable for a different
   * reason -- they are staff who can be asked to make contact. */
  function a11nHTML(p) {
    if (!state.showA11n || p.lat == null) return "";
    var near = nearbyA11n(p);
    if (!near.length) {
      return '<div class="a11n-block"><p class="label">Automatticians nearby</p>' +
        '<div class="state">None within ' + state.radiusMi + " miles.</div></div>";
    }
    // Named people first at equal distance: an unnamed dot still counts toward
    // "is there anyone near here", but only a named one can actually be asked.
    var named = near.filter(function (h) { return (h.p.name || "").trim(); });
    var anon = near.length - named.length;
    var show = named.slice(0, 5);

    return '<div class="a11n-block">' +
      '<p class="label">Automatticians nearby · ' + near.length + "</p>" +
      (show.length
        ? '<div class="nearlist">' + show.map(function (h) {
            return '<div class="row near is-a11n" data-name="' + esc(h.p.name) +
                '" data-key="' + esc(a11nKey(h.p)) + '">' +
              '<div class="nm">' + esc(h.p.name) + ' <span class="tag a11n">a8c</span></div>' +
              '<div class="meta">' + esc(h.p.role) + "</div>" +
              '<div class="meta"><strong>' + km(h.d) + "</strong> away</div>" +
            "</div>";
          }).join("") + "</div>"
        : "") +
      (named.length > 5 ? '<p class="hint">' + (named.length - 5) +
        " more named within range.</p>" : "") +
      (anon ? '<p class="hint subtle">' + anon + " more " +
        (anon === 1 ? "is" : "are") + " in range but not named on automattic.com/map, " +
        "so they are counted here and not listed.</p>" : "") +
      "</div>";
  }

  function nearHTML(p, list) {
    if (p.lat == null) {
      return '<p class="label">Who is nearby</p>' +
        '<div class="state">This person has no location on record, so proximity ' +
        "cannot be worked out. Correcting their location puts them on the map.</div>";
    }
    var tally = nearbyTally(p, list);
    var rows = nearbyPeople(p, list, state.nearStatus).slice(0, 12);
    var head = '<p class="label">Who is nearby</p>' + radiusSliderHTML() + nearFilterHTML(tally);

    if (!Object.keys(tally).length) {
      var far = nearestAnywhere(p, list);
      return head +
        '<div class="state"><strong>Nobody within ' + state.radiusMi + ' miles.</strong>' +
        (far ? "The closest active person is " + esc(far.p.name) + " in " +
               esc(far.p.city || far.p.country || "an unknown place") + ", " + km(far.d) +
               " away. Drag the slider out if that still counts as reachable."
             : "No one else in this view has a location to compare against.") +
        "</div>";
    }
    if (!rows.length) {
      return head + a11nHTML(p) + '<div class="state">Nobody ' + esc(state.nearStatus) +
             " within " + state.radiusMi + " miles. Clear the filter to see everyone.</div>";
    }
    return head + a11nHTML(p) +
      '<p class="hint">Nearest first. Hover a name to find them on the map.</p>' +
      '<div class="nearlist">' + rows.map(function (h) {
        return '<div class="row near" data-name="' + esc(h.p.name) + '" data-key="' +
            esc(keyOf(h.p)) + '">' +
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

  /* Highlighting is done on the marker's own element rather than by re-rendering
   * the layer, so hovering a name in the panel is instant and does not disturb
   * the map. Selecting someone marks their dot; hovering a nearby candidate
   * marks theirs, which is what makes "who is near them" legible at a glance. */
  function markMarker(key, cls, on) {
    var m = state.markers[key];
    var el = m && m.getElement && m.getElement();
    if (!el) return;
    var pin = el.querySelector(".pin") || el;
    pin.classList.toggle(cls, !!on);
  }

  function clearMarks(cls) {
    Object.keys(state.markers).forEach(function (k) { markMarker(k, cls, false); });
  }

  /* Zoom close enough to read the surroundings, not so close the neighbours
   * fall off the screen -- the point of selecting someone is seeing who is
   * around them. Never zooms out if the viewer is already closer in. */
  var FOCUS_ZOOM = 8;

  function focusOnMap(p, then) {
    if (!state.map || p.lat == null) return;
    var m = state.markers[keyOf(p)];
    state.map.flyTo([p.lat, p.lng], Math.max(state.map.getZoom(), FOCUS_ZOOM),
                    { duration: 0.6 });
    // A clustered marker has no element to mark or pop until the cluster is
    // opened, so ask the cluster group to reveal it -- it zooms in, or fans
    // the pile out when several people share one coordinate.
    setTimeout(function () {
      if (!m || !state.layer.zoomToShowLayer) { if (then) then(m); return; }
      try {
        state.layer.zoomToShowLayer(m, function () { if (then) then(m); });
      } catch (e) {
        if (then) then(m);
      }
    }, 620);
  }

  function select(p, list) {
    state.selected = p;
    state.editing = false;
    renderSide(list);
    clearMarks("is-picked");
    clearMarks("is-near");
    // One selection, both surfaces: the panel shows the record, and the map
    // reveals their dot, marks it and opens its popup. Selecting from the list
    // used to leave the map silent, so you had to work out which dot it was.
    focusOnMap(p, function (m) {
      if (state.selected !== p) return;
      markMarker(keyOf(p), "is-picked", true);
      nearbyPeople(p, list).forEach(function (h) {
        markMarker(keyOf(h.p), "is-near", true);
      });
      if (m && m.openPopup) m.openPopup();
    });
  }

  function wireDetail(p, list) {
    var rad = $("f-radius"), radOut = $("f-radius-out");
    if (rad) {
      rad.oninput = function (e) {
        state.radiusMi = parseInt(e.target.value, 10);
        if (radOut) radOut.textContent = state.radiusMi + " mi";
      };
      // Re-render on release rather than on every pixel of drag, so the list
      // does not thrash under the cursor.
      rad.onchange = function () {
        renderSide(visible());
        clearMarks("is-near");
        nearbyPeople(p, visible()).forEach(function (h) {
          markMarker(keyOf(h.p), "is-near", true);
        });
      };
    }

    Array.prototype.forEach.call(document.querySelectorAll("#side .chip"), function (el) {
      el.onclick = function () {
        var s = el.dataset.status || "";
        state.nearStatus = (state.nearStatus === s) ? "" : s;
        renderSide(visible());
      };
    });

    Array.prototype.forEach.call(document.querySelectorAll("#side .row.near"), function (el) {
      var key = el.dataset.key;
      el.onmouseenter = function () { markMarker(key, "is-hot", true); };
      el.onmouseleave = function () { markMarker(key, "is-hot", false); };
      el.onclick = function () {
        var hit = null;
        list.forEach(function (q) { if (keyOf(q) === key) hit = q; });
        if (hit) select(hit, list);
      };
    });

    var b = $("do-back"), e = $("do-edit");
    if (b) b.onclick = function () {
      state.selected = null;
      state.editing = false;
      if (state.map) state.map.closePopup();
      clearMarks("is-picked");
      clearMarks("is-near");
      renderSide(visible());
    };
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
    state.a11n = data.automatticians || [];
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
    $("l-a11n").onclick = function () {
      state.showA11n = !state.showA11n;
      $("l-a11n").setAttribute("aria-pressed", state.showA11n ? "true" : "false");
      renderA11n();
      renderSide(visible());   // the nearby panel gains or loses its a11n section
    };

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
