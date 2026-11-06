// Sync with Fjord on an iPhone, straight over the home network: no account, no cloud, nothing through the internet.
// Pairing (features/sync.js) shows a QR code holding a new random key; the iPhone then connects to this computer on
// the local network, and every message both ways is encrypted and signed with that key (AES-GCM), so anything that
// can't be opened with a paired device's key is dropped. A sync is one request from the iPhone (its history since the
// last sync, its open tabs and hidden page parts) and one answer (this computer's history since the iPhone last heard,
// bookmarks, open tabs and hidden parts). History is neither sent nor taken in while it isn't kept here (history off,
// or Ghost mode clearing it when Fjord closes). Private windows and Mist tabs are never sent.
// Messages: [4-byte length] [16-byte device id] [12-byte nonce] [ciphertext + tag], the id as additional data;
// answers are [4-byte length] [12-byte nonce] [ciphertext + tag]. The same as Sync.swift on the iPhone.
import { PlacesUtils } from "resource://gre/modules/PlacesUtils.sys.mjs";
import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";
import * as hidden from "resource://fjord/hidden.sys.mjs";
import { isMist } from "resource://fjord/mist.sys.mjs";

const PORT = 47130; // the iPhone looks for Fjord on this port when the computer's address has changed
const PREF = "fjord.sync.devices";
const TABS = PathUtils.join(PathUtils.profileDir, "fjord-sync-tabs.json"); // the paired devices' open tabs
const MAX = 32 << 20;
const FIRST = 90 * 86400e3; // a first sync brings the last 90 days of history
const STALE = 10 * 60e3;   // requests older than this are refused, so a recorded one can't be replayed later

const pref = (name, fallback) => Services.prefs.getBoolPref(name, fallback);
const keepsHistory = () => pref("places.history.enabled", true) &&
  !(pref("privacy.sanitize.sanitizeOnShutdown", false) && pref("privacy.clearOnShutdown_v2.browsingHistoryAndDownloads", false));
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const fromHex = s => new Uint8Array(s.match(/../g).map(b => parseInt(b, 16)));
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const changed = () => Services.obs.notifyObservers(null, "fjord-sync-changed");

// ---------- Paired devices ----------
let devices = [];
try { devices = JSON.parse(Services.prefs.getStringPref(PREF, "[]")); } catch {}
const saveDevices = () => Services.prefs.setStringPref(PREF, JSON.stringify(devices));
let pending = null; // the pairing whose QR code is showing: { id, key, until }
let remoteTabs = {};
IOUtils.readJSON(TABS).then(j => { remoteTabs = j ?? {}; changed(); }, () => {});
const saveTabs = () => IOUtils.writeJSON(TABS, remoteTabs, { tmpPath: TABS + ".tmp" }).catch(console.error);

export const paired = () => devices.map(({ id, name, paired, lastSync }) => ({ id, name, paired, lastSync, tabs: remoteTabs[id] ?? [] }));
export function unpair(id) {
  devices = devices.filter(d => d.id !== id);
  delete remoteTabs[id];
  saveDevices();
  saveTabs();
  if (!devices.length && !pending) stop();
  changed();
}

// What the QR code says: fjord-sync:1?i=<id>&k=<key>&p=<port>&a=<addresses>&n=<name>. Valid for 10 minutes.
export async function startPairing() {
  start();
  if (!server) throw new Error("Fjord couldn't listen on the network");
  pending = { id: hex(crypto.getRandomValues(new Uint8Array(16))), key: b64url(crypto.getRandomValues(new Uint8Array(32))),
    until: Date.now() + STALE };
  const q = new URLSearchParams({ i: pending.id, k: pending.key, p: port, a: (await addresses()).join(","), n: computerName() });
  return `fjord-sync:1?${q}`;
}
export function cancelPairing() {
  pending = null;
  if (!devices.length) stop();
}

// The computer's network name, made readable: "Eliass-MacBook-Neo-8.local" becomes "Eliass MacBook Neo"
function computerName() {
  const host = Services.dns.myHostName.replace(/\.(local|lan|home)$/i, "").replace(/-\d+$/, "").replace(/[-_]+/g, " ").trim();
  return host || "Your computer";
}

// This computer's addresses on the home network, so the iPhone can usually connect straight away
async function addresses() {
  try {
    const rec = await new Promise((resolve, reject) => Services.dns.asyncResolve(Services.dns.myHostName,
      Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT, Ci.nsIDNSService.RESOLVE_DISABLE_IPV6 | Ci.nsIDNSService.RESOLVE_DISABLE_TRR, null,
      { onLookupComplete: (req, r, status) => Components.isSuccessCode(status) ? resolve(r.QueryInterface(Ci.nsIDNSAddrRecord)) : reject(status) },
      Services.tm.mainThread, {}));
    const out = [];
    while (rec.hasMore()) {
      const a = rec.getNextAddrAsString();
      if (/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a) && !out.includes(a)) out.push(a);
    }
    return out;
  } catch {
    return [];
  }
}

// ---------- The listener ----------
let server = null, port = 0;
function start() {
  for (let p = PORT; !server && p < PORT + 10; p++) {
    try {
      const s = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
      s.init(p, false, -1);
      s.asyncListen({ onSocketAccepted: (_, t) => accept(t), onStopListening() {} });
      server = s;
      port = p;
    } catch {}
  }
}
function stop() {
  server?.close();
  server = null;
}
if (devices.length) start();

