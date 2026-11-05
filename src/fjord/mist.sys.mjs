// Mist tabs, once per session: each Mist tab gets a brand-new container (its own cookies and storage). When the last
// tab in it closes, the container, everything sites stored in it, and the pages it visited in history are deleted.
// Containers left over from a crash or from closing Fjord with Mist tabs open are deleted after the session restores.
import { ContextualIdentityService } from "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs";

const PREF = "fjord.mist.ids";
const ids = new Set(Services.prefs.getStringPref(PREF, "").split(",").filter(Boolean).map(Number));
const visited = new Map(); // userContextId -> Set of page addresses
const saveIds = () => Services.prefs.setStringPref(PREF, [...ids].join(","));

export const isMist = userContextId => ids.has(userContextId);

export function create() {
  const { userContextId } = ContextualIdentityService.create("Mist", "fingerprint", "toolbar");
  ids.add(userContextId);
  visited.set(userContextId, new Set());
  saveIds();
  return userContextId;
}

export function visit(userContextId, url) {
  if (ids.has(userContextId) && /^https?:/.test(url)) visited.get(userContextId)?.add(url);
}

// Called when a Mist tab closes: forgets the container once none of its tabs are left in any window
export async function maybeForget(userContextId) {
  if (!ids.has(userContextId)) return;
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (win.gBrowser.tabs.some(t => !t.closing && t.userContextId === userContextId)) return;
  }
  await forget(userContextId);
}

async function forget(userContextId) {
  ids.delete(userContextId);
  saveIds();
  const urls = [...(visited.get(userContextId) ?? [])];
  visited.delete(userContextId);
  ContextualIdentityService.closeContainerTabs(userContextId);
  await new Promise(resolve => Services.clearData.deleteDataFromOriginAttributesPattern({ userContextId }, resolve));
  ContextualIdentityService.remove(userContextId);
  if (urls.length) {
    const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
    await PlacesUtils.history.remove(urls).catch(() => {});
  }
}

// Leftovers from last time: their restored tabs close too
const leftovers = [...ids];
if (leftovers.length) {
  const cleanUp = () => {
    Services.obs.removeObserver(cleanUp, "sessionstore-windows-restored");
    for (const id of leftovers) forget(id).catch(console.error);
  };
  Services.obs.addObserver(cleanUp, "sessionstore-windows-restored");
}
