// Scripts Fjord puts into web pages: the randomised fingerprint, the parts of sites you hid, and the picker that hides
// them (from Shields). The same ideas as page-frame.js on the desktop, in WebKit's own terms.
import Foundation

enum PageScripts {
    // New every time Fjord starts, like Firefox's canvas key on the desktop
    static let sessionKey = UInt32.random(in: 1...UInt32.max)

    // Every site gets slightly different, made-up canvas, WebGL and audio readings: every 64th value nudged by a key
    // made from this session's key and the site's name. Canvases shown on the page keep exact pixels when read back
    // (maps and games use them to tell what you tapped); pictures saved from any canvas, and every sound, are nudged.
    // shortcut: wrapped in the page's own world, so a page can tell the functions were replaced; WebKit offers no
    // canvas randomising of its own to use instead
    static var randomise: String {
        """
        (() => {
          let seed = \(sessionKey) >>> 0;
          for (const ch of location.hostname.replace(/^www\\./, "")) seed = Math.imul(seed ^ ch.charCodeAt(0), 0x9e3779b1) >>> 0;
          const nudge = i => {
            let x = Math.imul(seed ^ i, 0x85ebca6b) >>> 0;
            x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
            return (x >>> 8) / 0x1000000 - 0.5;
          };
          const flip = a => { for (let i = 0; i < a.length; i += 64) if (nudge(i) > 0) a[i] ^= 1; };
          const replace = (proto, name, make) => {
            const real = proto && proto[name];
            if (typeof real !== "function") return;
            Object.defineProperty(proto, name, { value: make(real), writable: true, configurable: true });
          };
          const C2D = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
          const getData = C2D && C2D.getImageData;
          replace(C2D, "getImageData", real => function (...args) {
            const data = real.apply(this, args);
            if (!this.canvas.isConnected) flip(data.data);
            return data;
          });
          // A copy of the canvas with its pixels nudged, for toDataURL and toBlob
          const nudged = canvas => {
            if (!canvas.width || !canvas.height || !getData) return canvas;
            const copy = document.createElement("canvas");
            copy.width = canvas.width; copy.height = canvas.height;
            const x = copy.getContext("2d");
            x.drawImage(canvas, 0, 0);
            const img = getData.call(x, 0, 0, copy.width, copy.height);
            flip(img.data);
            x.putImageData(img, 0, 0);
            return copy;
          };
          const CV = HTMLCanvasElement.prototype;
          replace(CV, "toDataURL", real => function (...args) { return real.apply(nudged(this), args); });
          replace(CV, "toBlob", real => function (...args) { return real.apply(nudged(this), args); });
          for (const gl of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
            replace(gl && gl.prototype, "readPixels", real => function (...args) {
              real.apply(this, args);
              if (ArrayBuffer.isView(args[6]) && !this.canvas.isConnected) flip(args[6]);
            });
          }
          const noise = (a, from = 0, scale = 1) => {
            for (let i = (64 - (from % 64)) % 64; i < a.length; i += 64) a[i] += nudge(from + i) * 2e-7 * scale;
          };
          const done = new WeakSet();
          const AB = window.AudioBuffer && AudioBuffer.prototype;
          replace(AB, "getChannelData", real => function (channel) {
            const data = real.call(this, channel);
            if (!done.has(data)) { done.add(data); noise(data); }
            return data;
          });
          replace(AB, "copyFromChannel", real => function (dest, channel, start = 0) {
            real.call(this, dest, channel, start);
            noise(dest, start >>> 0);
          });
          replace(window.AnalyserNode && AnalyserNode.prototype, "getFloatFrequencyData", real => function (dest) {
            real.call(this, dest);
            noise(dest, 0, 1000); // decibels, around -100: a ten-millionth would be lost to rounding
          });
        })();
        """
    }

