// The "you're offline" page, when a site couldn't load because this computer has no network (page-frame.js decides):
// the ski jump game above Firefox's error card, and in the card Fjord's own drawing (illustrations/offline.jpg, a
// signal tower's lines running into a mountain) and words instead of Firefox's fox and text. The card's Try Again
// button stays Firefox's own.
import { startSkiJump } from "resource://fjord/skijump.sys.mjs";

export async function dressOfflinePage(win, { offlineMode, best, saveBest }) {
  const doc = win.document;
  const box = doc.createElement("div");
  box.style.cssText = "max-width: 600px; margin: 48px auto 0; padding: 0 24px;";
  doc.body.prepend(box);
  startSkiJump(win, box, { best, saveBest });

  // The card draws itself, and Firefox fills in its text, a moment after the page loads
  const card = await waitFor(win, () => {
    const root = doc.querySelector("net-error-card")?.shadowRoot;
    return root?.querySelector("#error-title")?.textContent && root.querySelector("img.no-connection") ? root : null;
  });
  if (!card) return;
  // The page only loads images from Firefox itself, so the drawing is decoded here and painted onto a canvas. Black ink
  // on white paper: multiplied into a light page, inverted to light lines and screened onto a dark one
  const img = card.querySelector("img.no-connection");
  const jpeg = await (await fetch("resource://fjord/illustrations/offline.jpg")).arrayBuffer();
  const drawing = await win.createImageBitmap(new win.Blob([Cu.cloneInto(jpeg, win)], { type: "image/jpeg" }));
  const canvas = doc.createElement("canvas");
  canvas.width = drawing.width;
  canvas.height = drawing.height;
  canvas.getContext("2d").drawImage(drawing, 0, 0);
  canvas.setAttribute("aria-hidden", "true");
  const dark = win.matchMedia("(prefers-color-scheme: dark)");
  // Try Again in Fjord's colours (chrome.css .ns-primary): near-white in dark mode, near-black in light. Firefox's
  // <moz-button> takes its colours from these properties
  const tryAgain = card.querySelector("#tryAgainButton");
  const theme = () => {
    canvas.style.cssText = "width: 280px; height: 210px; max-width: 100%; object-fit: contain;" +
      (dark.matches ? "filter: invert(1); mix-blend-mode: screen;" : "mix-blend-mode: multiply;");
    const [bg, hover, fg] = dark.matches ? ["#ededed", "#ffffff", "#1e1e20"] : ["#1d1d1f", "#3a3a3d", "#ffffff"];
    for (const [name, value] of Object.entries({
      "--button-background-color-primary": bg, "--button-background-color-primary-hover": hover,
      "--button-background-color-primary-active": hover, "--button-text-color-primary": fg,
      "--button-text-color-primary-hover": fg, "--button-text-color-primary-active": fg,
      "--button-border-color-primary": "transparent", "--button-border-radius": "11px", "--focus-outline-color": bg,
    })) tryAgain?.style.setProperty(name, value);
    // Its focus ring is drawn by the part inside, in Firefox's purple
    tryAgain?.shadowRoot?.querySelector(".button-background")?.style.setProperty("outline-color", bg);
  };
  theme();
  dark.addEventListener("change", theme);
  img.replaceWith(canvas);
  // Room between the drawing and the words (Firefox's fox had white space of its own)
  canvas.parentElement.style.marginInlineEnd = "56px";

  // Fjord's font, Geist (fonts/Geist-Variable.woff2), handed to the page as data for the same reason as the drawing
  try {
    const font = await (await fetch("resource://fjord/fonts/Geist-Variable.woff2")).arrayBuffer();
    const face = new win.FontFace("Geist", Cu.cloneInto(font, win), { weight: "100 900" });
    doc.fonts.add(await face.load());
    card.querySelector("article").style.fontFamily = '"Geist", system-ui, sans-serif';
  } catch (e) {
    Cu.reportError(e); // keeps Firefox's font
  }

  let host = "";
  try { host = new URL(new URLSearchParams(doc.documentURI.split("?")[1]).get("u")).hostname; } catch {}
  const say = (selector, ...parts) => {
    const el = card.querySelector(selector);
    if (!el) return;
    el.removeAttribute("data-l10n-id"); // else Firefox's translations write their text back
    el.removeAttribute("data-l10n-args");
    el.replaceChildren(...parts);
  };
  const strong = text => Object.assign(doc.createElement("strong"), { textContent: text });
  say("#error-title", "You're offline");
  say("#error-intro", ...(host ? ["Fjord can't reach ", strong(host)] : ["Fjord can't reach this site"]),
    offlineMode ? ", because it's set to work offline." : ", because this computer isn't connected to the internet.");
  say("h3", "What you can do");
  say("#whatCanYouDo", offlineMode ? "Press Try Again to go back online." : "Check your Wi-Fi or network cable, then press Try Again.",
    " Until then, there's the ski jump above: press Space.");
}

// Checks every 50 ms for up to 3 s
function waitFor(win, test) {
  return new Promise(done => {
    let tries = 0;
    const check = () => {
      const result = test();
      if (result || ++tries > 60) done(result);
      else win.setTimeout(check, 50);
    };
    check();
  });
}
