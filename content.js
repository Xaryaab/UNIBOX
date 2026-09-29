// UNiBOX - content script: read inbox rows, categorize them locally, and lay
// a filter bar + colored dots on top of Gmail.
//
// Display-only. This script NEVER opens, clicks, archives, moves, or deletes
// anything in Gmail. It reads rendered rows and adds its OWN visual elements
// (a filter bar and a colored dot per row); the category filter only hides
// non-matching rows via CSS display:none -- Gmail's data is never changed.
//
// Gmail selectors live in selectors.js; rule matching in rules.js. Everything
// runs locally in the browser -- no network calls, no email bodies read.

(function () {
  "use strict";

  // Flip to true to see per-scan logs and the review-log dump in the console.
  const DEBUG = false;

  const S = window.UNIBOX_SELECTORS;
  if (!S) {
    console.error("UNiBOX: selectors.js did not load before content.js");
    return;
  }

  const classify = window.UNIBOX_CLASSIFY;
  if (!classify) {
    console.error("UNiBOX: rules.js did not load before content.js");
    return;
  }

  // chrome.storage needs the "storage" permission in manifest.json. Guard in
  // case it's ever missing so scanning still works without it.
  const store =
    typeof chrome !== "undefined" && chrome.storage && chrome.storage.local
      ? chrome.storage.local
      : null;

  // After the extension is reloaded/updated, this already-injected content
  // script keeps running in the open Gmail tab but its chrome.* APIs are dead
  // ("Extension context invalidated"). Guard every storage call so the
  // orphaned instance stops quietly instead of throwing until the tab reloads.
  function contextAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }
  function onContextDead() {
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
  }
  function safeGet(keys, cb) {
    if (!store) return;
    if (!contextAlive()) return onContextDead();
    try { store.get(keys, cb); } catch (e) { onContextDead(); }
  }
  function safeSet(obj, cb) {
    if (!store) return;
    if (!contextAlive()) return onContextDead();
    try { store.set(obj, cb); } catch (e) { onContextDead(); }
  }

  // Training-data harvester (DEV tool, dormant by default). When enabled via
  // the HARVEST_FLAG storage key (exposed only in the popup's DEV harvester
  // UI), every scanned row is logged to chrome.storage.local under HARVEST_KEY,
  // keyed by row id, so scrolling the inbox builds a dataset used to (re)build
  // senderMap.js with tools/generate-rules.js. Off for normal users.
  const HARVEST_KEY = "harvest";
  const HARVEST_FLAG = "harvestEnabled";
  let harvestOn = false;
  const harvestedIds = new Set();

  function domainOf(email) {
    const e = (email || "").toLowerCase();
    const at = e.indexOf("@");
    return at === -1 ? "" : e.slice(at + 1);
  }

  function seedState(done) {
    if (!store || !contextAlive()) return done();
    safeGet([HARVEST_KEY, HARVEST_FLAG], function (res) {
      const h = res[HARVEST_KEY] || {};
      Object.keys(h).forEach(function (k) { harvestedIds.add(k); });
      harvestOn = !!res[HARVEST_FLAG];
      done();
    });
  }

  function harvestRows(data) {
    if (!harvestOn || !store) return;
    const fresh = data.filter(function (d) { return !harvestedIds.has(d.id); });
    if (fresh.length === 0) return;
    fresh.forEach(function (d) { harvestedIds.add(d.id); });
    safeGet([HARVEST_KEY], function (res) {
      const h = res[HARVEST_KEY] || {};
      fresh.forEach(function (d) {
        h[d.id] = {
          id: d.id,
          senderName: d.senderName || "",
          senderEmail: d.senderEmail || "",
          domain: domainOf(d.senderEmail),
          subject: d.subject || "",
          snippet: d.snippet || "",
          ruleCategory: d.ruleCategory,
          ts: new Date().toISOString(),
        };
      });
      safeSet({ [HARVEST_KEY]: h });
    });
  }

  // How long to wait after DOM activity settles before re-scanning. Gmail
  // fires many tiny mutations while scrolling/redrawing; debouncing keeps
  // us from scanning on every one.
  const DEBOUNCE_MS = 400;

  // ---------------------------------------------------------------------------
  // Filter bar + category dots (Stage 5)
  // ---------------------------------------------------------------------------
  // "All" first (default, shows everything); the rest match rules.js output.
  const CATEGORIES = ["All", "Academic", "Announcement", "Placement", "Others"];
  const BAR_ID = "unibox-bar";

  // Which chip is active. Kept in a variable (and mirrored onto <body> as an
  // attribute the CSS reads) so the filter survives Gmail redraws even if the
  // bar node itself is briefly rebuilt.
  let currentFilter = "All";

  // Latest per-category counts, so the toolbar popup can show live numbers.
  let lastCounts = {
    All: 0, Academic: 0, Announcement: 0, Placement: 0, Others: 0,
  };

  function setFilter(cat) {
    currentFilter = cat;
    // CSS in styles.css keys off this body attribute. "All" = no attribute.
    if (cat === "All") {
      document.body.removeAttribute("data-unibox-filter");
    } else {
      document.body.setAttribute("data-unibox-filter", cat);
    }
    const bar = document.getElementById(BAR_ID);
    if (bar) {
      bar.querySelectorAll(".unibox-chip").forEach(function (chip) {
        chip.setAttribute("aria-pressed", String(chip.getAttribute("data-cat") === cat));
      });
    }
  }

  function buildChip(cat) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "unibox-chip";
    chip.setAttribute("data-cat", cat);
    chip.setAttribute("aria-pressed", String(cat === currentFilter));

    const dot = document.createElement("span");
    dot.className = "unibox-chip-dot";

    const label = document.createElement("span");
    label.className = "unibox-chip-label";
    label.textContent = cat;

    const count = document.createElement("span");
    count.className = "unibox-chip-count";
    count.textContent = "0";

    chip.append(dot, label, count);
    chip.addEventListener("click", function () { setFilter(cat); });
    return chip;
  }

  // Inject the bar once, at the top of the inbox pane. If it already exists
  // (e.g. from a previous render), reuse it -- never duplicate.
  function ensureBar() {
    const container = findContainer();
    if (!container) return null;

    // Reuse the bar only if it already sits in the CURRENT container -- then
    // its chip click handlers are live for this view. If Gmail swapped the
    // container (pagination, label switch), the old bar is stale and its chips
    // do nothing, so remove any bars and build a fresh one here. currentFilter
    // and the <body> filter attribute persist, so the filter state is kept.
    const existing = document.getElementById(BAR_ID);
    if (existing && existing.parentElement === container) return existing;
    document.querySelectorAll('[id="' + BAR_ID + '"]').forEach(function (b) { b.remove(); });

    const bar = document.createElement("div");
    bar.id = BAR_ID;
    const brand = document.createElement("span");
    brand.className = "unibox-brand";
    brand.textContent = "UNiBOX";
    bar.appendChild(brand);
    CATEGORIES.forEach(function (cat) { bar.appendChild(buildChip(cat)); });
    container.insertBefore(bar, container.firstChild);
    return bar;
  }

  function updateCounts(data) {
    const counts = { All: data.length };
    CATEGORIES.forEach(function (c) { if (c !== "All") counts[c] = 0; });
    data.forEach(function (d) {
      if (counts[d.category] !== undefined) counts[d.category] += 1;
    });
    lastCounts = counts; // expose to the popup
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    bar.querySelectorAll(".unibox-chip").forEach(function (chip) {
      const cat = chip.getAttribute("data-cat");
      const el = chip.querySelector(".unibox-chip-count");
      const next = String(counts[cat] || 0);
      // Only write when changed -- otherwise our own text edit would trip the
      // MutationObserver and cause an endless rescan loop.
      if (el && el.textContent !== next) el.textContent = next;
    });
  }

  // Tag a row for CSS filtering and give it a colored dot. Idempotent: the
  // dot is created only once, so repeated scans don't duplicate it or thrash
  // the observer.
  function decorateRow(row, category) {
    row.classList.add("unibox-row");
    if (row.getAttribute("data-unibox-cat") !== category) {
      row.setAttribute("data-unibox-cat", category);
    }
    let dot = row.querySelector(".unibox-dot");
    if (!dot) {
      dot = document.createElement("span");
      dot.className = "unibox-dot";
      const senderEl = row.querySelector(S.sender);
      if (senderEl && senderEl.parentNode) {
        senderEl.parentNode.insertBefore(dot, senderEl);
      } else {
        const cell = row.querySelector("td");
        if (cell) cell.insertBefore(dot, cell.firstChild);
      }
    }
    if (dot && dot.getAttribute("data-cat") !== category) {
      dot.setAttribute("data-cat", category);
      dot.title = "UNiBOX: " + category;
    }
  }

  function text(el) {
    return el ? el.textContent.trim() : "";
  }

  // djb2 hash -> short key. Only used as a fallback id when the row exposes
  // no usable DOM identifier (see findRowId).
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return "h" + (h >>> 0).toString(36);
  }

  // A stable-ish identifier so the same email isn't treated as new every
  // time Gmail redraws the DOM.
  function findRowId(row, fallbackSeed) {
    for (const attr of S.idAttrs) {
      const own = row.getAttribute(attr);
      if (own) return own;
      const child = row.querySelector("[" + attr + "]");
      const childVal = child && child.getAttribute(attr);
      if (childVal) return childVal;
    }
    return hash(fallbackSeed);
  }

  function extractRow(row) {
    const senderEls = row.querySelectorAll(S.sender);
    const subjectEl = row.querySelector(S.subject);
    const snippetEl = row.querySelector(S.snippet);

    // A conversation row can list several participants (e.g. a reply thread),
    // each as its own span[email]. Collect them all, so classification can
    // recognize a trusted sender even when they aren't the first name shown.
    // sender email may be null if Gmail ever omits the `email` attribute; we
    // do NOT infer it from other markup -- better an honest null.
    const participants = Array.from(senderEls).map(function (el) {
      return {
        name: el.getAttribute(S.senderNameAttr) || text(el),
        email: el.getAttribute(S.senderEmailAttr) || null,
      };
    });

    // Primary sender = first participant; used for display.
    const primary = participants[0] || { name: "", email: null };
    const senderName = primary.name;
    const senderEmail = primary.email;

    const subject = text(subjectEl);

    // Gmail prefixes the snippet with a hyphen ("- ..."); strip it.
    const snippet = text(snippetEl).replace(/^\s*-\s*/, "");

    const id = findRowId(row, senderEmail + "|" + subject + "|" + snippet);

    return { id, senderName, senderEmail, subject, snippet, participants };
  }

  // Is this row part of the currently active list view?
  //
  // Gmail keeps previously-visited label lists in the DOM but hidden, by
  // setting display:none on an ANCESTOR container -- those we want to skip.
  // But our OWN category filter hides individual rows by setting display:none
  // on the row itself. We must still count and decorate those, otherwise a
  // rescan while a filter is active (e.g. after opening a mail and coming
  // back) would recount every other category as 0.
  //
  // So: walk the ancestors and treat the row as inactive only if an ancestor
  // is hidden. The row's own display (which our filter may set) is ignored.
  function inActiveView(row) {
    let el = row.parentElement;
    while (el && el !== document.body) {
      if (getComputedStyle(el).display === "none") return false;
      el = el.parentElement;
    }
    return true;
  }

  function scan() {
    const root = findContainer() || document;
    const rows = Array.from(root.querySelectorAll(S.row)).filter(inActiveView);
    const data = rows.map(function (row) {
      const r = extractRow(row);
      const c = classify(r);
      r.ruleCategory = c.category; // what rules.js decided
      r.category = c.category;
      decorateRow(row, r.category); // dot + data-unibox-cat for filtering
      return r;
    });
    if (DEBUG) console.log("UNiBOX scan:", data.length, "rows", data);

    // Keep the filter bar present and its counts current across redraws.
    ensureBar();
    updateCounts(data);

    // Collect training data when the DEV harvester is enabled (dormant otherwise).
    harvestRows(data);

    return data;
  }

  // --- Debounced re-scan driven by a MutationObserver ---
  let timer = null;
  function scheduleScan() {
    clearTimeout(timer);
    timer = setTimeout(scan, DEBOUNCE_MS);
  }

  function findContainer() {
    // Prefer a container that is actually on screen. Gmail can keep a hidden
    // cached main-pane around, and we must not attach the bar to that.
    for (const sel of S.inboxContainer) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (el.getClientRects().length > 0) return el;
      }
    }
    // Fallback: first match even if not currently visible.
    for (const sel of S.inboxContainer) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // Observe the whole document body -- NOT just the current inbox container.
  // Gmail replaces the main-pane / list node on pagination (51-100) and label
  // switches, which detaches and silently kills an observer bound to it, and
  // pagination doesn't always fire a hashchange. Body is stable; the debounced
  // scan re-targets the live container each time. We only observe, never
  // mutate. Idempotent decoration keeps this from looping.
  let observer = null;
  function ensureObserving() {
    if (observer) return;
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function start() {
    if (!findContainer()) {
      // Gmail's SPA shell may not be mounted yet; retry shortly.
      setTimeout(start, 1000);
      return;
    }

    ensureObserving();

    // Label/view switches in Gmail change the URL hash (#inbox, #sent,
    // #label/...). The mutation observer alone can miss these if the
    // container node was replaced, so also re-check on every hash change.
    window.addEventListener("hashchange", function () {
      ensureObserving();
      scheduleScan();
    });

    console.log("UNiBOX loaded - watching inbox for changes");
    // Seed harvester state from storage, then do the first scan.
    seedState(scan);
  }

  // Let the toolbar popup read live counts and drive the filter. The popup
  // reaches this content script via chrome.tabs.sendMessage.
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg) return;
      if (msg.type === "UNIBOX_GET_COUNTS") {
        sendResponse({ counts: lastCounts, filter: currentFilter });
      } else if (msg.type === "UNIBOX_SET_FILTER" && msg.category) {
        setFilter(msg.category);
        sendResponse({ ok: true, filter: currentFilter });
      }
    });
  }

  // React to the popup toggling the harvester on/off without a page reload.
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "local" && changes[HARVEST_FLAG]) {
        harvestOn = !!changes[HARVEST_FLAG].newValue;
        if (harvestOn) scheduleScan(); // capture what's on screen right away
      }
    });
  }

  start();
})();
