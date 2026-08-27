/* Community Reach.
 *
 * Deliberately not "dashboard". A dashboard is read; this is worked -- open a
 * ranked list, pick someone, see who is near them, mark them, move on. The word
 * also already belongs to the WordPress Community Events Dashboard, which
 * covers the same community for a different question, and two tools called the
 * dashboard in one team get confused every time either is mentioned.
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
  var SOURCE_LABEL = { slack: "Slack", helpscout: "Help Scout", github: "GitHub" };
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

  /* Holding a Community Team role is an attribute of a person, not a mode of
   * the tool. It used to be a population toggle -- "Has a role" against
   * "Everyone in Slack" -- which meant the answer to "how many people are
   * there" depended on a control, and a shared link could arrive in the other
   * population without saying so. The toggle is gone. Everyone is always
   * shown; role-holders are marked wherever a person appears. */
  function hasRole(p) { return !!p && p.tier !== "community"; }

  /* The badge itself, carrying the role's own definition, so "what is an Event
   * Supporter" is answered where the label sits rather than in the docs. */
  function roleTag(p) {
    if (!hasRole(p)) return "";
    var d = roleDef(p.role);
    return ' <span class="tag role' + (d ? " def" : "") + '"' +
      (d ? ' tabindex="0" data-def="' + esc(d) + '"' : "") + ">" + esc(p.role) + "</span>";
  }
  var state = {
    // Landing state: the United States. There is no longer a population to
    // pair it with -- everyone in the two Slack channels is always shown, so
    // this cannot land on the 11-person US-plus-role-holders view that made
    // the tool read as empty. US is 2,023 people and 637 dots, which is a map.
    //
    // `place` is one field, not a region toggle plus a country dropdown. Empty
    // string means Global; any other value is a country name.
    data: null, view: "map", place: "United States", q: "",
    // Statuses are a SET, not a choice. "Slowing and active" is a thing you can
    // want to look at, and a dropdown that allows one made the tool unable to
    // express it. Empty means all -- no status selected is not "show nobody".
    statuses: {}, usState: "", rows: 50, page: 0,
    map: null, layer: null, selected: null,
    radiusMi: 100, markers: {}, nearStatus: "",
    a11n: [], meetups: [], selectedMeetup: null,
    // A view toggle, not a mode. Expanding hides the rail and gives the map the
    // whole stage; nothing else about the tool changes, and nothing you click
    // can flip it back on you. It replaced a Triage/Explore pair where picking
    // someone on the map silently switched mode AND moved the map -- two
    // surprises for one click.
    mapExpanded: false,
    /* The preset: a saved selection you switch on, driven by the two headline
     * numbers. "" is off, and off is a legitimate state -- the list is then
     * whatever the facets select.
     *
     * Landing on "quiet" so the tool opens on the job it exists for rather than
     * on 2,023 undifferentiated rows. It is a toggle, not a mode: clicking the
     * headline off gives you everyone, and the link carries whichever you left
     * it on. */
    preset: "quiet", headline: null,
    _focusToken: 0,
    // The list's memory. Inspecting someone used to destroy the ranked list you
    // were working through and return you to the top of it. These three fields
    // are what make it survive a look at one of its rows: where you were
    // scrolled, who you last opened, and the walk order for the arrow keys.
    // listKeys holds PEOPLE only -- arrow-stepping into a meetup and back out
    // of a mixed list is not navigation, it is a surprise.
    listKeys: [], queueScroll: 0, lastViewed: null,
    // How many rows each section shows before "show more", keyed by section id.
    // Sections used to stop dead at 60 and point at the table, which carries no
    // ranking at all.
    limits: {},
    // Layer on/off and the live cluster group, keyed by descriptor id, so
    // adding a layer never means adding two more state fields. People is a
    // layer like the others now: it can be switched off to look at meetups
    // alone, which is what "toggle everything" has to mean to be true.
    overlays: { people: true }, overlayLayers: {},
    // Per-layer narrowing, keyed by layer id, each a SET of selected values.
    // An empty set means all of them.
    overlayFilter: {},
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

  /* Facets are sets, and an empty set means "all", not "none".
   *
   * Every filter in this tool is now additive: turning on Slowing and Active
   * asks for either of them, and turning both off asks for all statuses rather
   * than an empty screen. These four are the whole contract, used identically
   * by the people statuses and by every layer's own chips, so the two kinds of
   * chip cannot drift apart in behaviour. */
  function facetAny(set) {
    if (!set) return false;
    for (var k in set) if (set[k]) return true;
    return false;
  }
  function facetOn(set, v) { return !!set && !!set[v]; }
  function facetMatch(set, v) { return !facetAny(set) || !!set[v]; }
  function facetToggle(set, v) {
    if (set[v]) delete set[v]; else set[v] = true;
    return set;
  }
  function facetList(set) {
    return Object.keys(set || {}).filter(function (k) { return set[k]; });
  }

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


  /* --- shareable URL state ------------------------------------------------
   *
   * This is a coordination tool, so "look at this" has to be a link. Before
   * this every view was unaddressable: the only way to hand someone the Brazil
   * dormant queue was to tell them which controls to set.
   *
   * The fragment, not a query string. It never reaches the server, so the Pages
   * host and its CDN log nothing about who is looking at whom, and it is
   * stripped from the Referer on outbound clicks. It also costs no reload,
   * which matters when the payload took a PBKDF2 200k derivation to decrypt.
   *
   * What may travel here is identifiers only. A .org username is already public
   * at profiles.wordpress.org. What may NEVER travel here is the association
   * the passphrase gates: status, last seen, employer, city, coordinates.
   * "#p=someuser" is a pointer. A hash pairing that name with a dormancy label
   * would be a plaintext accusation with a person attached, sitting in Slack
   * and in browser history. `st` is a filter over the whole list and is
   * independent of who is selected; keep it that way. */
  var HASH_VIEW = { m: "map", t: "table" };
  /* No HASH_POP. Links shared before the population toggle was removed carry
   * `pop=r` or `pop=a`; both are now ignored rather than rejected, so an old
   * link still opens at the right place and person. */

  /* Set while the app writes its own hash, so the listener can tell its echo
   * from a real navigation. Reset on a timeout rather than inline, because some
   * browsers dispatch hashchange asynchronously and an inline reset would clear
   * the guard before the event it guards against arrives. */
  var writingHash = false;

  function encodeState() {
    var parts = [];
    if (state.mapExpanded) parts.push("x=1");
    if (state.view !== "map") parts.push("v=t");
    /* Place is written even at its default. It has already moved once and is
     * expected to move again; if omission meant "default", every link shared
     * this week would quietly re-point somewhere else the next time that line
     * is edited. A link is a promise about what the recipient sees. "*" rather
     * than an empty value because some chat clients strip a trailing "=". */
    parts.push("pl=" + (state.place ? encodeURIComponent(state.place) : "*"));
    if (state.usState) parts.push("us=" + encodeURIComponent(state.usState));
    if (state.preset) parts.push("pr=" + state.preset);
    var st = facetList(state.statuses);
    if (st.length) parts.push("st=" + st.join(","));
    // Layer facets travel too, or "US, active meetups" is a view you can build
    // and cannot send. Written as layer:value,value;layer:value.
    var lf = OVERLAYS.map(function (d) {
      var vals = facetList(state.overlayFilter[d.id]);
      return vals.length ? d.id + ":" + vals.map(encodeURIComponent).join(",") : "";
    }).filter(Boolean);
    if (lf.length) parts.push("lf=" + lf.join(";"));
    if (state.q) parts.push("q=" + encodeURIComponent(state.q));
    if (state.selected) parts.push("p=" + encodeURIComponent(keyOf(state.selected)));
    else if (state.selectedMeetup) {
      parts.push("mt=" + encodeURIComponent(overlayById("meetups").key(state.selectedMeetup)));
    }
    var on = OVERLAYS.filter(function (d) { return state.overlays[d.id]; })
                     .map(function (d) { return d.id; });
    if (on.length) parts.push("ly=" + on.join(","));
    return "#" + parts.join("&");
  }

  /* Write only on change, and with replaceState. An unconditional assignment
   * adds a history entry per render, and Back would then walk one filter
   * keystroke at a time instead of returning where the reader came from. */
  function syncHash() {
    if (!state.data) return;
    var next = encodeState();
    if (next === location.hash) return;
    writingHash = true;
    try {
      history.replaceState(null, "", location.pathname + location.search + next);
    } catch (e) {
      // file:// and some sandboxes reject replaceState. Losing the shareable
      // URL is acceptable there; losing the app is not.
      location.hash = next;
    }
    setTimeout(function () { writingHash = false; }, 0);
  }

  function parseHash() {
    var raw = location.hash.replace(/^#/, ""), out = {};
    if (!raw) return out;
    raw.split("&").forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf("=");
      var k = i === -1 ? pair : pair.slice(0, i);
      var v = i === -1 ? "" : pair.slice(i + 1);
      try { out[k] = decodeURIComponent(v.replace(/\+/g, " ")); }
      catch (e) { out[k] = v; }   // a hand-mangled link should degrade, not throw
    });
    return out;
  }

  /* Every value is validated against what the app supports rather than
   * assigned. A hash is user-editable input arriving from a chat message, and
   * an unknown status would silently filter the view to zero rows, which reads
   * as "the data is broken" rather than "that link is wrong". */
  function applyStateFromHash() {
    var h = parseHash(), touched = false;

    if (h.x != null) { state.mapExpanded = h.x === "1"; touched = true; }
    if (h.v && HASH_VIEW[h.v])   { state.view = HASH_VIEW[h.v]; touched = true; }
    // h.pop is deliberately unread: see HASH_POP above.
    if (h.pl != null) { state.place = h.pl === "*" ? "" : h.pl; touched = true; }
    if (h.pr != null) {
      state.preset = (h.pr === "quiet" || h.pr === "reachable") ? h.pr : "";
      touched = true;
    }
    if (h.st != null) {
      // Validated one value at a time: an unknown status in a hand-edited link
      // should be dropped, not allowed to filter the view to zero rows and read
      // as broken data.
      state.statuses = {};
      h.st.split(",").forEach(function (v) {
        if (STATUS.indexOf(v) !== -1) state.statuses[v] = true;
      });
      touched = true;
    }
    if (h.lf != null) {
      OVERLAYS.forEach(function (d) { state.overlayFilter[d.id] = {}; });
      h.lf.split(";").forEach(function (part) {
        var i = part.indexOf(":");
        if (i === -1) return;
        var def = overlayById(part.slice(0, i));
        if (!def) return;
        var set = state.overlayFilter[def.id] = {};
        part.slice(i + 1).split(",").forEach(function (v) {
          try { v = decodeURIComponent(v); } catch (e) { /* keep it raw */ }
          if (v) set[v] = true;
        });
      });
      touched = true;
    }
    // Validated against the real list, so a hand-edited link cannot filter the
    // view down to zero rows and read as broken data.
    if (h.us != null) {
      state.usState = US_STATE_NAMES.indexOf(h.us) === -1 ? "" : h.us;
      touched = true;
    }
    if (h.q != null)  { state.q = h.q; touched = true; }

    if (h.ly != null) {
      var want = h.ly ? h.ly.split(",") : [];
      OVERLAYS.forEach(function (d) { state.overlays[d.id] = want.indexOf(d.id) !== -1; });
      touched = true;
    }

    /* Selection resolves last, and against the filtered list: a link whose
     * person is excluded by its own place or status is a broken link, and
     * landing on the queue is more honest than opening a record that
     * contradicts the filters drawn around it. */
    state.selected = null;
    state.selectedMeetup = null;
    if (h.p) {
      var hit = byKey(h.p, visible());
      if (hit) { state.selected = hit; state.lastViewed = h.p; touched = true; }
    } else if (h.mt && state.meetups.length) {
      var mkey = overlayById("meetups").key;
      state.meetups.forEach(function (m) {
        if (mkey(m) === h.mt) { state.selectedMeetup = m; touched = true; }
      });
    }

    /* A shared link opens a view of the map, never the recipient's own working
     * set. Theirs is a different list from the sender's and usually empty,
     * which would read as a broken link. */
    state.showSet = false;
    state.page = 0;
    return touched;
  }

  /* The control bar is not redrawn by render(), so without this a link lands on
   * the right data with the wrong buttons lit, which teaches the reader to
   * distrust the controls. */
  function syncControls() {
    var el;
    if ((el = $("f-place")))  el.value = state.place;
    buildStateOptions();
    if ((el = $("f-state")))  el.value = state.usState;

    if ((el = $("q")))        el.value = state.q;
    if ((el = $("v-map")))    el.setAttribute("aria-pressed", String(state.view === "map"));
    if ((el = $("v-table")))  el.setAttribute("aria-pressed", String(state.view === "table"));
    syncExpandButton();
    OVERLAYS.forEach(function (d) {
      var b = $("l-" + d.id);
      if (b) b.setAttribute("aria-pressed", state.overlays[d.id] ? "true" : "false");
    });
  }

  /* Back, Forward, and pasted links, but never our own writes. Skipped before
   * the data exists, because applyStateFromHash resolves the selected person
   * against visible(), which is empty until boot() runs. */
  window.addEventListener("hashchange", function () {
    if (writingHash || !state.data) return;
    applyStateFromHash();
    syncControls();
    var p = state.selected;
    state.selected = null;
    render();
    // Through select(), so a person arriving by link gets what a click gives:
    // dot marked, neighbours highlighted, map flown in.
    if (p) select(p, visible());
    renderSetCount();
  });


  /* --- US state, derived from a free-text location ------------------------
   *
   * There is no state field anywhere in the pipeline, and the `city` string is
   * whatever people typed on their .org profile: "Charleston, SC", "Albuquerque,
   * New Mexico", "Phoenix, AZ USA", "Southern California", "Las Vegas",
   * "2000 W 3rd St, Los Angeles, CA 90057, USA".
   *
   * A full state name anywhere in the string is safe. A bare two-letter code is
   * NOT: matching one anywhere reads "put me in" as Indiana and "Ok then" as
   * Oklahoma, which is how a filter invents people in a state nobody lives in.
   * So a code is only trusted in a string punctuated like an address, and only
   * in its trailing segment, with country tails and ZIP codes stepped over.
   *
   * This resolves 527 of the 636 placed US people. The other 109 are bare city
   * names and regions ("Portland" is genuinely ambiguous, Oregon or Maine), and
   * they are counted as "state not on record" rather than guessed at. */
  var US_STATES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
    CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
    HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
    KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
    MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
    MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
    NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
    NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
    OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
    SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
    VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
    WY: "Wyoming", DC: "District of Columbia"
  };
  // Longest first, so "West Virginia" is not swallowed by "Virginia".
  var US_STATE_NAMES = Object.keys(US_STATES).map(function (k) { return US_STATES[k]; })
    .sort(function (a, b) { return b.length - a.length; });
  var COUNTRYISH = { USA: 1, US: 1, "U.S.": 1, "U.S.A.": 1, AMERICA: 1, UNITED: 1, STATES: 1 };

  function stateOf(city) {
    if (!city) return "";
    var low = city.toLowerCase();
    for (var i = 0; i < US_STATE_NAMES.length; i++) {
      var n = US_STATE_NAMES[i].toLowerCase();
      if (new RegExp("\\b" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(low)) {
        return US_STATE_NAMES[i];
      }
    }
    if (!/[,\-\/]/.test(city)) return "";      // not punctuated like an address
    var segs = city.split(/[,\-\/]/).map(function (x) { return x.trim(); })
      .filter(function (x) { return x; });
    for (var j = segs.length - 1; j >= 0; j--) {
      var toks = segs[j].split(/\s+/).map(function (t) {
        return t.replace(/\.$/, "").toUpperCase();
      }).filter(function (t) { return t && !COUNTRYISH[t] && !/^\d+$/.test(t); });
      if (!toks.length) continue;               // a country or ZIP-only tail
      var last = toks[toks.length - 1], first = toks[0];
      if (last.length === 2 && US_STATES[last]) return US_STATES[last];
      if (first.length === 2 && US_STATES[first]) return US_STATES[first];
      return "";                                // a real tail that is not a state
    }
    return "";
  }

  /* --- helpers ----------------------------------------------------------- */

  function inUS(p) {
    if (p.country) return /united states|usa|u\.s\./i.test(p.country);
    if (p.lat != null) return p.lat > 24 && p.lat < 50 && p.lng < -66 && p.lng > -125;
    if (p.tz) return /^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Indiana|Kentucky|Boise|Juneau)/.test(p.tz);
    return false;
  }

  /* Place is one control with one meaning: empty is Global, anything else is a
   * country. The United States is deliberately not a plain string match.
   * 4,174 people carry no country string at all, and inUS() recovers 1,387 of
   * them from a US timezone. Matching `p.country === "United States"` instead
   * would quietly drop those people from the default view -- 2,023 becomes 636.
   * The other countries have no such fallback yet, so their counts are
   * country-string only. That asymmetry is real; it is written down in
   * PROJECT.md rather than hidden here. */
  function matchPlace(p) {
    if (!state.place) return true;                       // Global
    if (state.place === "United States") return inUS(p);
    return p.country === state.place;
  }

  /* The same question for a record that carries a country and nothing else --
   * a meetup group. It cannot use inUS(), which recovers 1,387 people from a US
   * timezone when their country is blank; a meetup either says where it is or
   * it does not. */
  function matchPlaceCountry(c) {
    if (!state.place) return true;
    // A US view is a country view for these: State is derived from free text on
    // .org profiles and meetups have no such field, so narrowing to a state
    // would silently drop every group rather than filter them.
    return c === state.place;
  }

  /* Maruti's dashboard spells three countries differently from the .org
   * profiles. Left unmapped, a United States view loses all 147 US meetup
   * groups without an error anywhere. */
  var MEETUP_COUNTRY = {
    "USA": "United States",
    "Czech Republic": "Czechia",
    "DR Congo": "Democratic Republic of the Congo"
  };

  /* Match on the .org key, never the name: 78 names in this dataset are shared
   * by more than one person, so name matching selects the wrong one. */
  function byKey(key, list) {
    for (var i = 0; i < list.length; i++) if (keyOf(list[i]) === key) return list[i];
    return null;
  }

  function isQuiet(p) { return p.status === "dormant" || p.status === "inactive"; }

  /* THE POPULATION: who is in scope, before any question is asked about them.
   * Place, state and search only -- deliberately not status, and not the
   * headline filter.
   *
   * This split exists because the headline numbers used to be computed from
   * the already-filtered list, so clicking "gone quiet" redefined the total
   * that number was a fraction of, and it changed under the click. A headline
   * that moves when you press it is not a headline.
   *
   * It also fixes reachability. "Nearest active person" was measured against
   * the filtered list, so narrowing to Dormant removed every active person
   * from the pool and the whole queue reported "nobody in range" -- the tool
   * silently answering a different question than the one on screen. Who lives
   * near someone does not depend on which status chip is pressed. */
  function population() {
    var d = state.data ? state.data.people : [];
    var q = state.q.trim().toLowerCase();
    if (!q) {
      return d.filter(function (p) {
        return matchPlace(p) && (!state.usState || p.usState === state.usState);
      });
    }
    return d.filter(function (p) {
      if (!matchPlace(p)) return false;
      if (state.usState && p.usState !== state.usState) return false;
      // Role is searchable, which is what replaced the population toggle:
      // typing "Program Supporter" gives you exactly that group.
      var hay = (p.name + " " + (p.city || "") + " " + (p.country || "") + " " +
                 (p.slack || "") + " " + (p.org || "") + " " + (p.employer || "") + " " +
                 (p.role || "")).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  /* The population, for anything that COUNTS: place, state and search. Held on
   * state for the duration of one render so placedIn()'s identity cache hits
   * and the array is built once, not once per caller. */
  function pool() {
    return state.pool || (state.data ? state.data.people : []);
  }

  /* WHO LIVES NEAR SOMEONE IS A FACT ABOUT THE WORLD, NOT ABOUT YOUR FILTERS.
   *
   * Every proximity question used to be asked against pool(), which includes
   * the SEARCH box. So searching a name and opening that person asked "who is
   * active near her, among the people whose details match her name" -- which is
   * nobody, and the record duly said "Nobody active within 100 mi". Velda has
   * three. The tool was not wrong about the distance, it was answering a
   * question no one asked.
   *
   * Proximity now always reads the whole dataset. A filter changes which people
   * you are LOOKING at; it cannot change who lives near them. */
  function neighbours() {
    return state.data ? state.data.people : [];
  }

  /* Who has gone quiet, and which of them have an active person in range.
   *
   * One computation behind one memo, because three separate places want this
   * answer -- the headline, the queue's ranking, and the "reachable now"
   * filter -- and three implementations of it is three chances for the tool to
   * contradict itself on screen. reachIndex rather than a loop over
   * nearestActive(): that is the difference between 52ms and 26 seconds.
   *
   * Keyed on the population's identity and the radius, which are the only two
   * things the answer depends on. population() returns a fresh array per
   * render, so this recomputes exactly once per render and never per caller. */
  var _reach = { pool: null, radius: -1, quiet: [], keys: {} };

  function reachCompute() {
    var within = pool();
    if (_reach.pool === within && _reach.radius === state.radiusMi) return;
    var quiet = within.filter(isQuiet);
    // Measured against everyone, not against the filtered view: a US view that
    // counted only US actives called four people unreachable who have someone
    // active just over a border.
    var idx = reachIndex(quiet, neighbours());
    var keys = {};
    for (var i = 0; i < quiet.length; i++) {
      var k = keyOf(quiet[i]);
      if (idx[k]) keys[k] = true;
    }
    _reach = { pool: within, radius: state.radiusMi, quiet: quiet, keys: keys };
  }
  function quietIn()  { reachCompute(); return _reach.quiet; }
  function reachKeys() { reachCompute(); return _reach.keys; }

  function visible() {
    // People off means people are not shown ANYWHERE -- map, list and table.
    // Leaving the table populated while the map and the list were empty would
    // make the toggle mean one thing in two views and another in the third.
    // pool() is untouched, so a meetup's "who is nearby" still answers.
    if (!overlayOn("people")) return [];
    var rows = pool();
    if (state.preset === "quiet") {
      rows = rows.filter(isQuiet);
    } else if (state.preset === "reachable") {
      // This branch used to be missing entirely: clicking "reachable now"
      // filtered nothing at all and the view sat there looking unchanged.
      var keys = reachKeys();
      rows = quietIn().filter(function (p) { return keys[keyOf(p)]; });
    }
    if (facetAny(state.statuses)) {
      rows = rows.filter(function (p) { return !!state.statuses[p.status]; });
    }
    return rows;
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
  /* Placed-people index, rebuilt only when the visible list actually changes.
   *
   * This used to walk the whole visible list on every call: allocate an object
   * per candidate, compute a Haversine, filter, then sort. It is called once per
   * quiet person to work out reachability, so on "Everyone in Slack" that came
   * to roughly 4.8 million distance calculations and ~193,000 sort comparisons
   * for a single render -- which is why changing a filter felt like the page had
   * hung.
   *
   * Two changes fix it. Cache the placed subset, so the no-location majority is
   * skipped before any maths. Then reject candidates with a bounding box before
   * computing a real distance: a degree of latitude is ~69 miles and a degree of
   * longitude is never more, so anything outside the box cannot be inside the
   * radius. That discards nearly everything for two subtractions. */
  var _placedCache = { token: null, list: null };

  function placedIn(list) {
    if (_placedCache.token !== list) {
      _placedCache = { token: list,
                       list: list.filter(function (a) { return a.lat != null; }) };
    }
    return _placedCache.list;
  }

  function nearbyPeople(p, list, statusFilter) {
    if (p.lat == null) return [];
    var pk = keyOf(p);
    var r = state.radiusMi;
    var dLat = r ? (r / 69) + 0.001 : Infinity;
    var cosLat = Math.max(0.01, Math.cos(p.lat * Math.PI / 180));
    var dLng = r ? (r / (69 * cosLat)) + 0.001 : Infinity;

    var placed = placedIn(list);
    var out = [];
    for (var i = 0; i < placed.length; i++) {
      var a = placed[i];
      if (r && (Math.abs(a.lat - p.lat) > dLat || Math.abs(a.lng - p.lng) > dLng)) continue;
      if (statusFilter && a.status !== statusFilter) continue;
      if (keyOf(a) === pk) continue;
      var d = distance(p, a);
      if (r && miles(d) > r) continue;
      out.push({ p: a, d: d });
    }
    out.sort(function (x, y) { return x.d - y.d; });
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

  /* Two numbers, not eight.
   *
   * The masthead used to carry in-view, active, new, slowing, dormant, unknown,
   * on-the-map and no-location, all the same size, as though the tool were a
   * dashboard. It is not: it asks one question, and only two of those eight
   * answered it. The other six are facts about the dataset, so they moved to
   * the queue header where the list they describe actually is.
   *
   * Both of these are live filters, so nothing that was clickable stopped
   * being clickable -- and every status is still reachable from the Status
   * control, which is where you would look for it. */
  function renderCounters() {
    /* Measured against the population, never against the filtered list, so
     * pressing either number does not change the number you pressed. */
    var quiet = quietIn(), keys = reachKeys();
    var reachable = quiet.filter(function (p) { return keys[keyOf(p)]; }).length;
    var total = pool().length, rest = total - quiet.length;
    state.headline = { quiet: quiet.length, reachable: reachable, total: total };

    /* Both numbers carry their denominator, because without one they read as
     * two slices of the whole that ought to sum to it -- and they never did.
     * "Gone quiet" is a fraction of everyone in view; "reachable now" is a
     * fraction OF THAT, which is what "of those" says. */
    $("counters").innerHTML =
      headlineCell("gone quiet", quiet.length, "of " + total.toLocaleString(),
        "is-dormant", "quiet",
        quiet.length.toLocaleString() + " of the " + total.toLocaleString() +
        " people in view have not been seen by any source in over 90 days: " +
        "dormant plus inactive. The other " + rest.toLocaleString() + " are active, " +
        "new, slowing, or have never been seen at all. Full breakdown above the list.") +
      headlineCell("reachable now", reachable, "of those",
        "is-active", "reachable",
        reachable.toLocaleString() + " of those " + quiet.length.toLocaleString() +
        " have an active person within " + state.radiusMi + " miles, so someone can be " +
        "asked to make contact today. This is a slice of the number to its left, not a " +
        "separate group \u2014 the two are not meant to add up to " + total.toLocaleString() + ".");

    Array.prototype.forEach.call($("counters").children, function (el) {
      if (!el.dataset.pick) return;
      el.onclick = function () {
        // A preset REPLACES the status selection rather than intersecting
        // with it: "gone quiet" and a Slowing chip are contradictory asks, and
        // silently returning nothing is the worst way to say so.
        var was = state.preset;
        state.preset = was === el.dataset.pick ? "" : el.dataset.pick;
        // A preset is a statement about people, so it switches People back on
        // rather than filtering a layer nobody is looking at.
        if (state.preset) { state.statuses = {}; state.overlays.people = true; }
        state.page = 0;
        render();
      };
    });
  }

  function headlineCell(k, v, of, cls, pick, title) {
    var on = state.preset === pick;
    return '<button class="counter headline ' + cls + (on ? " is-on" : "") +
      '" data-pick="' + pick + '" aria-pressed="' + on + '" title="' + esc(title) + '">' +
      '<span class="n tabular">' + v.toLocaleString() +
        '<span class="of"> ' + esc(of) + "</span></span>" +
      '<span class="k">' + k + "</span></button>";
  }

  /* --- role definitions, floating free ------------------------------------ */

  /* THE TOOLTIP LIVES ON <body>, NOT INSIDE THE THING IT DESCRIBES.
   *
   * It was a ::after on the label, so it was laid out inside .rail -- a scroll
   * container with overflow-y: auto. An absolutely positioned child cannot
   * escape an ancestor's overflow no matter what z-index it carries, so the
   * definition was clipped at the rail's edge and cut in half.
   *
   * One element, appended to <body>, positioned with viewport coordinates. It
   * has no containing block to be trapped by, so it floats over the rail, over
   * the map, over anything. Position is computed per show rather than per
   * element, which is also what lets it flip up near the bottom of the window
   * and pull itself back inside the right edge instead of hanging off it. */
  var _tip = null;

  function defTip() {
    if (!_tip) {
      _tip = document.createElement("div");
      _tip.className = "deftip";
      _tip.setAttribute("role", "tooltip");
      document.body.appendChild(_tip);
    }
    return _tip;
  }

  function showDefTip(el) {
    var text = el.getAttribute("data-def");
    if (!text) return;
    var r = el.getBoundingClientRect();
    // A hidden anchor measures 0x0 and would park the tip in the top-left
    // corner pointing at nothing. The rail is display:none while a record is
    // open, and its rows keep their data-def attributes.
    if (!r.width && !r.height) { hideDefTip(); return; }

    var t = defTip();
    t.textContent = text;
    t.classList.add("on");
    // Measured after the text is in, or the first show of a long definition is
    // positioned against the width of the previous one.
    var w = t.offsetWidth, h = t.offsetHeight, gap = 8, edge = 10;
    // documentElement first: window.innerWidth reports 0 inside some embedded
    // browser panes, and a zero viewport turns every clamp below into nonsense.
    var vw = document.documentElement.clientWidth || window.innerWidth || 0;
    var vh = document.documentElement.clientHeight || window.innerHeight || 0;

    var top = r.bottom + gap;
    if (vh && top + h > vh - edge) top = Math.max(edge, r.top - h - gap);

    // Clamp the LOW bound last. Clamping high-then-low lets the right-edge
    // limit win on a narrow window and push the tip off the left of the screen,
    // which is the same class of bug as the clipping this replaced.
    var left = r.left;
    if (vw) left = Math.min(left, vw - w - edge);
    left = Math.max(edge, left);

    t.style.top = Math.round(top) + "px";
    t.style.left = Math.round(left) + "px";
  }

  function hideDefTip() { if (_tip) _tip.classList.remove("on"); }

  /* Delegated, because the rows carrying these are rebuilt on every render and
   * per-element listeners would have to be rewired each time -- which is the
   * kind of thing that works until the day someone adds a render path. */
  function wireDefTips() {
    document.addEventListener("mouseover", function (e) {
      var el = e.target && e.target.closest && e.target.closest("[data-def]");
      if (el) showDefTip(el); else hideDefTip();
    });
    document.addEventListener("focusin", function (e) {
      var el = e.target && e.target.closest && e.target.closest("[data-def]");
      if (el) showDefTip(el); else hideDefTip();
    });
    document.addEventListener("focusout", hideDefTip);
    // Anchored to a viewport coordinate, so anything that moves the anchor has
    // to dismiss it rather than leave it pointing at empty space. Capture
    // phase: the rail and the note body scroll, not the document.
    document.addEventListener("scroll", hideDefTip, true);
    window.addEventListener("resize", hideDefTip);
  }

  /* --- the data note ------------------------------------------------------ */

  /* THE ANSWERS, IN THE TOOL, WITHOUT A SECOND COPY OF THEM.
   *
   * The questions this answers get asked out loud, in the room, while the tool
   * is on screen: why the two numbers do not add up, what "unknown" means, why
   * only a third is on the map, how old this is. An answer a page away is not
   * available at that moment.
   *
   * So the words live in ONE place -- <section id="data-note"> in about.html --
   * and this fetches that section and shows it in a sheet. Two surfaces, one
   * source. It was briefly built here from the loaded dataset instead, which
   * was live but meant the same paragraphs existed twice and would eventually
   * disagree. The build already checks every figure in about.html against
   * data/people.json and names the stale one, which is the guarantee that
   * mattered.
   */
  var _noteHTML = null;

  function openDataNote() {
    var dlg = $("datanote");
    if (!dlg) return;
    dlg.innerHTML = noteFrame('<p class="note-lead">Loading the data notes…</p>');
    wireNote(dlg);
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");

    if (_noteHTML !== null) return paintNote(dlg, _noteHTML);

    fetch("about.html", { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (html) {
        // Parsed, never regex-scraped: the section is real markup and a
        // template element keeps its images and scripts from loading.
        var doc = new DOMParser().parseFromString(html, "text/html");
        var sec = doc.getElementById("data-note");
        if (!sec) throw new Error("about.html has no #data-note section");
        _noteHTML = sec.innerHTML;
        paintNote(dlg, _noteHTML);
      })
      .catch(function (e) {
        // Opened from file://, or the page is missing. Say which, and give the
        // link rather than a dead end.
        paintNote(dlg,
          '<p class="note-lead">The data notes could not be loaded (' +
          esc(e && e.message ? e.message : String(e)) + ').</p>' +
          '<p>They live on the <a href="about.html">Docs page</a>, under ' +
          '“The data, and every number in it”.</p>');
      });
  }

  function noteFrame(body) {
    return '<article class="note-doc">' +
      '<header class="note-head"><h2>The data</h2>' +
        '<a class="note-link" href="about.html">Open in Docs</a>' +
        '<button type="button" class="note-close" id="close-data" aria-label="Close">' +
        "Close</button></header>" +
      '<div class="note-body">' + body + "</div></article>";
  }

  function paintNote(dlg, body) {
    dlg.querySelector(".note-body").innerHTML = body;
    // Wide content scrolls inside its own box, never by pushing the sheet
    // sideways: at 375px the four-column tables are 457px and would take the
    // whole note with them.
    Array.prototype.forEach.call(dlg.querySelectorAll(".note-body table"), function (t) {
      if (t.parentNode.classList.contains("tscroll")) return;
      var box = document.createElement("div");
      box.className = "tscroll";
      t.parentNode.insertBefore(box, t);
      box.appendChild(t);
    });
    dlg.querySelector(".note-body").scrollTop = 0;
  }

  function wireNote(dlg) {
    var x = $("close-data");
    if (x) x.onclick = function () { dlg.close(); };
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
    // "Set" read as an instruction rather than a place. The button now says
    // what is in there, which is the only thing worth knowing at a glance.
    b.textContent = state.set.length
      ? state.set.length + (state.set.length === 1 ? " saved" : " saved")
      : "Empty";
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

  /* ONE WORD, ONE MEANING, ACROSS BOTH LAYERS.
   *
   * The upstream events dashboard calls a meetup "Active" if it met within 365
   * days. This tool calls a PERSON active if a source saw them within 30. So
   * 130 groups were drawn green and labelled Active while a person with the
   * identical gap was drawn red and labelled Dormant -- on the same map, at the
   * same time. Nobody can hold two definitions of "active" in their head while
   * reading one screen.
   *
   * The windows are NOT changed: they belong to the events dashboard, and
   * diverging would mean two tools reporting different numbers for the same 708
   * groups. Only the words change, and only where they are shown. The raw value
   * stays the facet key, so shared links and the upstream data are untouched. */
  var MEETUP_LABEL = { "Active": "Meeting", "Dormant": "Stopped", "Not started": "Never met" };
  function meetupLabel(v) { return MEETUP_LABEL[v] || v; }

  /* A dot should say who it is before you commit a click to it.
   *
   * Scanning a map of 2,858 dots told you nothing without poking at each one,
   * so the map was a picture of density rather than of people. Hover now opens
   * the card; click still selects.
   *
   * autoPan:false is the load-bearing option. Leaflet pans the map to fit a
   * popup by default -- the same behaviour that made the map drag itself back
   * to a selection on every moveend. On hover it would be far worse: the map
   * would lurch every time the pointer crossed a dot near an edge, moving the
   * dot you were aiming at. */
  var POPUP_OPTS = { autoPan: false, closeButton: false, autoClose: false,
                     closeOnClick: false };

  function hoverPeek(m) {
    m.on("mouseover", function () { if (!m.isPopupOpen()) m.openPopup(); });
    m.on("mouseout", function () {
      // The selected person's card is not a peek: it was opened deliberately
      // and closing it on mouseout would make the selection flicker.
      var sel = state.selected && state.markers[keyOf(state.selected)];
      var mt = state.selectedMeetup &&
               state.markers[overlayById("meetups").key(state.selectedMeetup)];
      if (m === sel || m === mt) return;
      m.closePopup();
    });
  }

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
      statusLabel: function (m) { return meetupLabel(m.status); },
      // What this layer can be narrowed by. A layer that returns nothing here
      // simply gets no filter chips, which is why Automatticians need no
      // special case anywhere.
      facet: function (m) { return m.status; },
      // Shown on the chips and in the list; facet() above stays the raw value
      // so a shared link keeps working and the upstream vocabulary is intact.
      facetLabel: meetupLabel,
      /* Meetups carry a country, so Place applies to them: "the US, and active
       * meetups" has to mean US meetups. The upstream file spells three of them
       * differently from the people file, which would silently drop 147 US
       * groups from a US view. */
      place: function (m) { return matchPlaceCountry(MEETUP_COUNTRY[m.country] || m.country); },
      listMeta: function (m) {
        return [
          esc(m.city || m.country || "") + " · " + m.members.toLocaleString() + " members",
          m.lastEvent ? "last event " + esc(m.lastEvent) : "no events on record"
        ];
      },
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
          '<span class="tag ' + (MEETUP_CLASS[m.status] || "m-never") + '">' +
            esc(meetupLabel(m.status)) + "</span>" +
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
      /* No place(). automattic.com/map publishes coordinates and no country, so
       * this layer cannot be filtered by Place without inventing one -- and the
       * rule this project runs on is never to infer. The section says so rather
       * than quietly showing the wrong 1,346 people. */
      place: null,
      listMeta: function (a) { return [esc(a.role || "Automattician")]; },
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

    // Exactly the records the list is showing, from the same function, so the
    // map and the rail cannot disagree about what is on.
    var recs = layerRecords(def);
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

    var batch = [];
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
      m.bindPopup(function () { return def.popup(r); }, POPUP_OPTS);
      hoverPeek(m);
      if (def.select) m.on("click", function () { def.select(r); });
      state.markers[def.key(r)] = m;
      batch.push(m);
    });
    // addLayers() builds the cluster tree once for the whole batch. Adding one
    // at a time re-walks it per marker, which is the difference between a
    // responsive filter change and a frozen tab.
    group.addLayers(batch);

    group.on("animationend", repaintSelection);
    group.addTo(state.map);
    state.overlayLayers[def.id] = group;
  }

  /* CHIPS ARE THE FILTER SURFACE.
   *
   * One renderer for every facet in the tool: the people statuses and each
   * layer's own values go through this, so a status chip and a meetup chip
   * cannot end up behaving differently. Multi-select, because "slowing and
   * active" is a thing you can want to look at and a dropdown that allowed one
   * made the tool unable to express it.
   *
   * Counts come from the population -- place, state and search -- and never
   * from the current chip selection, so turning a chip on does not renumber the
   * chip beside it. That is what makes them readable as "what is out there"
   * rather than "what is left".
   */
  function chipRowHTML(id, label, values, counts, set, clsFor, labelFor) {
    var total = 0;
    values.forEach(function (v) { total += counts[v] || 0; });
    var any = facetAny(set);
    return '<div class="chips" data-facet="' + esc(id) + '">' +
      '<span class="label">' + esc(label) + "</span>" +
      '<button class="chip' + (any ? "" : " on") + '" data-v="" aria-pressed="' + !any +
        '">All ' + total.toLocaleString() + "</button>" +
      values.map(function (v) {
        var on = facetOn(set, v);
        return '<button class="chip ' + esc(clsFor ? clsFor(v) : v) + (on ? " on" : "") +
          '" data-v="' + esc(v) + '" aria-pressed="' + on + '">' +
          esc(labelFor ? labelFor(v) : v) + " " +
          (counts[v] || 0).toLocaleString() + "</button>";
      }).join("") + "</div>";
  }

  /* People statuses. Counts are of the population, so they answer "how many
   * slowing people are there in the US" whatever else is switched on. */
  function renderStatusFilters() {
    var host = $("status-filters");
    if (!host) return;
    if (!overlayOn("people")) { host.innerHTML = ""; return; }
    var counts = {};
    pool().forEach(function (p) { counts[p.status] = (counts[p.status] || 0) + 1; });
    var vals = STATUS.filter(function (s) { return counts[s]; });
    host.innerHTML = chipRowHTML("people", "Status", vals, counts, state.statuses);
    wireChips(host, function (v) {
      // A status and a preset are contradictory asks -- the preset already
      // fixes the statuses -- so picking a status clears the preset rather than
      // intersecting with it and returning nothing.
      state.preset = "";
      if (v) facetToggle(state.statuses, v); else state.statuses = {};
      state.page = 0;
      render();
    });
  }

  /* A layer's own values, from the registry the same way its toggle is. A layer
   * that declares no facet gets no chips, which is why Automatticians need no
   * special case: they have one value and no question worth asking about it.
   * Chips appear only while their layer is on, because a filter for something
   * invisible is furniture. */
  function renderLayerFilters() {
    var host = $("layer-filters");
    if (!host) return;
    var html = "";
    OVERLAYS.forEach(function (def) {
      if (!overlayOn(def.id) || !def.facet) return;
      var counts = {};
      (def.data() || []).forEach(function (r) {
        if (r.lat == null) return;
        if (def.place && !def.place(r)) return;   // count what Place would give you
        var v = def.facet(r);
        if (v) counts[v] = (counts[v] || 0) + 1;
      });
      var vals = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
      if (vals.length < 2) return;              // nothing to choose between
      html += chipRowHTML(def.id, def.label, vals, counts,
        state.overlayFilter[def.id] || (state.overlayFilter[def.id] = {}),
        function (v) { return MEETUP_CLASS[v] || ""; }, def.facetLabel);
    });
    host.innerHTML = html;
    wireChips(host, function (v, id) {
      var set = state.overlayFilter[id] || (state.overlayFilter[id] = {});
      if (v) facetToggle(set, v); else state.overlayFilter[id] = {};
      renderOverlay(overlayById(id));
      renderLayerFilters();
      renderSide(visible());
    });
  }

  function wireChips(host, onPick) {
    Array.prototype.forEach.call(host.querySelectorAll(".chip"), function (el) {
      el.onclick = function () { onPick(el.dataset.v, el.parentNode.dataset.facet); };
    });
  }

  function renderOverlays() { OVERLAYS.forEach(renderOverlay); }

  /* One proximity function for every overlay. Was two. */
  function nearbyIn(def, p) {
    if (p.lat == null) return [];
    // Same filter the map and the list use. Without this the record panel lists
    // dormant groups the map is not showing, and the surfaces contradict.
    return layerRecords(def)
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

  /* Reset view. Flying to a person leaves the map wherever they are, and
   * clearing the record does not move it back -- deliberately, so dismissing a
   * record does not yank the map. That left no way home short of changing a
   * filter or reloading.
   *
   * Resets the view only. The selection and the record stay put, because the
   * button says view and a button should do what it says. */
  function resetView() {
    if (!state.map || !state.homeBounds) return;
    // A cluster left fanned open is stale map furniture the moment you stop
    // looking at the person it was opened for.
    if (state.layer && state.layer.unspiderfy) state.layer.unspiderfy();
    state.map.closePopup();
    state.map.invalidateSize(false);
    state.map.flyToBounds(state.homeBounds, { padding: [20, 20], maxZoom: 12, duration: 0.6 });
  }

  /* The key, on the map it describes, collapsed until asked for. It used to sit
   * at the bottom of the queue, below up to sixty rows, where it was both
   * unfindable and in the way of the list. */
  function addKeyControl() {
    if (!state.map || state.keyCtl) return;
    var Ctl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var wrap = L.DomUtil.create("div", "leaflet-bar leaflet-control cm-key");
        var a = L.DomUtil.create("a", "", wrap);
        a.href = "#";
        a.title = "What the shapes and colours mean";
        a.setAttribute("role", "button");
        a.setAttribute("aria-expanded", "false");
        a.setAttribute("aria-label", "Map key");
        a.innerHTML =
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
          'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
          'stroke-linejoin="round" aria-hidden="true">' +
          '<circle cx="7" cy="7" r="3.2"></circle>' +
          '<rect x="13.6" y="3.8" width="6.4" height="6.4" rx="1"></rect>' +
          '<path d="M4 17.5h16"></path><path d="M4 21h10"></path></svg>';
        var panel = L.DomUtil.create("div", "cm-key-panel", wrap);
        panel.hidden = true;
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.disableScrollPropagation(wrap);
        L.DomEvent.on(a, "click", L.DomEvent.stop);
        /* Fit the panel by reshaping it, not by scrolling it.
         *
         * Scrolling a legend is a hack: it is a reference you read at a glance,
         * and a scrollbar means part of the answer is hidden behind a gesture.
         * So the panel walks a ladder of layouts and takes the first that
         * genuinely fits the map both ways -- one column, two columns side by
         * side, tighter type, and finally swatches and labels without their
         * descriptions. Only if the map is smaller than the smallest of those
         * does it fall back to scrolling, which in practice it does not. */
        var LADDER = ["", "wide", "compact", "wide compact", "bare", "wide compact bare"];

        function fitPanel() {
          if (panel.hidden || !state.map) return;
          var gutter = 12;
          var map = state.map.getContainer().getBoundingClientRect();
          var ctl = wrap.getBoundingClientRect();
          var availH = map.height - gutter * 2;
          var availW = map.right - ctl.right - gutter * 2;

          panel.style.maxHeight = "";
          panel.style.overflowY = "hidden";
          var chosen = LADDER[LADDER.length - 1];
          for (var i = 0; i < LADDER.length; i++) {
            panel.className = "cm-key-panel " + LADDER[i];
            if (panel.offsetWidth > availW) continue;          // no room sideways
            if (panel.scrollHeight <= availH) { chosen = LADDER[i]; break; }
            chosen = LADDER[i];
          }
          panel.className = "cm-key-panel " + chosen;

          // Last resort only: if even the barest layout is taller than the map,
          // let it scroll rather than clip something off entirely.
          if (panel.scrollHeight > availH) {
            panel.style.maxHeight = availH + "px";
            panel.style.overflowY = "auto";
          }

          // Keep it inside the map vertically: hang from the top when there is
          // room below, otherwise sit against the bottom edge.
          var h = Math.min(panel.scrollHeight, availH);
          if (ctl.top + h + gutter <= map.bottom) {
            panel.style.top = "0"; panel.style.bottom = "auto";
          } else {
            panel.style.top = "auto";
            panel.style.bottom = (map.bottom - ctl.bottom - gutter) * -1 + "px";
          }
        }

        L.DomEvent.on(a, "click", function () {
          // Built on open, not at map creation: the counts inside it come from
          // the dataset, which is not loaded when the control is added.
          if (panel.hidden) panel.innerHTML = legend();
          panel.hidden = !panel.hidden;
          a.setAttribute("aria-expanded", String(!panel.hidden));
          fitPanel();
        });
        // A window resized while the key is open should not leave it clipped
        // until the next click.
        window.addEventListener("resize", fitPanel);
        state.map.on("resize", fitPanel);
        return wrap;
      }
    });
    state.keyCtl = new Ctl();
    state.keyCtl.addTo(state.map);
  }

  /* Expand, where every map already puts it: in the control stack, as the
   * corner-arrows icon people already know. It was briefly a Triage/Explore
   * pair in the masthead, which made it a mode -- and a mode that other clicks
   * could flip. A map control cannot be triggered by anything but itself. */
  function addExpandControl() {
    if (!state.map || state.expandCtl) return;
    var OUT = '<path d="M9 3H3v6"></path><path d="M3 3l7 7"></path>' +
              '<path d="M15 21h6v-6"></path><path d="M21 21l-7-7"></path>';
    var IN  = '<path d="M3 9h6V3"></path><path d="M10 10L3 3"></path>' +
              '<path d="M21 15h-6v6"></path><path d="M14 14l7 7"></path>';
    function svg(paths) {
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
             'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
             'stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
    }
    var Ctl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var wrap = L.DomUtil.create("div", "leaflet-bar leaflet-control cm-expand");
        var a = L.DomUtil.create("a", "", wrap);
        a.href = "#";
        a.id = "map-expand";
        a.setAttribute("role", "button");
        a.setAttribute("aria-pressed", "false");
        a.setAttribute("aria-label", "Expand the map");
        a.innerHTML = svg(OUT);
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.on(a, "click", L.DomEvent.stop);
        L.DomEvent.on(a, "click", function () {
          setMapExpanded(!state.mapExpanded);
          a.innerHTML = svg(state.mapExpanded ? IN : OUT);
        });
        return wrap;
      }
    });
    state.expandCtl = new Ctl();
    state.expandCtl.addTo(state.map);
  }

  function addResetControl() {
    if (!state.map || state.resetCtl) return;
    var Ctl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var wrap = L.DomUtil.create("div", "leaflet-bar leaflet-control cm-reset");
        var a = L.DomUtil.create("a", "", wrap);
        a.href = "#";
        a.title = "Reset the map view";
        a.setAttribute("role", "button");
        a.setAttribute("aria-label", "Reset the map view");
        // Drawn, not typed: a glyph would not scale or recolour with the theme.
        a.innerHTML =
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
          'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
          'stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5"></path></svg>';
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.on(a, "click", L.DomEvent.stop);
        L.DomEvent.on(a, "click", resetView);
        return wrap;
      }
    });
    state.resetCtl = new Ctl();
    state.resetCtl.addTo(state.map);
  }

  function renderMap(list) {
    if (!state.map) { initMap(); addExpandControl(); addResetControl(); addKeyControl(); }
    state.layer.clearLayers();
    state.markers = {};
    // People is a layer now, and a layer that is off draws nothing. Without
    // this, switching People off would leave the dots on the map while the list
    // said they were gone.
    var placed = overlayOn("people")
      ? list.filter(function (p) { return p.lat != null; })
      : [];

    var batch = [];
    placed.forEach(function (p) {
      // Hit targets, not decoration. A 10px dot is a hard click on a trackpad
      // and effectively unclickable for anyone whose eyes are not 25 -- the
      // whole map is unusable if you cannot reliably land on a person.
      var size = hasRole(p) ? 20 : 16;
      var cls = "circle " + p.status + (hasRole(p) ? " is-roster" : "") +
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
      // Lazy: Leaflet calls this when the popup is actually opened. Building the
      // markup eagerly meant composing ~2,900 popup strings on every filter
      // change, none of which anyone was going to read.
      m.bindPopup(function () {
        return "<strong>" + esc(p.name) + "</strong>" +
          (p.a8c ? ' <span class="tag a8c">a8c</span>' : "") + "<br>" +
          (hasRole(p) ? "<strong>" + esc(p.role) + "</strong>" : esc(p.role)) +
          (roleDef(p.role) ? '<br><span class="popup-def">' + esc(roleDef(p.role)) + "</span>" : "") +
          "<br>" + esc(p.city || p.country || "") +
          (p.precision === "country" ? " <em>(country only)</em>" : "") +
          '<br><span class="tag ' + p.status + '">' + p.status + "</span>";
      }, POPUP_OPTS);
      hoverPeek(m);
      batch.push(m);
    });
    // addLayers() builds the cluster tree once for the whole batch. Adding one
    // at a time re-walks it per marker, which is the difference between a
    // responsive filter change and a frozen tab.
    state.layer.addLayers(batch);

    if (placed.length) {
      // fitBounds against a pane Leaflet still measures as zero-height silently
      // falls back to zoom 0, which is how a map of 637 United States dots ends
      // up showing the whole globe. Fit once now and again after the browser has
      // settled layout, so the result does not depend on load-timing luck.
      // Pixel padding, not .pad(0.15). pad() expands by a fraction of the data
      // extent, so it always spends ~11.5% of each edge on margin regardless of
      // pane width -- fine across 1100px, a sixth of a 500px context pane.
      // maxZoom covers a case the wide map hid: filtering to a single placed
      // person gives degenerate bounds, and fitBounds slams to street level.
      var bounds = L.latLngBounds(placed.map(function (p) { return [p.lat, p.lng]; }));
      // Kept so Reset view has somewhere to go back to. It is the frame the
      // current filter would land on, not the frame the app opened with: after
      // switching to Brazil, "reset" means Brazil, not the United States.
      state.homeBounds = bounds;
      var fit = function () {
        if (!state.map || state.selected || state.selectedMeetup) return;   // never fight a selection
        state.map.invalidateSize(false);
        state.map.fitBounds(bounds, { padding: [20, 20], maxZoom: 12 });
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
        '<button class="backlink" id="do-back">Clear</button>' +
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
      '<button class="backlink" id="do-back">Clear</button>' +
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

  /* The rail used to be one element with a four-way switch inside it, so
   * opening a record destroyed the queue you were working through. It is now
   * two panes rendered independently. renderSide stays as the orchestrator
   * because fourteen call sites reach for it, and none of them care. */
  function syncExpandButton() {
    var b = $("map-expand");
    if (!b) return;
    b.setAttribute("aria-pressed", String(state.mapExpanded));
    b.title = state.mapExpanded ? "Show the list again" : "Give the map the whole width";
  }

  function renderSide(list) {
    // Read the queue's scroll BEFORE the class below may hide it: a display:none
    // element reports scrollTop 0, so capturing afterwards loses the position
    // every time you open a record.
    var q = $("queue");
    if (q && q.offsetParent !== null) state.queueScroll = q.scrollTop;

    // The rail swap lives here, not in render(). closeRecord(), select() and
    // selectMeetup() all repaint through renderSide WITHOUT calling render(),
    // so a toggle in render() would leave Escape showing an empty record pane
    // with the queue still hidden behind it.
    var stage = $("stage");
    if (stage) {
      stage.classList.toggle("has-record",
        !!(state.selected || state.selectedMeetup || state.showSet));
    }

    // Required, not redundant: select(), closeRecord(), selectMeetup(), the set
    // button, the layer toggles and stepQueue() all repaint through here
    // WITHOUT going through render(). Without this, opening a person would not
    // change the URL, which is the single most important thing to link to.
    syncHash();
    renderList(list);
    renderRecord(list);
  }

  function renderRecord(list) {
    var pane = $("record");
    if (!pane) return;

    if (state.showSet) {
      pane.innerHTML = setPanelHTML();
      wireSetPanel();
      return;
    }

    if (state.selectedMeetup) {
      pane.innerHTML = meetupDetailHTML(state.selectedMeetup, list) + pendingHTML();
      wireMeetupDetail(state.selectedMeetup, list);
      wirePending();
      return;
    }

    if (state.selected) {
      pane.innerHTML = detailHTML(state.selected, list) +
        (state.editing ? editorHTML(state.selected) : "") + pendingHTML();
      wireDetail(state.selected, list);
      wirePending();
      return;
    }

    // Nothing selected: the column is not shown at all, so it has nothing to
    // say. An empty pane holding a "pick someone" sign was spending the map's
    // width on an instruction you only need once.
    pane.innerHTML = "";
  }

  /* THE LIST IS A VIEW OF WHAT IS SELECTED.
   *
   * It used to be a queue: dormant and inactive people, always, and every other
   * control could only narrow inside that. Turning on "slowing" therefore
   * produced "No dormant people in this view" -- the list could not represent
   * the selection, so it reported the selection as empty. That is the wrong
   * shape for a tool whose whole premise is toggling things on and off.
   *
   * Now every facet is additive and the list shows what they select, in
   * sections: people, then whichever layers are on. "Gone quiet, reachable
   * first" survives as a PRESET rather than as a property of the list.
   */
  function renderList(list) {
    var side = $("queue");
    if (!side) return;
    // Still built while the map is expanded: the rail is hidden, not gone, and
    // the arrow keys must have something to walk the moment it returns.
    if (!side.offsetParent && state.listKeys.length) return;

    var prevScroll = state.queueScroll;
    var html = pendingHTML() + selectionHTML(list);

    var walk = [];                    // what the arrow keys move through
    if (overlayOn("people")) html += peopleSectionHTML(list, walk);
    OVERLAYS.forEach(function (def) {
      if (def.id === "people" || !overlayOn(def.id)) return;
      html += layerSectionHTML(def);
    });
    if (!walk.length) html += emptyHTML();

    state.listKeys = walk;
    side.innerHTML = html;
    if (side.offsetParent !== null) side.scrollTop = prevScroll;

    wirePending();
    wireListRows(side, list);
    wireShowMore(side, list);
    scrollLastViewedIntoView(side);
  }

  /* What the current selection is, said in one line above the list, because a
   * list of 3,196 rows does not tell you which of six statuses produced it. */
  function selectionHTML(list) {
    var bits = [];
    if (state.preset === "quiet") bits.push("gone quiet");
    else if (state.preset === "reachable") bits.push("gone quiet, with someone active in range");
    var st = Object.keys(state.statuses).filter(function (k) { return state.statuses[k]; });
    if (st.length) bits.push(st.join(", "));
    if (state.place) bits.push(state.usState ? state.usState : state.place);
    if (state.q) bits.push('"' + esc(state.q) + '"');

    var sub = bits.length
      ? '<p class="hint">Showing ' + bits.join(" · ") + ".</p>"
      : '<p class="hint">Everyone in the two Slack channels, everywhere. Turn on a ' +
        "status, a place or a headline to narrow it.</p>";

    // Ranking only means something when the preset is on, so it is only claimed
    // then. Saying "ranked by reachability" over an alphabetical list would be
    // the tool describing work it did not do.
    if (state.preset) {
      sub += '<p class="hint">Reachable first — those are the ones you can act on ' +
        "today. Anyone with nobody in range sits at the bottom: that is a coverage gap, " +
        'not a lead. <span class="subtle">↑ ↓ to move through them, Esc to come ' +
        "back.</span></p>";
    }

    var mapped = list.filter(function (p) { return p.lat != null; }).length;
    if (overlayOn("people") && mapped < list.length) {
      sub += '<p class="hint coverage">' + mapped.toLocaleString() + " of " +
        list.length.toLocaleString() + " are on the map. The rest never filled in a " +
        "location, so they are counted here but cannot be placed.</p>";
    }
    return sub;
  }

  function emptyHTML() {
    return '<div class="state"><strong>Nothing selected</strong>' +
      "Nothing matches, or every layer is switched off. Widen the place, clear a status, " +
      "or turn People back on.</div>";
  }

  /* The people section.
   *
   * Two orders, and which one is in force is stated above the list rather than
   * left to be inferred:
   *
   *  - PRESET ON: reachability first, then role-holders, then most recently
   *    quiet. Recoverability falls off with time, so sorting by longest-gone
   *    put 2014 accounts at the top, which is the opposite of actionable.
   *  - PRESET OFF: most recently seen first, which is the only order that means
   *    anything across a mixed selection of statuses.
   *
   * Reachability is read from the per-render memo, never computed inside the
   * comparator: a comparator runs O(n log n) times and each call would be a
   * full sweep of the active set. */
  function peopleSectionHTML(list, walk) {
    var rows = list.slice();
    if (state.preset) {
      var reach = reachKeys();
      rows.sort(function (a, b) {
        var an = reach[keyOf(a)] ? 0 : 1, bn = reach[keyOf(b)] ? 0 : 1;
        if (an !== bn) return an - bn;
        var ar = hasRole(a) ? 0 : 1, br = hasRole(b) ? 0 : 1;
        if (ar !== br) return ar - br;
        var ad = a.status === "inactive" ? 1 : 0, bd = b.status === "inactive" ? 1 : 0;
        if (ad !== bd) return ad - bd;
        return (a.days || 0) - (b.days || 0);
      });
    } else {
      rows.sort(function (a, b) {
        var ax = a.last_signal || a.last_seen || "", bx = b.last_signal || b.last_seen || "";
        if (ax === bx) return String(a.name).localeCompare(String(b.name));
        if (!ax) return 1;
        if (!bx) return -1;
        return ax < bx ? 1 : -1;
      });
    }

    var limit = state.limits.people || 60;
    var shown = rows.slice(0, limit);
    shown.forEach(function (p) { walk.push(keyOf(p)); });

    var html = sectionHead("People", rows.length,
      state.preset ? "reachable first" : "most recently seen first");
    html += shown.map(personRowHTML).join("");
    html += moreHTML("people", shown.length, rows.length);
    return html;
  }

  function personRowHTML(p) {
    var reach;
    var near = nearestActive(p, neighbours(), 1)[0] || null;
    if (near) {
      reach = '<div class="meta">Nearest active: <strong>' + esc(near.p.name) +
              "</strong> · " + km(near.d) + "</div>";
    } else if (p.lat == null) {
      reach = '<div class="meta subtle">No location on record</div>';
    } else {
      // Say how far the nearest one actually is, so the radius can be widened
      // deliberately rather than guessed at.
      var far = nearestAnywhere(p, neighbours());
      reach = '<div class="meta subtle">Nobody active within ' + state.radiusMi + " mi" +
              (far ? " · closest is " + esc(far.p.name) + " at " + km(far.d) : "") + "</div>";
    }
    return '<div class="row' + (keyOf(p) === state.lastViewed ? " is-viewed" : "") +
      '" data-name="' + esc(p.name) + '" data-key="' + esc(keyOf(p)) + '">' +
      '<div class="nm">' + esc(p.name) + ' <span class="tag ' + p.status + '">' + p.status + "</span>" +
        roleTag(p) +
        (p.a8c ? ' <span class="tag a8c">a8c</span>' : "") + "</div>" +
      '<div class="meta">' + (hasRole(p) ? "" : roleHTML(p.role)) +
        (hasRole(p) ? "" : " · ") +
        // the freshest signal from any source, not just Slack's, or the row
        // contradicts the record it opens
        (p.last_signal || p.last_seen
          ? "last seen " + esc(p.last_signal || p.last_seen)
          : "no signal on record") +
      "</div>" + reach +
      "</div>";
  }

  /* One section builder for every layer, driven by the same registry that draws
   * the markers and the chips. A new layer is a descriptor, not a fourth copy
   * of this. Ordered the way the map orders it: whatever the layer calls worth
   * acting on comes first. */
  function layerSectionHTML(def) {
    var recs = layerRecords(def);
    recs.sort(function (a, b) {
      var aq = def.quiet(a) ? 0 : 1, bq = def.quiet(b) ? 0 : 1;
      if (aq !== bq) return aq - bq;
      return String(def.name(a)).localeCompare(String(def.name(b)));
    });

    var limit = state.limits[def.id] || 40;
    var shown = recs.slice(0, limit);

    var html = sectionHead(def.label, recs.length,
      def.place ? "" : "not filtered by Place — no country on record");
    if (!recs.length) {
      html += '<div class="state">None match this selection.</div>';
      return html;
    }
    html += shown.map(function (r) {
      var meta = def.listMeta ? def.listMeta(r) : [];
      return '<div class="row" data-key="' + esc(def.key(r)) + '" data-layer="' +
        esc(def.id) + '">' +
        '<div class="nm">' + esc(def.name(r)) +
          ' <span class="tag ' + esc(def.cls(r)) + '">' + esc(def.statusLabel(r)) + "</span></div>" +
        meta.map(function (m) { return '<div class="meta">' + m + "</div>"; }).join("") +
        "</div>";
    }).join("");
    html += moreHTML(def.id, shown.length, recs.length);
    return html;
  }

  /* The records a layer contributes to the CURRENT selection: its own facet
   * chips, plus Place where the layer carries a country. The map filters by
   * exactly this, so the two surfaces cannot disagree about what is on. */
  function layerRecords(def) {
    return (def.data() || []).filter(function (r) {
      if (r.lat == null) return false;
      if (def.facet && !facetMatch(state.overlayFilter[def.id], def.facet(r))) return false;
      if (def.place && !def.place(r)) return false;
      return true;
    });
  }

  function sectionHead(label, n, note) {
    return '<div class="section-head"><p class="label">' + esc(label) + " " +
      n.toLocaleString() + "</p>" +
      (note ? '<p class="hint">' + esc(note) + "</p>" : "") + "</div>";
  }

  function moreHTML(id, shown, total) {
    if (total <= shown) return "";
    return '<div class="state">' + shown.toLocaleString() + " of " + total.toLocaleString() +
      ". " + '<button class="btn" data-more="' + esc(id) + '">Show ' +
      Math.min(60, total - shown) + " more</button></div>";
  }

  function wireShowMore(side, list) {
    Array.prototype.forEach.call(side.querySelectorAll("[data-more]"), function (el) {
      el.onclick = function () {
        // Keep the scroll where it is: the point of showing more is to carry on
        // from where you had read to, not to be thrown back to the top.
        state.queueScroll = side.scrollTop;
        var id = el.dataset.more;
        state.limits[id] = (state.limits[id] || (id === "people" ? 60 : 40)) + 60;
        renderList(list);
      };
    });
  }

  function wireListRows(side, list) {
    Array.prototype.forEach.call(side.querySelectorAll(".row"), function (el) {
      var key = el.dataset.key, layer = el.dataset.layer;
      el.onmouseenter = function () { markMarker(key, "is-hot", true); };
      el.onmouseleave = function () { markMarker(key, "is-hot", false); };
      if (layer) {
        var def = overlayById(layer);
        if (!def || !def.select) return;
        var rec = null;
        layerRecords(def).forEach(function (r) { if (def.key(r) === key) rec = r; });
        el.onclick = function () { if (rec) def.select(rec); };
        return;
      }
      // Match on the .org key, not the name: 78 names in this dataset are shared
      // by more than one person, so name matching selects the wrong one.
      var hit = null;
      list.forEach(function (x) { if (keyOf(x) === key) hit = x; });
      el.onclick = function () { if (hit) select(hit, list); };
    });
  }

  function scrollLastViewedIntoView(side) {
    // Centre it if any part of it is clipped, not only when it is fully off
    // screen: a row half-cut by the top edge is exactly as hard to find.
    var seen = side.querySelector(".row.is-viewed");
    if (!seen) return;
    var top = seen.offsetTop, bottom = top + seen.offsetHeight;
    if (top < side.scrollTop + 8 || bottom > side.scrollTop + side.clientHeight - 8) {
      seen.scrollIntoView({ block: "center" });
    }
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

    var withRole = state.data.people.filter(hasRole).length;

    return '<div class="legend">' +
      '<p class="label">Shape is the layer</p><dl>' +
        "<dt><span class='dot pin circle active'></span>People</dt><dd>always shown</dd>" +
        shapes +
      "</dl>" +
      '<p class="label" style="margin-top:var(--s-4)">Colour is the status</p><dl>' + colours + "</dl>" +
      // The ring carries the whole "has a role" distinction now that it is not
      // a filter, so it earns its own line rather than a footnote.
      '<p class="label" style="margin-top:var(--s-4)">A ring is a role</p><dl>' +
        "<dt><span class='dot pin circle active is-roster'></span>Team role</dt><dd>" +
          withRole.toLocaleString() + " on the roster or found doing the work</dd>" +
        "<dt><span class='dot pin circle active'></span>No role</dt><dd>" +
          (state.data.people.length - withRole).toLocaleString() + " in the channels</dd>" +
      "</dl>" +
      '<p class="meta" style="font-size:var(--t-small);color:var(--faint);margin-top:var(--s-3)">' +
      esc(m.caveats[1]) + "</p></div>";
  }

  /* Who is nearest, for a set of rows.
   *
   * This is the tool's actual finding, and until now it existed in exactly one
   * place: the sidebar queue. The table sorted by message count and carried no
   * reachability at all, and the CSV export inherited that, so the thing worth
   * knowing never left the screen it was computed on.
   *
   * Computed for the rows being rendered or exported, not for the whole
   * dataset. nearbyPeople rejects on a bounding box before it reaches any
   * trigonometry, so a page of 250 costs little; a 7,032-row export pays for
   * itself once, deliberately, on a click. */
  function reachIndex(rows, list) {
    /* Deliberately not a loop over nearestActive(). That walks all 2,858 placed
     * people per row and sorts the whole result to take the first of it, which
     * put a 7,032-row export around half a minute. Here the active subset is
     * built once (roughly 360 of them) and each row keeps a running minimum, so
     * there is no per-row allocation and no sort at all. */
    var actives = placedIn(list).filter(function (a) { return a.status === "active"; });
    var r = state.radiusMi;
    var out = {};
    for (var j = 0; j < rows.length; j++) {
      var p = rows[j], pk = keyOf(p);
      if (p.lat == null) { out[pk] = null; continue; }
      var dLat = r ? (r / 69) + 0.001 : Infinity;
      var cosLat = Math.max(0.01, Math.cos(p.lat * Math.PI / 180));
      var dLng = r ? (r / (69 * cosLat)) + 0.001 : Infinity;
      var best = null, bestD = Infinity;
      for (var i = 0; i < actives.length; i++) {
        var a = actives[i];
        if (r && (Math.abs(a.lat - p.lat) > dLat || Math.abs(a.lng - p.lng) > dLng)) continue;
        if (keyOf(a) === pk) continue;
        var d = distance(p, a);
        if (d >= bestD) continue;
        if (r && miles(d) > r) continue;
        best = a; bestD = d;
      }
      out[pk] = best ? { name: best.name, d: bestD } : null;
    }
    return out;
  }

  /* A third element is a getter, for columns that are derived rather than
   * stored. Without it the export would write "undefined" for them, since it
   * reads p[key] straight off the record. */
  var COLS = [
    ["name", "Name"], ["role", "Role"], ["status", "Status"], ["last_seen", "Last seen"],
    ["messages", "Messages"], ["posts", "Supporter ch."], ["vetting", "Vetting"], ["checkins", "Check-ins"],
    ["city", "Location"], ["country", "Country"], ["employer", "Employer"],
    ["slack", "Slack"], ["org", ".org"],
    ["near_name", "Nearest active", function (p, r) { return r ? r.name : ""; }],
    ["near_dist", "Distance",       function (p, r) { return r ? km(r.d) : ""; }]
  ];
  var sortKey = "messages", sortDir = -1;

  function renderTable(list) {
    // The two reachability columns are computed against the radius slider,
    // which lives in the record panel and is invisible from here. Say the
    // number in the header rather than leaving a silent dependency.
    $("thead").innerHTML = "<th>#</th>" + COLS.map(function (c) {
      var label = c[0].indexOf("near_") === 0
        ? c[1] + " (" + state.radiusMi + " mi)" : c[1];
      return "<th data-k='" + c[0] + "'>" + label + "</th>";
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
    // Only the page on screen, so paging stays instant on 7,032 rows.
    var reach = reachIndex(rows, neighbours());

    $("do-csv").textContent = "Export " + all.length.toLocaleString() + " rows";
    if (!all.length) {
      // An empty grid with live headers reads as a loading failure. Say which
      // switch produced it, since with People off no filter change will refill
      // this table.
      $("tbody").innerHTML = '<tr><td colspan="' + (COLS.length + 1) + '">' +
        (overlayOn("people")
          ? "No one matches this selection. Clear a status, widen the place, or clear the search."
          : "People are switched off. Turn them back on in Show.") +
        "</td></tr>";
      $("tcount").textContent = "0 contributors";
      $("pg-label").textContent = "1 / 1";
      $("do-csv").textContent = "Export 0 rows";
      return;
    }

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
        "<td>" + (reach[keyOf(p)] ? esc(reach[keyOf(p)].name) : "—") + "</td>" +
        "<td class='tabular'>" + (reach[keyOf(p)] ? esc(km(reach[keyOf(p)].d)) : "—") + "</td>" +
        "</tr>";
    }).join("");

    Array.prototype.forEach.call($("thead").children, function (th) {
      if (!th.dataset.k) return;
      // Derived columns have nothing on the record to sort by, and computing
      // them for all 7,032 rows to sort a page of 50 is not worth it. The queue
      // is where reachability ordering lives.
      if (th.dataset.k.indexOf("near_") === 0) { th.classList.add("no-sort"); return; }
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
      '<button class="backlink" id="do-back">Clear</button>' +
      (p.avatar ? '<img class="record-avatar" src="' + esc(p.avatar) + '?s=112" alt="">' : "") +
      "<h2>" + esc(p.name) +
        // Both things at once, said plainly. Someone can hold a Community Team
        // role and work here, and the map used to show them twice rather than
        // saying so.
        roleTag(p) +
        (p.a8c ? ' <span class="tag a8c">a8c</span>' : "") + "</h2>" +
      '<p class="meta">' + (hasRole(p) ? "" : roleHTML(p.role)) +
        (p.a8c && p.a8c_title ? " · " + esc(p.a8c_title) + " at Automattic"
                              : (p.employer ? " · " + esc(p.employer) : "")) + "</p>" +
      '<p style="margin-top:var(--s-2)"><span class="tag ' + p.status + '">' + p.status + "</span>" +
        // No "corrected" badge. It sat beside the person's name and status and
        // read as a mark on them, when the thing that was corrected is a field
        // in a spreadsheet. The reason is still recorded below, against the
        // data. "Edited locally" stays because it is a warning about the
        // reader's own unsaved change, not a label on the person.
        (p.locallyEdited ? ' <span class="edited">· edited locally</span>' : "") + "</p>" +
      "<dl>" +
        "<dt>Location</dt><dd>" + esc(p.city || p.country || "not on record") +
          (p.precision === "country" ? " <em>(country only)</em>" : "") + "</dd>" +
        "<dt>Last seen</dt><dd>" + esc(p.last_signal || p.last_seen || "no signal on record") +
          (p.last_signal_source ? ' <span class="via">via ' + esc(p.last_signal_source) + "</span>" : "") +
          "</dd>" +
        (p.sources && Object.keys(p.sources).length > 1
          ? "<dt>Seen in</dt><dd>" + Object.keys(p.sources).sort(function (a, b) {
              return p.sources[b] < p.sources[a] ? -1 : 1;
            }).map(function (k) {
              return '<span class="src">' + esc(SOURCE_LABEL[k] || k) + " " +
                     esc(p.sources[k]) + "</span>";
            }).join(" ") + "</dd>"
          : "") +
        "<dt>Evidence</dt><dd>" + (src.length ? esc(src.join(" · ")) : "nothing in the sources we read") + "</dd>" +
        (p.slack ? "<dt>Slack</dt><dd>" + link(slackLink(p), "@" + p.slack) + "</dd>" : "") +
        (p.org ? "<dt>.org</dt><dd>" + link(orgLink(p), p.org) + "</dd>" : "") +
        (p.override && p.override.why ? "<dt>Note</dt><dd>" + esc(p.override.why) + "</dd>" : "") +
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
    nearbyPeople({ lat: mt.lat, lng: mt.lng, org: "", slack: "", name: "" }, neighbours())
      .forEach(function (h) { markMarker(keyOf(h.p), "is-near", true); });
  }

  function meetupDetailHTML(mt, list) {
    var here = { lat: mt.lat, lng: mt.lng, org: "", slack: "", name: "\u0000" };
    var near = nearbyPeople(here, neighbours(), state.nearStatus);
    var tally = nearbyTally(here, neighbours());
    var cls = MEETUP_CLASS[mt.status] || "m-never";
    var mtLabel = meetupLabel(mt.status);

    var head = '<div class="detail">' +
      '<button class="backlink" id="do-back">Clear</button>' +
      "<h2>" + esc(mt.group) + "</h2>" +
      '<p class="meta">Meetup group' + (mt.region ? " · " + esc(mt.region) : "") + "</p>" +
      '<p style="margin-top:var(--s-2)"><span class="tag ' + cls + '">' + esc(mtLabel) + "</span></p>" +
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
      '<p class="hint">Meeting means an event within 365 days, a window set by the ' +
      'events dashboard ' +
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
    var tally = nearbyTally(p, neighbours());
    var rows = nearbyPeople(p, neighbours(), state.nearStatus).slice(0, 12);
    var head = '<p class="label">Who is nearby</p>' + radiusSliderHTML() + nearFilterHTML(tally);

    if (!Object.keys(tally).length) {
      var far = nearestAnywhere(p, neighbours());
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
    nearbyPeople(here, neighbours()).forEach(function (h) {
      markMarker(keyOf(h.p), "is-near", true);
    });
  }

  /* Deliberately no openPopup() here.
   *
   * This runs on every zoomend and moveend, to re-apply the highlight classes
   * after clustering rebuilds the markers. It used to re-open the selected
   * popup too, and Leaflet's openPopup autoPans by default -- so panning away
   * from the person you had open fired moveend, which re-opened the popup,
   * which panned the map straight back to them. The map fought you for the
   * viewport every time you tried to look at anything else.
   *
   * Opening a popup is a thing the reader did once, in select(). Re-asserting
   * it on every map movement is not repainting, it is overriding. */

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
    // Derived rather than a constant, so it self-corrects between a 1100px
    // Explore map and a 500px Triage pane. The thing that must stay legible is
    // the search radius, so frame that rather than a fixed zoom level.
    var target;
    try {
      var span = L.latLng(p.lat, p.lng).toBounds(state.radiusMi * 1609.34 * 2);
      target = state.map.getBoundsZoom(span, false, L.point(24, 24));
    } catch (e) {
      target = Math.max(state.map.getZoom(), FOCUS_ZOOM);
    }
    state.map.flyTo([p.lat, p.lng], Math.min(target, MAX_FOCUS_ZOOM), { duration: 0.6 });

    // flyTo emits no moveend when the map is already where it was asked to go,
    // so the settle handler has to be armed both ways or the selection silently
    // never gets painted. Fires exactly once, whichever arrives first.
    // Arrowing quickly through the queue leaves earlier flights in flight, and
    // spiderfy() below fires before the caller's own staleness check. Without a
    // token, a cluster fans open for someone you have already moved past.
    var token = ++state._focusToken;
    var settled = false;
    function onSettle() {
      if (settled || token !== state._focusToken) return;
      settled = true;
      if (!m) { if (then) then(m); return; }
      var parent = state.layer.getVisibleParent && state.layer.getVisibleParent(m);
      if (parent && parent !== m && parent.spiderfy) {
        parent.spiderfy();                       // open the pile where it stands
        setTimeout(function () {
          // markercluster does not pan to keep a fan on screen, so in a narrow
          // pane the person you picked can land outside it: decorated, and
          // invisible.
          if (state.map.panInside) state.map.panInside(m.getLatLng(), { padding: [30, 30] });
          if (then) then(m);
        }, 320);
        return;
      }
      if (then) then(m);
    }
    state.map.once("moveend", onSettle);
    setTimeout(onSettle, 750);
  }

  function select(p, list) {
    // Picking someone on the Explore map means you want to work on them, so it
    // hands you to Triage on that person rather than making you flip modes.
    // Must happen before renderSide(), or the list does not exist yet and
    // listKeys stays empty, which breaks the arrow keys on arrival.
    // Deliberately does NOT collapse the map. Clicking someone used to switch
    // mode and re-frame the map at once, so a single click moved two things
    // nobody asked it to move.
    state.lastViewed = keyOf(p);
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
      // In Triage the record column already shows everything the popup would,
      // and opening one triggers Leaflet autoPan -> moveend -> repaintSelection,
      // which is a full proximity sweep. Pure cost.
      // A popup only earns its place when the record pane is off screen. With
      // the rail showing it repeats the record and costs a re-render through
      // Leaflet's autoPan.
      if (state.mapExpanded && m && m.openPopup) m.openPopup();
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
    Array.prototype.forEach.call(document.querySelectorAll("#record .set-remove"), function (el) {
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
    Array.prototype.forEach.call(document.querySelectorAll("#record .set-add"), function (el) {
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

    Array.prototype.forEach.call(document.querySelectorAll("#record .chip"), function (el) {
      el.onclick = function () {
        var s = el.dataset.status || "";
        state.nearStatus = (state.nearStatus === s) ? "" : s;
        renderSide(visible());
      };
    });

    Array.prototype.forEach.call(document.querySelectorAll("#record .row.near"), function (el) {
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

  /* Leaving a record. Escape and the Clear button both come through here
   * so the two cannot drift apart. */
  function closeRecord() {
    state.selected = null;
    state.editing = false;
    if (state.map) state.map.closePopup();
    clearMarks("is-picked");
    clearMarks("is-near");
    renderSide(visible());
  }

  /* Move through the ranked queue without going back to it first. Triage is the
   * job this tool exists for, and it was costing two clicks and a lost scroll
   * position per person. Deliberately does not wrap: running off the end of a
   * work list should stop, not silently restart it. */
  function stepQueue(delta) {
    var keys = state.listKeys;
    if (!keys.length) return;
    var cur = state.lastViewed ? keys.indexOf(state.lastViewed) : -1;
    // Someone picked off the map may be active, so they are not in the queue at
    // all. Stepping from there used to teleport to row 1; now it does nothing,
    // because silently jumping somewhere unrelated is worse than not moving.
    if (state.lastViewed && cur === -1) return;
    var next = cur === -1 ? (delta > 0 ? 0 : keys.length - 1) : cur + delta;
    if (next < 0 || next >= keys.length) return;
    var list = visible();
    var hit = byKey(keys[next], list);
    if (hit) select(hit, list);
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

    Array.prototype.forEach.call(document.querySelectorAll("#record .chip"), function (el) {
      el.onclick = function () {
        var s = el.dataset.status || "";
        state.nearStatus = (state.nearStatus === s) ? "" : s;
        renderSide(visible());
      };
    });

    Array.prototype.forEach.call(document.querySelectorAll("#record .row.near"), function (el) {
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
    if (b) b.onclick = closeRecord;
    if (e) e.onclick = function () { state.editing = true; renderSide(visible()); };

    var cancel = $("e-cancel");
    if (cancel) cancel.onclick = function () { state.editing = false; renderSide(visible()); };
  }

  function exportCSV() {
    var list = visible();
    var reach = reachIndex(list, neighbours());
    var cols = ["#"].concat(COLS.map(function (c) { return c[1]; }));
    var lines = [cols.map(q).join(",")];
    list.forEach(function (p, i) {
      var r = reach[keyOf(p)];
      lines.push([i + 1].concat(COLS.map(function (c) {
        return c[2] ? c[2](p, r) : p[c[0]];
      })).map(q).join(","));
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
    // One call on the single render path, rather than one bolted onto each of
    // the eleven handlers that mutate state.
    syncHash();
    // Built once per render and held on state: every proximity question on
    // screen is asked against this, and placedIn() caches on its identity.
    state.pool = population();
    var list = visible();
    renderCounters();
    renderStatusFilters();
    renderLayerFilters();
    // The mode is stamped on the stage, and the CSS does the layout. Written
    // before renderMap() runs, because fitBounds measures the pane and would
    // otherwise measure the track width the previous mode had.
    $("stage").classList.toggle("is-expanded", state.mapExpanded);
    if (state.view === "map") {
      $("map").hidden = false; $("queue").hidden = false; $("record").hidden = false;
      $("tablewrap").hidden = true;
      $("stage").classList.remove("is-table");
      renderMap(list); renderSide(list);
      // Leaflet caches its size, so a track-width change has to be announced.
      // This was cosmetic when the map was the only thing that moved; it is now
      // the only thing correcting the pane after a mode switch.
      if (state.map) setTimeout(function () { state.map.invalidateSize(); }, 30);
    } else {
      $("map").hidden = true; $("queue").hidden = true; $("record").hidden = true;
      $("tablewrap").hidden = false;
      $("stage").classList.add("is-table");
      renderTable(list);
    }
  }

  /* Not built on toggle(): switching mode has side effects that a plain state
   * write plus render() does not cover -- Leaflet has to be told its pane
   * resized, and the spiderfy spread is tuned per pane width. */
  /* Expanding is a view change and nothing else. It repaints, tells Leaflet its
   * pane resized, and stops. It does not move the map, change what is selected,
   * or alter what any other control means. */
  function setMapExpanded(on) {
    if (state.mapExpanded === on) return;
    state.mapExpanded = on;
    syncExpandButton();
    render();
    if (state.map) {
      // Two frames: a grid-template change committed this tick is not
      // guaranteed to have been laid out by the next one on every engine.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { state.map.invalidateSize(); });
      });
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

  /* The State control exists only while Place is the United States, and its
   * counts are computed with the same predicate that filters on them, so the
   * number in an option is the number of rows picking it gives you. People
   * whose state could not be derived are named rather than hidden: silently
   * dropping 109 of 636 would make the filter look like it lost them. */
  function buildStateOptions() {
    var sel = $("f-state"), group = $("g-state");
    if (!sel || !group) return;
    var isUS = state.place === "United States";
    group.hidden = !isUS;
    if (!isUS) return;
    var pool = (state.data ? state.data.people : []).filter(inUS);
    var counts = {}, unknown = 0;
    pool.forEach(function (p) {
      if (p.usState) counts[p.usState] = (counts[p.usState] || 0) + 1;
      else unknown++;
    });
    var names = Object.keys(counts).sort();
    sel.innerHTML = '<option value="">All states (' + pool.length + ")</option>" +
      names.map(function (n) {
        return '<option value="' + esc(n) + '"' + (n === state.usState ? " selected" : "") +
               ">" + esc(n) + " (" + counts[n] + ")</option>";
      }).join("") +
      (unknown ? '<option value="" disabled>' + unknown + " with no state on record</option>" : "");
  }

  function boot(data) {
    state.data = data;
    state.a11n = data.automatticians || [];
    state.meetups = data.meetups || [];
    state.set = loadSet();
    applyEdits(data.people);
    // Derived once here rather than per render: it is string work over 7,032
    // records and the answer never changes.
    data.people.forEach(function (p) { p.usState = stateOf(p.city); });
    // Read the link before anything is drawn, so the first paint is already the
    // shared view. After state.data is set, because it resolves the selected
    // person against visible().
    var fromLink = applyStateFromHash();
    document.title = "Community Reach — " + data.meta.counts.total.toLocaleString() + " people";
    toggle("v-map", "v-table", "view", "map", "table");
    syncExpandButton();
    wireDefTips();

    // Place list, most-populated first, so the useful ones are at the top.
    // Each count is produced by the same predicate that filters on it, so the
    // number in the option is the number of rows you get when you pick it.
    var counts = {};
    data.people.forEach(function (p) { if (p.country) counts[p.country] = (counts[p.country] || 0) + 1; });
    counts["United States"] = data.people.filter(inUS).length;
    var sorted = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    $("f-place").innerHTML = '<option value="">Global (' + data.people.length + ")</option>" +
      sorted.map(function (c) {
        return '<option value="' + esc(c) + '"' +
               (c === state.place ? " selected" : "") + ">" +
               esc(c) + " (" + counts[c] + ")</option>";
      }).join("");
    buildStateOptions();


    // Changing place clears any selection, so the map is free to re-fit to the
    // new place instead of being held in position by the old pin.
    $("f-place").onchange = function (e) {
      state.place = e.target.value;
      // A state filter left set while the place moves to Brazil would silently
      // return nothing, which is the same class of bug the merged Place control
      // was built to remove.
      state.usState = "";
      buildStateOptions();
      state.selected = null; state.selectedMeetup = null;
      state.page = 0;
      render();
    };
    $("f-state").onchange   = function (e) { state.usState = e.target.value; state.page = 0; render(); };
    $("f-rows").onchange    = function (e) { state.rows = parseInt(e.target.value, 10); state.page = 0; render(); };

    $("set-btn").onclick = function () {
      // The set panel renders into the record column, which Explore hides.
      // The set panel renders into the record column, so opening it brings the
      // rail back rather than rendering into something nobody can see.
      if (state.mapExpanded && !state.showSet) setMapExpanded(false);
      state.showSet = !state.showSet;
      if (state.showSet) { state.selected = null; state.selectedMeetup = null; }
      renderSetCount();
      renderSide(visible());
    };
    // Toggles are generated from the registry, so a new layer is a descriptor
    // and not another hand-wired pair of button and handler.
    var seg = $("layer-toggles");
    if (seg) {
      /* People sits in the same strip as the other layers rather than being an
       * implicit always-on background, because "toggle everything on and off"
       * is not true if one of the three cannot be toggled. It is not in
       * OVERLAYS: those descriptors draw clustered marker groups from their own
       * data, and people are drawn by renderMap with avatars, ranking and a
       * record panel. Same switch, different renderer. */
      var LAYERS = [{
        id: "people", label: "People",
        title: "Everyone in #community-events or #community-team on Make WordPress Slack."
      }].concat(OVERLAYS);

      seg.innerHTML = LAYERS.map(function (def) {
        return '<button id="l-' + def.id + '" aria-pressed="' +
               (overlayOn(def.id) ? "true" : "false") + '" title="' +
               esc(def.title) + '">' + esc(def.label) + "</button>";
      }).join("");
      LAYERS.forEach(function (def) {
        var btn = $("l-" + def.id);
        btn.onclick = function () {
          state.overlays[def.id] = !state.overlays[def.id];
          btn.setAttribute("aria-pressed", state.overlays[def.id] ? "true" : "false");
          // Turning a layer off drops its narrowing too, so it does not come
          // back later silently filtered by something you set ages ago.
          if (!state.overlays[def.id]) {
            if (def.id === "people") { state.statuses = {}; state.preset = ""; }
            else state.overlayFilter[def.id] = {};
          }
          render();
        };
      });
    }

    $("pg-prev").onclick    = function () { state.page--; renderTable(visible()); };
    $("pg-next").onclick    = function () { state.page++; renderTable(visible()); };
    $("do-csv").onclick     = exportCSV;

    /* Keyboard triage. Arrow keys walk the queue and Escape leaves a record,
     * so working through the list never needs the pointer. Ignored while focus
     * is in a field, or the search box would eat every keystroke. */
    document.addEventListener("keydown", function (e) {
      var el = e.target;
      if (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // These panels used to destroy the queue, so stepping through it while
      // one was open made no sense. They no longer do.
      if (state.mapExpanded) return;
      if (e.key === "Escape") {
        if (!state.selected) return;
        e.preventDefault(); closeRecord(); return;
      }
      if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); stepQueue(1); }
      else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); stepQueue(-1); }
    });

    var t;
    $("q").oninput = function (e) {
      clearTimeout(t);
      var v = e.target.value;
      t = setTimeout(function () { state.q = v; state.page = 0; render(); }, 160);
    };

    // The mode from the link has to be on the stage before the first paint, or
    // renderMap measures the track width of the mode we are leaving.
    // Stamp the expanded state before the first paint, so renderMap measures
    // the track it is actually going to get.
    $("stage").classList.toggle("is-expanded", state.mapExpanded);
    syncExpandButton();
    syncControls();
    render();
    // A person arriving by link goes through select(), so the link produces
    // what a click produces. Deferred a tick because focusOnMap needs the
    // Leaflet container to have been sized by the render above.
    if (fromLink && state.selected) {
      var linked = state.selected;
      state.selected = null;
      setTimeout(function () { select(linked, visible()); }, 0);
    }
    renderSetCount();
  }

  /* Data loading. Two shapes:
   *  - plain people.json (local dev, Spacefast behind its own access gate)
   *  - people.enc: AES-256-CTR + HMAC-SHA256, PBKDF2(200k). The passphrase is
   *    the actual protection on the public fallback host, not a curtain --
   *    without it the file is noise. */
  /* Writes into #side-state, which lives inside #record. If that element is
   * ever moved or dropped, this throws on null and the passphrase prompt never
   * renders -- silently, and only on the encrypted host, because local dev
   * resolves data/people.json first and never reaches this path. */
  /* Owns its container rather than borrowing #side-state.
   *
   * #side-state is seeded markup inside #record, and renderRecord() replaces
   * the whole of #record the first time it paints. On a wrong-passphrase retry
   * that element is already gone, so a gate that writes into it writes into
   * nothing -- and only on the encrypted host, because local dev resolves
   * data/people.json and never comes through here at all. */
  /* THE GATE OWNS ITS OWN ELEMENT, ON <body>, WHERE NOTHING CAN HIDE IT.
   *
   * It used to render into #record. #record is one half of the queue/record
   * swap, and the CSS hides it until #stage carries .has-record -- which only
   * happens once something is selected. So on a fresh load the passphrase form
   * was written into a pane with display:none: correct markup, correct
   * handlers, zero pixels. Anyone arriving without a passphrase already in
   * sessionStorage saw an empty page with nothing to type into.
   *
   * It survived every automated check because querySelector finds hidden
   * elements and setting .value on one works. The unlock test was driving a
   * form no human could see. Any check on this element must assert
   * getBoundingClientRect().width > 0, not merely that it exists.
   *
   * A gate blocks the whole app; it is not a panel inside one column of it. */
  function gate(msg) {
    var host = $("cm-gate");
    if (!host) {
      host = document.createElement("div");
      host.id = "cm-gate";
      host.className = "gate";
      document.body.appendChild(host);
    }
    host.innerHTML =
      '<div class="gate-card" role="dialog" aria-modal="true" aria-label="Team passphrase">' +
        "<h2>" + esc(msg || "Team passphrase") + "</h2>" +
        "<p>This tool names individual people. It is private to the Community Team, " +
        "and the file on the server stays encrypted until you unlock it.</p>" +
        '<div class="gate-row">' +
          '<input id="pw" class="field" type="password" placeholder="Passphrase" ' +
            'autocomplete="current-password">' +
          '<button class="btn primary" id="pw-go">Open</button>' +
        "</div>" +
      "</div>";
    function go() {
      unlock($("pw").value).catch(function (err) {
        // Only the HMAC check proves the passphrase is wrong. Everything else --
        // the payload missing, the network failing, the JSON being malformed --
        // used to be reported as "wrong passphrase" too, which sent the whole
        // team off retyping a passphrase that was never the problem.
        gate(err && err.cmReason ? err.cmReason : "Wrong passphrase — try again");
      });
    }
    $("pw-go").onclick = go;
    $("pw").onkeydown = function (e) { if (e.key === "Enter") go(); };
    $("pw").focus();
  }

  /* Removed rather than hidden: leaving a fixed, full-viewport overlay in the
   * document after unlock would sit invisibly over the map and swallow clicks. */
  function closeGate() {
    var g = $("cm-gate");
    if (g && g.parentNode) g.parentNode.removeChild(g);
  }

  function unlock(pass) {
    function fail(reason) {
      var e = new Error(reason);
      e.cmReason = reason;
      return e;
    }
    return fetch("data/people.enc").then(function (r) {
      if (!r.ok) {
        throw fail("Could not load the data (HTTP " + r.status + "). This is not " +
                   "the passphrase — the encrypted file is missing or unreachable.");
      }
      // A truncated body fails the HMAC exactly like a wrong passphrase does,
      // and someone retyping their passphrase will never get anywhere. So it is
      // worth catching, but ONLY where the comparison is honest.
      //
      // content-length describes the bytes ON THE WIRE. arrayBuffer() returns
      // the bytes AFTER decoding. Where the server gzips, those two are
      // different numbers and comparing them accuses a perfectly good download.
      // Ciphertext does not compress, so gzip makes it slightly LARGER: GitHub
      // Pages serves 4,385,601 encoded bytes for a 4,384,243-byte file, and
      // this check called that "incomplete" and locked the whole team out.
      var encoded = r.headers.get("content-encoding");
      var declared = parseInt(r.headers.get("content-length") || "0", 10);
      return r.arrayBuffer().then(function (buf) {
        if (!encoded && declared && buf.byteLength !== declared) {
          throw fail("The data file arrived incomplete (" +
                     buf.byteLength.toLocaleString() + " of " +
                     declared.toLocaleString() + " bytes). This is not the " +
                     "passphrase. Reload the page and try again.");
        }
        // Works whatever the transfer encoding: a file this small cannot be the
        // payload, so it is a failed or partial fetch rather than a bad key.
        if (buf.byteLength < 100000) {
          throw fail("The data file is too small to be real (" +
                     buf.byteLength.toLocaleString() + " bytes). This is not " +
                     "the passphrase — the download did not complete.");
        }
        return buf;
      });
    }, function () {
      throw fail("Could not reach the data file. Check the connection — this is " +
                 "not the passphrase.");
    }).then(function (buf) {
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
              if (!ok) {
                // The tag covers the whole payload, so this fires for a wrong
                // passphrase AND for a file that arrived corrupted. Length was
                // already checked above, so a wrong passphrase is much the more
                // likely of the two, but saying only that has sent people off
                // retyping a passphrase that was never the problem.
                throw fail("That passphrase did not open the file. If you are "
                           + "sure it is right, the download may have been "
                           + "corrupted \u2014 reload and try once more.");
              }
              return crypto.subtle.importKey("raw", encRaw, { name: "AES-CTR" }, false, ["decrypt"]);
            })
            .then(function (ek) {
              return crypto.subtle.decrypt({ name: "AES-CTR", counter: iv, length: 64 }, ek, ct);
            });
        })
        .then(function (pt) {
          var data;
          try {
            data = JSON.parse(new TextDecoder().decode(pt));
          } catch (e) {
            // Decryption succeeded, so the passphrase was right and the payload
            // itself is broken -- a bad build. Say that, or the next hour goes
            // into the wrong question.
            throw fail("The passphrase worked, but the data file is corrupt and " +
                       "could not be read. It needs rebuilding — tell Corey.");
          }
          if (!data || !data.people || !data.people.length) {
            throw fail("The passphrase worked, but the data file contains no " +
                       "people. It needs rebuilding — tell Corey.");
          }
          sessionStorage.setItem("cm-pass", pass);
          closeGate();
          // boot() runs inside this promise chain, so anything it throws used
          // to surface as "wrong passphrase" -- the one message guaranteed to
          // be false, since the data had already decrypted. The passphrase is
          // saved above, which is why a reload then appeared to fix it.
          try {
            boot(data);
          } catch (e) {
            throw fail("The passphrase worked and the data loaded, but the page "
                       + "failed to start: " + (e && e.message ? e.message : e)
                       + ". Tell Corey \u2014 this is not the passphrase.");
          }
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
