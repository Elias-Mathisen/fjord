// Firefox's own settings page (about:preferences). In Firefox 160 its first page is "Account and sync"; in Fjord,
// which has no Mozilla account (content.css hides those parts), all that's left there is Default browser and
// Import, so it's called General. Loaded into each window by browser.js.
(() => {
  const rename = doc => {
    const header = doc.querySelector('moz-page-header[data-l10n-id="account-sync-section"]');
    if (!header) return false;
    header.removeAttribute("data-l10n-id"); // Fluent would put the old name back
    header.removeAttribute("data-l10n-attrs");
    header.setAttribute("heading", "General");
    header.setAttribute("iconsrc", "chrome://browser/skin/preferences/category-general.svg");
    return true;
  };
  gBrowser.addTabsProgressListener({
    onStateChange(browser, webProgress, request, flags) {
      if (!webProgress.isTopLevel || !(flags & Ci.nsIWebProgressListener.STATE_STOP)) return;
      if (!/^about:(preferences|settings)/.test(browser.currentURI.spec)) return;
      const doc = browser.contentDocument; // about:preferences runs in this process
      if (!doc || rename(doc)) return;
      // The page draws its sections a moment after it loads
      let tries = 0;
      const timer = setInterval(() => { if (rename(doc) || ++tries > 20) clearInterval(timer); }, 150);
    },
  });
})();
