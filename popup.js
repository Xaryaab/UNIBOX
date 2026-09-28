// UNiBOX - toolbar popup. Shows live per-category counts from the active
// Gmail tab, lets you filter from here, and exposes settings + maintenance.

const CATEGORIES = ["All", "Hackathon", "Academic", "Announcement", "Placement", "Unsure"];
const COLORVAR = {
  All: "--all", Hackathon: "--hackathon", Academic: "--academic",
  Announcement: "--announcement", Placement: "--placement", Unsure: "--unsure",
};

function $(id) { return document.getElementById(id); }

function setStatus(text, ok) {
  const el = $("status");
  el.textContent = text;
  el.style.color = ok === false ? "#d93025" : "#188038";
  if (text) setTimeout(function () { el.textContent = ""; }, 1600);
}

// Find the active tab if it's Gmail; otherwise null.
function getGmailTab() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const tab = tabs && tabs[0];
      if (tab && tab.url && tab.url.indexOf("https://mail.google.com/") === 0) {
        resolve(tab);
      } else {
        resolve(null);
      }
    });
  });
}

function askContent(tabId, msg) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, msg, function (resp) {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp);
    });
  });
}

let gmailTab = null;
let activeFilter = "All";

function renderCats(counts, filter) {
  activeFilter = filter || "All";
  const host = $("cats");
  host.innerHTML = "";
  CATEGORIES.forEach(function (cat) {
    const btn = document.createElement("button");
    btn.className = "cat";
    btn.style.setProperty("--c", "var(" + COLORVAR[cat] + ")");
    btn.setAttribute("aria-pressed", String(cat === activeFilter));

    const dot = document.createElement("span"); dot.className = "dot";
    const label = document.createElement("span"); label.className = "label"; label.textContent = cat;
    const count = document.createElement("span"); count.className = "count";
    count.textContent = counts && counts[cat] != null ? String(counts[cat]) : "0";

    btn.append(dot, label, count);
    btn.addEventListener("click", function () { applyFilter(cat); });
    host.appendChild(btn);
  });
}

function applyFilter(cat) {
  if (!gmailTab) return;
  askContent(gmailTab.id, { type: "UNIBOX_SET_FILTER", category: cat }).then(function (resp) {
    if (resp && resp.ok) {
      activeFilter = resp.filter;
      // reflect the new pressed state without a full reload
      document.querySelectorAll(".cat").forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.querySelector(".label").textContent === activeFilter));
      });
    }
  });
}

function showLLMState() {
  chrome.storage.local.get(["settings"], function (res) {
    const s = res.settings || {};
    const configured = !!(s.apiKey && s.endpoint);
    $("llm-state").textContent = configured
      ? "on (" + (s.model || "model unset") + ")"
      : "not configured";
  });
}

async function init() {
  gmailTab = await getGmailTab();
  if (!gmailTab) {
    $("note").hidden = false;
    renderCats(null, "All"); // zeros, non-functional
    document.querySelectorAll(".cat").forEach(function (b) { b.disabled = true; });
  } else {
    const resp = await askContent(gmailTab.id, { type: "UNIBOX_GET_COUNTS" });
    if (resp) {
      renderCats(resp.counts, resp.filter);
    } else {
      // Content script not ready (e.g. tab still loading).
      $("note").hidden = false;
      $("note").textContent = "Reload the Gmail tab, then reopen this popup.";
      renderCats(null, "All");
    }
  }

  showLLMState();

  $("settings").addEventListener("click", function () {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  });
  $("clear-log").addEventListener("click", function () {
    chrome.storage.local.remove("unsureLog", function () { setStatus("Unsure log cleared."); });
  });
  $("reset-cache").addEventListener("click", function () {
    chrome.storage.local.remove("llmCache", function () {
      setStatus("LLM cache reset. Reload Gmail to re-classify.");
    });
  });

  initHarvester();
}

// --- Training-data harvester controls ---------------------------------------

const HARVEST_KEY = "harvest";
const HARVEST_FLAG = "harvestEnabled";
const SENDER_LABELS_KEY = "senderLabels";
const LABEL_PROGRESS_KEY = "senderLabelProgress";

let progressTimer = null;
function pollLabelProgress() {
  const box = $("label-progress");
  function tick() {
    chrome.storage.local.get([LABEL_PROGRESS_KEY], function (res) {
      const p = res[LABEL_PROGRESS_KEY];
      if (!p) { box.hidden = true; return; }
      box.hidden = false;
      box.textContent = (p.running ? "Labelling " : "Labelled ") + p.done + " / " + p.total + (p.running ? "…" : " (done)");
      if (p.running) {
        progressTimer = setTimeout(tick, 1000);
      } else {
        progressTimer = null;
        refreshHarvestStats();
      }
    });
  }
  if (progressTimer) clearTimeout(progressTimer);
  tick();
}

