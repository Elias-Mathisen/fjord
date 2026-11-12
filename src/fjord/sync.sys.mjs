// Sync with Fjord on an iPhone, straight over the home network: no account, no cloud, nothing through the internet.
// Pairing (features/sync.js) shows a QR code holding a new random key; the iPhone then connects to this computer on
// the local network, and every message both ways is encrypted and signed with that key (AES-GCM), so anything that
// can't be opened with a paired device's key is dropped. A sync is one request from the iPhone (its history since the
// last sync, its open tabs and hidden page parts) and one answer (this computer's history since the iPhone last heard,
// bookmarks, open tabs and hidden parts). History is neither sent nor taken in while it isn't kept here (history off,
// or Ghost mode clearing it when Fjord closes). Private windows and Mist tabs are never sent.
// Messages: [4-byte length] [16-byte device id] [12-byte nonce] [ciphertext + tag], the id as additional data;
// answers are [4-byte length] [12-byte nonce] [ciphertext + tag]. The same as Sync.swift on the iPhone.
//
// Away from home, through a folder you choose (iCloud Drive, Dropbox, OneDrive, a USB stick): each device writes only
// its own file, <folder>/Fjord Sync/<pairing id>/<device id>.fjord, sealed with the pairing's key, and reads the
// other's. The folder's owner sees only scrambled files. Another computer pairs by pasting the pairing code; two
// computers also share passwords (unless switched off) and Fjord's settings. Pairing keys made from now on are
// locked with the system's own key store (OSKeyStore), like Fjord's saved passwords, not written out plainly.
import { PlacesUtils } from "resource://gre/modules/PlacesUtils.sys.mjs";
import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";
import { OSKeyStore } from "resource://gre/modules/OSKeyStore.sys.mjs";
import { setInterval } from "resource://gre/modules/Timer.sys.mjs";
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
// { id, kind: "iphone" | "computer", sealed (the key, locked; older pairings: key), name, paired, lastSync,
//   passwords (computers), seen: { device id: when its file was last read } }
let devices = [];
try { devices = JSON.parse(Services.prefs.getStringPref(PREF, "[]")); } catch {}
const saveDevices = () => Services.prefs.setStringPref(PREF, JSON.stringify(devices));
let pending = null; // the pairing whose QR code is showing: { id, key, until }
let remoteTabs = {};
IOUtils.readJSON(TABS).then(j => { remoteTabs = j ?? {}; changed(); }, () => {});
const saveTabs = () => IOUtils.writeJSON(TABS, remoteTabs, { tmpPath: TABS + ".tmp" }).catch(console.error);

const keys = new Map(); // pairing id -> key, once unlocked
async function keyOf(device) {
  if (device.key) return device.key;
  if (!keys.has(device.id)) keys.set(device.id, await OSKeyStore.decrypt(device.sealed, "fjord-sync"));
  return keys.get(device.id);
}
async function addDevice(id, key, fields) {
  keys.set(id, key);
  devices.push({ id, sealed: await OSKeyStore.encrypt(key), paired: Date.now(), lastSync: 0, seen: {}, ...fields });
  saveDevices();
}

export const paired = () => devices.map(({ id, kind, name, paired, lastSync, passwords }) =>
  ({ id, kind: kind ?? "iphone", name, paired, lastSync, passwords: !!passwords, tabs: remoteTabs[id] ?? [] }));
export function unpair(id) {
  const folder = folderPath();
  if (folder) IOUtils.remove(groupDir(folder, id), { recursive: true, ignoreAbsent: true }).catch(console.error);
  devices = devices.filter(d => d.id !== id);
  delete remoteTabs[id];
  keys.delete(id);
  saveDevices();
  saveTabs();
  if (!devices.some(d => (d.kind ?? "iphone") === "iphone") && !pending) stop();
  changed();
}
export function setPasswords(id, on) {
  const d = devices.find(x => x.id === id);
  if (!d) return;
  d.passwords = on;
  saveDevices();
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
  if (!devices.some(d => (d.kind ?? "iphone") === "iphone")) stop();
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
if (devices.some(d => (d.kind ?? "iphone") === "iphone")) start();

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
  const device = devices.find(d => d.id === id && (d.kind ?? "iphone") === "iphone") ?? (pending?.id === id && pending.until > Date.now() ? pending : null);
  if (!device) throw new Error("not a paired device");
  const key = await cryptoKey(await keyOf(device));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: frame.slice(16, 28), additionalData: idBytes }, key, frame.slice(28));
  const m = JSON.parse(new TextDecoder().decode(plain));
  if (m.v !== 1 || !(Math.abs(Date.now() - m.t) < STALE)) throw new Error("an old or unknown request");

  if (device === pending) { // the iPhone that scanned the QR code: paired from now on
    pending = null;
    await addDevice(id, device.key, { kind: "iphone", name: "iPhone" });
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
  // What this computer has, worked out before the iPhone's visits are added, so they don't come straight back
  const answer = { v: 1, name: computerName(), now: Date.now(), history: keepsHistory() ? await historySince(Number(m.since) || 0) : [],
    bookmarks: await bookmarks(), tabs: openTabs(), hidden: hidden.selectors() };
  await takeIn(device, m);
  return answer;
}

