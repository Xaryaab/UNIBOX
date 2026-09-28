// UNiBOX - Stage 6: background service worker.
//
// ALL LLM calls happen here -- never in content.js or any page-injected
// script. The API key is read from chrome.storage.local (written by the
// options page) and is NEVER logged, and never leaves this worker except in
// the Authorization header of the request to the endpoint the user configured.
//
// content.js sends { type: "UNIBOX_CLASSIFY", row: {senderName, senderEmail,
// subject, snippet} }. We reply with { category, cache }:
//   category: one of the five allowed labels (Others on any failure)
//   cache:    true only for a genuine LLM answer; false for "not configured"
//             or an error, so content.js can retry later instead of caching a
//             fallback.

const ALLOWED = ["Hackathon", "Academic", "Announcement", "Placement", "Others"];
const SETTINGS_KEY = "settings";

function getSettings() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([SETTINGS_KEY], function (res) {
      resolve(res[SETTINGS_KEY] || {});
    });
  });
}

// Build the chat messages. The prompt forces a single JSON object with one
// "category" field and nothing else.
function buildMessages(row) {
  const system =
    "You classify a university student's incoming email into exactly one " +
    "category. Allowed categories: Hackathon, Academic, Announcement, " +
    "Placement, Others. Use Others for anything that fits none of the first " +
    "four (promotions, newsletters, personal DMs, etc.). " +
    'Respond with ONLY a JSON object of the exact form {"category":"<one>"} ' +
    "where <one> is one of the five allowed words. No prose, no explanation.";
  const user =
    "Sender name: " + (row.senderName || "") + "\n" +
    "Sender email: " + (row.senderEmail || "") + "\n" +
    "Subject: " + (row.subject || "") + "\n" +
    "Snippet: " + (row.snippet || "");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// Pull a valid category out of an OpenAI-compatible response, or "Others".
function parseCategory(data) {
  try {
    const content =
      data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (!content) return "Others";
    let obj;
    try {
      obj = JSON.parse(content);
    } catch (e) {
      // Some models wrap JSON in prose despite instructions; grab the object.
      const m = content.match(/\{[\s\S]*\}/);
      obj = m ? JSON.parse(m[0]) : null;
    }
    const cat = obj && obj.category;
    return ALLOWED.indexOf(cat) !== -1 ? cat : "Others";
  } catch (e) {
    return "Others";
  }
}

const MIN_GAP_MS = 2500; // spacing between calls (~24/min; safe under Groq's free 30 RPM)
const MAX_RETRIES = 3; // retries on transient failures (429, 5xx, network)
const BACKOFF_STEP_MS = 2000; // base backoff; grows per attempt

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// Serialize requests through a single chain so a burst of Others rows doesn't
// hit the provider all at once -- free models rate-limit hard. Each row waits
// its turn, and calls are spaced by MIN_GAP_MS.
let queue = Promise.resolve();
let lastCallAt = 0;

function classifyWithLLM(row) {
  return enqueue(buildMessages(row), row.subject);
}

// Label a whole SENDER (not one email) from its display name, addresses, and
// a few example subjects -- used by the training-data auto-labeller.
function buildSenderMessages(sd) {
  const system =
    "You label an email SENDER into exactly one category for a university " +
    "student, judging by the sender and example subject lines. Allowed " +
    "categories: Hackathon, Academic, Announcement, Placement, Others. Use " +
    "Others for senders that fit none of the first four (e.g. generic " +
    'promotions, newsletters, personal DMs). Respond with ONLY {"category":"<one>"} and nothing else.';
  const subjects = (sd.samples || "")
    .split(" | ").filter(Boolean).map(function (x) { return "- " + x; }).join("\n");
  const user =
    "Sender: " + (sd.sender || "") + "\n" +
    "Emails: " + (sd.emails || "") + "\n" +
    "Domains: " + (sd.domains || "") + "\n" +
    "Example subjects:\n" + subjects;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function classifySender(sd) {
  return enqueue(buildSenderMessages(sd), "sender:" + sd.sender);
}

// Serialize every request (email or sender) through the one throttled queue.
function enqueue(messages, label) {
  const run = queue.then(function () { return doClassify(messages, label); });
  queue = run.catch(function () {}); // one failure must not break the chain
  return run;
}

async function doClassify(messages, label) {
  const s = await getSettings();

  // Not configured yet -> fall back to Others, and tell the caller NOT to
  // cache it (so it retries once a key/endpoint is set).
  if (!s.apiKey || !s.endpoint) {
    console.warn("UNiBOX bg: not configured -", {
      hasKey: !!s.apiKey,
      hasEndpoint: !!s.endpoint,
    });
    return { category: "Others", cache: false };
  }

  const base = {
    model: s.model || "openai/gpt-4o-mini",
    messages: messages,
    temperature: 0,
  };
  let useFormat = true; // structured output; dropped if the model rejects it

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const gap = MIN_GAP_MS - (Date.now() - lastCallAt);
    if (gap > 0) await sleep(gap);
    lastCallAt = Date.now();

    let resp;
    try {
      const body = useFormat
        ? Object.assign({}, base, { response_format: { type: "json_object" } })
        : base;
      resp = await callApi(s, body);
    } catch (e) {
      // Network error / "Failed to fetch": transient, back off and retry.
      const delay = BACKOFF_STEP_MS * (attempt + 1);
      console.warn("UNiBOX bg: fetch threw", String(e), "- retry in", delay, "ms");
      await sleep(delay);
      continue;
    }

    // Transient server states: 429 (rate limit) and 5xx (overloaded / down).
    // Back off and retry (respect Retry-After when present).
    if (resp.status === 429 || resp.status >= 500) {
      const ra = parseInt(resp.headers.get("retry-after"), 10);
      const delay = ra > 0 ? ra * 1000 : BACKOFF_STEP_MS * (attempt + 1);
      // Log the reason once (e.g. per-minute vs per-day quota) so we can tell
      // a momentary spike from an exhausted daily free quota.
      if (attempt === 0) {
        const why = await resp.text();
        console.warn("UNiBOX bg: transient", resp.status, why.slice(0, 250));
      }
      console.warn("UNiBOX bg: retry in", delay, "ms");
      await sleep(delay);
      continue;
    }

    // Model rejects the structured-output param: drop it and retry once.
    if (resp.status === 400 && useFormat) {
      console.warn("UNiBOX bg: 400 with response_format; retrying without it");
      useFormat = false;
      continue;
    }

    if (!resp.ok) {
      const body = await resp.text();
      console.warn("UNiBOX bg: failed", resp.status, body.slice(0, 300));
      return { category: "Others", cache: false };
    }

    const data = await resp.json();
    const category = parseCategory(data);
    console.log("UNiBOX bg: classified", { label: label, category });
    return { category, cache: true };
  }

  console.warn("UNiBOX bg: gave up after retries (still rate-limited)");
  return { category: "Others", cache: false };
}

function callApi(s, body) {
  return fetch(s.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + s.apiKey,
    },
    body: JSON.stringify(body),
  });
}