    // What the page tries to load from other sites (scripts, images, frames, pixels, fetches), one host per address,
    // for the new tab's tracker count (TrackerStats). WebKit's block lists say nothing about what they stop, so Fjord
    // notes what was asked for and counts the addresses on its tracker list.
    // shortcut: requests a page makes some other way (CSS backgrounds, <link rel=preload> later in the page's life,
    // workers) aren't seen, so the count is lower than what's really stopped
    static let watcher = """
    (() => {
      const own = location.hostname.split(".").slice(-2).join(".");
      const seen = new Set(), queue = [];
      const note = value => {
        if (!value || typeof value !== "string" || seen.size > 2000) return;
        let url;
        try { url = new URL(value, location.href); } catch { return; }
        if (!/^https?:$/.test(url.protocol) || url.hostname.split(".").slice(-2).join(".") === own) return;
        const key = url.hostname + url.pathname;
        if (seen.has(key)) return;
        seen.add(key);
        queue.push(url.hostname);
      };
      const send = () => {
        if (!queue.length) return;
        try { window.webkit.messageHandlers.fjordSeen.postMessage({ hosts: queue.splice(0) }); } catch {}
      };
      setInterval(send, 2000);
      addEventListener("pagehide", send);
      const scan = el => {
        if (el.nodeType !== 1) return;
        for (const attr of ["src", "href", "data"]) if (el.hasAttribute && el.hasAttribute(attr) && el.localName !== "a") note(el.getAttribute(attr));
        if (el.querySelectorAll) for (const child of el.querySelectorAll("[src], link[href], object[data]")) scan(child);
      };
      new MutationObserver(list => {
        for (const m of list) {
          if (m.type === "attributes") scan(m.target);
          else for (const n of m.addedNodes) scan(n);
        }
      }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href", "data"] });
      // Tracking pixels made in code (new Image().src = …) never join the page
      const img = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
      if (img && img.set) Object.defineProperty(HTMLImageElement.prototype, "src", { ...img, set(v) { note(String(v)); img.set.call(this, v); } });
      const realFetch = window.fetch;
      if (realFetch) window.fetch = function (input, init) { note(typeof input === "string" ? input : input && input.url); return realFetch.call(this, input, init); };
      const open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) { note(String(url)); return open.call(this, method, url, ...rest); };
      if (navigator.sendBeacon) { const beacon = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = (url, data) => { note(String(url)); return beacon(url, data); }; }
    })();
    """

    // The parts of this site you hid, as a style sheet the page gets before it shows. One rule per selector: one the
    // browser can't read would cancel every other one in its rule.
    static func hidden(_ selectors: [String], unlockScroll: Bool) -> String {
        var css = selectors.map { "\($0) { display: none !important; }" }.joined(separator: "\n")
        if unlockScroll { css += "\nhtml, body { overflow: auto !important; }" }
        let literal = String(data: try! JSONEncoder().encode(css), encoding: .utf8)!
        return """
        (() => {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(\(literal));
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        })();
        """
    }

