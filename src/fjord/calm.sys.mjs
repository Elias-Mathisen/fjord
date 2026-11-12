// Calm web, inside a page (started for each page by page-frame.js): takes out the nudges that pressure you.
//  - fake urgency: "Only 2 left", "14 people are looking at this", "In 30 other carts", "Booked 12 times today"
//  - countdown timers next to offers ("Sale ends in 02:14:59")
//  - confirm-shaming: "No thanks, I don't like saving money" becomes "No thanks"
// Matches only short pieces of text with a number in them (or a ticking clock next to an offer), so headlines and
// articles stay as they are. Ad blocking, newsletter and chat pop-ups are uBlock's (features/calm.js picks the lists).
// shortcut: English wording only; add other languages' patterns when Fjord is translated.
const URGENCY = [
  /\b(only|just) \d+ (items? |rooms? |seats? |tickets? )?(left|remaining)\b/i,
  /\b\d+ (left|remaining) in stock\b/i,
  /\b\d+ (other )?(people|persons|others|shoppers|travell?ers|users|customers) (are |is )?(viewing|looking|watching|interested)/i,
  /\b\d+ (other )?(people|persons|others|shoppers) (have|has) (this|it) in (their|a) (cart|basket|bag)/i,
  /\bin \d+ (other )?(people's |shoppers' )?(carts|baskets|bags)\b/i,
  /\b(booked|bought|sold|purchased|reserved) \d+ times (today|in the last|this)/i,
  /\b\d+ (people )?(booked|bought|purchased) (this|it) (today|in the last)/i,
];
const TIMER = /\b\d{1,2}\s*[:h]\s*\d{2}\s*[:m]\s*\d{2}\s*s?\b|\b\d+\s*(days?|d)\s*,?\s*\d+\s*(hours?|hrs?|h)\b/i;
const OFFER = /\b(ends?|ending|left|expires?|hurry|offer|deal|sale|discount|only|limited|price|today)\b/i;
const SHAMING = [
  /^no,?\s*(thanks|thank you)?[,.!]?\s+(i|i'm|i’m|i'd|i’d|i'll|i’ll)\b/i, // "No thanks, I prefer paying full price"
  /^i\s+(don't|don’t|do not)\s+(want|like|need|care)\b/i, // "I don't want free shipping"
  /^no,?\s+i\s+(would|'d|’d)\s+rather\b/i,
  /^(nah|nope)[,.!]?\s+\S+/i,
];
const SHORT = 100; // longer text is an article or a description, not a badge
const SKIP = "script, style, textarea, input, select, [contenteditable], pre, code, article p, h1, h2, h3";

export function calm(win, report) {
  const doc = win.document;
  if (!doc.body) return;
  const done = new WeakSet();
  let count = 0, reported = 0, timer = null;
  const changed = () => {
    win.clearTimeout(timer);
    timer = win.setTimeout(() => { if (count !== reported) report(reported = count); }, 500);
  };
  const hide = el => {
    if (done.has(el)) return;
    done.add(el);
    el.style.setProperty("display", "none", "important");
    count++;
    changed();
  };
  const textOf = el => (el.textContent ?? "").replace(/\s+/g, " ").trim();

  // The badge a piece of text is in: its element, and wrappers around it with nothing else to say
  function badge(el) {
    while (el.parentElement && el.parentElement !== doc.body && textOf(el.parentElement).length <= textOf(el).length + 4) el = el.parentElement;
    return el;
  }

  function scan(root) {
    if (!root || done.has(root)) return;
    const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let node = walker.currentNode.nodeType === 3 ? walker.currentNode : walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || seen.has(el) || done.has(el) || !/\d|no|i /i.test(node.data)) continue;
      seen.add(el);
      if (el.closest(SKIP)) continue;
      const text = textOf(el);
      if (!text || text.length > SHORT) continue;
      if (URGENCY.some(re => re.test(text))) hide(badge(el));
      else if (SHAMING.some(re => re.test(text))) {
        const button = el.closest("a, button, [role=button], label");
        if (button && textOf(button) === text && el.childNodes.length === 1) {
          done.add(el);
          node.data = "No thanks";
          count++;
          changed();
        }
      }
    }
  }

  // Countdowns: text that ticks every second, with an offer next to it
  const ticks = new WeakMap(); // element -> [times it changed]
  function tick(el) {
    if (!el || done.has(el) || !TIMER.test(textOf(el))) return;
    const now = Date.now(), t = (ticks.get(el) ?? []).filter(x => now - x < 5000);
    t.push(now);
    ticks.set(el, t);
    if (t.length < 3 || el.closest("video, audio, [class*=player], [class*=Player]")) return;
    for (let box = el, i = 0; box && box !== doc.body && i < 4; box = box.parentElement, i++) {
      const text = textOf(box);
      if (text.length > 160) break;
      if (OFFER.test(text)) return hide(box);
    }
  }

  scan(doc.body);
  const pending = new Set();
  let queued = false;
  new win.MutationObserver(records => {
    for (const r of records) {
      if (r.type === "characterData") tick(r.target.parentElement);
      else for (const n of r.addedNodes) {
        if (n.nodeType === 1) pending.add(n);
        else if (n.nodeType === 3) { pending.add(n.parentElement); tick(n.parentElement); }
      }
    }
    if (queued || !pending.size) return;
    queued = true;
    win.setTimeout(() => {
      queued = false;
      for (const n of pending) if (n?.isConnected) scan(n);
      pending.clear();
    }, 300);
  }).observe(doc.body, { childList: true, subtree: true, characterData: true });
}

// For tests: whether a piece of text counts as fake urgency, and as confirm-shaming
export const isUrgency = text => URGENCY.some(re => re.test(text));
export const isShaming = text => SHAMING.some(re => re.test(text));
