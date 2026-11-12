// Fjord Shields: the button in the address bar. Shows what was blocked on this page, which companies it tried to
// share your visit with, and a dial for how strict Fjord is on this site. Loaded into each browser window by browser.js.
(() => {
  const ublock = ChromeUtils.importESModule("resource://fjord/ublock.sys.mjs");
  const privacy = ChromeUtils.importESModule("resource://fjord/privacy.sys.mjs");
  const hidden = ChromeUtils.importESModule("resource://fjord/hidden.sys.mjs");
  const { ContentBlockingAllowList } = ChromeUtils.importESModule("resource://gre/modules/ContentBlockingAllowList.sys.mjs");
  const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
  const { h, FPP_STRICT } = Fjord;
  const prefs = Services.prefs;

  const button = h("button", { id: "fjord-shields-button", "aria-label": "Shields", title: "Shields" },
    h("img", { src: "chrome://browser/skin/tracking-protection.svg", alt: "" }),
    h("span", { class: "count" }));
  (document.getElementById("page-action-buttons") ?? document.getElementById("urlbar-input-container")).append(button);

  const panel = document.createXULElement("panel");
  panel.id = "fjord-shields";
  panel.setAttribute("type", "arrow");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Shields");
  document.getElementById("mainPopupSet").append(panel);

  const site = () => {
    const uri = gBrowser.currentURI;
    return /^https?$/.test(uri.scheme) ? uri.host : null;
  };
  // Firefox's tracker blocking: origins it blocked on this page. Only real blocks count, not cookies it
  // merely partitions (those stay partitioned even with Shields off).
  const wpl = Ci.nsIWebProgressListener;
  const BLOCKED = wpl.STATE_BLOCKED_TRACKING_CONTENT | wpl.STATE_BLOCKED_FINGERPRINTING_CONTENT |
    wpl.STATE_BLOCKED_CRYPTOMINING_CONTENT | wpl.STATE_BLOCKED_SOCIALTRACKING_CONTENT |
    wpl.STATE_COOKIES_BLOCKED_TRACKER | wpl.STATE_COOKIES_BLOCKED_SOCIALTRACKER;
  const etpOrigins = async browser => {
    try {
      return Object.entries(JSON.parse(await browser.getContentBlockingLog()))
        .filter(([, events]) => events.some(([state, blocked]) => blocked && state & BLOCKED)).map(([origin]) => origin);
    } catch {
      return [];
    }
  };
  const pageCount = async () => ublock.pageBlocked(gBrowser.selectedTab) + (await etpOrigins(gBrowser.selectedBrowser)).length;
  const isUp = async host => !ContentBlockingAllowList.includes(gBrowser.selectedBrowser) && !await ublock.isTrusted(host);

  // shortcut: badge polls every 2 s for the selected tab, rather than listening to uBlock's badge changes
  const updateBadge = async () => {
    // Shields off sets both allowlists together, so Firefox's one tells us cheaply
    const n = site() && !ContentBlockingAllowList.includes(gBrowser.selectedBrowser) ? await pageCount() : 0;
    button.querySelector(".count").textContent = n ? (n > 99 ? "99+" : n) : "";
  };
  const timer = setInterval(updateBadge, 2000);
  gBrowser.tabContainer.addEventListener("TabSelect", updateBadge);
  window.addEventListener("unload", () => clearInterval(timer));

  // Per-site exceptions to clearing on close: "persist-data-on-shutdown" keeps a site's data when Ghost clears
  // everything; a "cookie" SESSION permission forgets one site on close otherwise (both are Firefox's own)
  const { ALLOW_ACTION, DENY_ACTION } = Ci.nsIPermissionManager;
  const SESSION = Ci.nsICookiePermission.ACCESS_SESSION;
  const principal = () => gBrowser.contentPrincipal;
  const hasPerm = (type, value) => Services.perms.testExactPermissionFromPrincipal(principal(), type) === value;
  const setPerm = (type, value, on) => on
    ? Services.perms.addFromPrincipal(principal(), type, value)
    : Services.perms.removeFromPrincipal(principal(), type);

  const toggle = (label, on, onChange) => {
    const input = h("input", { type: "checkbox", role: "switch" });
    input.checked = on;
    input.addEventListener("change", () => onChange(input.checked));
    return h("label", { class: "ns-switch" }, h("span", {}, label), input);
  };

  // ---------- The dial ----------
  // Off: Firefox's and uBlock's allowlists. Strict: Firefox's fingerprinting protection in full for this site only
  // (granularOverrides). Lockdown: strict, plus uBlock's no-scripting switch and cookies denied.
  // The level beyond the default is remembered as a "fjord-shields" permission: 3 strict, 4 lockdown.
  const LEVELS = {
    off: ["Off", "Nothing is blocked here. For sites that don't work with Shields on."],
    standard: ["Standard", "Blocks ads and trackers. Sites work normally."],
    strict: ["Strict", "Also hides your screen size, fonts and other device details from this site."],
    lockdown: ["Lockdown", "Also turns off JavaScript and cookies. Pages still show, but nothing on them can run or track you. Many sites will break."],
  };
  const LEVEL_PERM = "fjord-shields";
  const GRANULAR = "privacy.fingerprintingProtection.granularOverrides";
  const globalStrict = () => prefs.getStringPref("fjord.protection", "balanced") !== "balanced";

  async function siteLevel(host) {
    if (!await isUp(host)) return "off";
    const v = Services.perms.testExactPermissionFromPrincipal(principal(), LEVEL_PERM);
    return v === 4 ? "lockdown" : v === 3 || globalStrict() ? "strict" : "standard";
  }

  function setSiteFingerprinting(domain, overrides) {
    let list = [];
    try { list = JSON.parse(prefs.getStringPref(GRANULAR, "") || "[]"); } catch {}
    list = list.filter(e => e.firstPartyDomain !== domain);
    if (overrides) list.push({ firstPartyDomain: domain, overrides });
    prefs.setStringPref(GRANULAR, JSON.stringify(list));
  }

  async function setLevel(host, level) {
    const browser = gBrowser.selectedBrowser;
    if (level === "off") ContentBlockingAllowList.add(browser);
    else ContentBlockingAllowList.remove(browser);
    // With Strict or Ghost chosen in settings, full fingerprinting protection is already on everywhere
    const extra = level === "lockdown" || (level === "strict" && !globalStrict());
    setSiteFingerprinting(privacy.baseDomain(host), extra ? FPP_STRICT : null);
    if (level === "lockdown") Services.perms.addFromPrincipal(principal(), "cookie", DENY_ACTION);
    else if (hasPerm("cookie", DENY_ACTION)) Services.perms.removeFromPrincipal(principal(), "cookie");
    setPerm(LEVEL_PERM, level === "lockdown" ? 4 : 3, level === "lockdown" || extra);
    await ublock.setSiteRules(host, { trusted: level === "off", noScripting: level === "lockdown" });
    // Past the cache: a cached page keeps the no-JavaScript rule uBlock added to it
    browser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
  }

  function dial(host, current) {
    // Standard is only a step when it's also the setting for all sites (it can't be undone for one site under Strict)
    const stops = globalStrict() ? ["off", "strict", "lockdown"] : ["off", "standard", "strict", "lockdown"];
    const desc = h("p", { class: "ns-quiet ns-dial-desc" }, LEVELS[current][1]);
    const group = h("div", { class: "ns-dial", role: "radiogroup", "aria-label": "Protection on this site" });
    for (const level of stops) {
      const b = h("button", { role: "radio", "aria-checked": String(level === current), "data-level": level }, LEVELS[level][0]);
      b.addEventListener("mouseenter", () => { desc.textContent = LEVELS[level][1]; });
      b.addEventListener("mouseleave", () => { desc.textContent = LEVELS[current][1]; });
      b.addEventListener("click", async () => {
        if (level === current) return;
        panel.hidePopup();
        await setLevel(host, level);
      });
      group.append(b);
    }
    return h("div", { class: "ns-dial-wrap" }, group, desc);
  }

  // ---------- Privacy label: who the page tried to share your visit with ----------
  async function label(host, up) {
    const companies = privacy.pageCompanies(gBrowser.selectedBrowser.browserId);
    // Trackers Firefox blocked that aren't on Fjord's company list
    const named = new Set(companies.map(([c]) => c));
    const others = new Set((await etpOrigins(gBrowser.selectedBrowser)).map(o => {
      try { return privacy.baseDomain(new URL(o).hostname); } catch { return null; }
    }).filter(d => d && d !== privacy.baseDomain(host) && !named.has(privacy.companyOf(d))));
    const box = h("div", { class: "ns-label" }, h("h4", {}, up ? "Tried to share your visit with" : "Shared your visit with"));
    if (!companies.length && !others.size) {
      box.append(h("p", { class: "ns-quiet" }, "No tracking companies found on this page."));
      return box;
    }
    const max = companies[0]?.[1] ?? 1;
    for (const [name, n] of companies.slice(0, 5)) {
      box.append(h("div", { class: "ns-label-row" }, h("span", {}, name), h("i", { style: `--w: ${Math.max(6, (n / max) * 100)}%` }), h("b", {}, String(n))));
    }
    const more = Math.max(0, companies.length - 5) + others.size;
    if (more > 0) box.append(h("p", { class: "ns-quiet" }, `and ${more} other tracking ${more === 1 ? "company" : "companies"}`));
    return box;
  }

  // Everything the site (and its subdomains) stored, and its history. Saved passwords and its Shields settings stay.
  // The tab moves to a new tab, so the page can't store it all again.
  // shortcut: other open tabs on the site keep running and can save things again; close them first if that matters
  async function forgetSite(host) {
    const domain = privacy.baseDomain(host);
    const browser = gBrowser.selectedBrowser;
    const F = Ci.nsIClearDataService;
    const failed = await new Promise(done => Services.clearData.deleteDataFromSite(domain, {}, true,
      F.CLEAR_COOKIES_AND_SITE_DATA | F.CLEAR_ALL_CACHES | F.CLEAR_HISTORY, done));
    await privacy.forgetSites(domain); // and the privacy report's counts for it
    browser.fixupAndLoadURIString(FJORD.newtab, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
    });
    Fjord.toast(browser, failed ? `Some of ${domain}'s data couldn't be deleted. Try again after closing its other tabs.`
      : `Fjord forgot ${domain}: its cookies, saved data and history are gone.`);
  }

  async function render() {
    const host = site();
    const kids = [];
    if (!host) {
      kids.push(h("p", { class: "ns-quiet" }, "Shields only work on websites."));
    } else {
      const level = await siteLevel(host);
      const up = level !== "off";
      const n = await pageCount();
      kids.push(
        h("div", { class: "ns-head" }, h("b", {}, host),
          up ? h("p", { class: "ns-count" }, h("b", {}, String(n)), n === 1 ? " ad or tracker blocked" : " ads and trackers blocked")
            : h("p", { class: "ns-count" }, "Nothing is blocked on this site.")),
        dial(host, level),
        await label(host, up),
      );
      // Calm web (features/calm.js): what it took out of this page, and a switch for the site
      if (Fjord.calm?.enabled()) {
        const site = privacy.baseDomain(host), removed = Fjord.calm.count(gBrowser.selectedBrowser);
        kids.push(toggle(removed ? `Calm web: ${removed === 1 ? "1 nudge" : `${removed} nudges`} taken out` : "Calm web",
          Fjord.calm.isOn(site), on => { panel.hidePopup(); Fjord.calm.setHere(site, on); }));
      }
      if (!PrivateBrowsingUtils.isWindowPrivate(window)) {
        const ghost = prefs.getStringPref("fjord.protection", "balanced") === "ghost";
        if (level !== "lockdown") kids.push(ghost
          ? toggle("Stay signed in here", hasPerm("persist-data-on-shutdown", ALLOW_ACTION), on => setPerm("persist-data-on-shutdown", ALLOW_ACTION, on))
          : toggle("Forget this site when I close Fjord", hasPerm("cookie", SESSION), on => setPerm("cookie", SESSION, on)));
        const hiddenHere = hidden.forSite(privacy.baseDomain(host)).length;
        if (hiddenHere) {
          const unhide = h("button", { class: "ns-link-row ns-forget" },
            h("b", {}, hiddenHere === 1 ? "1 part of this site hidden" : `${hiddenHere} parts of this site hidden`),
            h("span", {}, "Show them again."));
          unhide.addEventListener("click", () => {
            panel.hidePopup();
            hidden.remove(privacy.baseDomain(host));
            gBrowser.selectedBrowser.reload();
          });
          kids.push(unhide);
        }
        const forget = h("button", { class: "ns-link-row ns-forget" }, h("b", {}, "Forget this site now"),
          h("span", {}, "Deletes its cookies, saved data and history now. You'll be signed out."));
        forget.addEventListener("click", () => { panel.hidePopup(); forgetSite(host).catch(console.error); });
        kids.push(forget);
      } else {
        kids.push(h("p", { class: "ns-quiet" }, "Private window: history and cookies are deleted when you close it."));
      }
    }
    for (const [text, section] of [["Privacy report", "report"], ["Fjord settings", "privacy"]]) {
      const link = h("button", { class: "ns-link-row" }, text);
      link.addEventListener("click", () => { panel.hidePopup(); Fjord.showSettings(section); });
      kids.push(link);
    }
    panel.replaceChildren(h("div", { class: "ns-shields" }, ...kids));
  }

  // For the command bar: the same actions on the site in the current tab
  Fjord.siteActions = {
    LEVELS,
    setLevel: level => site() && setLevel(site(), level),
    forget: () => site() && forgetSite(site()).catch(console.error),
  };

  button.addEventListener("click", async () => {
    await render();
    panel.openPopup(button, "bottomright topright");
  });
})();
