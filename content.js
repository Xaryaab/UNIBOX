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

  function scan() {
    const rows = document.querySelectorAll(S.row);
    const data = Array.from(rows).map(extractRow);
    console.log("UNiBOX scan:", data.length, "rows", data);
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

  function start() {
    const container = findContainer();
    if (!container) {
      // Gmail's SPA shell may not be mounted yet; retry shortly.
      setTimeout(start, 1000);
      return;
    }

    // Watch the inbox for structural changes: scrolling in new rows,
    // switching labels, new mail arriving. We only observe -- never mutate.
    const observer = new MutationObserver(scheduleScan);
    observer.observe(container, { childList: true, subtree: true });

    console.log("UNiBOX loaded - watching inbox for changes");
    scan(); // initial scan of whatever is already rendered
  }

  start();
})();
