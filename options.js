// UNiBOX - options page logic. Reads/writes settings in chrome.storage.local.
// The API key is stored as-is and NEVER logged.

const SETTINGS_KEY = "settings";
function $(id) { return document.getElementById(id); }

function load() {
  chrome.storage.local.get([SETTINGS_KEY], function (res) {
    const s = res[SETTINGS_KEY] || {};
    $("provider").value = s.provider || "openai-compatible";
    $("endpoint").value = s.endpoint || "";
    $("model").value = s.model || "";
    $("apiKey").value = s.apiKey || "";
  });
}

function save() {
  const settings = {
    provider: $("provider").value,
    endpoint: $("endpoint").value.trim(),
    model: $("model").value.trim(),
    apiKey: $("apiKey").value, // stored verbatim; never logged
  };
  chrome.storage.local.set({ [SETTINGS_KEY]: settings }, function () {
    const status = $("status");
    status.textContent = "Saved.";
    setTimeout(function () { status.textContent = ""; }, 1500);
  });
}

document.addEventListener("DOMContentLoaded", function () {
  load();
  $("save").addEventListener("click", save);
});
