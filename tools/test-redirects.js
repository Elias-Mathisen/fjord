// Checks Fjord's tracking-redirect rules. Paste into Fjord's Browser Console (Ctrl+Shift+J); prints "redirects: all N passed".
(() => {
  const { unwrapRedirect } = ChromeUtils.importESModule("resource://fjord/privacy.sys.mjs");
  const cases = {
    "https://www.google.com/url?q=https://example.com/a&sa=D": "https://example.com/a",
    "https://www.google.co.uk/url?url=https%3A%2F%2Fexample.org%2F": "https://example.org/",
    "https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2F&h=AT0": "https://example.com/",
    "https://www.youtube.com/redirect?event=video_description&q=https%3A%2F%2Fexample.com": "https://example.com",
    "https://steamcommunity.com/linkfilter/?url=https://example.com": "https://example.com",
    "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F": "https://example.com/",
    "https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com%2F&data=x": "https://example.com/",
    // Not redirects, or not to a web address: left alone
    "https://www.google.com/search?q=https://example.com": null,
    "https://www.google.com/url?q=javascript:alert(1)": null,
    "https://www.facebook.com/l.php?u=https://example.com": null,
    "https://example.com/url?q=https://evil.example": null,
  };
  const failed = Object.entries(cases).filter(([url, want]) => unwrapRedirect(url) !== want);
  console.log(failed.length ? "redirects failed:" : `redirects: all ${Object.keys(cases).length} passed`, ...failed.map(([u]) => `${u} -> ${unwrapRedirect(u)}`));
})();
