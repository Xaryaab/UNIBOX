// UNiBOX - Gmail DOM selectors, isolated in ONE file on purpose.
//
// Gmail's CSS class names are obfuscated (e.g. "zA", "bog") and Google
// changes them without notice. When the inbox scan breaks or returns
// empty/garbled data, the fix almost always lives HERE, not in content.js.
//
// How to re-derive a broken selector:
//   1. Open https://mail.google.com, press F12 -> Elements.
//   2. Click the inspector (arrow) and click an inbox row / sender / subject.
//   3. Update the matching entry below with the current class or attribute.
//
// Exposed as a global so content.js (loaded after this file, same isolated
// world) can read it without ES-module wiring.

window.UNIBOX_SELECTORS = {
  // Scrollable region we attach the MutationObserver to. Broad + stable:
  // Gmail's main pane. First candidate that exists wins.
  inboxContainer: [
    'div[role="main"]',
  ],

  // A single conversation row in the list view. Gmail renders each as
  // <tr class="zA">.
  row: "tr.zA",

  // Sender element. This <span> shows the display name as its text, and
  // ALSO carries the real address in an `email` attribute and the display
  // name in a `name` attribute -- so the sender email IS readable from the
  // list without opening the message. If a future Gmail build ever drops
  // the `email` attribute, content.js reports senderEmail as null instead
  // of guessing it from other markup.
  sender: "span[email]",
  senderEmailAttr: "email",
  senderNameAttr: "name",

  // Subject text span.
  subject: ".bog",

  // Snippet / preview text. Gmail usually prefixes it with " - ".
  snippet: ".y2",

  // Stable-ish row identifiers, tried in order (on the row itself, then on
  // any descendant carrying the attribute). Gmail exposes no single clean,
  // documented thread id, so if none of these are present content.js falls
  // back to a hash of sender+subject+snippet.
  idAttrs: ["data-legacy-thread-id", "data-legacy-last-message-id", "data-thread-id", "id"],
};
