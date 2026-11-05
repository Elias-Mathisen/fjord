// Fjord's helper inside web pages, a frame script loaded into every tab by perms.sys.mjs (Firefox 159 doesn't let
// runtime-registered JSWindowActors into web content, but frame scripts still run there):
//  - permission watch: tells Fjord when a page uses location or reads the clipboard
//  - design tools: "What font is this?" picker, a page's images, SVGs and fonts, the full page size
//  - the ski jump game on the "you're offline" page
// Requests come as "Fjord:Ask" { id, name } and are answered with "Fjord:Reply" { id, result }.
(() => {
  // ---------- The "you're offline" page ----------
  // Firefox's error page for a site that couldn't load, when that's because this computer has no network (or Firefox
  // is set to work offline): Fjord's own drawing and words, and the ski jump game (offline.sys.mjs)
  addEventListener("DOMContentLoaded", e => {
    const doc = e.target, win = doc.defaultView;
    // Reader view in Fjord's font (its colours are in reader.css)
    if (win && doc.documentURI.startsWith("about:reader")) {
      ChromeUtils.importESModule("resource://fjord/offline.sys.mjs").addFjordFont(win);
      return;
    }
    const code = /^about:neterror\?e=(\w+)/.exec(doc.documentURI)?.[1];
    if (!win || win.browsingContext?.parent || !code || !doc.body) return; // the tab's page, not a frame in it
    if (code !== "netOffline" && !(["dnsNotFound", "netTimeout", "connectionFailure", "netReset"].includes(code) && !win.navigator.onLine)) return;
    const { dressOfflinePage } = ChromeUtils.importESModule("resource://fjord/offline.sys.mjs");
    dressOfflinePage(win, {
      offlineMode: code === "netOffline",
      best: Services.prefs.getIntPref("fjord.skijump.best", 0),
      saveBest: m => sendAsyncMessage("Fjord:SkiJumpBest", { m }),
    }).catch(err => Cu.reportError(err));
  });

  // ---------- Permission watch ----------
  // The page's own functions are wrapped so Fjord hears about the call first; the page still gets the real thing.
  addEventListener("DOMWindowCreated", e => {
    const win = e.target.defaultView;
    const page = win?.wrappedJSObject;
    if (!page || !/^https?:$/.test(win.location.protocol)) return;
    const reported = new Set();
    const report = what => {
      if (reported.has(what)) return;
      reported.add(what);
      sendAsyncMessage("Fjord:Permission", { what, host: win.location.host });
    };
    const wrap = (proto, name, what) => {
      const real = proto?.[name];
      if (typeof real !== "function") return;
      // Arguments passed one by one: an array made here isn't readable by the page's own function
      Cu.exportFunction(function (...args) { report(what); return real.call(this, ...args); }, proto, { defineAs: name });
    };
    wrap(page.Geolocation?.prototype, "getCurrentPosition", "location");
    wrap(page.Geolocation?.prototype, "watchPosition", "location");
    wrap(page.Clipboard?.prototype, "readText", "clipboard");
    wrap(page.Clipboard?.prototype, "read", "clipboard");
    guardClipboard(win, page);
  });

  // ---------- Clipboard hijack guard ----------
  // A page can swap what you copy (a crypto address for its own, say). After the page has had its say on a copy (a
  // system-group listener runs last), Fjord compares what you selected with what went on the clipboard; it also
  // watches the page writing to the clipboard itself within 3 s of your copy. Adding text, like "Read more at…", is fine.
  const squash = s => s.replace(/\s+/g, " ").trim();
  function guardClipboard(win, page) {
    if (!Services.prefs.getBoolPref("fjord.clipboardGuard.enabled", true)) return;
    let last = { text: "", t: 0 };
    const selection = () => {
      const el = win.document.activeElement;
      if (el && "selectionStart" in el && typeof el.value === "string") return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
      return win.getSelection()?.toString() ?? "";
    };
    const check = (selected, put) => {
      if (!selected.trim() || typeof put !== "string" || !put.trim()) return;
      if (squash(put).includes(squash(selected))) return;
      sendAsyncMessage("Fjord:ClipboardChanged", { host: win.location.host, selected: selected.slice(0, 2000), put: put.slice(0, 200) });
    };
    win.addEventListener("copy", e => {
      const selected = selection();
      last = { text: selected, t: Date.now() };
      if (e.defaultPrevented && e.clipboardData) check(selected, e.clipboardData.getData("text/plain"));
    }, { mozSystemGroup: true });
    const proto = page.Clipboard?.prototype, real = proto?.writeText;
    if (typeof real === "function") {
      Cu.exportFunction(function (text) {
        if (Date.now() - last.t < 3000) check(last.text, String(text));
        return real.call(this, text);
      }, proto, { defineAs: "writeText" });
    }
  }

  addMessageListener("Fjord:Ask", ({ data: { id, name } }) => {
    let result = null;
    try {
      if (name === "PickFont") pickFont();
      else if (name === "Assets") result = assets();
      else if (name === "PageSize") {
        const el = content.document.documentElement;
        result = { width: el.scrollWidth, height: Math.max(el.scrollHeight, content.document.body?.scrollHeight ?? 0) };
      }
    } catch (e) {
      Cu.reportError(e);
    }
    sendAsyncMessage("Fjord:Reply", { id, result });
  });

  // ---------- "What font is this?" ----------
  // Hover outlines an element, click shows its font in a card (drawn in a closed shadow root, so the page's styles and
  // scripts can't touch it). Esc or Done ends it.
  let stopPicking = null;
  function pickFont() {
    if (stopPicking) return;
    const doc = content.document, win = content;
    const host = doc.createElement("fjord-font-picker");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .outline { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid #3b82f6; border-radius: 3px; background: rgb(59 130 246 / 0.08); }
      .card { position: fixed; z-index: 2147483647; width: 280px; padding: 14px 16px; border-radius: 12px; background: #1e1e20; color: #ededed;
        font: 13px/1.45 system-ui, sans-serif; box-shadow: 0 10px 40px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(255 255 255 / 0.08); }
      .card b { display: block; font-size: 17px; font-weight: 600; margin-bottom: 8px; overflow-wrap: anywhere; }
      .card dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0 0 12px; }
      .card dt { color: #a1a1a6; } .card dd { margin: 0; overflow-wrap: anywhere; }
      .card .row { display: flex; gap: 8px; align-items: center; }
      .card button { font: inherit; padding: 6px 12px; border: none; border-radius: 8px; background: #ededed; color: #1e1e20; font-weight: 600; cursor: pointer; }
      .card button.plain { background: transparent; color: #a1a1a6; font-weight: 400; }
      .hint { position: fixed; z-index: 2147483647; top: 12px; left: 50%; transform: translateX(-50%); padding: 8px 14px; border-radius: 999px;
        background: #1e1e20; color: #ededed; font: 13px system-ui, sans-serif; box-shadow: 0 6px 24px rgb(0 0 0 / 0.35); }
    </style><div class="outline" hidden></div><div class="hint">Click any text to see its font. Esc to stop.</div><div class="card" hidden></div>`;
    doc.documentElement.append(host);
    const outline = root.querySelector(".outline"), card = root.querySelector(".card"), hint = root.querySelector(".hint");
    const target = e => {
      const el = e.composedPath?.()[0] ?? e.target;
      return el === host || !Element.isInstance(el) ? null : el;
    };
    const onMove = e => {
      const el = target(e);
      if (!el) return;
      const r = el.getBoundingClientRect();
      Object.assign(outline.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width}px`, height: `${r.height}px` });
      outline.hidden = false;
    };
    const onClick = e => {
      if (e.composedPath?.().includes(host)) return; // clicks on the card itself
      const el = target(e);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      showFont(el, card, e.clientX, e.clientY);
      hint.hidden = true;
    };
    const onKey = e => { if (e.key === "Escape") { e.preventDefault(); stopPicking(); } };
    stopPicking = () => {
      win.removeEventListener("mousemove", onMove, true);
      win.removeEventListener("click", onClick, true);
      win.removeEventListener("keydown", onKey, true);
      host.remove();
      stopPicking = null;
    };
    win.addEventListener("mousemove", onMove, true);
    win.addEventListener("click", onClick, true);
    win.addEventListener("keydown", onKey, true);
  }

  function showFont(el, card, x, y) {
    const win = content, s = win.getComputedStyle(el);
    const range = content.document.createRange();
    range.selectNodeContents(el);
    let used = [];
    try { used = InspectorUtils.getUsedFontFaces(range, 3); } catch {}
    const face = used[0];
    const name = face?.CSSFamilyName || face?.name || s.fontFamily.split(",")[0].replace(/["']/g, "");
    const source = !face ? "" : face.URI ? "Web font" : face.localName ? "Installed on this computer" : "System font";
    const rows = [["Font", face?.name || name], ["Source", source], ["Size", s.fontSize], ["Weight", s.fontWeight],
      ["Line height", s.lineHeight], ["Letter spacing", s.letterSpacing], ["Colour", s.color], ["CSS stack", s.fontFamily]].filter(r => r[1]);
    const css = `font-family: ${s.fontFamily};\nfont-size: ${s.fontSize};\nfont-weight: ${s.fontWeight};\nline-height: ${s.lineHeight};\nletter-spacing: ${s.letterSpacing};\ncolor: ${s.color};`;
    const doc = content.document;
    const b = doc.createElement("b");
    b.textContent = name;
    b.style.fontFamily = s.fontFamily;
    const dl = doc.createElement("dl");
    for (const [k, v] of rows) {
      const dt = doc.createElement("dt"), dd = doc.createElement("dd");
      dt.textContent = k;
      dd.textContent = v;
      dl.append(dt, dd);
    }
    const row = doc.createElement("div");
    row.className = "row";
    const copy = doc.createElement("button");
    copy.textContent = "Copy CSS";
    copy.addEventListener("click", e => {
      e.stopPropagation();
      sendAsyncMessage("Fjord:Copy", { text: css });
      copy.textContent = "Copied";
    });
    const done = doc.createElement("button");
    done.className = "plain";
    done.textContent = "Done";
    done.addEventListener("click", e => { e.stopPropagation(); stopPicking?.(); });
    row.append(copy, done);
    card.replaceChildren(b, dl, row);
    card.hidden = false;
    const h = card.getBoundingClientRect().height;
    card.style.left = `${Math.max(8, Math.min(x + 12, win.innerWidth - 320))}px`;
    card.style.top = `${Math.max(8, Math.min(y + 12, win.innerHeight - h - 8))}px`;
  }

  // ---------- A page's images, SVGs and fonts ----------
  function assets() {
    const doc = content.document, win = content;
    const images = new Set();
    const add = u => { try { images.add(new URL(u, doc.baseURI).href); } catch {} };
    for (const img of doc.images) add(img.currentSrc || img.src);
    // The largest candidate of every srcset
    for (const el of doc.querySelectorAll("[srcset]")) add(el.getAttribute("srcset").split(",").pop().trim().split(/\s+/)[0]);
    const all = doc.querySelectorAll("*");
    for (let i = 0; i < all.length && i < 6000; i++) {
      const bg = win.getComputedStyle(all[i]).backgroundImage;
      if (bg && bg !== "none") for (const m of bg.matchAll(/url\("?([^")]+)"?\)/g)) add(m[1]);
    }
    const svgs = [...doc.querySelectorAll("svg")].filter(s => !s.parentElement?.closest("svg")).map(s => {
      const copy = s.cloneNode(true);
      copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      return copy.outerHTML;
    }).filter(m => m.length < 500000);
    const fonts = new Set(win.performance.getEntriesByType("resource").map(e => e.name).filter(n => /\.(woff2?|ttf|otf)([?#]|$)/i.test(n)));
    return {
      host: doc.location.host,
      images: [...images].filter(u => /^(https?|data):/.test(u)).slice(0, 400),
      svgs: svgs.slice(0, 200),
      fonts: [...fonts].slice(0, 60),
    };
  }
})();
