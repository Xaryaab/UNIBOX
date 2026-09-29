// UNiBOX - toolbar popup. Shows live per-category counts from the active Gmail
// tab and lets you filter from here. The training-data tools are DEV-only.

// Flip to true to expose the training-data harvester (dev workflow for
// rebuilding senderMap.js). Off for normal users.
const DEV = false;

const CATEGORIES = ["All", "Academic", "Announcement", "Placement", "Others"];
const COLORVAR = {
  All: "--all", Academic: "--academic",
  Announcement: "--announcement", Placement: "--placement", Others: "--others",
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
      document.querySelectorAll(".cat").forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.querySelector(".label").textContent === activeFilter));
      });
    }
  });
}

async function init() {
  gmailTab = await getGmailTab();
  if (!gmailTab) {
    $("note").hidden = false;
    renderCats(null, "All");
    document.querySelectorAll(".cat").forEach(function (b) { b.disabled = true; });
  } else {
    const resp = await askContent(gmailTab.id, { type: "UNIBOX_GET_COUNTS" });
    if (resp) {
      renderCats(resp.counts, resp.filter);
    } else {
      $("note").hidden = false;
      $("note").textContent = "Reload the Gmail tab, then reopen this popup.";
      renderCats(null, "All");
    }
  }

  if (DEV) {
    $("train").hidden = false;
    initHarvester();
  }
}

// --- DEV training-data harvester --------------------------------------------

const HARVEST_KEY = "harvest";
const HARVEST_FLAG = "harvestEnabled";

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

// Group harvested rows by sender identity (display name, else email).
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
    const c = r.ruleCategory || "Others";
    g.cats[c] = (g.cats[c] || 0) + 1;
    if (g.samples.length < 3 && r.subject) g.samples.push(r.subject);
  });
  return Object.keys(groups).map(function (k) {
    const g = groups[k];
    const topCat = Object.keys(g.cats).sort(function (a, b) { return g.cats[b] - g.cats[a]; })[0] || "Others";
    return {
      key: k,
      sender: g.name || k,
      emails: Object.keys(g.emails).join("; "),
      domains: Object.keys(g.domains).join("; "),
      count: g.count,
      currentTopCategory: topCat,
      proposedCategory: topCat, // pre-filled with the rules' guess; correct by hand
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

function buildRollupIndex(harvest) {
  const keys = {};
  Object.keys(harvest).forEach(function (id) {
    const r = harvest[id];
    const key = ((r.senderName || r.senderEmail || "(unknown)") + "").trim().toLowerCase();
    keys[key] = 1;
  });
  return keys;
}

function refreshHarvestStats() {
  chrome.storage.local.get([HARVEST_KEY], function (res) {
    const harvest = res[HARVEST_KEY] || {};
    const emails = Object.keys(harvest).length;
    const senders = Object.keys(buildRollupIndex(harvest)).length;
    $("harvest-stats").textContent = "Harvested: " + emails + " emails, " + senders + " senders";
  });
}

function initHarvester() {
  chrome.storage.local.get([HARVEST_FLAG], function (res) {
    $("harvest").checked = !!res[HARVEST_FLAG];
  });
  refreshHarvestStats();

  $("harvest").addEventListener("change", function () {
    chrome.storage.local.set({ [HARVEST_FLAG]: $("harvest").checked }, function () {
      setStatus($("harvest").checked ? "Collecting. Scroll your inbox." : "Collection paused.");
    });
  });

  $("dl-rollup").addEventListener("click", function () {
    chrome.storage.local.get([HARVEST_KEY], function (res) {
      const harvest = res[HARVEST_KEY] || {};
      if (!Object.keys(harvest).length) return setStatus("Nothing harvested yet.", false);
      download("unibox-sender-rollup.csv", rollupToCsv(buildRollup(harvest)), "text/csv");
      setStatus("Rollup downloaded.");
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