    // Shields > Hide part of this page: tap what you want gone, "Bigger" picks the area around it, "Hide" hides it on
    // this site from now on (sent to Tab as a "fjordHide" message). The bar is drawn in a closed shadow root, so the
    // page's styles and scripts can't touch it.
    static let picker = """
    (() => {
      if (window.__fjordPicking) return;
      window.__fjordPicking = true;
      const doc = document, host = doc.createElement("fjord-hide-picker");
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>
        .outline { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid #ededed; border-radius: 4px;
          background: rgb(30 30 32 / 0.25); box-shadow: 0 0 0 1px #1e1e20, 0 0 0 9999px rgb(0 0 0 / 0.12); }
        .bar { position: fixed; z-index: 2147483647; left: 12px; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom));
          display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px; border-radius: 16px; background: #1e1e20;
          color: #ededed; font: 15px/1.35 -apple-system, system-ui, sans-serif; box-shadow: 0 10px 30px rgb(0 0 0 / 0.35); }
        .bar span { flex: 1 1 100%; }
        .bar button { flex: 1; font: inherit; font-weight: 600; padding: 10px; border: none; border-radius: 10px;
          background: #38383b; color: #ededed; }
        .bar button.main { background: #ededed; color: #1e1e20; }
        .bar button:disabled { opacity: 0.4; }
      </style><div class="outline" hidden></div><div class="bar"><span></span>
        <button class="cancel">Cancel</button><button class="bigger" disabled>Bigger</button><button class="main" disabled>Hide</button></div>`;
      doc.documentElement.append(host);
      const outline = root.querySelector(".outline"), text = root.querySelector("span");
      const bigger = root.querySelector(".bigger"), hide = root.querySelector(".main"), cancel = root.querySelector(".cancel");
      const site = location.hostname;
      text.textContent = "Tap what you want gone from " + site.replace(/^www\\./, "") + ".";
      let current = null;
      const show = el => {
        current = el;
        const r = el.getBoundingClientRect();
        Object.assign(outline.style, { left: r.left - 2 + "px", top: r.top - 2 + "px", width: r.width + "px", height: r.height + "px" });
        outline.hidden = false;
        bigger.disabled = !el.parentElement || el.parentElement === doc.body;
        hide.disabled = false;
      };
      const fixedAround = el => {
        let found = null;
        for (let e = el; e && e !== doc.body; e = e.parentElement) if (getComputedStyle(e).position === "fixed") found = e;
        return found;
      };
      // A selector for this element on the next visit. It has to name something (an id or a class) or start from
      // <body>, since it applies to every page of the site
      const selectorFor = el => {
        const lasting = s => s && !/\\d{3,}|[A-Z0-9]{6,}/.test(s) && s.length < 40;
        const parts = [];
        for (let e = el; e && e !== doc.documentElement; e = e.parentElement) {
          if (lasting(e.id) && doc.querySelectorAll("#" + CSS.escape(e.id)).length === 1) {
            parts.unshift("#" + CSS.escape(e.id));
          } else {
            let part = e.localName + [...e.classList].filter(lasting).slice(0, 2).map(c => "." + CSS.escape(c)).join("");
            const same = e.parentElement ? [...e.parentElement.children].filter(s => s.localName === e.localName) : [];
            if (same.length > 1 && e.parentElement.querySelectorAll(":scope > " + part).length > 1) part += ":nth-of-type(" + (same.indexOf(e) + 1) + ")";
            parts.unshift(part);
          }
          const sel = parts.join(" > "), found = doc.querySelectorAll(sel);
          if (found.length === 1 && found[0] === el && /[#.]/.test(sel)) return sel;
          if (parts[0].startsWith("#")) break;
        }
        return parts.join(" > ");
      };
      const stop = () => {
        removeEventListener("click", onTap, true);
        host.remove();
        window.__fjordPicking = false;
      };
      const onTap = e => {
        if (e.composedPath().includes(host)) return;
        e.preventDefault();
        e.stopPropagation();
        const el = e.target;
        if (el && el !== doc.documentElement && el !== doc.body) show(fixedAround(el) || el);
      };
      addEventListener("click", onTap, true);
      cancel.addEventListener("click", stop);
      bigger.addEventListener("click", () => current && current.parentElement && show(current.parentElement));
      hide.addEventListener("click", () => {
        if (!current) return;
        const r = current.getBoundingClientRect();
        const unlockScroll = current === fixedAround(current) && r.width * r.height > 0.4 * innerWidth * innerHeight;
        const selector = selectorFor(current);
        current.style.setProperty("display", "none", "important");
        if (unlockScroll) for (const x of [doc.documentElement, doc.body]) x && x.style.setProperty("overflow", "auto", "important");
        window.webkit.messageHandlers.fjordHide.postMessage({ site, selector, unlockScroll });
        stop();
      });
    })();
    """
}
