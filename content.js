// UNiBOX - Stages 3-6: read rows, categorize, filter bar + dots, and send
// rules-Unsure rows to the LLM (via the background service worker).
//
// Display-only. This script NEVER opens, clicks, archives, moves, or deletes
// anything in Gmail. It reads rendered rows and adds its OWN visual elements
// (a filter bar and a colored dot per row); the category filter only hides
// non-matching rows via CSS display:none -- Gmail's data is never changed.
//
// Gmail selectors live in selectors.js; rule matching in rules.js; the actual
// LLM API call (and the API key) live ONLY in background.js -- never here.
// content.js sends {senderName, senderEmail, subject, snippet} to background
// and gets back a category; email bodies are never read or sent.

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
  const LLM_CACHE_KEY = "llmCache";

  // Persistent LLM result cache: row id -> resolved category. Guarantees each
  // email is sent to the LLM at most once, across redraws and reloads.
  const llmCache = {};

  // Unsure-log bookkeeping: id -> last llmCategory we wrote, so we only touch
  // storage when a row's LLM decision actually changes.
  const loggedUnsure = new Map();

  // In-flight LLM requests, plus ids we won't retry this session (no key set,
  // network error, rate limit). `skip` is in-memory only, so reloading Gmail
  // retries them -- e.g. right after you add an API key in the options page.
  const pending = new Set();
  const skip = new Set();

  function seedState(done) {
    if (!store) return done();
    store.get([UNSURE_LOG_KEY, LLM_CACHE_KEY], function (res) {
      (res[UNSURE_LOG_KEY] || []).forEach(function (e) {
        if (e.id) loggedUnsure.set(e.id, e.llmCategory != null ? e.llmCategory : null);
      });
      const cache = res[LLM_CACHE_KEY] || {};
      Object.keys(cache).forEach(function (k) { llmCache[k] = cache[k]; });
      done();
    });
  }

  function cacheLLM(id, category) {
    llmCache[id] = category;
    if (!store) return;
    store.get([LLM_CACHE_KEY], function (res) {
      const cache = res[LLM_CACHE_KEY] || {};
      cache[id] = category;
      store.set({ [LLM_CACHE_KEY]: cache });
    });
  }

  function makeUnsureEntry(d, llmCategory) {
    return {
      id: d.id,
      senderName: d.senderName,
      senderEmail: d.senderEmail,
      subject: d.subject,
      snippet: d.snippet,
      reason: d.reason || null, // "possible-hackathon" or null
      ruleCategory: "Unsure", // what rules.js decided (always Unsure here)
      llmCategory: llmCategory != null ? llmCategory : null, // what the LLM said
      timestamp: new Date().toISOString(),
    };
  }

  // Create or update this row's Unsure-log entry (merged by id), so the LLM's
  // decision can be filled in after the fact. Writes only when it changed.
  function recordUnsure(entry) {
    if (!store) return;
    const nextLlm = entry.llmCategory != null ? entry.llmCategory : null;
    if (loggedUnsure.has(entry.id) && loggedUnsure.get(entry.id) === nextLlm) return;
    loggedUnsure.set(entry.id, nextLlm);
    store.get([UNSURE_LOG_KEY], function (res) {
      const log = res[UNSURE_LOG_KEY] || [];
      let found = false;
      for (let i = 0; i < log.length; i++) {
        if (log[i].id === entry.id) { log[i] = entry; found = true; break; }
      }
      if (!found) log.push(entry);
      store.set({ [UNSURE_LOG_KEY]: log }, dumpUnsureLog);
    });
  }

  // Ask the background service worker (which holds the key and makes the API
  // call) to classify one Unsure row. Only sender name/email, subject and
  // snippet are sent -- never the email body. Fires at most once per id.
  function requestLLM(d) {
    const id = d.id;
    if (!store) return;
    if (llmCache[id] || pending.has(id) || skip.has(id)) return;
    if (!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id)) return;
    pending.add(id);
    try {
      chrome.runtime.sendMessage(
        {
          type: "UNIBOX_CLASSIFY",
          row: {
            senderName: d.senderName,
            senderEmail: d.senderEmail,
            subject: d.subject,
            snippet: d.snippet,
          },
        },
        function (resp) {
          pending.delete(id);
          if (chrome.runtime.lastError || !resp) { skip.add(id); return; }
          if (resp.cache) {
            cacheLLM(id, resp.category);
            recordUnsure(makeUnsureEntry(d, resp.category));
            scheduleScan(); // re-apply categories/counts with the new result
          } else {
            // Not configured or a transient failure: fall back to Unsure
            // silently and don't hammer it again this session.
            skip.add(id);
          }
        }
      );
    } catch (e) {
      pending.delete(id);
      skip.add(id);
    }
  }

  // The Gmail page's own console can't read chrome.storage (that API lives
  // only in this content script's isolated world), so we print the stored
  // Unsure log here on load and whenever it changes. Look for "UNiBOX unsureLog".
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

  // ---------------------------------------------------------------------------
  // Filter bar + category dots (Stage 5)
  // ---------------------------------------------------------------------------
  // "All" first (default, shows everything); the rest match rules.js output.
  const CATEGORIES = ["All", "Hackathon", "Academic", "Announcement", "Placement", "Unsure"];
  const BAR_ID = "unibox-bar";

  // Which chip is active. Kept in a variable (and mirrored onto <body> as an
  // attribute the CSS reads) so the filter survives Gmail redraws even if the
  // bar node itself is briefly rebuilt.
  let currentFilter = "All";

  // Latest per-category counts, so the toolbar popup can show live numbers.
  let lastCounts = {
    All: 0, Hackathon: 0, Academic: 0, Announcement: 0, Placement: 0, Unsure: 0,
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
    let bar = document.getElementById(BAR_ID);
    if (bar) return bar;
    const container = findContainer();
    if (!container) return null;
    bar = document.createElement("div");
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

    // Primary sender = first participant; used for display and the Unsure log.
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
      r.reason = c.reason; // "possible-hackathon" or null
      // If rules were Unsure but the LLM has already resolved this row, use
      // that cached decision as the displayed category.
      r.llmCategory = llmCache[r.id] || null;
      r.category =
        c.category === "Unsure" && r.llmCategory ? r.llmCategory : c.category;
      decorateRow(row, r.category); // dot + data-unibox-cat for filtering
      return r;
    });
    console.log("UNiBOX scan:", data.length, "rows", data);

    // Keep the filter bar present and its counts current across redraws.
    ensureBar();
    updateCounts(data);

    // Rows rules.js couldn't place: log them (recording the LLM's decision if
    // we have one) and, if still unresolved, send them to the LLM once.
    data.forEach(function (d) {
      if (d.ruleCategory !== "Unsure") return;
      recordUnsure(makeUnsureEntry(d, d.llmCategory));
      if (!llmCache[d.id]) requestLLM(d);
    });

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
    // Seed the LLM cache and Unsure-log bookkeeping from storage, then do the
    // first scan and print whatever is already in the Unsure log.
    seedState(function () {
      scan();
      dumpUnsureLog();
    });
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

  start();
})();
