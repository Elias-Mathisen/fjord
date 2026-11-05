// Fjord's private YouTube player: YouTube videos open in YouTube's own privacy-enhanced player (youtube-nocookie.com)
// on its own, without recommendations, comments, personalised ads or your YouTube history. Full page loads are
// caught before they reach YouTube (privacy.sys.mjs); videos opened inside YouTube's page by features/youtube.js.
// The player's own "Watch on YouTube" opens real YouTube, and that tab stays on YouTube.
const PLAYER = "fjord.youtube.player";
const SYSTEM = () => Services.scriptSecurityManager.getSystemPrincipal();

export const enabled = () => Services.prefs.getBoolPref(PLAYER, false);
export function setEnabled(on) {
  Services.prefs.setBoolPref(PLAYER, on);
  // You chose to watch, so the player may start without a click (Firefox otherwise blocks sound until you click)
  const principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin("https://www.youtube-nocookie.com");
  if (on) Services.perms.addFromPrincipal(principal, "autoplay-media", Ci.nsIPermissionManager.ALLOW_ACTION);
  else Services.perms.removeFromPrincipal(principal, "autoplay-media");
}

// Tabs where you picked YouTube itself (browserIds); they stay on YouTube until they leave it
export const onYouTube = new Set();

// { id, start } for a YouTube video address, or null
export function videoOf(uri) {
  let url;
  try { url = new URL(uri.spec ?? uri); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^(www|m)\./, "");
  let id = null;
  if (host === "youtube.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else id = /^\/(?:shorts|live|embed)\/([\w-]{11})/.exec(url.pathname)?.[1];
  } else if (host === "youtu.be") {
    id = /^\/([\w-]{11})/.exec(url.pathname)?.[1];
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  // t=90, t=90s or t=1m30s
  const t = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(url.searchParams.get("t") ?? url.searchParams.get("start") ?? "");
  const start = t ? (+t[1] || 0) * 3600 + (+t[2] || 0) * 60 + (+t[3] || 0) : 0;
  return { id, start };
}

// YouTube's player refuses to play without a referrer ("Error 153"); its documentation asks apps to name themselves
const referrer = () => {
  const info = Cc["@mozilla.org/referrer-info;1"].createInstance(Ci.nsIReferrerInfo);
  info.init(Ci.nsIReferrerInfo.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, true, Services.io.newURI("https://io.github.eliasmathisen.fjord/"));
  return info;
};

// replace: the YouTube page already took the tab's place in its history (a video opened inside YouTube), so Back
// skips it
export function play(browser, { id, start }, replace = false) {
  const url = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0${start ? `&start=${start}` : ""}`;
  browser.fixupAndLoadURIString(url, {
    triggeringPrincipal: SYSTEM(),
    referrerInfo: referrer(),
    loadFlags: replace ? Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY : 0,
  });
}

// A page load about to start: true when it's a video that should open in the player instead
export function catches(uri, loadInfo, browserId) {
  if (!enabled() || onYouTube.has(browserId) || !videoOf(uri)) return false;
  const by = loadInfo.triggeringPrincipal;
  if (by?.isContentPrincipal && /(^|\.)youtube-nocookie\.com$/.test(by.host)) {
    onYouTube.add(browserId); // the player's own "Watch on YouTube"
    return false;
  }
  return true;
}