// What another device sent, over the Wi-Fi or in its file. Visits already here (same page, same second) are skipped,
// so reading the same file twice, or getting back what this computer sent, adds nothing.
async function takeIn(device, m) {
  const visits = Array.isArray(m.history) ? m.history.filter(page).slice(0, 5000) : [];
  if (keepsHistory() && visits.length) {
    const fresh = await newVisits(visits);
    if (fresh.length) await PlacesUtils.history.insertMany(fresh.map(v => ({ url: v.url, title: text(v.title) || undefined,
      visits: [{ date: new Date(Math.min(Number(v.time) || Date.now(), Date.now())), transition: PlacesUtils.history.TRANSITIONS.LINK }] })))
      .catch(e => console.warn("Fjord sync history:", e.message));
  }
  for (const [site, list] of Object.entries(m.hidden ?? {}).slice(0, 2000)) {
    if (!Array.isArray(list)) continue;
    for (const selector of list.slice(0, 50)) if (typeof selector === "string" && selector.length < 1000) hidden.add(text(site, 253), selector, false);
  }
  if (device.kind === "computer") {
    takeSettings(m.settings);
    if (device.passwords) await takeLogins(m.logins).catch(e => console.warn("Fjord sync passwords:", e.message));
  }
  remoteTabs[device.id] = Array.isArray(m.tabs) ? m.tabs.filter(page).slice(0, 500).map(t => ({ url: t.url, title: text(t.title) })) : [];
  device.name = text(m.name, 60) || device.name;
  device.lastSync = Date.now();
  saveDevices();
  saveTabs();
  changed();
}

async function newVisits(visits) {
  const from = Math.min(...visits.map(v => Number(v.time) || Date.now()));
  const db = await PlacesUtils.promiseDBConnection();
  const rows = await db.executeCached(`SELECT h.url, v.visit_date FROM moz_historyvisits v JOIN moz_places h ON h.id = v.place_id
    WHERE v.visit_date >= :from`, { from: (from - 1000) * 1000 });
  const have = new Set(rows.map(r => `${Math.round(r.getResultByName("visit_date") / 1e6)} ${r.getResultByName("url")}`));
  return visits.filter(v => !have.has(`${Math.round(Number(v.time) / 1000)} ${v.url}`));
}

// ---------- Passwords (between computers) ----------
// Added when new, and changed when the other computer changed it more recently. Only while they're unlocked here,
// so syncing never asks for the Primary Password.
// shortcut: a password deleted on one computer stays on the other; sync deletions when someone asks for it.
const loginInfo = (...args) => { const l = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo); l.init(...args); return l; };
const loginKey = (origin, realm, user) => `${origin}\n${realm ?? ""}\n${user}`;
async function logins() {
  if (!Services.logins.isLoggedIn) return undefined;
  return (await Services.logins.getAllLogins()).filter(l => /^https?:\/\//.test(l.origin)).map(l => {
    l.QueryInterface(Ci.nsILoginMetaInfo);
    return { origin: l.origin, action: l.formActionOrigin, realm: l.httpRealm, user: l.username, pass: l.password,
      userField: l.usernameField, passField: l.passwordField, changed: l.timePasswordChanged };
  });
}
async function takeLogins(list) {
  if (!Array.isArray(list) || !Services.logins.isLoggedIn) return;
  const mine = new Map((await Services.logins.getAllLogins()).map(l => [loginKey(l.origin, l.httpRealm, l.username), l]));
  for (const r of list.slice(0, 10000)) {
    if (!/^https?:\/\/[^/]+$/.test(r?.origin ?? "") || typeof r.user !== "string" || typeof r.pass !== "string" || !r.pass) continue;
    const old = mine.get(loginKey(r.origin, r.realm, r.user));
    if (old) {
      old.QueryInterface(Ci.nsILoginMetaInfo);
      if (old.password === r.pass || !(Number(r.changed) > old.timePasswordChanged)) continue;
      const bag = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag);
      bag.setProperty("password", r.pass);
      bag.setProperty("timePasswordChanged", Number(r.changed));
      await Services.logins.modifyLoginAsync(old, bag);
    } else {
      const realm = typeof r.realm === "string" && r.realm ? text(r.realm) : null;
      await Services.logins.addLoginAsync(loginInfo(r.origin, realm ? null : (typeof r.action === "string" ? r.action : ""), realm,
        r.user, r.pass, text(r.userField), text(r.passField)));
    }
  }
}

