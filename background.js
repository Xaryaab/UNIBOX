// UNiBOX - Stage 6: background service worker.
//
// ALL LLM calls happen here -- never in content.js or any page-injected
// script. The API key is read from chrome.storage.local (written by the
// options page) and is NEVER logged, and never leaves this worker except in
// the Authorization header of the request to the endpoint the user configured.
//
// content.js sends { type: "UNIBOX_CLASSIFY", row: {senderName, senderEmail,
// subject, snippet} }. We reply with { category, cache }:
//   category: one of the five allowed labels (Unsure on any failure)
//   cache:    true only for a genuine LLM answer; false for "not configured"
//             or an error, so content.js can retry later instead of caching a
//             fallback.

const ALLOWED = ["Hackathon", "Academic", "Announcement", "Placement", "Unsure"];
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
    "Placement, Unsure. Choose Unsure only if you genuinely cannot tell. " +
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

// Pull a valid category out of an OpenAI-compatible response, or "Unsure".
function parseCategory(data) {
  try {
    const content =
      data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (!content) return "Unsure";
    let obj;
    try {
      obj = JSON.parse(content);
    } catch (e) {
      // Some models wrap JSON in prose despite instructions; grab the object.
      const m = content.match(/\{[\s\S]*\}/);
      obj = m ? JSON.parse(m[0]) : null;
    }
    const cat = obj && obj.category;
    return ALLOWED.indexOf(cat) !== -1 ? cat : "Unsure";
  } catch (e) {
    return "Unsure";
  }
}

const MIN_GAP_MS = 2500; // spacing between calls (~24/min; safe under Groq's free 30 RPM)
const MAX_RETRIES = 3; // retries on transient failures (429, 5xx, network)
const BACKOFF_STEP_MS = 2000; // base backoff; grows per attempt

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// Serialize requests through a single chain so a burst of Unsure rows doesn't
// hit the provider all at once -- free models rate-limit hard. Each row waits
// its turn, and calls are spaced by MIN_GAP_MS.
let queue = Promise.resolve();
let lastCallAt = 0;

function classifyWithLLM(row) {
  const run = queue.then(function () { return doClassify(row); });
  queue = run.catch(function () {}); // one failure must not break the chain
  return run;
}

async function doClassify(row) {
  const s = await getSettings();

  // Not configured yet -> fall back to Unsure, and tell content.js NOT to
  // cache it (so it retries once a key/endpoint is set).
  if (!s.apiKey || !s.endpoint) {
    console.warn("UNiBOX bg: not configured -", {
      hasKey: !!s.apiKey,
      hasEndpoint: !!s.endpoint,
    });
    return { category: "Unsure", cache: false };
  }

  const base = {
    model: s.model || "openai/gpt-4o-mini",
    messages: buildMessages(row),
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
      return { category: "Unsure", cache: false };
    }

    const data = await resp.json();
    const category = parseCategory(data);
    console.log("UNiBOX bg: classified", { subject: row.subject, category });
    return { category, cache: true };
  }

  console.warn("UNiBOX bg: gave up after retries (still rate-limited)");
  return { category: "Unsure", cache: false };
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

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === "UNIBOX_CLASSIFY" && msg.row) {
    console.log("UNiBOX bg: request received for", msg.row.subject);
    classifyWithLLM(msg.row).then(sendResponse);
    return true; // keep the message channel open for the async reply
  }
});
