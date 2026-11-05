// Fjord's bridge to uBlock Origin: reads its counts and settings straight from its storage.
// shortcut: depends on uBlock's storage keys (requestStats, selectedFilterLists, netWhitelist); re-check after big uBlock updates.
import { ExtensionStorageIDB } from "resource://gre/modules/ExtensionStorageIDB.sys.mjs";
import { extensionStorageSession } from "resource://gre/modules/ExtensionStorage.sys.mjs";
import { ExtensionParent } from "resource://gre/modules/ExtensionParent.sys.mjs";
import { AddonManager } from "resource://gre/modules/AddonManager.sys.mjs";

export const UBO = "uBlock0@raymondhill.net";
const EXTRA_LISTS = ["adguard-spyware-url", "curben-phishing", "block-lan", "fanboy-cookiemonster", "ublock-cookies-easylist"];
const WHITELIST_DEFAULT = ["chrome-extension-scheme", "moz-extension-scheme"]; // uBlock's own default

const extension = () => WebExtensionPolicy.getByID(UBO)?.extension;
const storage = ext => ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(ext));
// Restart uBlock so it reads what we wrote, instead of later overwriting it from memory
const restart = async () => (await AddonManager.getAddonByID(UBO))?.reload();

// "Blocked since install": storage.session is refreshed every ~23 s, storage.local every few minutes
export async function totalBlocked() {
  const ext = extension();
  if (!ext) return 0;
  // Session values are StructuredCloneHolders; keepData=true leaves uBlock's copy intact
  const live = (await extensionStorageSession.get(ext, ["requestStats"]))?.requestStats?.deserialize(globalThis, true);
  const stats = live ?? (await (await storage(ext)).get(["requestStats"])).requestStats;
  return stats?.blockedCount ?? 0;
}

// Requests blocked on a tab's current page: the number on uBlock's toolbar badge
export function pageBlocked(tab) {
  const ext = extension();
  if (!ext) return 0;
  try {
    return parseInt(ExtensionParent.apiManager.global.browserActionFor(ext).action.getProperty(tab, "badgeText"), 10) || 0;
  } catch {
    return 0;
  }
}

// Fjord's extra filter lists are added once; after that the list choices are the user's own.
// Resolves false while uBlock is still installing or hasn't picked its defaults yet.
export async function addExtraLists() {
  const ext = extension();
  const db = ext && await storage(ext);
  const lists = db && (await db.get(["selectedFilterLists"])).selectedFilterLists;
  if (!lists) return false;
  await db.set({ selectedFilterLists: [...new Set([...lists, ...EXTRA_LISTS])] });
  await restart();
  return true;
}

// Sites where uBlock is switched off (its "trusted sites" list)
async function whitelist() {
  const ext = extension();
  if (!ext) return null;
  const db = await storage(ext);
  let list = (await db.get(["netWhitelist"])).netWhitelist ?? WHITELIST_DEFAULT;
  if (typeof list === "string") list = list.split("\n");
  return { db, list };
}

export async function isTrusted(host) {
  return !!(await whitelist())?.list.includes(host);
}

// uBlock's per-site switches ("no-scripting: example.com true" turns JavaScript off there)
const SWITCHES_DEFAULT = "no-large-media: behind-the-scene false"; // uBlock's own default

// One site's uBlock rules: switched off entirely (trusted), and JavaScript off. One restart for both.
export async function setSiteRules(host, { trusted, noScripting }) {
  const wl = await whitelist();
  if (!wl) return;
  const list = trusted ? [...new Set([...wl.list, host])] : wl.list.filter(h => h !== host);
  const switches = ((await wl.db.get(["hostnameSwitchesString"])).hostnameSwitchesString ?? SWITCHES_DEFAULT)
    .split("\n").filter(l => l && !l.startsWith(`no-scripting: ${host} `));
  if (noScripting) switches.push(`no-scripting: ${host} true`);
  await wl.db.set({ netWhitelist: list, hostnameSwitchesString: switches.join("\n") });
  await restart();
}

export async function hasNoScripting(host) {
  const wl = await whitelist();
  const switches = wl && (await wl.db.get(["hostnameSwitchesString"])).hostnameSwitchesString;
  return !!switches?.split("\n").includes(`no-scripting: ${host} true`);
}
