// Design tools: a toolbar button with a colour picker, "What font is this?", saving a page's
// images, SVGs and fonts, and a full-page screenshot. The page side is page-frame.js; files go to
// Downloads\Fjord. Loaded into each window by browser.js.
(() => {
  const { h, toast, switchRow } = Fjord;
  const { CustomizableUI } = ChromeUtils.importESModule("moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs");
  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  const ART = "resource://fjord/illustrations/icons/";
  const WIDGET = "fjord-design-button";

  try {
    CustomizableUI.createWidget({
      id: WIDGET, type: "button", label: "Design tools", tooltiptext: "Design tools: colours, fonts, assets and screenshots",
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onCommand: e => e.target.ownerDocument.defaultView.Fjord.openDesignPanel(e.target),
    });
  } catch {} // made by the first window already

  const panel = document.createXULElement("panel");
  panel.id = "fjord-design";
  panel.setAttribute("type", "arrow");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Design tools");
  document.getElementById("mainPopupSet").append(panel);

  const perms = ChromeUtils.importESModule("resource://fjord/perms.sys.mjs"); // its ask() talks to page-frame.js
  const browser = () => gBrowser.selectedBrowser;
  const needsPage = fn => () => {
    panel.hidePopup();
    const b = browser();
    if (!/^https?$/.test(b.currentURI.scheme)) return toast(b, "Design tools work on websites.");
    fn(name => perms.ask(b, name)).catch(e => { console.error(e); toast(b, "That didn't work on this page."); });
  };
  const stamp = () => new Date().toLocaleString("sv").replace(/:/g, ".").slice(0, 16);
  const folder = async name => {
    const dir = PathUtils.join(await Downloads.getPreferredDownloadsDirectory(), "Fjord", name);
    await IOUtils.makeDirectory(dir, { createAncestors: true });
    return dir;
  };
  const reveal = path => () => { try { new FileUtils.File(path).reveal(); } catch (e) { console.error(e); } };

  // Unique, Windows-safe file names; the extension comes from the address, or else from the file type
  const EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif",
    "image/svg+xml": ".svg", "image/x-icon": ".ico", "font/woff2": ".woff2", "font/woff": ".woff", "font/ttf": ".ttf", "font/otf": ".otf" };
  function namer() {
    const used = new Set();
    return (url, type) => {
      let base = "file";
      try { base = decodeURIComponent(new URL(url).pathname.split("/").pop()) || base; } catch {}
      if (url.startsWith("data:")) base = "image";
      base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 80);
      if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += EXT[type?.split(";")[0]] ?? "";
      let name = base, i = 1;
      while (used.has(name.toLowerCase())) name = base.replace(/(\.[^.]*)?$/, m => ` (${++i})${m}`);
      used.add(name.toLowerCase());
      return name;
    };
  }

  async function saveAssets(ask) {
    toast(browser(), "Collecting images, SVGs and fonts…");
    const a = await ask("Assets");
    if (!a) throw new Error("The page didn't answer");
    const dir = await folder(`${a.host} ${stamp()}`);
    const name = namer();
    let saved = { images: 0, svgs: 0, fonts: 0 };
    const fetchTo = async (url, sub, kind) => {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) return;
        const type = res.headers.get("content-type") ?? "";
        await IOUtils.makeDirectory(PathUtils.join(dir, sub), { ignoreExisting: true });
        await IOUtils.write(PathUtils.join(dir, sub, name(url, type)), new Uint8Array(await res.arrayBuffer()));
        saved[kind]++;
      } catch {}
    };
    // A few at a time, so a big page doesn't open hundreds of connections at once
    const queue = [...a.images.map(u => [u, "Images", "images"]), ...a.fonts.map(u => [u, "Fonts", "fonts"])];
    await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await fetchTo(...queue.shift()); }));
    if (a.svgs.length) await IOUtils.makeDirectory(PathUtils.join(dir, "SVGs"), { ignoreExisting: true });
    for (const [i, svg] of a.svgs.entries()) {
      await IOUtils.writeUTF8(PathUtils.join(dir, "SVGs", `svg-${i + 1}.svg`), svg);
      saved.svgs++;
    }
    const parts = [[saved.images, "image"], [saved.svgs, "SVG"], [saved.fonts, "font"]].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
    toast(browser(), parts.length ? `Saved ${parts.join(", ")} to Downloads\\Fjord` : "Nothing to save on this page.",
      parts.length ? ["Show folder", reveal(dir)] : null);
  }

  // The whole page, drawn by Firefox at up to 2x, capped so very long pages stay within image size limits
  async function screenshot(ask) {
    const size = await ask("PageSize");
    if (!size) throw new Error("The page didn't answer");
    const { width, height } = size;
    const scale = Math.min(window.devicePixelRatio || 1, 2, 16000 / height, 16000 / width);
    const bitmap = await browser().browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(0, 0, width, height), scale, "white");
    const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
    const dir = await folder("Screenshots");
    const file = PathUtils.join(dir, `${browser().currentURI.host || "page"} ${stamp()}.png`);
    await IOUtils.write(file, new Uint8Array(await blob.arrayBuffer()));
    toast(browser(), "Saved a full-page screenshot", ["Show", reveal(file)]);
  }

  // Colour picker: a still of the visible page goes over the tab; the colour under the pointer shows next to it, and a
  // click copies it as hex. Esc cancels.
  async function pickColour() {
    panel.hidePopup();
    const b = browser(), wg = b.browsingContext.currentWindowGlobal;
    if (!wg) return;
    const bitmap = await wg.drawSnapshot(null, window.devicePixelRatio || 1, "white");
    const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const swatch = h("i"), code = h("b");
    const lens = h("div", { class: "ns-picker-lens" }, swatch, code);
    const layer = h("div", { class: "ns-picker", tabindex: "0", role: "application", "aria-label": "Colour picker. Click to copy a colour, Esc to cancel." }, canvas, lens);
    const colourAt = e => {
      const r = canvas.getBoundingClientRect();
      const x = Math.floor((e.clientX - r.left) * canvas.width / r.width), y = Math.floor((e.clientY - r.top) * canvas.height / r.height);
      const [red, green, blue] = ctx.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data;
      return "#" + [red, green, blue].map(v => v.toString(16).padStart(2, "0")).join("");
    };
    layer.addEventListener("mousemove", e => {
      const hex = colourAt(e), r = layer.getBoundingClientRect();
      swatch.style.background = hex;
      code.textContent = hex;
      lens.style.left = `${Math.min(e.clientX - r.left + 16, r.width - 130)}px`;
      lens.style.top = `${Math.min(e.clientY - r.top + 16, r.height - 44)}px`;
    });
    layer.addEventListener("click", e => {
      const hex = colourAt(e);
      Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(hex);
      layer.remove();
      toast(b, `Copied ${hex}`);
    });
    layer.addEventListener("keydown", e => { if (e.key === "Escape") layer.remove(); });
    b.parentElement.append(layer);
    layer.focus();
  }

  const TOOLS = [
    ["design-colour", "Pick a colour", "Click anywhere on the page to copy its colour.", pickColour],
    ["design-font", "What font is this?", "Click any text to see its font, size and colour.", needsPage(ask => ask("PickFont"))],
    ["design-assets", "Save images, SVGs and fonts", "Everything on this page, into a folder in Downloads.", needsPage(saveAssets)],
    ["design-screenshot", "Screenshot the whole page", "The full length of the page as a PNG, not just what's on screen.", needsPage(screenshot)],
  ];
  Fjord.openDesignPanel = anchor => {
    panel.replaceChildren(h("div", { class: "ns-shields ns-design" }, h("b", { class: "ns-design-title" }, "Design tools"),
      ...TOOLS.map(([icon, label, desc, fn]) => {
        const b = h("button", { class: "ns-design-tool" }, h("img", { class: "ns-icon", src: `${ART}${icon}.svg`, alt: "" }),
          h("span", {}, h("b", {}, label), h("span", {}, desc)));
        b.addEventListener("click", fn);
        return b;
      })));
    panel.openPopup(anchor, "bottomright topright");
  };

  Fjord.sections.design = {
    label: "Design tools", after: "sidebar",
    desc: "Colours, fonts, images and screenshots from any page, from the toolbar.",
    keys: "design tools eyedropper colour color picker font images svg assets screenshot full page designer",
    render: ({ reopen }) => [
      h("div", { class: "ns-group" }, switchRow("Show the design tools button", "In the toolbar, next to the address bar.",
        !!CustomizableUI.getPlacementOfWidget(WIDGET),
        on => { on ? CustomizableUI.addWidgetToArea(WIDGET, CustomizableUI.AREA_NAVBAR) : CustomizableUI.removeWidgetFromArea(WIDGET); reopen(); })),
      h("h3", {}, "What's in it"),
      h("div", { class: "ns-group" }, ...TOOLS.map(([, label, desc]) => h("div", { class: "ns-list-row" }, h("span", {}, h("b", {}, label), h("span", { class: "ns-quiet" }, ` · ${desc}`))))),
      h("p", { class: "ns-quiet ns-note" }, "Saved files go to Downloads\\Fjord. Fonts and images belong to their makers: check the licence before you use them."),
    ],
  };
})();
