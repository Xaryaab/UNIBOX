// UNiBOX - Stage 4: classification rules (implements rules.txt).
//
// Priority order, top to bottom, first match wins:
//   1. Hackathon  2. Academic  3. Announcement  4. Placement  5. Unsure
//
// classify(row) takes { senderName, senderEmail, subject, snippet } and
// returns an object:
//   { category, reason }
//     category: "Hackathon" | "Academic" | "Announcement" | "Placement" | "Unsure"
//     reason:   null in every case EXCEPT the Hackathon LLM-fallback
//               placeholder, where it is "possible-hackathon".
// (rules.txt speaks of returning a single category; we return an object so
//  the placeholder reason can travel to the Unsure log. Callers that only
//  want the label read `.category`.)
//
// All matching is case-insensitive.

(function () {
  "use strict";

  function norm(s) {
    return (s || "").toString().toLowerCase().trim();
  }

  // case-insensitive "contains any of these substrings"
  function containsAny(haystack, terms) {
    var h = norm(haystack);
    return terms.some(function (t) { return h.indexOf(norm(t)) !== -1; });
  }

  // case-insensitive exact match (trimmed) -- for rules that say "subject ="
  function equals(a, b) {
    return norm(a) === norm(b);
  }

  function domainOf(email) {
    var e = norm(email);
    var at = e.indexOf("@");
    return at === -1 ? "" : e.slice(at + 1);
  }

  // --- rule 0: trusted senders (highest priority) --------------------------
  // Routed by SENDER identity alone; overrides every subject-based rule below
  // (an announcement that mentions "Competition" still lands in Announcement).
  //
  // These senders mail through batch mailing lists, so the address visible in
  // the inbox list is the list itself (Batch25@ / BSCS25@isb.nu.edu.pk) and
  // the real address (placement.isb@, studentaffairs.isb@, amir.rehman@) sits
  // in reply-to, which is only visible after opening the message -- and UNiBOX
  // never opens anything. So we match on the display NAME shown in the list,
  // with the direct addresses kept as a fallback for when they send directly.
  var SENDER_EMAIL_ROUTES = {
    "placement.isb@nu.edu.pk": "Placement",
    "amir.rehman@nu.edu.pk": "Announcement",
    "studentaffairs.isb@nu.edu.pk": "Announcement",
  };
  // Display-name substrings (matched case-insensitively). Keep these specific
  // to the actual senders so batch-list mail from others isn't swept in.
  var SENDER_NAME_ROUTES = [
    { match: "placement @ one stop", category: "Placement" },
    { match: "one stop islamabad", category: "Placement" },
    { match: "student affairs", category: "Announcement" },
    { match: "amir rehman", category: "Announcement" },
  ];

  function routeBySender(email, name) {
    var byEmail = SENDER_EMAIL_ROUTES[norm(email)];
    if (byEmail) return byEmail;
    var lname = norm(name);
    for (var i = 0; i < SENDER_NAME_ROUTES.length; i++) {
      if (lname.indexOf(SENDER_NAME_ROUTES[i].match) !== -1) {
        return SENDER_NAME_ROUTES[i].category;
      }
    }
    return null;
  }

  // --- rule 1: Hackathon ---------------------------------------------------
  // Hard keywords: a clear match here IS a Hackathon.
  var HACK_SUBJECT_KEYWORDS = ["Competition", "Hackathon", "Hack Summer", "Build with AI"];

  // Soft signals for rules.txt's "loosely suggests a competition/build event
  // but no clear keyword" branch. In the finished design an LLM makes that
  // call (Stage 6). Until then this conservative keyword list stands in:
  // a row hitting a soft signal is flagged Unsure + "possible-hackathon" so
  // it surfaces in the review log. See where this is applied below for the
  // one ordering decision worth knowing about.
  //
  // PLACEHOLDER for Stage 6 -- to be replaced by the LLM Hackathon/Not call.
  var HACK_SOFT_SIGNALS = [
    "hack", "challenge", "contest", "ideathon", "datathon", "devpost",
    "hackfest", "code sprint", "coding sprint", "innovation", "prize",
    "win prizes", "submission deadline", "register your team", "tech fest"
  ];

  // --- rule 3: Announcement ------------------------------------------------
  var ANNOUNCEMENT_SENDERS = ["studentaffairs.isb@nu.edu.pk", "amir.rehman@nu.edu.pk"];
  var ANNOUNCEMENT_SUBJECTS = ["Announcement", "Important Announcement"];

  // --- rule 4: Placement ---------------------------------------------------
  var PLACEMENT_SENDER = "placement.isb@nu.edu.pk";
  var PLACEMENT_EXACT_SUBJECTS = ["A Weekend worth spending", "Level up your tech skills"];
  var PLACEMENT_SUBJECT_KEYWORDS = ["Job", "Internship", "Opportunities", "Vacancy Announcement"];
  var PLACEMENT_SENDER_SUBJECT_KEYWORDS = ["Manager", "Paid"];

  function looselyHackathon(name, email, subject) {
    return containsAny(subject, HACK_SOFT_SIGNALS) ||
           containsAny(name, HACK_SOFT_SIGNALS) ||
           containsAny(email, HACK_SOFT_SIGNALS);
  }

  function classify(row) {
    var name = row.senderName || "";
    var email = row.senderEmail || "";
    var subject = row.subject || "";

    // 0. Trusted senders win over everything else.
    var routed = routeBySender(email, name);
    if (routed) {
      return { category: routed, reason: null };
    }

    // 1. Hackathon / Competition -- hard keyword match wins outright.
    if (containsAny(subject, HACK_SUBJECT_KEYWORDS)) {
      return { category: "Hackathon", reason: null };
    }

    // 2. Academics
    if (domainOf(email) === "classroom.google.com" ||
        containsAny(name, ["(Classroom)"])) {
      return { category: "Academic", reason: null };
    }

    // 3. Announcement
    if (ANNOUNCEMENT_SENDERS.some(function (s) { return equals(email, s); }) ||
        containsAny(subject, ANNOUNCEMENT_SUBJECTS)) {
      return { category: "Announcement", reason: null };
    }

    // 4. Placement Offer
    if (equals(email, PLACEMENT_SENDER) ||
        PLACEMENT_EXACT_SUBJECTS.some(function (s) { return equals(subject, s); })) {
      return { category: "Placement", reason: null };
    }
    if (containsAny(subject, PLACEMENT_SUBJECT_KEYWORDS)) {
      return { category: "Placement", reason: null };
    }
    if (containsAny(subject, PLACEMENT_SENDER_SUBJECT_KEYWORDS) &&
        equals(email, PLACEMENT_SENDER)) {
      return { category: "Placement", reason: null };
    }

    // 5. Everything else -> Unsure.
    //
    // ORDERING NOTE: rules.txt nests the "loosely suggests a hackathon" LLM
    // branch inside rule 1, i.e. at top priority. Applied literally there, a
    // broad placeholder keyword list ("challenge", "innovation", "prize", ...)
    // would hijack rows that the concrete rules below (Placement etc.) claim
    // cleanly, mislabeling them as possible-hackathon. Since the real LLM step
    // is meant to catch genuinely AMBIGUOUS mail -- the kind no hard rule owns
    // -- the soft check is applied here, only to rows that would otherwise be
    // plain Unsure. This is the closest faithful stand-in for the LLM until
    // Stage 6; tell me if you'd rather it run at strict rule-1 priority.
    if (looselyHackathon(name, email, subject)) {
      return { category: "Unsure", reason: "possible-hackathon" };
    }
    return { category: "Unsure", reason: null };
  }

  window.UNIBOX_CLASSIFY = classify;
})();
