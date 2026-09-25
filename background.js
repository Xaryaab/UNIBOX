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

async function classifyWithLLM(row) {
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

  try {
    // First try with structured-output enabled. Some (esp. free) models
    // reject the response_format param, so on a non-OK response we retry once
    // without it -- the prompt still asks for JSON and parseCategory salvages
    // it from plain text.
    let resp = await callApi(s, Object.assign({}, base, {
      response_format: { type: "json_object" },
    }));
    if (!resp.ok) {
      const body1 = await resp.text();
      console.warn("UNiBOX bg: attempt 1 failed", resp.status, body1.slice(0, 300));
      resp = await callApi(s, base);
    }
    if (!resp.ok) {
      const body2 = await resp.text();
      console.warn("UNiBOX bg: attempt 2 failed", resp.status, body2.slice(0, 300));
      // Rate limit / auth / server error: silent Unsure, allow retry later.
      return { category: "Unsure", cache: false };
    }

    const data = await resp.json();
    const category = parseCategory(data);
    console.log("UNiBOX bg: classified", { subject: row.subject, category });
    return { category, cache: true };
  } catch (e) {
    // Network error etc.: silent Unsure, allow retry later.
    console.warn("UNiBOX bg: request threw", String(e));
    return { category: "Unsure", cache: false };
  }
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
