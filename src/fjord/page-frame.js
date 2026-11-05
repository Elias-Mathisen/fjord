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
    noiseAudio(win, page);
    applyHidden(win);
  });

  // ---------- Link preview (features/glance.js) ----------
  // Shift-click on a link opens it in a window over the page instead of a new window. Stopped here first, so neither
  // the page nor Firefox's own link handling acts on it.
  addEventListener("click", e => {
    if (!e.isTrusted || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.button !== 0 || e.defaultPrevented) return;
    if (!Services.prefs.getBoolPref("fjord.glance.enabled", true)) return;
    // composedPath() seen from here doesn't hold the page's elements; the innermost target does (closest() can't leave a
    // shadow root, so a link drawn inside one isn't caught)
    const target = e.originalTarget;
    const link = Element.isInstance(target) ? target.closest("a[href], area[href]") : target?.parentElement?.closest("a[href], area[href]");
    if (!link || !/^https?:/.test(link.href)) return;
    e.preventDefault();
    e.stopPropagation();
    sendAsyncMessage("Fjord:Glance", { url: link.href });
  }, true);

  // ---------- Parts of pages you hid (hidden.sys.mjs keeps the list) ----------
  // A user style sheet per page, which the page can't override or remove. One rule per selector: a selector the
  // browser can't read would cancel every other one in its rule.
  const siteOf = host => { try { return Services.eTLD.getBaseDomainFromHost(host); } catch { return host; } };
  const hideSheets = new WeakMap(); // document -> the CSS it got (the window stays the same across pages)
  function applyHidden(win) {
    if (!/^https?:$/.test(win.location.protocol)) return;
    const s = (Services.cpmm.sharedData.get("Fjord:hidden") ?? {})[siteOf(win.location.hostname)];
    const css = !s?.selectors.length ? "" : s.selectors.map(sel => `${sel} { display: none !important; }`).join("\n") +
      (s.unlockScroll ? "\nhtml, body { overflow: auto !important; }" : "");
    const old = hideSheets.get(win.document) ?? "";
    if (old === css) return;
    const wu = win.windowUtils;
    if (old) try { wu.removeSheetUsingURIString(`data:text/css,${encodeURIComponent(old)}`, wu.USER_SHEET); } catch {}
    if (css) wu.loadSheetUsingURIString(`data:text/css,${encodeURIComponent(css)}`, wu.USER_SHEET);
    hideSheets.set(win.document, css);
  }
  Services.cpmm.sharedData.addEventListener("change", e => {
    if (e.changedKeys.includes("Fjord:hidden") && content) applyHidden(content);
  });

  // "Hide this…" in the right-click menu (features/hide.js): starts from what you right-clicked, or the pop-up
  // around it. Hover picks something else, ↑ and ↓ make the area bigger or smaller, a click or Enter hides it.
  let lastContextTarget = null;
  addEventListener("contextmenu", e => {
    const t = e.originalTarget; // as for link preview: composedPath() from here doesn't hold the page's elements
    lastContextTarget = Element.isInstance(t) ? t : t?.parentElement ?? null;
  }, true);
  addMessageListener("Fjord:HidePicker", () => { try { pickToHide(); } catch (e) { Cu.reportError(e); } });

  // The outermost fixed part of the page around an element: a cookie wall, a newsletter box, a floating video
  const overlayAround = el => {
    let found = null;
    for (let e = el; e && e !== content.document.body; e = e.parentElement) {
      if (content.getComputedStyle(e).position === "fixed") found = e;
    }
    return found;
  };
  // A selector that finds this element again on the next visit: its id if it has a lasting one, else the path to it.
  // It has to name something (an id or a class) or start from <body>, since it applies to every page of the site:
  // a bare "p:nth-of-type(2)" would hide the second paragraph everywhere.
  function selectorFor(el) {
    const doc = el.ownerDocument, esc = s => content.CSS.escape(s);
    const lasting = s => s && !/\d{3,}|[A-Z0-9]{6,}/.test(s) && s.length < 40;
    const parts = [];
    for (let e = el; e && e !== doc.documentElement; e = e.parentElement) {
      if (lasting(e.id) && doc.querySelectorAll(`#${esc(e.id)}`).length === 1) {
        parts.unshift(`#${esc(e.id)}`);
      } else {
        let part = e.localName + [...e.classList].filter(lasting).slice(0, 2).map(c => `.${esc(c)}`).join("");
        const siblings = e.parentElement ? [...e.parentElement.children].filter(s => s.localName === e.localName) : [];
        if (siblings.length > 1 && e.parentElement.querySelectorAll(`:scope > ${part}`).length > 1) {
          part += `:nth-of-type(${siblings.indexOf(e) + 1})`;
        }
        parts.unshift(part);
      }
      const sel = parts.join(" > ");
      const found = doc.querySelectorAll(sel);
      if (found.length === 1 && found[0] === el && /[#.]/.test(sel)) return sel;
      if (parts[0].startsWith("#")) break;
    }
    return parts.join(" > ");
  }

  let stopHiding = null;
  function pickToHide() {
    try { stopHiding?.(); } catch {} // a picker left open on a page that's gone
    stopHiding = null;
    const win = content, doc = win.document;
    if (!/^https?:$/.test(win.location.protocol)) return;
    const site = siteOf(win.location.hostname);
    const host = doc.createElement("fjord-hide-picker");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .outline { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid #ededed; border-radius: 4px;
        background: rgb(30 30 32 / 0.25); box-shadow: 0 0 0 1px #1e1e20, 0 0 0 9999px rgb(0 0 0 / 0.12); }
      .hint { position: fixed; z-index: 2147483647; top: 12px; left: 50%; transform: translateX(-50%); display: flex; gap: 10px; align-items: center;
        max-width: calc(100vw - 48px); padding: 8px 8px 8px 16px; border-radius: 12px; background: #1e1e20; color: #ededed;
        font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 10px 30px rgb(0 0 0 / 0.35), 0 0 0 1px rgb(255 255 255 / 0.08); }
      .hint button { font: inherit; padding: 6px 12px; border: none; border-radius: 8px; background: #ededed; color: #1e1e20; font-weight: 600; cursor: pointer; }
      .hint button.plain { background: transparent; color: #a1a1a6; font-weight: 400; }
      .hint button:focus-visible { outline: 2px solid #ededed; outline-offset: 2px; }
    </style><div class="outline" hidden></div><div class="hint"><span></span><button class="plain">Cancel</button></div>`;
    doc.documentElement.append(host);
    const outline = root.querySelector(".outline"), hint = root.querySelector(".hint"), text = hint.querySelector("span");
    text.textContent = `Click what you want gone from ${site}. ↑ picks the area around it.`;
    let current = null, smaller = [];
    const show = el => {
      current = el;
      if (!el) { outline.hidden = true; return; }
      const r = el.getBoundingClientRect();
      Object.assign(outline.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width}px`, height: `${r.height}px` });
      outline.hidden = false;
    };
    const pageElement = e => {
      const el = e.composedPath?.()[0] ?? e.target;
      return el === host || !Element.isInstance(el) || el === doc.documentElement || el === doc.body ? null : el;
    };
    const start = lastContextTarget && doc.documentElement.contains(lastContextTarget) ? lastContextTarget : null;
    show(start && (overlayAround(start) ?? start));

    const hide = () => {
      const el = current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const covers = r.width * r.height > 0.4 * win.innerWidth * win.innerHeight;
      const fixed = el === overlayAround(el);
      const selector = selectorFor(el);
      el.style.setProperty("display", "none", "important");
      if (fixed && covers) for (const x of [doc.documentElement, doc.body]) x?.style.setProperty("overflow", "auto", "important");
      sendAsyncMessage("Fjord:Hide", { site, selector, unlockScroll: fixed && covers });
      stop(false);
      // A moment to take it back
      text.textContent = `Hidden on ${site}. Shields can show it again.`;
      button.textContent = "Undo";
      button.className = "";
      onButton = () => {
        el.style.removeProperty("display");
        sendAsyncMessage("Fjord:Unhide", { site, selector });
        host.remove();
      };
      win.setTimeout(() => host.remove(), 5000);
    };
    const onMove = e => {
      const el = pageElement(e);
      if (el && el !== current && !current?.contains(el)) { smaller = []; show(el); }
    };
    const onClick = e => {
      if (e.composedPath?.().includes(host)) return; // the hint's own buttons
      e.preventDefault();
      e.stopPropagation();
      const el = pageElement(e);
      if (el && !current?.contains(el)) show(el);
      hide();
    };
    const onKey = e => {
      if (e.key === "Escape") stop(true);
      else if (e.key === "Enter") hide();
      else if (e.key === "ArrowUp" && current?.parentElement && current.parentElement !== doc.body) { smaller.push(current); show(current.parentElement); }
      else if (e.key === "ArrowDown" && smaller.length) show(smaller.pop());
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    // Clicks on links and buttons mustn't go through while picking
    const swallow = e => { if (!e.composedPath?.().includes(host)) { e.preventDefault(); e.stopPropagation(); } };
    const stop = removeHint => {
      win.removeEventListener("mousemove", onMove, true);
      win.removeEventListener("click", onClick, true);
      win.removeEventListener("keydown", onKey, true);
      for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup"]) win.removeEventListener(t, swallow, true);
      outline.hidden = true;
      if (removeHint) host.remove();
      stopHiding = null;
    };
    const button = hint.querySelector("button");
    let onButton = () => stop(true); // Cancel, then Undo once something is hidden
    button.addEventListener("click", () => onButton());
    stopHiding = () => stop(true);
    win.addEventListener("pagehide", () => { stopHiding = null; }, { once: true });
    win.addEventListener("mousemove", onMove, true);
    win.addEventListener("click", onClick, true);
    win.addEventListener("keydown", onKey, true);
    for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup"]) win.addEventListener(t, swallow, true);
  }

  // ---------- Audio randomising ----------
  // Trackers render a sound offline and add up the samples: the total differs a little from device to device. Fjord
  // nudges every 64th sample by an inaudible amount (about a ten-millionth), the same for one site all session and
  // different for every site, like Firefox does for canvas. Positions count from the start of the sound, so reading
  // it in parts gives the same result.
  // shortcut: frames from other sites run in their own process without this script, so their audio isn't randomised
  function noiseAudio(win, page) {
    const key = Services.cpmm.sharedData.get("Fjord:noiseKey");
    if (!key || !Services.prefs.getBoolPref("fjord.fingerprint.randomise", true)) return;
    let site = win.location.hostname;
    try { site = Services.eTLD.getBaseDomainFromHost(site); } catch {}
    let seed = key >>> 0;
    for (const ch of site) seed = Math.imul(seed ^ ch.charCodeAt(0), 0x9e3779b1) >>> 0;
    const nudge = i => {
      let x = Math.imul(seed ^ i, 0x85ebca6b) >>> 0;
      x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
      return ((x >>> 8) / 0x1000000 - 0.5) * 2e-7;
    };
    const noise = (data, from = 0, scale = 1) => {
      const a = Cu.waiveXrays(data);
      for (let i = (64 - (from % 64)) % 64; i < a.length; i += 64) a[i] += nudge(from + i) * scale;
    };
    const done = new WeakSet(); // a buffer's own data is nudged once
    const proto = page.AudioBuffer?.prototype;
    const getData = proto?.getChannelData, copyFrom = proto?.copyFromChannel;
    if (typeof getData === "function") {
      Cu.exportFunction(function (channel) {
        const data = getData.call(this, channel);
        const raw = Cu.waiveXrays(data);
        if (!done.has(raw)) { done.add(raw); noise(data); }
        return data;
      }, proto, { defineAs: "getChannelData" });
    }
    if (typeof copyFrom === "function") {
      Cu.exportFunction(function (dest, channel, start = 0) {
        copyFrom.call(this, dest, channel, start);
        noise(dest, start >>> 0);
      }, proto, { defineAs: "copyFromChannel" });
    }
    const analyser = page.AnalyserNode?.prototype, getFreq = analyser?.getFloatFrequencyData;
    if (typeof getFreq === "function") {
      Cu.exportFunction(function (dest) {
        getFreq.call(this, dest);
        noise(dest, 0, 1000); // decibels, around -100: a ten-millionth would be lost to rounding
      }, analyser, { defineAs: "getFloatFrequencyData" });
    }

    // WebGL pixels read straight back from a canvas that isn't on the page (Firefox already randomises WebGL canvases
    // saved as images): every 64th value flips its lowest bit, or not, by the same per-site key. Canvases on the page
    // are left alone, because maps and games read exact colours back to tell what you clicked.
    for (const gl of [page.WebGLRenderingContext?.prototype, page.WebGL2RenderingContext?.prototype]) {
      const read = gl?.readPixels;
      if (typeof read !== "function") continue;
      Cu.exportFunction(function (...args) {
        read.call(this, ...args);
        const dest = args[6];
        if (!ArrayBuffer.isView(Cu.waiveXrays(dest)) || this.canvas?.isConnected) return;
        const a = Cu.waiveXrays(dest);
        for (let i = 0; i < a.length; i += 64) if (nudge(i) > 0) a[i] ^= 1;
      }, gl, { defineAs: "readPixels" });
    }
  }

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
    win.addEventListener("pagehide", () => { stopPicking = null; }, { once: true }); // or it could never start again
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
