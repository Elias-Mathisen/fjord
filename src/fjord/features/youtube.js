// The private YouTube player in each window (youtube.sys.mjs): videos opened inside YouTube's own page, which
// changes address without loading a new page, and the one-time offer the first time you watch something.
// Loaded into each window by browser.js.
(() => {
  const youtube = ChromeUtils.importESModule("resource://fjord/youtube.sys.mjs");
  const prefs = Services.prefs;
  const ASKED = "fjord.youtube.asked";
  const onYouTubeSite = uri => { try { return /(^|\.)(youtube\.com|youtu\.be)$/.test(uri.host); } catch { return false; } };

  gBrowser.addTabsProgressListener({
    onLocationChange(browser, webProgress, request, location, flags) {
      if (!webProgress.isTopLevel) return;
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
