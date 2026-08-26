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
    // Landing state: the 96 people who hold a Community Team role, worldwide.
    // Region defaults to global because the roster is global -- Karen is in New
    // Mexico, Cheyne in New Zealand, Maruti in India, Isotta and Juan in Spain.
    // Filtering to the United States on load cut the list to 11 people and 5
    // quiet ones, which reads as an empty tool and hides most of Comet's remit.
    // "Everyone in Slack" is one click away and shows all 7,032.
    data: null, view: "map", region: "global", pop: "roster", q: "",
    country: "", status: "", rows: 50, page: 0,
    map: null, layer: null, selected: null,
    radiusMi: 100, markers: {}, nearStatus: "",
    a11n: [], meetups: [], selectedMeetup: null,
    // Overlay on/off and the live cluster group, keyed by descriptor id, so
    // adding a layer never means adding two more state fields.
    overlays: {}, overlayLayers: {},
    set: [], showSet: false
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

  /* Distances round to the kilometre, so 0 means "under 500m apart on record"
   * -- which in this dataset almost always means two people resolved to the
   * same city or country centroid, not that they are neighbours. Saying "0 mi"
   * invites someone to read a shared centroid as walking distance. */
  function km(n) {
    if (n === 0) return "same place on record";
    return n.toLocaleString() + " km / " + Math.round(n * 0.621371).toLocaleString() + " mi";
  }

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
    /* zoomSnap 0.5 lets a wheel gesture land between integer zooms instead of
     * jumping a whole level at a time, and the slower wheel ratio stops one
     * flick crossing three levels. zoomAnimation keeps markers travelling with
     * the tiles rather than disappearing and popping back. */
    state.map = L.map("map", {
      worldCopyJump: true, zoomControl: true,
      zoomSnap: 0.5, zoomDelta: 0.5,
      wheelPxPerZoomLevel: 140, wheelDebounceTime: 45,
      zoomAnimation: true, markerZoomAnimation: true,
      inertia: true, inertiaDeceleration: 2200
    }).setView([39.5, -98.35], 4);
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
    // Anything that can rebuild marker elements has to repaint the selection.
    state.map.on("zoomend moveend", function () { setTimeout(repaintSelection, 60); });

    state.layer = L.markerClusterGroup({
      maxClusterRadius: 45,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      // Default spacing packs a seven-person fan into a few dozen pixels, so
      // one twitch lands on the map instead of a person and the whole fan
      // collapses. Spread them right out.
      spiderfyDistanceMultiplier: 2.6,
      // No disableClusteringAtZoom on purpose. Turning clustering off at high
      // zoom would let people geocoded to the same city centroid stack on one
      // pixel again, which is the problem clustering is here to solve. Keeping
      // it on at every zoom means a pile of identical coordinates always stays
      // a countable bubble, and clicking it fans the members out on legs.
      spiderLegPolylineOptions: { weight: 1, color: "#9aa2ad", opacity: 0.7 },
      iconCreateFunction: clusterIcon
    }).addTo(state.map);
    state.layer.on("animationend", repaintSelection);
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
      html: '<div class="cluster circle ' + dominant + '" style="width:' + size + "px;height:" + size +
            'px"><span>' + (n < 1000 ? n : Math.round(n / 100) / 10 + "k") + "</span></div>",
      iconSize: [size, size], iconAnchor: [size / 2, size / 2]
    });
  }

  /* Meetup overlay. Squares, so the three layers read as circle (person),
   * square (group) and diamond (Automattician) -- distinguishable in greyscale
   * and to a colour-blind reader, which three colours alone would not be.
   *
   * Status is upstream's, on a 365-day window. A meetup that met ten months ago
   * is "Active" here while a person silent for two months is "slowing". That is
   * deliberate and the legend says so; do not reconcile the two scales. */
  /* --- working set --------------------------------------------------------
   *
   * A basket you fill from anywhere on the map and then take somewhere else.
   *
   * Filters answer "who matches these criteria". They cannot answer "these
   * particular seven people and that meetup group, because I have a reason for
   * each of them". That reason lives in the reader's head and no filter will
   * ever reconstruct it, so the tool has to let them assemble the set by hand.
   *
   * It deliberately survives filtering, layer toggles and reload: you build it
   * WHILE moving around the map, and changing the view to find the next person
   * must not throw away the last one. localStorage, because there is no server
   * and this is one person's scratch list, not shared state. */
  var SET_KEY = "community-map-set";

  function loadSet() {
    try { return JSON.parse(localStorage.getItem(SET_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function persistSet() {
    try { localStorage.setItem(SET_KEY, JSON.stringify(state.set)); } catch (e) {}
  }

  function setIdOf(kind, rec) {
    if (kind === "person") return "person:" + keyOf(rec);
    if (kind === "meetup") return overlayById("meetups").key(rec);
    return overlayById("a11n").key(rec);
  }
  function inSet(kind, rec) {
    var id = setIdOf(kind, rec);
    return state.set.some(function (e) { return e.id === id; });
  }

  /* Snapshot rather than reference: the set has to keep meaning something after
   * a rebuild, and an entry whose record has vanished should still export. */
  function toggleSet(kind, rec) {
    var id = setIdOf(kind, rec);
    var at = -1;
    state.set.forEach(function (e, i) { if (e.id === id) at = i; });
    if (at >= 0) {
      state.set.splice(at, 1);
    } else {
      var e = { id: id, kind: kind, added: new Date().toISOString().slice(0, 10) };
      if (kind === "person") {
        e.name = rec.name; e.role = rec.role; e.status = rec.status;
        e.org = rec.org || ""; e.slack = rec.slack || "";
        e.last_seen = rec.last_seen || ""; e.employer = rec.employer || "";
        e.a8c = !!rec.a8c;
        e.city = rec.city || ""; e.country = rec.country || "";
        e.lat = rec.lat; e.lng = rec.lng;
      } else if (kind === "meetup") {
        e.name = rec.group; e.status = rec.status; e.role = "Meetup group";
        e.city = rec.city || ""; e.country = rec.country || "";
        e.members = rec.members; e.last_seen = rec.lastEvent || "";
        e.url = rec.url || ""; e.lat = rec.lat; e.lng = rec.lng;
      } else {
        e.name = rec.name || "Name not listed"; e.role = rec.role || "";
        e.status = "a8c"; e.org = rec.org || "";
        e.lat = rec.lat; e.lng = rec.lng;
      }
      state.set.push(e);
    }
    persistSet();
    renderSetCount();
    render();
    return at < 0;
  }

  function renderSetCount() {
    var b = $("set-btn");
    if (!b) return;
    b.textContent = state.set.length ? "Set · " + state.set.length : "Set";
    b.setAttribute("aria-pressed", state.showSet ? "true" : "false");
    b.disabled = false;
  }

  function setAddButtonHTML(kind, rec) {
    var on = inSet(kind, rec);
    return '<button class="btn set-add' + (on ? " on" : "") +
      '" data-setkind="' + kind + '" data-setid="' + esc(setIdOf(kind, rec)) + '">' +
      (on ? "&#10003; In set" : "+ Add to set") + "</button>";
  }

  /* Everything in the set, as a CSV that can be acted on without the map open --
   * handed to someone, pasted into a sheet, or given to an AI agent. Distances
   * are deliberately not included: the set is a list of things, and what pairs
   * with what is a judgement the reader made, not a column. */
  function exportSet() {
    var cols = ["kind", "name", "role", "status", "a8c", "location", "country",
                "last seen", "members", "org", "slack", "lat", "lng", "url", "added"];
    var lines = [cols.map(q).join(",")];
    state.set.forEach(function (e) {
      lines.push([e.kind, e.name, e.role || "", e.status || "",
                  e.a8c ? "yes" : "", e.city || "", e.country || "",
                  e.last_seen || "", e.members == null ? "" : e.members,
                  e.org || "", e.slack || "",
                  e.lat == null ? "" : e.lat, e.lng == null ? "" : e.lng,
                  e.url || "", e.added].map(q).join(","));
    });
    download(lines.join("\n"), "community-map-set.csv", "text/csv");
  }

  /* --- layer registry -----------------------------------------------------
   *
   * People are the BASE layer, not an entry here: they drive the filter bar,
   * the counters, the table and the quiet list, and forcing them into the same
   * descriptor as a meetup group would bend both out of shape. Everything drawn
   * ON TOP of them is an overlay, and every overlay is one descriptor.
   *
   * This exists because meetups and Automatticians were hand-rolled twice --
   * two render functions, two proximity functions, two panel builders, two sets
   * of toggle wiring, all near-identical. Adding WordPress events or the other
   * Make teams would have been a third and fourth copy. Now it is a descriptor.
   *
   * A descriptor declares:
   *   id, label, title  identity and the toggle's tooltip
   *   shape             circle | square | diamond. SHAPE MEANS LAYER. Status is
   *                     carried by colour, never by shape, or a diamond means
   *                     two things depending on which toggles are on.
   *   data()            the records
   *   key(r)            stable id, namespaced so it cannot collide with a person
   *   name(r)           display name
   *   cls(r)            status class for the marker and tag
   *   statusLabel(r)    human status
   *   quiet(r)          true when this record is the kind worth acting on;
   *                     those sort first in the panel
   *   avatar(r)         image url, or null
   *   popup(r)          map popup markup
   *   meta(r, d)        the two meta lines under a name in the nearby list
   *   blockLabel        heading for that nearby block
   *   note(recs)        optional line under the heading
   *   select(r)         what happens when its marker is clicked
   *   clusterCls(kids)  status class for a cluster of these
   */
  var MEETUP_CLASS = { "Active": "m-active", "Dormant": "m-dormant", "Not started": "m-never" };

  var OVERLAYS = [
    {
      id: "meetups",
      label: "Meetups",
      title: "WordPress meetup groups, coloured by whether they are still meeting. " +
             "From Maruti Mohanty's events dashboard.",
      shape: "square",
      data: function () { return state.meetups; },
      key: function (m) { return "meetup:" + m.group; },
      name: function (m) { return m.group; },
      cls: function (m) { return MEETUP_CLASS[m.status] || "m-never"; },
      statusLabel: function (m) { return m.status; },
      quiet: function (m) { return m.status === "Dormant"; },
      avatar: function () { return null; },
      select: function (m) { selectMeetup(m); },
      blockLabel: "Meetups nearby",
      note: function (recs) {
        var d = recs.filter(function (h) { return h.p.status === "Dormant"; }).length;
        return d ? "Dormant groups first — a group that has stopped meeting with " +
                   "someone active beside it is the clearest lead here." : "";
      },
      popup: function (m) {
        return "<strong>" + esc(m.group) + "</strong><br>" +
          esc(m.city || "") + (m.country ? ", " + esc(m.country) : "") + "<br>" +
          m.members.toLocaleString() + " members · " + m.pastEvents + " past events<br>" +
          '<span class="tag ' + (MEETUP_CLASS[m.status] || "m-never") + '">' + esc(m.status) + "</span>" +
          (m.lastEvent ? '<br><span class="popup-def">last event ' + esc(m.lastEvent) + "</span>"
                       : '<br><span class="popup-def">no events on record</span>') +
          (m.url ? '<br><a href="' + esc(m.url) + '" target="_blank" rel="noreferrer noopener">meetup.com</a>' : "");
      },
      meta: function (m, d) {
        return [
          esc(m.city || m.country || "") + " · " + m.members.toLocaleString() + " members",
          (m.lastEvent ? "last event " + esc(m.lastEvent) : "no events on record") +
            " · <strong>" + km(d) + "</strong> away"
        ];
      },
      clusterCls: function (kids) {
        var dormant = kids.filter(function (k) { return k.options.rStatus === "Dormant"; }).length;
        return dormant > kids.length / 2 ? "m-dormant" : "m-active";
      }
    },
    {
      id: "a11n",
      label: "Automatticians",
      title: "Overlay every Automattician from automattic.com/map. Internal only.",
      shape: "diamond",
      data: function () { return state.a11n; },
      key: function (a) { return "a11n:" + (a.name || a.role) + ":" + a.lat + "," + a.lng; },
      name: function (a) { return a.name || "Name not listed"; },
      cls: function () { return "a11n"; },
      statusLabel: function () { return "a8c"; },
      quiet: function () { return false; },
      avatar: function (a) { return a.avatar || null; },
      select: null,                       // no record panel of their own yet
      blockLabel: "Automatticians nearby",
      note: function (recs) {
        var anon = recs.filter(function (h) { return !(h.p.name || "").trim(); }).length;
        return anon ? anon + " of these " + (anon === 1 ? "is" : "are") +
                      " not named on automattic.com/map, so they are counted and not listed." : "";
      },
      popup: function (a) {
        return "<strong>" + esc(a.name || "Name not listed") + "</strong><br>" +
          esc(a.role) + '<br><span class="popup-def">Automattician</span>';
      },
      meta: function (a, d) {
        return [esc(a.role), "<strong>" + km(d) + "</strong> away"];
      },
      clusterCls: function () { return "a11n"; }
    }
  ];

  function overlayById(id) {
    return OVERLAYS.filter(function (o) { return o.id === id; })[0];
  }

  function overlayOn(id) { return !!state.overlays[id]; }

  /* One renderer for every overlay. Was two near-identical functions. */
  function renderOverlay(def) {
    if (!state.map) return;
    var live = state.overlayLayers[def.id];
    if (live) { state.map.removeLayer(live); state.overlayLayers[def.id] = null; }
    if (!overlayOn(def.id)) return;

    var recs = (def.data() || []).filter(function (r) { return r.lat != null; });
    if (!recs.length) return;

    var group = L.markerClusterGroup({
      maxClusterRadius: 45, spiderfyOnMaxZoom: true, showCoverageOnHover: false,
      spiderfyDistanceMultiplier: 2.6,
      spiderLegPolylineOptions: { weight: 1.5, color: "#8892a0", opacity: 0.8 },
      iconCreateFunction: function (c) {
        var kids = c.getAllChildMarkers();
        var n = kids.length;
        var size = n < 10 ? 36 : n < 50 ? 42 : 50;
        return L.divIcon({
          className: "",
          html: '<div class="cluster ' + def.shape + " " + def.clusterCls(kids) +
                '" style="width:' + size + "px;height:" + size + 'px"><span>' + n + "</span></div>",
          iconSize: [size, size], iconAnchor: [size / 2, size / 2]
        });
      }
    });

    recs.forEach(function (r) {
      var av = def.avatar(r);
      var box = av ? AVATAR_PX : 17;
      var m = L.marker([r.lat, r.lng], {
        icon: L.divIcon({
          className: "",
          html: av
            ? avatarPinHTML(av, def.shape + " " + def.cls(r) +
                (inSet(def.id === "meetups" ? "meetup" : "a11n", r) ? " in-set" : ""),
                box, def.shape === "diamond")
            : '<div class="pin ' + def.shape + " " + def.cls(r) +
              (inSet(def.id === "meetups" ? "meetup" : "a11n", r) ? " in-set" : "") +
              '" style="width:' + box + "px;height:" + box + 'px"></div>',
          iconSize: [box, box], iconAnchor: [box / 2, box / 2]
        }),
        title: def.name(r),
        rStatus: def.statusLabel(r)
      });
      m.bindPopup(def.popup(r));
      if (def.select) m.on("click", function () { def.select(r); });
      state.markers[def.key(r)] = m;
      group.addLayer(m);
    });

    group.on("animationend", repaintSelection);
    group.addTo(state.map);
    state.overlayLayers[def.id] = group;
  }

  function renderOverlays() { OVERLAYS.forEach(renderOverlay); }

  /* One proximity function for every overlay. Was two. */
  function nearbyIn(def, p) {
    if (p.lat == null) return [];
    return (def.data() || [])
      .filter(function (r) { return r.lat != null; })
      .map(function (r) { return { p: r, d: distance(p, { lat: r.lat, lng: r.lng }) }; })
      .filter(function (h) { return !state.radiusMi || miles(h.d) <= state.radiusMi; })
      .sort(function (x, y) { return x.d - y.d; });
  }

  /* One nearby-block builder for every overlay. Was two. */
  function overlayBlockHTML(def, p) {
    if (!overlayOn(def.id) || p.lat == null) return "";
    var near = nearbyIn(def, p);
    if (!near.length) {
      return '<div class="a11n-block"><p class="label">' + esc(def.blockLabel) + "</p>" +
        '<div class="state">None within ' + state.radiusMi + " miles.</div></div>";
    }
    // Whatever the layer calls "worth acting on" sorts first.
    var lead = near.filter(function (h) { return def.quiet(h.p); });
    var rest = near.filter(function (h) { return !def.quiet(h.p); });
    var ordered = lead.concat(rest).filter(function (h) { return (def.name(h.p) || "").trim(); });
    var note = def.note ? def.note(near) : "";

    return '<div class="a11n-block">' +
      '<p class="label">' + esc(def.blockLabel) + " · " + near.length +
        (lead.length ? " · " + lead.length + " dormant" : "") + "</p>" +
      (note ? '<p class="hint">' + note + "</p>" : "") +
      '<div class="nearlist">' + ordered.slice(0, 5).map(function (h) {
        var lines = def.meta(h.p, h.d);
        return '<div class="row near is-' + def.id + '" data-name="' + esc(def.name(h.p)) +
            '" data-key="' + esc(def.key(h.p)) + '">' +
          '<div class="nm">' + esc(def.name(h.p)) +
            ' <span class="tag ' + def.cls(h.p) + '">' + esc(def.statusLabel(h.p)) + "</span></div>" +
          lines.map(function (l) { return '<div class="meta">' + l + "</div>"; }).join("") +
        "</div>";
      }).join("") + "</div>" +
      (ordered.length > 5 ? '<p class="hint">' + (ordered.length - 5) + " more within range.</p>" : "") +
      "</div>";
  }

  function overlayBlocksHTML(p) {
    return OVERLAYS.map(function (def) { return overlayBlockHTML(def, p); }).join("");
  }

  var AVATAR_PX = 34;

  function avatarPinHTML(url, cls, size, counterRotate) {
    var s = size || AVATAR_PX;
    return '<div class="pin has-avatar ' + cls + '" style="width:' + s + "px;height:" + s + 'px">' +
      '<img src="' + esc(url) + "?s=" + (s * 2) + '" alt="" loading="lazy"' +
      (counterRotate ? ' class="counter-rot"' : "") + "></div>";
  }

  function renderMap(list) {
    if (!state.map) initMap();
    state.layer.clearLayers();
    state.markers = {};
    var placed = list.filter(function (p) { return p.lat != null; });

    placed.forEach(function (p) {
      // Hit targets, not decoration. A 10px dot is a hard click on a trackpad
      // and effectively unclickable for anyone whose eyes are not 25 -- the
      // whole map is unusable if you cannot reliably land on a person.
      var size = p.tier === "roster" ? 20 : 16;
      var cls = "circle " + p.status + (p.tier === "roster" ? " is-roster" : "") +
                (p.a8c ? " is-a8c" : "") + (inSet("person", p) ? " in-set" : "");
      var html, box;
      if (p.avatar) {
        box = AVATAR_PX;
        html = avatarPinHTML(p.avatar, cls, box, false);
      } else {
        box = size;
        html = '<div class="pin ' + cls + '" style="width:' + size + "px;height:" + size + 'px"></div>';
      }
      var m = L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: "", html: html,
                          iconSize: [box, box], iconAnchor: [box / 2, box / 2] }),
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
        if (!state.map || state.selected || state.selectedMeetup) return;   // never fight a selection
        state.map.invalidateSize(false);
        state.map.fitBounds(bounds);
      };
      fit();
      requestAnimationFrame(fit);
    }
    renderOverlays();
  }

  /* --- side panel: quiet people, and who is near them --------------------- */

  function setPanelHTML() {
    if (!state.set.length) {
      return '<div class="detail">' +
        '<button class="backlink" id="do-back">&larr; All people</button>' +
        "<h2>Working set</h2>" +
        '<div class="state"><strong>Nothing marked yet.</strong>' +
        "Open anyone or any meetup group and choose <em>Add to set</em>. Filters " +
        "answer who matches a rule; this is for the ones you picked on purpose, " +
        "for reasons the map does not know about. It survives filtering and reload.</div></div>";
    }
    var byKind = {};
    state.set.forEach(function (e) { byKind[e.kind] = (byKind[e.kind] || 0) + 1; });
    var summary = Object.keys(byKind).map(function (k) {
      return byKind[k] + " " + k + (byKind[k] === 1 ? "" : "s");
    }).join(" · ");

    return '<div class="detail">' +
      '<button class="backlink" id="do-back">&larr; All people</button>' +
      "<h2>Working set</h2>" +
      '<p class="meta">' + esc(summary) + "</p>" +
      '<div class="btnrow" style="margin:var(--s-3) 0">' +
        '<button class="btn primary" id="set-export">Export CSV</button>' +
        '<button class="btn" id="set-clear">Clear</button>' +
      "</div>" +
      '<div class="nearlist">' + state.set.map(function (e) {
        return '<div class="row set-row" data-setid="' + esc(e.id) + '">' +
          '<div class="nm">' + esc(e.name) +
            ' <span class="tag ' + esc(e.status || "") + '">' + esc(e.status || e.kind) + "</span>" +
            (e.a8c ? ' <span class="tag a8c">a8c</span>' : "") + "</div>" +
          '<div class="meta">' + esc(e.role || e.kind) +
            (e.city ? " · " + esc(e.city) : "") + "</div>" +
          '<div class="meta"><button class="linkish set-remove" data-setid="' +
            esc(e.id) + '">Remove</button></div>' +
        "</div>";
      }).join("") + "</div>" +
      '<p class="hint" style="margin-top:var(--s-3)">The CSV carries everything ' +
      "needed to act on these without the map open — hand it to someone, drop it " +
      "in a sheet, or give it to Claude.</p></div>";
  }

  function renderSide(list) {
    var side = $("side");

    if (state.showSet) {
      side.innerHTML = setPanelHTML();
      wireSetPanel();
      return;
    }

    if (state.selectedMeetup) {
      side.innerHTML = meetupDetailHTML(state.selectedMeetup, list) + pendingHTML();
      wireMeetupDetail(state.selectedMeetup, list);
      wirePending();
      return;
    }

    if (state.selected) {
      side.innerHTML = detailHTML(state.selected, list) +
        (state.editing ? editorHTML(state.selected) : "") + pendingHTML();
      wireDetail(state.selected, list);
      wirePending();
      return;
    }
    /* Re-engagement ranking, not a dormancy leaderboard.
     *
     * A quiet person with an active person near them is something you can do
     * today: ask the neighbour to make contact. A quiet person with nobody in
     * range is a coverage gap -- still worth knowing, but it needs a different
     * response and it should not sit at the top of a list you are working
     * through. So reachability sorts first.
     *
     * Then: people holding a supporter role, then the MOST RECENTLY quiet,
     * because recoverability falls off with time. Sorting by longest-gone put
     * 2014 accounts at the top, which is the opposite of actionable.
     *
     * Reachability is computed once per render into a lookup rather than inside
     * the comparator -- a comparator runs O(n log n) times and each call is a
     * full sweep of the active set, which turns a 1,100-row list into millions
     * of distance calculations. */
    var quiet = list.filter(function (p) {
      return p.status === "dormant" || p.status === "inactive";
    });
    var hasNeighbour = {};
    quiet.forEach(function (p) {
      hasNeighbour[keyOf(p)] = nearestActive(p, list, 1).length > 0;
    });
    quiet.sort(function (a, b) {
      var an = hasNeighbour[keyOf(a)] ? 0 : 1, bn = hasNeighbour[keyOf(b)] ? 0 : 1;
      if (an !== bn) return an - bn;
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

    var recent = quiet.filter(function (p) { return p.status === "dormant"; }).length;
    var withLead = quiet.filter(function (p) { return hasNeighbour[keyOf(p)]; }).length;
    var html = pendingHTML() +
      '<p class="label">Gone quiet — ' + quiet.length + "</p>" +
      '<p class="hint">' + withLead + " of these have an active person within " +
      state.radiusMi + " miles, and are listed first — those are the ones you can act on " +
      "today. " + recent + " went quiet within the last year. Anyone with nobody in range " +
      "sits at the bottom: that is a coverage gap, not a lead.</p>";

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
          '<div class="nm">' + esc(p.name) + ' <span class="tag ' + p.status + '">' + p.status + "</span>" +
            (p.a8c ? ' <span class="tag a8c">a8c</span>' : "") + "</div>" +
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

  /* Legend, generated from the registry rather than written out by hand, so a
   * new layer explains itself the moment it is declared. It carries both axes
   * because they are independent: shape says which layer a mark belongs to,
   * colour says what state it is in. That distinction is the thing people get
   * wrong when reading this map, so it leads. */
  function legend() {
    var m = state.data.meta;

    var shapes = OVERLAYS.map(function (def) {
      return "<dt><span class='dot pin " + def.shape + " " + def.cls({ status: "" }) +
             "'></span>" + esc(def.label) + "</dt><dd>" +
             (overlayOn(def.id) ? "shown" : "hidden") + "</dd>";
    }).join("");

    var colours = STATUS.map(function (s) {
      return "<dt><span class='dot pin " + s + "'></span>" + s + "</dt><dd>" +
             esc(m.buckets[s]) + "</dd>";
    }).join("");

    return '<div class="legend">' +
      '<p class="label">Shape is the layer</p><dl>' +
        "<dt><span class='dot pin circle active'></span>People</dt><dd>always shown</dd>" +
        shapes +
      "</dl>" +
      '<p class="label" style="margin-top:var(--s-4)">Colour is the status</p><dl>' + colours + "</dl>" +
      '<p class="meta" style="font-size:var(--t-small);color:var(--faint);margin-top:var(--s-3)">' +
      esc(m.caveats[1]) + "</p></div>";
  }

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
      (p.avatar ? '<img class="record-avatar" src="' + esc(p.avatar) + '?s=112" alt="">' : "") +
      "<h2>" + esc(p.name) +
        // Both things at once, said plainly. Someone can hold a Community Team
        // role and work here, and the map used to show them twice rather than
        // saying so.
        (p.a8c ? ' <span class="tag a8c">a8c</span>' : "") + "</h2>" +
      '<p class="meta">' + roleHTML(p.role) +
        (p.a8c && p.a8c_title ? " · " + esc(p.a8c_title) + " at Automattic"
                              : (p.employer ? " · " + esc(p.employer) : "")) + "</p>" +
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
        setAddButtonHTML("person", p) +
        '<button class="btn" id="do-edit">Suggest a correction</button>' +
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

  /* A meetup is a place, so its record answers the mirror-image question the
   * person record does: not "who is near this person" but "who is near this
   * group" -- and specifically, who is active near a group that has stopped
   * meeting. That pairing is the revival lead. */
  function selectMeetup(mt) {
    state.selected = null;
    state.selectedMeetup = mt;
    state.editing = false;
    renderSide(visible());
    clearMarks("is-picked");
    clearMarks("is-near");
    if (state.map && mt.lat != null) {
      state.map.invalidateSize(false);
      state.map.flyTo([mt.lat, mt.lng], Math.max(state.map.getZoom(), FOCUS_ZOOM), { duration: 0.6 });
    }
    markMarker(overlayById("meetups").key(mt), "is-picked", true);
    nearbyPeople({ lat: mt.lat, lng: mt.lng, org: "", slack: "", name: "" }, visible())
      .forEach(function (h) { markMarker(keyOf(h.p), "is-near", true); });
  }

  function meetupDetailHTML(mt, list) {
    var here = { lat: mt.lat, lng: mt.lng, org: "", slack: "", name: "\u0000" };
    var near = nearbyPeople(here, list, state.nearStatus);
    var tally = nearbyTally(here, list);
    var cls = MEETUP_CLASS[mt.status] || "m-never";

    var head = '<div class="detail">' +
      '<button class="backlink" id="do-back">&larr; All people</button>' +
      "<h2>" + esc(mt.group) + "</h2>" +
      '<p class="meta">Meetup group' + (mt.region ? " · " + esc(mt.region) : "") + "</p>" +
      '<p style="margin-top:var(--s-2)"><span class="tag ' + cls + '">' + esc(mt.status) + "</span></p>" +
      "<dl>" +
        "<dt>Where</dt><dd>" + esc(mt.city || "") +
          (mt.country ? ", " + esc(mt.country) : "") + "</dd>" +
        "<dt>Members</dt><dd>" + mt.members.toLocaleString() + "</dd>" +
        "<dt>Past events</dt><dd>" + mt.pastEvents + "</dd>" +
        "<dt>Last event</dt><dd>" + (mt.lastEvent ? esc(mt.lastEvent) : "none on record") + "</dd>" +
        (mt.leaders && mt.leaders.length
          ? "<dt>Organisers</dt><dd>" + mt.leaders.map(esc).join(", ") + "</dd>" : "") +
        (mt.url ? "<dt>Meetup</dt><dd>" + link(mt.url, "meetup.com") + "</dd>" : "") +
      "</dl>" +
      '<p class="hint">Status uses a 365-day window, set by the events dashboard ' +
      "this comes from. It is a wider window than the one used for people.</p>" +
      '<div class="btnrow" style="margin-bottom:var(--s-3)">' + setAddButtonHTML("meetup", mt) + "</div>";

    if (!Object.keys(tally).length) {
      return head + '<p class="label">Who is nearby</p>' + radiusSliderHTML() +
        '<div class="state">Nobody within ' + state.radiusMi + " miles. A group with " +
        "no one around it needs a different kind of help than one with people beside " +
        "it.</div></div>";
    }
    return head + '<p class="label">Who is nearby</p>' + radiusSliderHTML() +
      nearFilterHTML(tally) +
      (tally.active ? '<p class="hint">' + tally.active + " active " +
        (tally.active === 1 ? "person" : "people") + " within " + state.radiusMi +
        " miles" + (mt.status === "Dormant" ? " — any of them could restart this group." : ".") +
        "</p>" : "") +
      '<div class="nearlist">' + near.slice(0, 12).map(function (h) {
        return '<div class="row near" data-name="' + esc(h.p.name) + '" data-key="' +
            esc(keyOf(h.p)) + '">' +
          '<div class="nm">' + esc(h.p.name) +
            ' <span class="tag ' + h.p.status + '">' + h.p.status + "</span></div>" +
          '<div class="meta">' + roleHTML(h.p.role) + "</div>" +
          '<div class="meta">' + esc(h.p.city || h.p.country || "") +
            " · <strong>" + km(h.d) + "</strong> away</div>" +
        "</div>";
      }).join("") + "</div></div>";
  }

  /* Meetups near this person, shown only while the layer is on. Dormant groups
   * lead: an active supporter beside a group that has stopped meeting is the
   * single most actionable thing this map can surface. */
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
      // Layer blocks still render: "no community members nearby, but three
      // dormant meetups and an Automattician are" is a complete answer, and the
      // old early return threw it away.
      return head + overlayBlocksHTML(p) +
        '<div class="state"><strong>Nobody within ' + state.radiusMi + ' miles.</strong>' +
        (far ? "The closest active person is " + esc(far.p.name) + " in " +
               esc(far.p.city || far.p.country || "an unknown place") + ", " + km(far.d) +
               " away. Drag the slider out if that still counts as reachable."
             : "No one else in this view has a location to compare against.") +
        "</div>";
    }
    if (!rows.length) {
      return head + overlayBlocksHTML(p) + '<div class="state">Nobody ' + esc(state.nearStatus) +
             " within " + state.radiusMi + " miles. Clear the filter to see everyone.</div>";
    }
    return head + overlayBlocksHTML(p) +
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
  /* Re-apply the current selection to the map.
   *
   * Marker clustering destroys and recreates marker elements whenever the view
   * changes -- zoom, pan into a new cluster, a layer toggling on. The classes
   * and the open popup live on those elements, so any of those wiped the
   * highlight and shut the popup while the panel stayed open. From the outside
   * that reads as "the map refreshed and closed everything".
   *
   * State lives in `state.selected` / `state.selectedMeetup`, so the fix is to
   * paint the map from that state again once the cluster animation settles,
   * rather than trusting a class to survive. */
  function repaintSelection() {
    if (!state.map) return;
    var sel = state.selected, mt = state.selectedMeetup;
    if (!sel && !mt) return;

    clearMarks("is-picked");
    clearMarks("is-near");

    var key = sel ? keyOf(sel) : overlayById("meetups").key(mt);
    markMarker(key, "is-picked", true);

    var here = sel ? sel : { lat: mt.lat, lng: mt.lng, org: "", slack: "", name: "\u0000" };
    nearbyPeople(here, visible()).forEach(function (h) {
      markMarker(keyOf(h.p), "is-near", true);
    });

    var m = state.markers[key];
    if (m && m.getElement && m.getElement() && m.openPopup && !m.isPopupOpen()) {
      m.openPopup();
    }
  }

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
  /* Ceiling for the reveal below. zoomToShowLayer keeps zooming until the marker
   * is no longer inside a cluster, which on a shared city centroid means going
   * all the way to street level -- the opposite of "close enough to see who is
   * around them". Clamping means people on an identical coordinate stay in a
   * cluster you can click to fan out, which is the better trade. */
  var MAX_FOCUS_ZOOM = 13;

  /* Bring someone into view without diving to street level.
   *
   * The obvious move, zoomToShowLayer, keeps zooming until the marker is no
   * longer inside a cluster -- on a shared city centroid that means maximum
   * zoom, so you land on a rooftop and lose all sense of who is around them.
   * Clamping the zoom afterwards is worse: it re-clusters the marker on the way
   * back out, which closes the popup and drops the highlight. That fight is
   * what made a selection look like it "closed itself".
   *
   * So: fly to a readable zoom and, if the person is still inside a cluster
   * there, fan that cluster out instead of zooming into it. The pile opens, the
   * person is clickable, and the surroundings stay on screen -- which is the
   * entire point of selecting them. */
  function focusOnMap(p, then) {
    if (!state.map || p.lat == null) return;
    state.map.invalidateSize(false);
    var m = state.markers[keyOf(p)];
    var target = Math.max(state.map.getZoom(), FOCUS_ZOOM);
    state.map.flyTo([p.lat, p.lng], Math.min(target, MAX_FOCUS_ZOOM), { duration: 0.6 });

    // flyTo emits no moveend when the map is already where it was asked to go,
    // so the settle handler has to be armed both ways or the selection silently
    // never gets painted. Fires exactly once, whichever arrives first.
    var settled = false;
    function onSettle() {
      if (settled) return;
      settled = true;
      if (!m) { if (then) then(m); return; }
      var parent = state.layer.getVisibleParent && state.layer.getVisibleParent(m);
      if (parent && parent !== m && parent.spiderfy) {
        parent.spiderfy();                       // open the pile where it stands
        setTimeout(function () { if (then) then(m); }, 320);
        return;
      }
      if (then) then(m);
    }
    state.map.once("moveend", onSettle);
    setTimeout(onSettle, 750);
  }

  function select(p, list) {
    state.selected = p;
    state.selectedMeetup = null;
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

  function wireSetPanel() {
    var b = $("do-back");
    if (b) b.onclick = function () { state.showSet = false; renderSetCount(); renderSide(visible()); };
    var x = $("set-export");
    if (x) x.onclick = exportSet;
    var c = $("set-clear");
    if (c) c.onclick = function () {
      if (!state.set.length) return;
      // Destructive and easy to hit by accident next to Export, so it asks.
      if (!window.confirm("Clear all " + state.set.length + " items from the working set?")) return;
      state.set = [];
      persistSet(); renderSetCount(); render(); renderSide(visible());
    };
    Array.prototype.forEach.call(document.querySelectorAll("#side .set-remove"), function (el) {
      el.onclick = function () {
        var id = el.dataset.setid;
        state.set = state.set.filter(function (e) { return e.id !== id; });
        persistSet(); renderSetCount(); render(); renderSide(visible());
      };
    });
  }

  /* Add/remove buttons appear inside records, so wire them wherever a record
   * renders rather than in each record's own handler. */
  function wireSetAdd(list) {
    Array.prototype.forEach.call(document.querySelectorAll("#side .set-add"), function (el) {
      el.onclick = function () {
        var kind = el.dataset.setkind, id = el.dataset.setid;
        var rec = null;
        if (kind === "person") {
          list.forEach(function (p) { if (setIdOf("person", p) === id) rec = p; });
          if (!rec) state.data.people.forEach(function (p) { if (setIdOf("person", p) === id) rec = p; });
        } else if (kind === "meetup") {
          state.meetups.forEach(function (m) { if (setIdOf("meetup", m) === id) rec = m; });
        } else {
          state.a11n.forEach(function (a) { if (setIdOf("a11n", a) === id) rec = a; });
        }
        if (rec) { toggleSet(kind, rec); renderSide(visible()); }
      };
    });
  }

  function wireMeetupDetail(mt, list) {
    wireSetAdd(list);
    var b = $("do-back");
    if (b) b.onclick = function () {
      state.selectedMeetup = null;
      if (state.map) state.map.closePopup();
      clearMarks("is-picked");
      clearMarks("is-near");
      renderSide(visible());
    };

    var rad = $("f-radius"), radOut = $("f-radius-out");
    if (rad) {
      rad.oninput = function (e) {
        state.radiusMi = parseInt(e.target.value, 10);
        if (radOut) radOut.textContent = state.radiusMi + " mi";
      };
      rad.onchange = function () { renderSide(visible()); };
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
  }

  function wireDetail(p, list) {
    wireSetAdd(list);
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
    state.meetups = data.meetups || [];
    state.set = loadSet();
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

    $("set-btn").onclick = function () {
      state.showSet = !state.showSet;
      if (state.showSet) { state.selected = null; state.selectedMeetup = null; }
      renderSetCount();
      renderSide(visible());
    };
    // Toggles are generated from the registry, so a new layer is a descriptor
    // and not another hand-wired pair of button and handler.
    var seg = $("layer-toggles");
    if (seg) {
      seg.innerHTML = OVERLAYS.map(function (def) {
        return '<button id="l-' + def.id + '" aria-pressed="false" title="' +
               esc(def.title) + '">' + esc(def.label) + "</button>";
      }).join("");
      OVERLAYS.forEach(function (def) {
        var btn = $("l-" + def.id);
        btn.onclick = function () {
          state.overlays[def.id] = !state.overlays[def.id];
          btn.setAttribute("aria-pressed", state.overlays[def.id] ? "true" : "false");
          renderOverlay(def);
          renderSide(visible());
        };
      });
    }

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