async function accept(transport) {
  transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_READ_WRITE, 30);
  const input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
  const output = transport.openOutputStream(Ci.nsITransport.OPEN_BLOCKING, 0, 0);
  const reader = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
  reader.setInputStream(input);
  try {
    const size = new DataView((await read(input, reader, 4)).buffer).getUint32(0);
    if (size < 28 + 16 || size > MAX) throw new Error("not a Fjord message");
    const reply = await handle(await read(input, reader, size));
    const writer = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
    writer.setOutputStream(output);
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, reply.length);
    writer.writeByteArray(head);
    writer.writeByteArray(reply);
  } catch (e) {
    console.warn("Fjord sync:", e.message ?? e);
  } finally {
    input.close();
    output.close();
  }
}

function read(input, reader, n) {
  const out = new Uint8Array(n);
  let got = 0;
  return new Promise((resolve, reject) => {
    const wait = () => input.asyncWait({
      onInputStreamReady() {
        try {
          const ready = Math.min(input.available(), n - got);
          if (ready) {
            out.set(reader.readByteArray(ready), got);
            got += ready;
          }
          if (got === n) resolve(out); else wait();
        } catch (e) {
          reject(e); // the connection closed early
        }
      },
    }, 0, 0, Services.tm.mainThread);
    wait();
  });
}

async function cryptoKey(key) {
  return crypto.subtle.importKey("raw", fromB64url(key), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function handle(frame) {
  const idBytes = frame.slice(0, 16), id = hex(idBytes);
  const device = devices.find(d => d.id === id) ?? (pending?.id === id && pending.until > Date.now() ? pending : null);
  if (!device) throw new Error("not a paired device");
  const key = await cryptoKey(device.key);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: frame.slice(16, 28), additionalData: idBytes }, key, frame.slice(28));
  const m = JSON.parse(new TextDecoder().decode(plain));
  if (m.v !== 1 || !(Math.abs(Date.now() - m.t) < STALE)) throw new Error("an old or unknown request");

  if (device === pending) { // the iPhone that scanned the QR code: paired from now on
    devices.push({ id, key: device.key, name: "iPhone", paired: Date.now(), lastSync: 0 });
    pending = null;
    saveDevices();
  }
  const answer = await exchange(devices.find(d => d.id === id), m);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: idBytes }, key,
    new TextEncoder().encode(JSON.stringify(answer))));
  const reply = new Uint8Array(12 + sealed.length);
  reply.set(iv);
  reply.set(sealed, 12);
  return reply;
}

// ---------- What's exchanged ----------
const page = v => typeof v?.url === "string" && /^https?:\/\//.test(v.url) && v.url.length < 4096;
const text = (s, max = 300) => typeof s === "string" ? s.slice(0, max) : "";

async function exchange(device, m) {
  const keep = keepsHistory();
  // What this computer has, worked out before the iPhone's visits are added, so they don't come straight back
  const answer = { v: 1, name: computerName(), now: Date.now(), history: keep ? await historySince(Number(m.since) || 0) : [],
    bookmarks: await bookmarks(), tabs: openTabs(), hidden: hidden.selectors() };

  const visits = Array.isArray(m.history) ? m.history.filter(page).slice(0, 5000) : [];
  if (keep && visits.length) {
    await PlacesUtils.history.insertMany(visits.map(v => ({ url: v.url, title: text(v.title) || undefined,
      visits: [{ date: new Date(Math.min(Number(v.time) || Date.now(), Date.now())), transition: PlacesUtils.history.TRANSITIONS.LINK }] })))
      .catch(e => console.warn("Fjord sync history:", e.message));
  }
  for (const [site, list] of Object.entries(m.hidden ?? {}).slice(0, 2000)) {
    if (!Array.isArray(list)) continue;
    for (const selector of list.slice(0, 50)) if (typeof selector === "string" && selector.length < 1000) hidden.add(text(site, 253), selector, false);
  }
  remoteTabs[device.id] = Array.isArray(m.tabs) ? m.tabs.filter(page).slice(0, 500).map(t => ({ url: t.url, title: text(t.title) })) : [];
  device.name = text(m.name, 60) || device.name;
  device.lastSync = Date.now();
  saveDevices();
  saveTabs();
  changed();
  return answer;
}

// Web pages only (substr, as Places' SQLite takes LIKE only with a bound pattern)
async function historySince(since) {
  const db = await PlacesUtils.promiseDBConnection();
  const rows = await db.executeCached(`
    SELECT h.url, h.title, MAX(v.visit_date) AS last
    FROM moz_historyvisits v JOIN moz_places h ON h.id = v.place_id
    WHERE v.visit_date > :since AND substr(h.url, 1, 4) = 'http'
    GROUP BY h.id ORDER BY last DESC LIMIT 3000`, { since: Math.max(since, Date.now() - FIRST) * 1000 });
  return rows.map(r => ({ url: r.getResultByName("url"), title: r.getResultByName("title") ?? "", time: Math.round(r.getResultByName("last") / 1000) }));
}

async function bookmarks() {
  const db = await PlacesUtils.promiseDBConnection();
  const rows = await db.executeCached(`
    SELECT h.url, IFNULL(b.title, h.title) AS title FROM moz_bookmarks b JOIN moz_places h ON h.id = b.fk
    WHERE b.type = 1 AND substr(h.url, 1, 4) = 'http' ORDER BY b.lastModified DESC LIMIT 5000`);
  return rows.map(r => ({ url: r.getResultByName("url"), title: r.getResultByName("title") ?? "" }));
}

function openTabs() {
  const out = [];
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (PrivateBrowsingUtils.isWindowPrivate(win)) continue;
    for (const tab of win.gBrowser.tabs) {
      if (isMist(tab.userContextId)) continue;
      const url = tab.linkedBrowser.currentURI.spec;
      if (/^https?:\/\//.test(url)) out.push({ url, title: tab.label });
    }
  }
  return out.slice(0, 500);
}
