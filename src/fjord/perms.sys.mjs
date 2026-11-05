// Permission watch, once per session: which sites used your camera, microphone, screen, location or clipboard.
// Location and clipboard come from Fjord's page helper (page-frame.js, loaded into every tab here); camera,
// microphone and screen from Firefox's own sharing notices. Uses are kept in the profile (never from private
// windows) and each window shows a short notice. ask() is how the design tools talk to the page helper.
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const FILE = PathUtils.join(PathUtils.profileDir, "fjord-permissions.json");
const KEEP = 300;
let history = [];
const loaded = IOUtils.readJSON(FILE).then(j => { history = j.history ?? []; }, () => {});
const save = () => IOUtils.writeJSON(FILE, { history: history.slice(-KEEP) }, { tmpPath: FILE + ".tmp" }).catch(console.error);

Services.mm.loadFrameScript("resource://fjord/page-frame.js", true);
Services.mm.addMessageListener("Fjord:Permission", m => {
  if (m.data.host) recordUse(m.data.host, m.data.what, m.target, !!m.target.browsingContext?.usePrivateBrowsing);
});
// The clipboard hijack guard (page-frame.js): the tab's window shows the warning
Services.mm.addMessageListener("Fjord:ClipboardChanged", m => {
  m.target.ownerDocument?.defaultView?.Fjord?.clipboardWarning?.(m.target, m.data);
});
Services.mm.addMessageListener("Fjord:Copy", m => {
  Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(String(m.data.text));
});

// Ask the page in a tab for something ("Assets", "PageSize", "PickFont"); null if it doesn't answer in time
const waiting = new Map();
let nextId = 1;
Services.mm.addMessageListener("Fjord:Reply", m => {
  waiting.get(m.data.id)?.(m.data.result);
  waiting.delete(m.data.id);
});
export function ask(browser, name, timeout = 15000) {
  const id = nextId++;
  return new Promise(resolve => {
    waiting.set(id, resolve);
    browser.messageManager.sendAsyncMessage("Fjord:Ask", { id, name });
    setTimeout(() => { if (waiting.delete(id)) resolve(null); }, timeout);
  });
}

export const WHAT = {
  camera: "is using your camera",
  microphone: "is using your microphone",
  screen: "is sharing your screen",
  location: "asked for your location",
  clipboard: "tried to read your clipboard",
};

export async function recordUse(host, what, browser, isPrivate) {
  if (!WHAT[what]) return;
  if (!isPrivate) {
    await loaded;
    history.push({ t: Date.now(), host, what });
    if (history.length > KEEP) history = history.slice(-KEEP);
    save();
  }
  if (Services.prefs.getBoolPref("fjord.permissionWatch.notice", true)) browser?.ownerDocument?.defaultView?.Fjord?.permissionNotice?.(browser, host, what);
}

export async function recent(n = 40) {
  await loaded;
  return history.slice(-n).reverse();
}
export function clear() {
  history = [];
  save();
}

// Camera, microphone and screen: Firefox announces sharing changes; each new one is recorded once
const sharing = new Set();
Services.obs.addObserver(() => {
  const { webrtcUI } = ChromeUtils.importESModule("resource:///modules/webrtcUI.sys.mjs");
  const now = new Set();
  for (const s of webrtcUI.getActiveStreams(true, true, true)) {
    let host = "";
    try { host = Services.io.newURI(s.uri).host; } catch { continue; }
    for (const what of ["camera", "microphone", "screen"]) {
      if (!s[what] && !s.types?.[what] && !(what === "screen" && (s.window || s.application || s.browserWindow))) continue;
      const key = `${s.browser?.browserId}|${host}|${what}`;
      now.add(key);
      if (!sharing.has(key)) recordUse(host, what, s.browser, !!s.browser?.browsingContext?.usePrivateBrowsing);
    }
  }
  sharing.clear();
  for (const k of now) sharing.add(k);
}, "recording-device-events");
