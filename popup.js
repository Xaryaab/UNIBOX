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
}

document.addEventListener("DOMContentLoaded", init);
