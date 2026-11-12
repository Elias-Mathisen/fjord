// Calm web (on unless switched off): on top of ad blocking, takes out what's there to pressure you. Pages lose fake
// urgency, offer countdowns and guilt-trip buttons (calm.sys.mjs, started by page-frame.js); uBlock gets its
// pop-up, newsletter, chat, app-banner and AI-widget lists; videos wait for you to press play. Firefox already keeps
// notification requests to a quiet icon unless you clicked something. Switched off per site from Shields. Loaded
// into each window by browser.js.
(() => {
  const { h, btn, switchRow } = Fjord;
  const prefs = Services.prefs;
  const ublock = ChromeUtils.importESModule("resource://fjord/ublock.sys.mjs");
  const ON = "fjord.calm.enabled", OFF = "fjord.calm.off", ADDED = "fjord.calm.listsAdded";
  const LISTS = ["ublock-annoyances", "easylist-newsletters", "easylist-notifications", "easylist-chat",
    "adguard-mobile-app-banners", "fanboy-ai-suggestions"];
  const AUTOPLAY = "media.autoplay.default"; // 5: no video or sound until you press play (Firefox's own: 1, sound only)
  const enabled = () => prefs.getBoolPref(ON, true);
  const offSites = () => prefs.getStringPref(OFF, "").split(",").filter(Boolean);

  async function apply(on) {
    if (on) prefs.setIntPref(AUTOPLAY, 5);
    else prefs.clearUserPref(AUTOPLAY);
    return ublock.setLists(on, LISTS);
  }
  function setEnabled(on) {
    prefs.setBoolPref(ON, on);
    apply(on).catch(console.error);
  }
  // Once: the lists and autoplay, as soon as uBlock has picked its own lists (it may still be installing)
  if (enabled() && !prefs.getBoolPref(ADDED, false) && !Fjord.calmStarting) {
    Fjord.calmStarting = true;
    const first = async () => {
      if (await apply(true)) prefs.setBoolPref(ADDED, true);
      else setTimeout(() => first().catch(console.error), 10000);
    };
    first().catch(console.error);
  }

  // How many nudges the page in each tab lost (page-frame.js reports them)
  const counts = new WeakMap();
  window.messageManager.addMessageListener("Fjord:Calm", m => counts.set(m.target, { n: m.data.n, url: m.data.url }));
  const count = browser => {
    const c = counts.get(browser);
    return c && c.url === browser.currentURI.spec ? c.n : 0;
  };

  // For Shields: on or off for one site (its base domain); the page reloads to show the difference
  const isOn = site => enabled() && !offSites().includes(site);
  function setHere(site, on) {
    const rest = offSites().filter(s => s !== site);
    prefs.setStringPref(OFF, (on ? rest : [...rest, site]).join(","));
    gBrowser.selectedBrowser.reload();
  }
  Fjord.calm = { enabled, isOn, setHere, count };

  Fjord.sections.calm = {
    label: "Calm web", after: "privacy",
    desc: "Fjord takes out what's on a page to pressure you, not just its ads.",
    keys: "calm web dark patterns urgency countdown timer pop-ups newsletter chat autoplay video confirm shaming nag annoyances",
    render: ({ reopen }) => {
      const sites = offSites();
      return [
        h("div", { class: "ns-group" },
          switchRow("Calm web", "Fake urgency, countdowns, guilt-trip buttons, pop-ups and videos that play on their own are taken out of pages.",
            enabled(), v => { setEnabled(v); reopen(); })),
        h("h3", {}, "What it takes out"),
        h("ul", { class: "ns-calm-list" },
          h("li", {}, h("b", {}, "Fake urgency. "), "“Only 2 left”, “14 people are looking at this”, “In 30 other carts”."),
          h("li", {}, h("b", {}, "Countdowns "), "ticking next to an offer, like “Sale ends in 02:14:59”."),
          h("li", {}, h("b", {}, "Guilt-trip buttons. "), "“No thanks, I don't like saving money” just says “No thanks”."),
          h("li", {}, h("b", {}, "Pop-ups "), "asking for your email, chat bubbles, “Get our app” banners and AI widgets."),
          h("li", {}, h("b", {}, "Videos that play on their own. "), "They wait until you press play.")),
        h("p", { class: "ns-quiet ns-note" }, "Requests to show notifications already wait quietly in the address bar unless you clicked something on the page first."),
        sites.length ? h("h3", {}, "Off on these sites") : null,
        sites.length ? h("div", { class: "ns-group" }, ...sites.map(s => h("div", { class: "ns-list-row" }, h("span", {}, s),
          btn("ns-link", "Turn back on", () => { prefs.setStringPref(OFF, offSites().filter(x => x !== s).join(",")); reopen(); })))) : null,
      ];
    },
  };
})();