// ---------- Settings (between computers) ----------
// Fjord's own settings that mean the same on any computer; whichever computer changed one last wins
const SETTINGS = ["fjord.theme", "fjord.calm.off", "fjord.clipboardGuard.enabled", "fjord.debounce.enabled", "fjord.glance.enabled",
  "fjord.lookalike.enabled", "fjord.commandBar.enabled", "fjord.fingerprint.randomise", "fjord.newtab.blocked", "fjord.newtab.clock",
  "fjord.newtab.data", "fjord.newtab.photos", "fjord.newtab.time", "fjord.newtab.week", "fjord.memorySaver.enabled",
  "fjord.memorySaver.minutes", "fjord.memorySaver.awake"];
const SETTINGS_CHANGED = "fjord.sync.settingsChanged";
let takingSettings = false;
for (const name of SETTINGS) Services.prefs.addObserver(name, () => {
  if (!takingSettings) Services.prefs.setStringPref(SETTINGS_CHANGED, String(Date.now()));
});
function settings() {
  const values = {};
  for (const name of SETTINGS) {
    const t = Services.prefs.getPrefType(name);
    values[name] = !Services.prefs.prefHasUserValue(name) ? null : t === Services.prefs.PREF_BOOL ? Services.prefs.getBoolPref(name)
      : t === Services.prefs.PREF_INT ? Services.prefs.getIntPref(name) : Services.prefs.getStringPref(name);
  }
  return { changed: Number(Services.prefs.getStringPref(SETTINGS_CHANGED, "0")), values };
}
function takeSettings(s) {
  if (!(Number(s?.changed) > Number(Services.prefs.getStringPref(SETTINGS_CHANGED, "0"))) || typeof s.values !== "object") return;
  takingSettings = true;
  try {
    for (const name of SETTINGS) {
      if (!(name in s.values)) continue;
      const v = s.values[name];
      if (v === null) Services.prefs.clearUserPref(name);
      else if (typeof v === "boolean") Services.prefs.setBoolPref(name, v);
      else if (Number.isInteger(v)) Services.prefs.setIntPref(name, v);
      else if (typeof v === "string") Services.prefs.setStringPref(name, v.slice(0, 5000));
    }
    Services.prefs.setStringPref(SETTINGS_CHANGED, String(s.changed));
  } finally {
    takingSettings = false;
  }
  const theme = Services.prefs.getStringPref("fjord.theme", "dark");
  for (const win of Services.wm.getEnumerator("navigator:browser")) win.Fjord?.applyTheme?.(theme);
}

// ---------- Through a folder ----------
const FOLDER = "fjord.sync.folder", ME = "fjord.sync.me";
const MAGIC = [0x46, 0x4a, 0x53, 0x31]; // "FJS1"
const folderPath = () => Services.prefs.getStringPref(FOLDER, "");
const groupDir = (folder, id) => PathUtils.join(folder, "Fjord Sync", id);
function me() {
  let id = Services.prefs.getStringPref(ME, "");
  if (!/^[0-9a-f]{32}$/.test(id)) Services.prefs.setStringPref(ME, id = hex(crypto.getRandomValues(new Uint8Array(16))));
  return id;
}
const together = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

// A file: "FJS1" [12-byte nonce] [ciphertext + tag], with the pairing id and the writer's id as additional data, so a
// file can't be passed off as another device's or another pairing's
async function seal(key, group, member, m) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: together(fromHex(group), fromHex(member)) },
    await cryptoKey(key), new TextEncoder().encode(JSON.stringify(m))));
  return together(together(new Uint8Array(MAGIC), iv), sealed);
}
async function unseal(key, group, member, bytes) {
  if (bytes.length < 4 + 12 + 16 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error("not a Fjord sync file");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(4, 16), additionalData: together(fromHex(group), fromHex(member)) },
    await cryptoKey(key), bytes.slice(16));
  return JSON.parse(new TextDecoder().decode(plain));
}

