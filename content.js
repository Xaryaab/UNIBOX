// UNiBOX - Stage 3: read the inbox rows.
//
// Display-only. This script NEVER opens, clicks, modifies, archives, or
// deletes anything. It only reads what Gmail has already rendered in the
// inbox list, and console.logs the extracted rows.
//
// All Gmail-specific selectors live in selectors.js (loaded first).

(function () {
  "use strict";

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
  // case it's ever missing so scanning still works without the log.
  const store =
    typeof chrome !== "undefined" && chrome.storage && chrome.storage.local
      ? chrome.storage.local
      : null;
  const UNSURE_LOG_KEY = "unsureLog";

  // Ids already written to the log, so the same Unsure email isn't appended
  // again on every rescan (scroll, tab switch). Seeded from storage on load.
  const loggedIds = new Set();
  function seedLoggedIds(done) {
    if (!store) return done();
    store.get([UNSURE_LOG_KEY], function (res) {
      (res[UNSURE_LOG_KEY] || []).forEach(function (e) {
        if (e.id) loggedIds.add(e.id);
      });
      done();
    });
  }

  function logUnsure(entries) {
    if (!store || entries.length === 0) return;
    const fresh = entries.filter(function (e) { return !loggedIds.has(e.id); });
    if (fresh.length === 0) return;
    fresh.forEach(function (e) { loggedIds.add(e.id); });
    store.get([UNSURE_LOG_KEY], function (res) {
      const log = res[UNSURE_LOG_KEY] || [];
      store.set({ [UNSURE_LOG_KEY]: log.concat(fresh) }, dumpUnsureLog);
    });
  }

  // The Gmail page's own console can't read chrome.storage (that API lives
  // only in this content script's isolated world), so we print the stored
  // Unsure log here on load and whenever it grows. Look for "UNiBOX unsureLog".
  function dumpUnsureLog() {
    if (!store) return;
    store.get([UNSURE_LOG_KEY], function (res) {
      const log = res[UNSURE_LOG_KEY] || [];
      console.log("UNiBOX unsureLog (" + log.length + " entries):", log);
    });
  }

  // How long to wait after DOM activity settles before re-scanning. Gmail
  // fires many tiny mutations while scrolling/redrawing; debouncing keeps
  // us from scanning on every one.
  const DEBOUNCE_MS = 400;

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
    const senderEl = row.querySelector(S.sender);
    const subjectEl = row.querySelector(S.subject);
    const snippetEl = row.querySelector(S.snippet);

    const senderName = senderEl
      ? senderEl.getAttribute(S.senderNameAttr) || text(senderEl)
      : "";

    // May be null if Gmail's markup ever omits the `email` attribute. We do
    // NOT infer the address from other markup -- better an honest null.
    const senderEmail = senderEl
      ? senderEl.getAttribute(S.senderEmailAttr) || null
      : null;

    const subject = text(subjectEl);

    // Gmail prefixes the snippet with a hyphen ("- ..."); strip it.
    const snippet = text(snippetEl).replace(/^\s*-\s*/, "");

    const id = findRowId(row, senderEmail + "|" + subject + "|" + snippet);

    return { id, senderName, senderEmail, subject, snippet };
  }

  // Gmail keeps previously-visited label lists in the DOM but hidden
  // (display:none) rather than removing them, so a document-wide query
  // accumulates stale rows from every view you've opened. A hidden element
  // has no offsetParent, so this keeps only the rows actually on screen.
  function isVisible(el) {
    return el.offsetParent !== null;
  }

  function scan() {
    const root = observed || findContainer() || document;
    const rows = Array.from(root.querySelectorAll(S.row)).filter(isVisible);
    const data = rows.map(function (row) {
      const r = extractRow(row);
      const c = classify(r);
      r.category = c.category;
      r.reason = c.reason; // "possible-hackathon" or null
      return r;
    });
    console.log("UNiBOX scan:", data.length, "rows", data);

    // Log Unsure rows for later review / rules.txt improvement.
    const unsure = data
      .filter(function (d) { return d.category === "Unsure"; })
      .map(function (d) {
        return {
          id: d.id,
          senderName: d.senderName,
          senderEmail: d.senderEmail,
          subject: d.subject,
          snippet: d.snippet,
          reason: d.reason,
          timestamp: new Date().toISOString(),
        };
      });
    logUnsure(unsure);

    return data;
  }

  // --- Debounced re-scan driven by a MutationObserver ---
  let timer = null;
  function scheduleScan() {
    clearTimeout(timer);
    timer = setTimeout(scan, DEBOUNCE_MS);
  }

  function findContainer() {
    for (const sel of S.inboxContainer) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // Attach the observer to the current container. Gmail can swap in a new
  // main-pane node when you switch labels (Inbox -> Sent), which detaches
  // the old node and silently kills an observer bound to it. So re-resolve
  // the container and re-bind whenever it has changed.
  let observer = null;
  let observed = null;
  function ensureObserving() {
    const container = findContainer();
    if (container && container !== observed) {
      if (observer) observer.disconnect();
      observer = new MutationObserver(scheduleScan);
      // We only observe -- never mutate.
      observer.observe(container, { childList: true, subtree: true });
      observed = container;
    }
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
    // Seed the dedup set from any existing log, then do the first scan and
    // print whatever is already in the Unsure log.
    seedLoggedIds(function () {
      scan();
      dumpUnsureLog();
    });
  }

  start();
})();