// --- Sender auto-labelling (training-data step) -----------------------------
const SENDER_LABELS_KEY = "senderLabels"; // { senderKey: category }
const LABEL_PROGRESS_KEY = "senderLabelProgress"; // { total, done, running }
let labeling = false;

function getLocal(keys) {
  return new Promise(function (r) { chrome.storage.local.get(keys, function (res) { r(res); }); });
}
function setLocal(obj) {
  return new Promise(function (r) { chrome.storage.local.set(obj, function () { r(); }); });
}

// Label each sender via the LLM, one per queue slot, saving as we go so the
// run is resumable: senders already labelled are skipped. Progress lives in
// storage so the popup can show it even after it's closed and reopened.
async function labelSenders(senders) {
  if (labeling) return;
  labeling = true;
  try {
    const labels = (await getLocal([SENDER_LABELS_KEY]))[SENDER_LABELS_KEY] || {};
    const total = senders.length;
    let done = senders.reduce(function (n, sd) { return n + (labels[sd.key] ? 1 : 0); }, 0);
    await setLocal({ [LABEL_PROGRESS_KEY]: { total: total, done: done, running: true } });

    for (let i = 0; i < senders.length; i++) {
      const sd = senders[i];
      if (labels[sd.key]) continue; // resume: already labelled
      let category = "Others";
      try {
        const res = await classifySender(sd);
        category = res.category;
      } catch (e) {
        category = "Others";
      }
      labels[sd.key] = category;
      done += 1;
      await setLocal({
        [SENDER_LABELS_KEY]: labels,
        [LABEL_PROGRESS_KEY]: { total: total, done: done, running: true },
      });
    }
    await setLocal({ [LABEL_PROGRESS_KEY]: { total: total, done: done, running: false } });
  } finally {
    labeling = false;
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;
  if (msg.type === "UNIBOX_CLASSIFY" && msg.row) {
    console.log("UNiBOX bg: request received for", msg.row.subject);
    classifyWithLLM(msg.row).then(sendResponse);
    return true; // keep the message channel open for the async reply
  }
  if (msg.type === "UNIBOX_LABEL_SENDERS" && Array.isArray(msg.senders)) {
    // Fire-and-forget: the loop reports progress through storage.
    const wasRunning = labeling;
    labelSenders(msg.senders);
    sendResponse({ started: !wasRunning, alreadyRunning: wasRunning });
    return false;
  }
});
