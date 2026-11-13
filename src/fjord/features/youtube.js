// The private YouTube player in each window (youtube.sys.mjs): videos opened inside YouTube's own page, which
// changes address without loading a new page, and the one-time offer the first time you watch something.
// Loaded into each window by browser.js.
(() => {
  const youtube = ChromeUtils.importESModule("resource://fjord/youtube.sys.mjs");
  const prefs = Services.prefs;
  const ASKED = "fjord.youtube.asked";
  const onYouTubeSite = uri => { try { return /(^|\.)(youtube\.com|youtu\.be)$/.test(uri.host); } catch { return false; } };
  const playerVideo = uri => { try { return uri.host === "www.youtube-nocookie.com" && /^\/embed\/([\w-]{11})/.exec(uri.pathQueryRef)?.[1]; } catch { return null; } };

  // One click in or out of the private player, in the address bar: "Watch privately" on a YouTube video, "Open on
  // YouTube" in the player. Works whether or not the player is switched on for every video.
  const { h } = Fjord;
  const label = h("span", {});
  const switcher = h("button", { id: "fjord-youtube-switch", hidden: "" }, h("img", { src: "resource://fjord/illustrations/icons/video.svg", alt: "" }), label);
  (document.getElementById("page-action-buttons") ?? document.getElementById("urlbar-input-container")).prepend(switcher);
  function updateSwitch() {
    const uri = gBrowser.currentURI, inPlayer = playerVideo(uri), video = onYouTubeSite(uri) && youtube.videoOf(uri);
    switcher.hidden = !inPlayer && !video;
    label.textContent = inPlayer ? "Open on YouTube" : "Watch privately";
    switcher.title = inPlayer
      ? "Open this video on YouTube itself, with comments and recommendations. It goes into your YouTube history."
      : "Play just this video in Fjord's private player: no recommendations, and nothing goes into your YouTube history.";
  }
  switcher.addEventListener("click", () => {
    const browser = gBrowser.selectedBrowser, uri = browser.currentURI, id = playerVideo(uri);
    if (id) {
      youtube.onYouTube.add(browser.browserId); // stays on YouTube until it leaves
      const start = new URLSearchParams(uri.query).get("start");
      browser.fixupAndLoadURIString(`https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ""}`,
        { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    } else {
      const video = youtube.videoOf(uri);
      if (!video) return;
      youtube.onYouTube.delete(browser.browserId);
      youtube.play(browser, video);
    }
  });
  gBrowser.tabContainer.addEventListener("TabSelect", updateSwitch);

  gBrowser.addTabsProgressListener({
    onLocationChange(browser, webProgress, request, location, flags) {
      if (!webProgress.isTopLevel) return;
      if (browser === gBrowser.selectedBrowser) updateSwitch();
      if (!onYouTubeSite(location)) return youtube.onYouTube.delete(browser.browserId);
      const video = youtube.videoOf(location);
      if (!video) return;
      if (youtube.enabled()) {
        if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT && !youtube.onYouTube.has(browser.browserId)) {
          youtube.play(browser, video, true);
        }
        return;
      }
      if (prefs.getBoolPref(ASKED, false) || PrivateBrowsingUtils.isBrowserPrivate(browser)) return;
      prefs.setBoolPref(ASKED, true);
      Fjord.toast(browser, "Watch YouTube in Fjord's private player? Just the video: no recommendations, and nothing goes into your YouTube history.",
        ["Use it", () => { youtube.setEnabled(true); youtube.play(browser, video, true); }], 15000);
    },
  });
})();
