// Checks Fjord's lookalike-site rules. Paste into Fjord's Browser Console (Ctrl+Shift+J); prints "lookalike: all N passed".
(() => {
  const { lookalikeOf } = ChromeUtils.importESModule("resource://fjord/privacy.sys.mjs");
  const cases = {
    "paypa1.com": "paypal.com", "g00gle.com": "google.com", "gooogle.com": "google.com", "rnicrosoft.com": "microsoft.com",
    "arnazon.com": "amazon.com", "amazom.com": "amazon.com", "app1e.com": "apple.com", "githud.com": "github.com",
    "facebok.com": "facebook.com", "lnstagram.com": "instagram.com", "paypal.com.secure-login.net": "paypal.com",
    // Real sites, country versions and short names must pass
    "www.paypal.com": null, "paypal.de": null, "amazon.co.uk": null, "google.com.au": null, "apple.com": null,
    "apply.com": null, "dnb.no": null, "dnb.co": null, "bbc.co.uk": null, "localhost": null, "192.168.0.1": null,
  };
  const failed = Object.entries(cases).filter(([host, want]) => lookalikeOf(host) !== want);
  console.log(failed.length ? "lookalike failed:" : `lookalike: all ${Object.keys(cases).length} passed`, ...failed.map(([h]) => `${h} -> ${lookalikeOf(h)}`));
})();