// What this computer writes for one pairing: the iPhone gets bookmarks to show; another computer settings and passwords
async function snapshot(device) {
  const m = { v: 1, from: me(), kind: "computer", name: computerName(), now: Date.now(),
    history: keepsHistory() ? await historySince(0) : [], tabs: openTabs(), hidden: hidden.selectors() };
  if (device.kind === "computer") {
    m.settings = settings();
    if (device.passwords) m.logins = await logins();
  } else {
    m.bookmarks = await bookmarks();
  }
  return m;
}

const written = new Map(); // pairing id -> what was last written (without its time), so an unchanged file isn't rewritten
async function writeOwn(folder, device) {
  const m = await snapshot(device);
  const same = JSON.stringify({ ...m, now: 0 });
  const file = PathUtils.join(groupDir(folder, device.id), `${me()}.fjord`);
  if (written.get(device.id) === same && await IOUtils.exists(file)) return;
  await IOUtils.makeDirectory(groupDir(folder, device.id), { createAncestors: true, ignoreExisting: true });
  await IOUtils.write(file, await seal(await keyOf(device), device.id, me(), m), { tmpPath: file + ".tmp" });
  written.set(device.id, same);
}

// The other devices' files in one pairing's folder that changed since they were last read
async function readOthers(folder, group, key, seen) {
  let paths;
  try { paths = await IOUtils.getChildren(groupDir(folder, group)); } catch { return []; }
  const out = [];
  for (const path of paths) {
    const member = /^([0-9a-f]{32})\.fjord$/.exec(PathUtils.filename(path))?.[1];
    if (!member || member === me()) continue;
    try {
      const { lastModified } = await IOUtils.stat(path);
      if (seen[member] >= lastModified) continue;
      const m = await unseal(key, group, member, await IOUtils.read(path, { maxBytes: MAX }));
      if (m?.v === 1 && m.from === member) out.push({ member, lastModified, m });
    } catch (e) {
      console.warn("Fjord sync folder:", PathUtils.filename(path), e.message ?? e);
    }
  }
  return out;
}

let busy = false;
export async function syncFolder() {
  const folder = folderPath();
  if (!folder || busy) return;
  busy = true;
  try {
    // A device that used the pairing code from the folder's side (another computer, or an iPhone away from home)
    if (pending && pending.until > Date.now()) {
      const [first] = await readOthers(folder, pending.id, pending.key, {});
      if (first) {
        const { id, key } = pending;
        pending = null;
        await addDevice(id, key, { kind: first.m.kind === "computer" ? "computer" : "iphone", name: "Your other device",
          passwords: first.m.kind === "computer" });
      }
    }
    for (const device of [...devices]) {
      try {
        device.seen ??= {};
        for (const { member, lastModified, m } of await readOthers(folder, device.id, await keyOf(device), device.seen)) {
          await takeIn(device, m);
          device.seen[member] = lastModified;
          saveDevices();
        }
        await writeOwn(folder, device);
      } catch (e) {
        console.warn("Fjord sync folder:", device.name, e.message ?? e);
      }
    }
  } finally {
    busy = false;
  }
}
// Every minute, and every 10 seconds while a pairing code is waiting
let ticks = 0;
setInterval(() => {
  if (folderPath() && (devices.length || pending) && (pending || ++ticks % 6 === 0)) syncFolder().catch(console.error);
}, 10e3);

export const folder = () => folderPath() || null;
export async function setFolder(path) {
  const old = folderPath();
  // Leaving a folder takes this computer's files out of it, so nothing of it stays behind there
  if (old && old !== path) {
    for (const d of devices) await IOUtils.remove(PathUtils.join(groupDir(old, d.id), `${me()}.fjord`), { ignoreAbsent: true }).catch(console.error);
  }
  written.clear();
  for (const d of devices) d.seen = {};
  saveDevices();
  if (path) Services.prefs.setStringPref(FOLDER, path);
  else Services.prefs.clearUserPref(FOLDER);
  changed();
  if (path) await syncFolder();
}

// Another computer's pairing code, pasted here: paired through the folder, which both computers need to use
export async function join(code) {
  const q = new URLSearchParams(/^fjord-sync:1\?(.*)$/.exec(code.trim())?.[1] ?? "");
  const id = q.get("i") ?? "", key = q.get("k") ?? "";
  let raw = null;
  try { raw = fromB64url(key); } catch {}
  if (!/^[0-9a-f]{32}$/.test(id) || raw?.length !== 32) throw new Error("That isn't a Fjord pairing code.");
  if (!folderPath()) throw new Error("Choose the folder to sync through first. The other computer needs to use the same one.");
  if (devices.some(d => d.id === id)) throw new Error("This computer is already paired with that one.");
  await addDevice(id, key, { kind: "computer", name: text(q.get("n"), 60) || "Your other computer", passwords: true });
  changed();
  await syncFolder();
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