function download(filename, text, type) {
  const blob = new Blob([text], { type: type || "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

// Group harvested rows by their sender identity (display name, else email).
function buildRollup(harvest) {
  const groups = {};
  Object.keys(harvest).forEach(function (id) {
    const r = harvest[id];
    const key = ((r.senderName || r.senderEmail || "(unknown)") + "").trim().toLowerCase();
    let g = groups[key];
    if (!g) {
      g = groups[key] = { name: r.senderName || "", emails: {}, domains: {}, count: 0, cats: {}, samples: [] };
    }
    g.count += 1;
    if (r.senderEmail) g.emails[r.senderEmail] = 1;
    if (r.domain) g.domains[r.domain] = 1;
    const c = r.ruleCategory || "Unsure";
    g.cats[c] = (g.cats[c] || 0) + 1;
    if (g.samples.length < 3 && r.subject) g.samples.push(r.subject);
  });
  return Object.keys(groups).map(function (k) {
    const g = groups[k];
    const topCat = Object.keys(g.cats).sort(function (a, b) { return g.cats[b] - g.cats[a]; })[0] || "Unsure";
    return {
      key: k, // grouping key; matches senderLabels
      sender: g.name || k,
      emails: Object.keys(g.emails).join("; "),
      domains: Object.keys(g.domains).join("; "),
      count: g.count,
      currentTopCategory: topCat,
      proposedCategory: "", // filled from senderLabels (LLM) below
      samples: g.samples.join(" | "),
    };
  }).sort(function (a, b) { return b.count - a.count; });
}

function rollupToCsv(rollup) {
  const cols = ["sender", "emails", "domains", "count", "currentTopCategory", "proposedCategory", "samples"];
  const lines = [cols.join(",")];
  rollup.forEach(function (row) {
    lines.push(cols.map(function (c) { return csvCell(row[c]); }).join(","));
  });
  return lines.join("\r\n");
}

function refreshHarvestStats() {
  chrome.storage.local.get([HARVEST_KEY], function (res) {
    const harvest = res[HARVEST_KEY] || {};
    const emails = Object.keys(harvest).length;
    const senders = Object.keys(buildRollupIndex(harvest)).length;
    $("harvest-stats").textContent =
      "Harvested: " + emails + " emails, " + senders + " senders";
  });
}

// Lightweight sender-key index just for the count (mirrors buildRollup's key).
function buildRollupIndex(harvest) {
  const keys = {};
  Object.keys(harvest).forEach(function (id) {
    const r = harvest[id];
    const key = ((r.senderName || r.senderEmail || "(unknown)") + "").trim().toLowerCase();
    keys[key] = 1;
  });
  return keys;
}

function initHarvester() {
  chrome.storage.local.get([HARVEST_FLAG], function (res) {
    $("harvest").checked = !!res[HARVEST_FLAG];
  });
  refreshHarvestStats();

  // If a labelling run is in progress (or just finished), reflect it.
  chrome.storage.local.get([LABEL_PROGRESS_KEY], function (res) {
    if (res[LABEL_PROGRESS_KEY]) pollLabelProgress();
  });

  $("harvest").addEventListener("change", function () {
    chrome.storage.local.set({ [HARVEST_FLAG]: $("harvest").checked }, function () {
      setStatus($("harvest").checked ? "Collecting. Scroll your inbox." : "Collection paused.");
    });
  });

  $("dl-rollup").addEventListener("click", function () {
    chrome.storage.local.get([HARVEST_KEY, SENDER_LABELS_KEY], function (res) {
      const harvest = res[HARVEST_KEY] || {};
      if (!Object.keys(harvest).length) return setStatus("Nothing harvested yet.", false);
      const labels = res[SENDER_LABELS_KEY] || {};
      const rollup = buildRollup(harvest);
      rollup.forEach(function (row) { row.proposedCategory = labels[row.key] || ""; });
      download("unibox-sender-rollup.csv", rollupToCsv(rollup), "text/csv");
      setStatus("Rollup downloaded.");
    });
  });

  $("auto-label").addEventListener("click", function () {
    chrome.storage.local.get([HARVEST_KEY], function (res) {
      const harvest = res[HARVEST_KEY] || {};
      if (!Object.keys(harvest).length) return setStatus("Nothing harvested yet.", false);
      const senders = buildRollup(harvest).map(function (r) {
        return { key: r.key, sender: r.sender, emails: r.emails, domains: r.domains, samples: r.samples };
      });
      chrome.runtime.sendMessage({ type: "UNIBOX_LABEL_SENDERS", senders: senders }, function () {
        setStatus("Labelling " + senders.length + " senders…");
        pollLabelProgress();
      });
    });
  });

  $("dl-raw").addEventListener("click", function () {
    chrome.storage.local.get([HARVEST_KEY], function (res) {
      const harvest = res[HARVEST_KEY] || {};
      if (!Object.keys(harvest).length) return setStatus("Nothing harvested yet.", false);
      download("unibox-harvest.json", JSON.stringify(Object.values(harvest), null, 2), "application/json");
      setStatus("Raw data downloaded.");
    });
  });

  $("clear-harvest").addEventListener("click", function () {
    chrome.storage.local.remove(HARVEST_KEY, function () {
      refreshHarvestStats();
      setStatus("Harvest cleared.");
    });
  });
}

document.addEventListener("DOMContentLoaded", init);
