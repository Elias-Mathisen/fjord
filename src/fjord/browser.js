// Fjord window script: new tab page, first-run setup and settings (opened from the ☰ menu).
// Loaded into every browser window by Fjord.cfg; the Shields button lives in shields.js.
(() => {
  window.windowUtils.loadSheetUsingURIString("resource://fjord/chrome.css", window.windowUtils.AUTHOR_SHEET);
  // Windows shows Firefox's icon in the title bar, Alt+Tab and taskbar previews unless the window is given ours
  // (Firefox no longer reads chrome\icons\default\main-window.ico for its windows)
  if (AppConstants.platform == "win") {
    fetch("resource://fjord/branding/logo.png").then(r => r.arrayBuffer()).then(buf => {
      const img = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools).decodeImageFromArrayBuffer(buf, "image/png");
      Cc["@mozilla.org/windows-ui-utils;1"].getService(Ci.nsIWindowsUIUtils).setWindowIcon(window, img, img);
    }).catch(console.error);
  }
  if (!window.toolbar.visible) return; // popup windows get no extras

  const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
  const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");
  const ublock = ChromeUtils.importESModule("resource://fjord/ublock.sys.mjs");
  const privacy = ChromeUtils.importESModule("resource://fjord/privacy.sys.mjs");
  const keylock = AppConstants.platform == "win" ? ChromeUtils.importESModule("resource://fjord/keylock.sys.mjs") : null;
  const youtube = ChromeUtils.importESModule("resource://fjord/youtube.sys.mjs");
  const prefs = Services.prefs;
  const ART = "resource://fjord/illustrations/";
  const LOGO = "resource://fjord/branding/logo.png";
  const fjordVersion = () => fetch("resource://fjord/version.txt").then(r => r.text()).then(t => t.trim()).catch(() => "");
  const ENGINES = ["DuckDuckGo", "Google", "Bing"];

  // Built with DOM calls: Firefox strips <button> from innerHTML in its own window
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...kids.filter(k => k != null));
    return el;
  };
  const on = (el, type, fn) => (el.addEventListener(type, fn), el);
  const btn = (cls, label, onClick) => on(h("button", { class: cls }, label), "click", onClick);

  // ---------- New tab ----------
  // The blocked count reaches the page as a tiny script in the profile (file:// pages can't get
  // Firefox's JS actors), named in the page's ?stats= parameter.
  const { AboutNewTab } = ChromeUtils.importESModule("resource:///modules/AboutNewTab.sys.mjs");
  const statsFile = PathUtils.join(PathUtils.profileDir, "fjord-stats.js");
  const newtab = `${FJORD.newtab}?stats=${encodeURIComponent(PathUtils.toFileURI(statsFile))}`;
  AboutNewTab.newTabURL = newtab;
  prefs.getDefaultBranch("").setStringPref("browser.startup.homepage", newtab);
  // Keeps the address bar empty on new tabs (Firefox compares without the ?query)
  if (!gInitialPages.includes(FJORD.newtab)) gInitialPages.push(FJORD.newtab);

  const trackingDB = Cc["@mozilla.org/tracking-db-service;1"].getService(Ci.nsITrackingDBService);
  // What the new tab shows; each can be switched off in Fjord settings > New tab
  const NEWTAB = {
    blocked: ["Ads and trackers blocked", "The running total since Fjord was installed."],
    time: ["Time saved", "About 50 milliseconds for every ad or tracker that didn't load."],
    data: ["Data saved", "About 40 KB for every ad or tracker that didn't download."],
    week: ["This week", "Blocked per day, and the companies that tried to track you most."],
    clock: ["Clock and date", null],
    photos: ["Photos", "A different landscape on every new tab. Off shows a plain background."],
  };
  const newtabLayout = () => Object.fromEntries(Object.keys(NEWTAB).map(k => [k, prefs.getBoolPref(`fjord.newtab.${k}`, true)]));
  // Your own picture for the new tab: copied into the profile's fjord-photos folder (where the downloaded photos are,
  // so the new tab can show it) under a new name each time, so a changed picture isn't the old one from cache
  const OWN_PHOTO = "fjord.newtab.own";
  const photoDir = PathUtils.join(PathUtils.profileDir, "fjord-photos");
  const IMAGE = /\.(jpe?g|png|webp|avif|gif)$/i;
  async function setOwnPhoto(file) {
    const old = prefs.getStringPref(OWN_PHOTO, "");
    if (file) {
      if (!IMAGE.test(file.leafName)) throw new Error("Choose a JPEG, PNG, WebP, AVIF or GIF picture.");
      if (file.fileSize > 40 << 20) throw new Error("That picture is over 40 MB. Choose a smaller one.");
      const name = `own-${Date.now()}${IMAGE.exec(file.leafName)[0].toLowerCase()}`;
      await IOUtils.makeDirectory(photoDir, { ignoreExisting: true });
      await IOUtils.copy(file.path, PathUtils.join(photoDir, name));
      prefs.setStringPref(OWN_PHOTO, name);
    } else {
      prefs.clearUserPref(OWN_PHOTO);
    }
    if (old) await IOUtils.remove(PathUtils.join(photoDir, old), { ignoreAbsent: true }).catch(console.error);
  }
  function chooseOwnPhoto(reopen) {
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(window.browsingContext, "Choose a picture for the new tab", Ci.nsIFilePicker.modeOpen);
    fp.appendFilters(Ci.nsIFilePicker.filterImages);
    fp.open(r => {
      if (r === Ci.nsIFilePicker.returnOK) setOwnPhoto(fp.file).then(reopen, e => toast(gBrowser.selectedBrowser, e.message));
    });
  }
  // Firefox's tracker blocking and uBlock never count the same request: what uBlock blocks never reaches Firefox
  const writeStats = async () => {
    const [etp, ubo, since] = await Promise.all([trackingDB.sumAllEvents(), ublock.totalBlocked().catch(() => 0), trackingDB.getEarliestRecordedDate()]);
    await privacy.recordBlocked(etp + ubo);
    const week = await privacy.weekSummary();
    // Firefox's own first date is a UTC day; Fjord's is the local one
    const data = { blocked: etp + ubo, since: week.since ? `${week.since}T00:00` : since, week,
      layout: { ...newtabLayout(), own: prefs.getStringPref(OWN_PHOTO, "") } };
    await IOUtils.writeUTF8(statsFile, `fjordStats(${JSON.stringify(data)});\n`, { tmpPath: statsFile + ".tmp" });
  };
  // The new-tab photos that don't come with Fjord, downloaded once in the background (photos.sys.mjs)
  ChromeUtils.importESModule("resource://fjord/photos.sys.mjs").fetchPhotos();
  // shortcut: refreshed on tab open and every 30 s, so the count can trail by a few seconds
  writeStats();
  gBrowser.tabContainer.addEventListener("TabOpen", writeStats);
  const statsTimer = setInterval(writeStats, 30000);
  const layoutObserver = { observe: () => writeStats() };
  prefs.addObserver("fjord.newtab.", layoutObserver);
  window.addEventListener("unload", () => { clearInterval(statsTimer); prefs.removeObserver("fjord.newtab.", layoutObserver); });

  // The new tab's Customize button sets #customize on its own address; that opens the New tab settings
  // A new tab opened without ?stats (the first tab at startup can load before this script sets the address) gets it
  const fixNewtab = browser => browser.fixupAndLoadURIString(newtab, {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
  });
  // New tabs restored from before 1.0.1, when Fjord's folder had its old name
  const oldNewtab = FJORD.newtab.replace(/\/fjord\/newtab\.html$/, "/nocturne/newtab.html");
  for (const b of gBrowser.browsers) if (b.currentURI?.spec === FJORD.newtab || b.currentURI?.spec.startsWith(oldNewtab)) fixNewtab(b);
  gBrowser.addTabsProgressListener({
    onLocationChange(browser, webProgress, request, location) {
      if (!webProgress.isTopLevel) return;
      if (location.spec === FJORD.newtab || location.spec.startsWith(oldNewtab)) return fixNewtab(browser);
      if (location.spec.startsWith(FJORD.newtab) && browser === gBrowser.selectedBrowser) {
        if (location.ref === "customize") showSettings("newtab");
        if (location.ref === "report") showSettings("report"); // the new tab's week
      }
      browser.parentElement.querySelector(".ns-guard")?.remove(); // a lookalike warning goes once the tab goes elsewhere
    },
  });

  // Fjord's extra uBlock lists are added once; after that the list choices are the user's own
  if (!FJORD.uboChecked && !prefs.getBoolPref("fjord.ublock.listsAdded", false)) {
    FJORD.uboChecked = true;
    const addLists = async () => {
      if (await ublock.addExtraLists()) prefs.setBoolPref("fjord.ublock.listsAdded", true);
      else setTimeout(() => addLists().catch(console.error), 10000); // uBlock is still installing
    };
    addLists().catch(console.error);
  }

  // ---------- "Fjord settings" at the top of the ☰ menu ----------
  // The menu is built the first time it opens, so the item goes in then
  on(document, "ViewShowing", e => {
    if (e.target.id !== "appMenu-mainView" || document.getElementById("appMenu-fjord-button")) return;
    const item = document.createXULElement("toolbarbutton");
    item.id = "appMenu-fjord-button";
    item.className = "subviewbutton";
    item.setAttribute("label", "Fjord settings");
    on(item, "command", () => { PanelUI.hide(); showSettings(); });
    const body = e.target.querySelector(".panel-subview-body");
    body.prepend(item, document.createXULElement("toolbarseparator"));
  });

  // ---------- Protection levels ----------
  const FPP_STRICT = "+AllTargets,-CSSPrefersColorScheme,-JSDateTimeUTC"; // everything except dark mode and local time
  // Randomising: Firefox gives each site its own made-up canvas readings (on by default), WebGL canvases saved as
  // images included, from a key that changes every session. Fjord adds the same for audio and WebGL pixel reads
  // (page-frame.js).
  const RANDOM = "+CanvasRandomization,+WebGLRandomization", NOT_RANDOM = "-CanvasRandomization,-WebGLRandomization";
  const RANDOMISE = "fjord.fingerprint.randomise";
  function applyFingerprinting(level = prefs.getStringPref("fjord.protection", "balanced")) {
    const random = prefs.getBoolPref(RANDOMISE, true) ? RANDOM : NOT_RANDOM;
    prefs.setStringPref("privacy.fingerprintingProtection.overrides", level === "balanced" ? random : `${FPP_STRICT},${random}`);
  }
  function applyProtection(level) {
    prefs.setStringPref("fjord.protection", level);
    applyFingerprinting(level);
    if (level === "ghost") {
      prefs.setBoolPref("privacy.sanitize.sanitizeOnShutdown", true);
      for (const p of ["cookiesAndStorage", "browsingHistoryAndDownloads", "formdata", "cache"]) {
        prefs.setBoolPref(`privacy.clearOnShutdown_v2.${p}`, true);
      }
    } else {
      prefs.clearUserPref("privacy.sanitize.sanitizeOnShutdown");
    }
  }

  // ---------- Light / dark ----------
  // ui.systemUsesDarkTheme switches the browser, Firefox's own pages and the new-tab photos together
  function applyTheme(theme) {
    prefs.setStringPref("fjord.theme", theme);
    if (theme === "system") prefs.clearUserPref("ui.systemUsesDarkTheme");
    else prefs.setIntPref("ui.systemUsesDarkTheme", theme === "dark" ? 1 : 0);
  }

  // ---------- Pieces shared by setup and settings ----------
  const icon = name => h("img", { class: "ns-icon", src: `${ART}icons/${name}.svg`, alt: "" });
  const badge = (key, cls = "") => h("span", { class: `ns-badge ns-b-${key} ${cls}` }, icon(key));
  // The fjord banner, at dawn or at night to match the theme
  const scene = cls => h("div", { class: `ns-scene ${cls}` },
    h("img", { class: "ns-scene-light", src: `${ART}fjord-dawn.svg`, alt: "" }),
    h("img", { class: "ns-scene-dark", src: `${ART}fjord-night.svg`, alt: "" }));

  // A row of buttons where one is picked
  const choices = (cls, items, current, onPick) => {
    const group = h("div", { class: cls });
    for (const it of items) {
      const b = h("button", { "aria-pressed": String(it.value === current) }, ...it.content);
      on(b, "click", () => {
        for (const x of group.children) x.setAttribute("aria-pressed", String(x === b));
        onPick(it.value);
      });
      group.append(b);
    }
    return group;
  };
  const switchRow = (label, desc, checked, onChange) => {
    const input = h("input", { type: "checkbox", role: "switch" });
    input.checked = checked;
    on(input, "change", () => onChange(input.checked));
    return h("label", { class: "ns-switch-row" }, h("span", {}, h("b", {}, label), desc && h("span", {}, desc)), input);
  };
  // One switch for several boolean prefs that go together
  const prefSwitch = (label, desc, ...names) =>
    switchRow(label, desc, prefs.getBoolPref(names[0], false), v => names.forEach(p => prefs.setBoolPref(p, v)));

  const THEMES = [
    { value: "dark", name: "Dark" },
    { value: "light", name: "Light" },
    { value: "system", name: "System" },
  ];
  const themeChoices = (current, onPick) => choices("ns-tiles", THEMES.map(t => ({
    value: t.value, content: [h("img", { src: `${ART}theme-${t.value}.svg`, alt: "" }), h("b", {}, t.name)],
  })), current, onPick);

  const LEVELS = [
    { value: "balanced", name: "Standard", text: "Recommended. Sites work normally." },
    { value: "strict", name: "Strict", text: "Also hides details about your device, like screen size and fonts. A few sites may break." },
    { value: "ghost", name: "Ghost", text: "Strict, and deletes cookies and history every time you close Fjord. You'll be signed out of sites." },
  ];
  // What each level does and costs, shown next to the levels and updated as you pick
  const LEVEL_EFFECTS = [
    ["Ads and trackers blocked", ["balanced", "strict", "ghost"]],
    ["Common fingerprinting tricks blocked", ["balanced", "strict", "ghost"]],
    ["Screen size, fonts and other device details hidden", ["strict", "ghost"]],
    ["Cookies and history deleted when Fjord closes", ["ghost"]],
    ["You stay signed in to sites", ["balanced", "strict"]],
  ];
  function protectionPicker(current, onPick) {
    const summary = h("ul", { class: "ns-summary", "aria-live": "polite" });
    const show = level => summary.replaceChildren(...LEVEL_EFFECTS.map(([text, levels]) => {
      const yes = levels.includes(level);
      return h("li", { class: yes ? "ns-yes" : "" }, icon(yes ? "check" : "cross"), text);
    }));
    show(current);
    const options = choices("ns-options", LEVELS.map(l => ({
      value: l.value, content: [h("img", { src: `${ART}shield-${l.value}.svg`, alt: "" }), h("span", {}, h("b", {}, l.name), h("span", {}, l.text))],
    })), current, v => { show(v); onPick(v); });
    return h("div", { class: "ns-protection" }, options, summary);
  }

  // sidebar.verticalTabs moves the tabs into Firefox's sidebar, live
  const tabChoices = () => choices("ns-tiles ns-tiles-2", [
    { value: false, content: [h("img", { src: `${ART}tabs-horizontal.svg`, alt: "" }), h("b", {}, "Tabs on top")] },
    { value: true, content: [h("img", { src: `${ART}tabs-vertical.svg`, alt: "" }), h("b", {}, "Tabs on the side")] },
  ], prefs.getBoolPref("sidebar.verticalTabs", false), v => prefs.setBoolPref("sidebar.verticalTabs", v));

  // Secure DNS (DNS over HTTPS); policies.json starts it on with Quad9. Mode 2 falls back to the network's DNS
  // when the provider can't be reached, so hotel Wi-Fi sign-in pages still work; mode 5 is "off by choice".
  const DNS = [
    { value: "https://dns.quad9.net/dns-query", name: "Quad9", text: "The default. Swiss nonprofit that also blocks sites known to spread malware." },
    { value: "", name: "Your network's DNS", text: "Your internet provider and the Wi-Fi owner can see which sites you visit." },
    { value: "https://dns.mullvad.net/dns-query", name: "Mullvad", text: "Run by Mullvad VPN, which keeps no logs." },
    { value: "https://mozilla.cloudflare-dns.com/dns-query", name: "Cloudflare", text: "Fast. Bound by a no-logging agreement with Mozilla." },
  ];
  const currentDNS = () => prefs.getIntPref("network.trr.mode", 0) === 2 ? prefs.getStringPref("network.trr.uri", "") : "";
  function setDNS(uri) {
    if (uri) prefs.setStringPref("network.trr.uri", uri);
    prefs.setIntPref("network.trr.mode", uri ? 2 : 5);
  }

  async function engineChoices(current, onPick) {
    await SearchService.init();
    const visible = await SearchService.getVisibleEngines();
    const items = [];
    for (const name of ENGINES) {
      const engine = visible.find(e => e.name === name);
      if (!engine) continue;
      let icon = null;
      try { icon = await engine.getIconURL(32); } catch {}
      items.push({ value: name, content: [icon ? h("img", { src: icon, alt: "" }) : null, h("span", {}, name)] });
    }
    return choices("ns-pills", items, current, onPick);
  }

  async function setDefaultEngine(name) {
    await SearchService.init();
    const engine = SearchService.getEngineByName(name);
    if (engine) await SearchService.setDefault(engine, SearchService.CHANGE_REASON.USER);
  }
  async function setPrivateEngine(name) {
    await SearchService.init();
    const engine = SearchService.getEngineByName(name);
    if (engine) await SearchService.setDefaultPrivate(engine, SearchService.CHANGE_REASON.USER);
  }

  // Firefox's Forget button (the "panic-button" widget) in the toolbar
  const { CustomizableUI } = ChromeUtils.importESModule("moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs");
  const forgetButtonShown = () => !!CustomizableUI.getPlacementOfWidget("panic-button");
  const showForgetButton = on => on ? CustomizableUI.addWidgetToArea("panic-button", CustomizableUI.AREA_NAVBAR) : CustomizableUI.removeWidgetFromArea("panic-button");

  // Hardened mode: no JIT compilers, WebAssembly or WebGL, the usual way in for browser exploits
  const HARDENED = { "javascript.options.ion": false, "javascript.options.baselinejit": false, "javascript.options.wasm": false,
    "javascript.options.asmjs": false, "webgl.disabled": true };
  const hardened = () => prefs.getBoolPref("webgl.disabled", false) && !prefs.getBoolPref("javascript.options.ion", true);
  const setHardened = on => {
    for (const [p, v] of Object.entries(HARDENED)) on ? prefs.setBoolPref(p, v) : prefs.clearUserPref(p);
  };

  // Import from other browsers through Firefox's own importers
  async function importPanel() {
    const box = h("div", { class: "ns-import" }, h("p", { class: "ns-quiet" }, "Looking for other browsers…"));
    const { MigrationUtils } = ChromeUtils.importESModule("moz-src:///browser/components/migration/MigrationUtils.sys.mjs");
    const names = new Localization(["browser/migrationWizard.ftl"]);
    const T = MigrationUtils.resourceTypes;
    const KINDS = [[T.BOOKMARKS, "Bookmarks"], [T.HISTORY, "History"], [T.PASSWORDS, "Passwords"]];
    const sources = [];
    for (const key of MigrationUtils.availableMigratorKeys) {
      // Old Edge only offers Windows' saved-password vault, which isn't really another browser's data
      if (key === "internal-testing" || key === "edge") continue;
      try {
        const m = await MigrationUtils.getMigrator(key);
        if (!m) continue;
        const profiles = (await m.getSourceProfiles()) ?? [null];
        const name = await names.formatValue(m.constructor.displayNameL10nID) ?? key;
        for (const p of profiles) {
          const data = await m.getMigrateData(p);
          const kinds = KINDS.filter(([t]) => data & t);
          if (kinds.length) sources.push({ m, p, name, sub: profiles.length > 1 || p?.name ? p?.name : "", img: m.constructor.brandImage, kinds });
        }
      } catch (e) {
        console.error("Fjord import:", key, e);
      }
    }
    if (!sources.length) {
      box.replaceChildren(h("p", { class: "ns-quiet" }, "No other browsers found on this computer."));
      return box;
    }
    sources.sort((a, b) => b.kinds.length - a.kinds.length); // the browser with the most to bring over first
    let picked = sources[0];
    const kinds = h("div", { class: "ns-kinds" });
    const status = h("p", { class: "ns-quiet", role: "status" });
    const importBtn = h("button", { class: "ns-secondary" }, "Import");
    const showKinds = () => kinds.replaceChildren(...picked.kinds.map(([t, label]) => {
      const c = h("input", { type: "checkbox", "data-type": String(t) });
      c.checked = true;
      return h("label", {}, c, label);
    }));
    const list = choices("ns-sources", sources.map((s, i) => ({
      value: i, content: [h("img", { src: s.img, alt: "" }), h("span", {}, h("b", {}, s.name), s.sub ? h("span", {}, s.sub) : null)],
    })), 0, i => { picked = sources[i]; showKinds(); status.textContent = ""; });
    showKinds();
    on(importBtn, "click", async () => {
      const chosen = [...kinds.querySelectorAll("input:checked")].reduce((sum, c) => sum | Number(c.dataset.type), 0);
      if (!chosen) return;
      importBtn.disabled = true;
      status.textContent = `Importing from ${picked.name}…`;
      try {
        await picked.m.migrate(chosen, false, picked.p);
        status.textContent = `Done. Imported from ${picked.name}.`;
      } catch (e) {
        console.error("Fjord import:", e);
        status.textContent = `Couldn't import from ${picked.name}. Close ${picked.name} and try again.`;
      }
      importBtn.disabled = false;
    });
    box.replaceChildren(list, kinds, h("div", { class: "ns-row" }, importBtn, status));
    return box;
  }

  // One Fjord sheet (setup or settings) at a time across all windows. A window that closes with its sheet open gives the
  // claim back, or nothing could open again until Fjord restarts
  function claimOverlay() {
    if (FJORD.overlayOpen) return false;
    FJORD.overlayOpen = true;
    FJORD.overlayOwner = window;
    return true;
  }
  window.addEventListener("unload", () => {
    if (FJORD.overlayOwner === window) { FJORD.overlayOpen = false; FJORD.overlayOwner = null; }
  });

  // A full-window sheet with one card
  function openOverlay(label, card) {
    const overlay = h("div", { class: "ns-overlay", role: "dialog", "aria-modal": "true", "aria-label": label }, card);
    document.body.append(overlay);
    return overlay;
  }

  // ---------- First-run setup ----------
  // The profile next to the install (build.ps1's and the installer's layout), not a test profile
  const installedProfile = () => PathUtils.profileDir == PathUtils.join(Services.dirsvc.get("GreD", Ci.nsIFile).parent.path, "profile");

  // Making Fjord the default browser runs Firefox's helper, which registers it with Windows (Default apps, "Open with")
  // as "Firefox". Renamed to Fjord, only where the command runs this copy's firefox.exe, so a real Firefox keeps its own
  function nameForWindows() {
    if (AppConstants.platform != "win") return;
    const exe = Services.dirsvc.get("XREExeF", Ci.nsIFile).path.toLowerCase();
    const ico = PathUtils.join(Services.dirsvc.get("GreD", Ci.nsIFile).path, "fjord", "fjord.ico") + ",0";
    const open = path => {
      const k = Cc["@mozilla.org/windows-registry-key;1"].createInstance(Ci.nsIWindowsRegKey);
      try { k.open(k.ROOT_KEY_CURRENT_USER, path, k.ACCESS_ALL); return k; } catch { return null; }
    };
    const set = (path, values) => {
      const k = open(path);
      if (!k) return;
      for (const [name, value] of Object.entries(values)) k.writeStringValue(name, value);
      k.close();
    };
    const clients = open("Software\\Clients\\StartMenuInternet");
    if (!clients) return;
    const names = [];
    for (let i = 0; i < clients.childCount; i++) names.push(clients.getChildName(i));
    clients.close();
    for (const name of names) {
      const hash = /^Firefox-(\w+)$/.exec(name)?.[1];
      if (!hash) continue;
      const base = `Software\\Clients\\StartMenuInternet\\${name}`;
      const cmd = open(base + "\\shell\\open\\command");
      let ours = false;
      try { ours = cmd?.readStringValue("").toLowerCase().includes(exe); } catch {}
      cmd?.close();
      if (!ours) continue;
      set(base, { "": "Fjord" });
      set(base + "\\Capabilities", { ApplicationName: "Fjord", ApplicationDescription: "Fjord web browser", ApplicationIcon: ico });
      set(base + "\\DefaultIcon", { "": ico });
      for (const [prog, type] of [["FirefoxURL", "Fjord URL"], ["FirefoxHTML", "Fjord HTML Document"], ["FirefoxPDF", "Fjord PDF Document"]]) {
        const key = `Software\\Classes\\${prog}-${hash}`;
        set(key, { "": type });
        set(key + "\\Application", { ApplicationName: "Fjord", ApplicationCompany: "Fjord", ApplicationIcon: ico });
        set(key + "\\DefaultIcon", { "": ico });
      }
    }
  }
  const makeDefault = () => window.ShellService.setDefaultBrowser(false).then(nameForWindows);
  try { nameForWindows(); } catch (e) { console.error(e); } // also fixes a registration made before this

  async function showSetup() {
    if (!claimOverlay()) return;
    const firstRun = !prefs.getBoolPref("fjord.setup.done", false);
    const choice = {
      theme: prefs.getStringPref("fjord.theme", "dark"),
      protection: prefs.getStringPref("fjord.protection", "balanced"),
      search: firstRun ? "DuckDuckGo" : (await SearchService.getDefault()).name,
      // makeDefault and pin: switched on when their step is first shown, so Skip setup changes neither
    };
    applyTheme(choice.theme);
    // Asked here instead of by Firefox at its first start (Fjord.cfg turns those prompts off), so Windows' own "pin to
    // taskbar?" prompt comes after you chose it, with Fjord's name and icon from its Start menu shortcut.
    // Pinning needs that shortcut, which only the installed profile gets; the Mac pins to the Dock.
    let isDefault = true;
    try { isDefault = window.ShellService.isDefaultBrowser(false, false); } catch {}
    const canPin = (AppConstants.platform == "macosx" || (AppConstants.platform == "win" && installedProfile())) &&
      await window.ShellService.doesAppNeedPin().catch(() => false);

    // Same look as the installer: an ink drawing on the left, the logo and the step on the right
    const brand = () => h("div", { class: "ns-brand" }, h("img", { src: LOGO, alt: "" }), h("b", {}, "Fjord"));
    const head = (title, text) => [h("h2", {}, title), h("p", {}, text)];
    const ready = ["Ads and trackers blocked", "Cookie pop-ups rejected", "Secure connections only", "Tracking removed from links"];
    const steps = [
      () => [brand(),
        h("div", { class: "ns-end" },
          h("h1", {}, "Welcome to Fjord"),
          h("p", {}, "Ads and trackers are blocked from the first page you open. Make a few choices and you're set."),
          h("div", { class: "ns-actions" }, btn("ns-primary", "Get started", next), btn("ns-link", "Skip setup", finish)))],
      async () => [...head("Bring your things over", "Bookmarks, history and saved passwords from the browser you use now."),
        await importPanel(),
        nav()],
      () => [...head("Make it yours", "Fjord changes as you pick, so you can try each one."),
        themeChoices(choice.theme, v => applyTheme(choice.theme = v)),
        h("h3", {}, "Tabs"),
        tabChoices(),
        nav()],
      () => [...head("Choose your protection", "Every level blocks ads and trackers. The stricter ones cost a little convenience."),
        protectionPicker(choice.protection, v => (choice.protection = v)),
        nav()],
      async () => [...head("Pick a search engine", "Used when you search from the address bar."),
        await engineChoices(choice.search, v => (choice.search = v)),
        nav()],
      ...(!isDefault || canPin ? [() => [...head("Keep Fjord close", "Open links in Fjord and start it in one click. You can change both later."),
        h("div", { class: "ns-group" },
          isDefault ? null : switchRow("Make Fjord your default browser", "Links you open in other apps open in Fjord.",
            choice.makeDefault ??= true, v => (choice.makeDefault = v)),
          canPin ? switchRow(AppConstants.platform == "macosx" ? "Keep Fjord in the Dock" : "Pin Fjord to the taskbar",
            AppConstants.platform == "macosx" ? "Fjord stays in the Dock after you quit it." : "Windows asks you to confirm once setup is done.",
            choice.pin ??= true, v => (choice.pin = v)) : null),
        nav()]] : []),
      () => [brand(),
        h("div", { class: "ns-end" },
          h("h1", {}, "You're all set"),
          h("p", {}, "Fjord settings are at the top of the ☰ menu whenever you want to change something."),
          h("ul", { class: "ns-summary ns-ready" }, ...ready.map(t => h("li", { class: "ns-yes" }, icon("check"), t))),
          h("div", { class: "ns-actions" }, btn("ns-primary", "Start browsing", finish)))],
    ];

    const dots = h("div", { class: "ns-dots" }, ...steps.map(() => h("i")));
    const body = h("div", { class: "ns-body" });
    // The cabin while you set things up, the jetty once you're done: both are there, and the jetty fades in at the end
    const cabin = h("img", { src: `${ART}setup-cabin.jpg`, alt: "" });
    const jetty = h("img", { class: "ns-art-end", src: `${ART}setup-jetty.jpg`, alt: "" });
    const artBox = h("div", { class: "ns-setup-art" }, cabin, jetty);
    const overlay = openOverlay("Fjord setup",
      h("div", { class: "ns-card ns-setup" }, artBox, h("div", { class: "ns-setup-main" }, dots, body)));
    let step = 0;
    function nav() {
      return h("div", { class: "ns-actions ns-step-actions" }, btn("ns-link ns-back", "Back", back), btn("ns-primary", "Continue", next));
    }
    async function show(i) {
      // Content slides in from the side you're heading to: from the right going on, from the left going back
      body.style.setProperty("--dir", i < step ? -1 : 1);
      step = i;
      [...dots.children].forEach((d, j) => { d.toggleAttribute("on", j <= i); d.toggleAttribute("now", j === i); });
      body.replaceChildren(...await steps[i]());
      // Pieces arrive one after another (capped, so a long list doesn't keep you waiting)
      [...body.children].forEach((c, n) => c.style.setProperty("--i", Math.min(n, 6)));
      body.querySelectorAll(".ns-end > *").forEach((c, n) => c.style.setProperty("--i", Math.min(n + 1, 6)));
      body.querySelectorAll(":is(.ns-tiles, .ns-options, .ns-pills, .ns-sources) > button")
        .forEach((b, n) => b.style.setProperty("--j", Math.min(n, 7)));
      artBox.toggleAttribute("done", i === steps.length - 1);
      body.querySelector(".ns-primary")?.focus();
    }
    function next() { show(step + 1); }
    function back() { show(step - 1); }
    async function finish() {
      overlay.remove();
      FJORD.overlayOpen = false;
      applyTheme(choice.theme);
      applyProtection(choice.protection);
      prefs.setBoolPref("fjord.setup.done", true);
      if (choice.makeDefault) makeDefault().catch(console.error);
      if (choice.pin) Promise.resolve(FJORD.shortcut).then(() => window.ShellService.pinToTaskbar()).catch(console.error);
      await setDefaultEngine(choice.search);
    }
    on(overlay, "keydown", e => { if (e.key === "Escape") finish(); });
    show(0);
  }

  // ---------- Settings ----------
  const { ALLOW_ACTION } = Ci.nsIPermissionManager;
  const SESSION = Ci.nsICookiePermission.ACCESS_SESSION;

  const aiOn = () => prefs.getStringPref("browser.ai.control.default", "available") !== "blocked";
  function setAI(on) {
    prefs.setStringPref("browser.ai.control.default", on ? "available" : "blocked");
    for (const p of ["browser.ml.chat.enabled", "browser.ml.linkPreview.enabled"]) prefs.setBoolPref(p, on);
  }

  async function showSettings(section = "home") {
    if (!claimOverlay()) return;
    // keys: extra words the settings search matches, besides the label
    let SECTIONS = {
      home: { label: "Overview", render: homeSection },
      appearance: {
        label: "Appearance", desc: "How Fjord looks, and where your tabs go.", keys: "theme dark light system tabs vertical side sidebar layout",
        render: () => [
          h("h3", {}, "Theme"),
          themeChoices(prefs.getStringPref("fjord.theme", "dark"), applyTheme),
          h("h3", {}, "Tabs"),
          tabChoices(),
        ],
      },
      privacy: {
        label: "Privacy", desc: "Every level blocks ads and trackers. The stricter ones cost a little convenience.",
        keys: "protection shields trackers ads cookies https secure fingerprint ghost strict ai chatbot banner pop-ups gpc links signed in forget passwords locked windows account",
        render: () => [
          h("h3", {}, "Protection level"),
          protectionPicker(prefs.getStringPref("fjord.protection", "balanced"), applyProtection),
          h("p", { class: "ns-quiet ns-note" }, "Site not working? Turn Shields off for just that site with the shield in the address bar."),
          h("h3", {}, "More protections"),
          h("div", { class: "ns-group" },
            prefSwitch("Always use secure connections", "Fjord warns you before opening a site that doesn't support HTTPS.",
              "dom.security.https_only_mode"),
            switchRow("Reject cookie pop-ups", "Clicks “Reject” for you on sites Fjord recognises. The rest still ask.",
              prefs.getIntPref("cookiebanners.service.mode", 0) > 0,
              v => ["cookiebanners.service.mode", "cookiebanners.service.mode.privateBrowsing"].forEach(p => prefs.setIntPref(p, v ? 1 : 0))),
            prefSwitch("Ask sites not to sell or share your data", "Sends the Global Privacy Control signal. In some places, sites must obey it by law.",
              "privacy.globalprivacycontrol.enabled"),
            prefSwitch("Remove tracking from links", "Strips codes like fbclid from links you open, and adds “Copy clean link” to the right-click menu.",
              "privacy.query_stripping.enabled", "privacy.query_stripping.enabled.pbmode", "privacy.query_stripping.strip_on_share.enabled"),
            prefSwitch("Skip tracking redirects", "Links that pass through Google, Facebook or others first go straight to the real site, so the middleman never sees your click.",
              "fjord.debounce.enabled"),
            switchRow("Randomise your fingerprint", "Every site gets slightly different, made-up canvas, WebGL and audio readings, new each time Fjord starts, so sites can't use them to recognise you. Turn it off if a drawing or audio site acts up.",
              prefs.getBoolPref(RANDOMISE, true), v => { prefs.setBoolPref(RANDOMISE, v); applyFingerprinting(); }),
            switchRow("Private YouTube player", "YouTube videos play on their own in YouTube's privacy-enhanced player: no recommendations, comments or personalised ads, and nothing goes into your YouTube history. “Watch on YouTube” in the player opens the real page.",
              youtube.enabled(), youtube.setEnabled),
            switchRow("Mozilla's AI features", "The AI chatbot sidebar and AI link previews. Page translation keeps working either way, on your computer.",
              aiOn(), setAI)),
          h("h3", {}, "Safety"),
          h("div", { class: "ns-group" },
            prefSwitch("Warn me about lookalike sites", "Stops sites named to look like a popular one, like paypa1.com, before they load. Checked on your computer.",
              "fjord.lookalike.enabled"),
            prefSwitch("Warn me if a site changes what I copy", "Some sites swap copied text, like a crypto wallet address, for their own. Fjord tells you and lets you copy the real text.",
              "fjord.clipboardGuard.enabled"),
            prefSwitch("Warn me about hacked sites", "Shows a warning in Passwords when a site you have a saved password for has been breached.",
              "signon.management.page.breach-alerts.enabled"),
            switchRow("Show the Forget button", "One click in the toolbar deletes the last 5 minutes, 2 hours or 24 hours of history and cookies.",
              forgetButtonShown(), showForgetButton)),
          keylock?.active() ? h("p", { class: "ns-quiet ns-note" }, "Saved passwords are locked to this Windows account. A copy of your Fjord folder can't unlock them on another computer or account, so export them in Passwords before you move.") : null,
          h("h3", {}, "For extra privacy"),
          h("div", { class: "ns-group" },
            prefSwitch("Hide your window size", "Adds a thin border around pages, so sites can't tell your exact window size. Mullvad Browser does this too.",
              "privacy.resistFingerprinting.letterboxing"),
            switchRow("Hardened mode", "Turns off the parts attackers target most: the JavaScript speed booster, WebAssembly and WebGL. Sites get slower, and 3D maps and some games won't work. Applies to pages you open next.",
              hardened(), setHardened)),
          ...siteLists(),
        ],
      },
      sidebar: {
        label: "Sidebar", desc: "Sites like Spotify and WhatsApp, one click away in the sidebar. They stay signed in, even in Ghost mode.",
        keys: "sidebar apps spotify whatsapp discord telegram messenger slack gmail outlook proton notion chatgpt claude music web panels",
        render: async () => {
          const reopen = () => open("sidebar");
          const presetIds = new Set(apps.PRESETS.map(p => p.id));
          const own = apps.enabled().filter(a => !presetIds.has(a.id));
          return [
            h("p", { class: "ns-note" }, "Open the sidebar with the sidebar button at the far left of the toolbar."),
            h("h3", {}, "Apps"),
            h("div", { class: "ns-group" }, ...await Promise.all(apps.PRESETS.map(a => appRow(a, true, reopen)))),
            h("h3", {}, "Your own sites"),
            own.length ? h("div", { class: "ns-group" }, ...await Promise.all(own.map(a => appRow(a, false, reopen)))) : null,
            addSiteForm(reopen),
          ];
        },
      },
      newtab: {
        label: "New tab", desc: "Choose what your new tab shows.", keys: "new tab stats time saved data saved week summary clock photos background customize own picture image wallpaper",
        render: ({ reopen }) => [
          h("h3", {}, "Privacy stats"),
          h("div", { class: "ns-group" }, ...["blocked", "time", "data", "week"].map(k => prefSwitch(NEWTAB[k][0], NEWTAB[k][1], `fjord.newtab.${k}`))),
          h("h3", {}, "Look"),
          h("div", { class: "ns-group" }, ...["clock", "photos"].map(k => prefSwitch(NEWTAB[k][0], NEWTAB[k][1], `fjord.newtab.${k}`))),
          h("h3", {}, "Your own picture"),
          h("div", { class: "ns-group" }, prefs.getStringPref(OWN_PHOTO, "")
            ? h("div", { class: "ns-list-row" }, h("span", {}, "Your picture is on every new tab, instead of the landscapes."),
              h("span", { class: "ns-row" }, btn("ns-link", "Change", () => chooseOwnPhoto(reopen)),
                btn("ns-link", "Remove", () => setOwnPhoto(null).then(reopen, console.error))))
            : h("div", { class: "ns-list-row" }, h("span", { class: "ns-quiet" }, "A photo of your own instead of the landscapes. It stays on this computer."),
              btn("ns-secondary", "Choose a picture…", () => chooseOwnPhoto(reopen)))),
        ],
      },
      connection: {
        label: "Connection", desc: "Who can see which sites you visit.", keys: "dns doh secure dns vpn ip address network quad9 mullvad cloudflare provider proxy socks pac own",
        render: ctx => [
          h("h3", {}, "Secure DNS"),
          h("p", {}, "Opening a site starts with asking a DNS server where it is. Secure DNS encrypts that question, so your internet provider and the Wi-Fi owner can't read it."),
          choices("ns-options", DNS.map(d => ({ value: d.value, content: [h("span", {}, h("b", {}, d.name), h("span", {}, d.text))] })), currentDNS(), setDNS),
          h("h3", {}, "Hide your IP address"),
          h("p", {}, "Sites can see your IP address, which shows roughly where you are. Mozilla's free VPN, built into Firefox, hides it."),
          h("div", { class: "ns-group" },
            prefSwitch("Show the VPN button in the toolbar", "Needs a free Mozilla account. There's a monthly data limit.", "browser.ipProtection.enabled")),
          ...(Fjord.proxySettings?.(ctx) ?? []), // features/proxy.js
        ],
      },
      search: {
        label: "Search", desc: "Used when you search from the address bar.", keys: "engine duckduckgo google bing address bar private",
        render: async () => [
          await engineChoices((await SearchService.getDefault()).name, setDefaultEngine),
          h("h3", {}, "In private windows"),
          h("p", {}, "A separate choice, so private searches can go to a search engine that doesn't track you."),
          await engineChoices((await SearchService.getDefaultPrivate()).name, setPrivateEngine),
        ],
      },
      import: {
        label: "Import", desc: "Bring over bookmarks, history and saved passwords from another browser.", keys: "chrome edge brave opera bookmarks passwords history",
        render: async () => [await importPanel()],
      },
      about: {
        label: "About", keys: "version update firefox setup",
        render: async () => [
          h("div", { class: "ns-about" }, h("img", { src: LOGO, alt: "" }),
            h("span", {}, h("b", {}, `Fjord ${await fjordVersion()}`), h("span", {}, `Built on Firefox ${Services.appinfo.version}`))),
          h("p", {}, "Fjord keeps itself and Firefox's security fixes up to date."),
          btn("ns-secondary", "Run setup again", () => { close(); showSetup(); }),
        ],
      },
    };
    // Sections added by the feature scripts (features/*.js), each placed after the section it names
    const order = Object.keys(SECTIONS);
    for (const [key, s] of Object.entries(Fjord.sections)) order.splice(order.indexOf(s.after) + 1 || order.length, 0, key);
    SECTIONS = Object.fromEntries(order.map(k => [k, SECTIONS[k] ?? Fjord.sections[k]]));

    // A summary of every section, each card opening its section
    async function homeSection() {
      // uBlock's count can take a while on a fresh profile (it's still installing); the page doesn't wait for it
      const uboCount = Promise.race([ublock.totalBlocked().catch(() => 0), new Promise(r => setTimeout(() => r(0), 500))]);
      const [etp, ubo] = await Promise.all([trackingDB.sumAllEvents(), uboCount]);
      const level = LEVELS.find(l => l.value === prefs.getStringPref("fjord.protection", "balanced")) ?? LEVELS[0];
      const theme = THEMES.find(t => t.value === prefs.getStringPref("fjord.theme", "dark")) ?? THEMES[0];
      const dns = DNS.find(d => d.value === currentDNS()) ?? DNS[1];
      const card = (key, title, sub) => on(h("button", { class: "ns-home-card" }, badge(key),
        h("span", {}, h("b", {}, title), h("span", {}, sub))), "click", () => open(key));
      let isDefault = true;
      try { isDefault = window.ShellService.isDefaultBrowser(false, false); } catch {}
      return [
        h("div", { class: "ns-banner" }, scene("ns-banner-art"),
          h("div", { class: "ns-banner-text" }, h("b", {}, (etp + ubo).toLocaleString()), h("span", {}, "ads and trackers blocked so far"))),
        isDefault ? null : h("div", { class: "ns-callout" },
          h("span", {}, h("b", {}, "Fjord isn't your default browser"), h("span", {}, "Links from other apps open somewhere else.")),
          btn("ns-primary", "Make default", async e => {
            try { await makeDefault(); } catch (err) { console.error(err); }
            e.target.closest(".ns-callout").remove();
          })),
        h("div", { class: "ns-home-grid" },
          card("privacy", `${level.name} protection`, "Change how strict Fjord is"),
          card("appearance", `${theme.name} theme`, prefs.getBoolPref("sidebar.verticalTabs", false) ? "Tabs on the side" : "Tabs on top"),
          card("connection", dns.value ? `Secure DNS: ${dns.name}` : "Secure DNS is off", "Hide the sites you visit from your provider"),
          card("import", "Import", "From Chrome, Edge and other browsers")),
      ];
    }

    // Same permissions the Shields panel sets
    function siteLists() {
      const rows = (type, cap) => Services.perms.getAllByTypes([type]).filter(p => p.capability === cap).map(p =>
        h("div", { class: "ns-list-row" }, h("span", {}, p.principal.host),
          btn("ns-link", "Remove", () => { Services.perms.removePermission(p); open("privacy"); })));
      const keep = rows("persist-data-on-shutdown", ALLOW_ACTION), forget = rows("cookie", SESSION);
      const empty = () => h("p", { class: "ns-quiet ns-list-row" }, "None yet. Add the site you're on from the shield in the address bar.");
      return [
        h("h3", {}, "Stay signed in"),
        h("p", {}, "In Ghost mode, these sites keep their cookies when Fjord closes."),
        h("div", { class: "ns-group" }, ...(keep.length ? keep : [empty()])),
        h("h3", {}, "Forget when Fjord closes"),
        h("p", {}, "In Standard and Strict, these sites lose their cookies and data when Fjord closes."),
        h("div", { class: "ns-group" }, ...(forget.length ? forget : [empty()])),
      ];
    }

    const find = h("input", { type: "search", class: "ns-find", placeholder: "Search settings", "aria-label": "Search settings" });
    const navEl = h("nav", { class: "ns-nav", "aria-label": "Settings sections" });
    const pane = h("div", { class: "ns-pane" });
    const closeBtn = h("button", { class: "ns-close", "aria-label": "Close settings", title: "Close" }, h("img", { src: "chrome://global/skin/icons/close.svg", alt: "" }));
    const overlay = openOverlay("Fjord settings", h("div", { class: "ns-card ns-settings" },
      h("aside", { class: "ns-side" }, find, navEl), pane, closeBtn));
    for (const [key, s] of Object.entries(SECTIONS)) {
      const b = btn("", "", () => open(key));
      b.dataset.key = key;
      b.append(key === "home" ? h("img", { class: "ns-badge ns-logo", src: LOGO, alt: "" }) : badge(key), s.label);
      navEl.append(b);
    }
    on(find, "input", () => {
      const q = find.value.trim().toLowerCase();
      for (const b of navEl.children) {
        const s = SECTIONS[b.dataset.key];
        b.hidden = !!q && !`${s.label} ${s.keys ?? ""}`.toLowerCase().includes(q);
      }
    });
    on(find, "keydown", e => { if (e.key === "Enter") navEl.querySelector("button:not([hidden])")?.click(); });

    let shown = 0; // a slow section (import, overview) must not replace one opened after it
    async function open(key) {
      const me = ++shown;
      for (const b of navEl.children) b.toggleAttribute("aria-current", b.dataset.key === key);
      const s = SECTIONS[key];
      const head = key === "home"
        ? h("header", { class: "ns-head" }, h("div", {}, h("h2", {}, "Fjord settings"), h("p", {}, "Everything Fjord does for you, in one place.")))
        : h("header", { class: "ns-head" }, badge(key, "ns-badge-lg"), h("div", {}, h("h2", {}, s.label), s.desc ? h("p", {}, s.desc) : null));
      const body = (await s.render({ reopen: () => open(key), close })).filter(Boolean);
      if (me !== shown) return;
      pane.replaceChildren(head, ...body);
      pane.scrollTop = 0;
    }
    function close() {
      overlay.remove();
      FJORD.overlayOpen = false;
    }
    on(closeBtn, "click", close);
    on(overlay, "keydown", e => { if (e.key === "Escape") close(); });
    on(overlay, "click", e => { if (e.target === overlay) close(); });
    await open(section in SECTIONS ? section : "home");
    find.focus();
  }

  // ---------- Lookalike-site warning ----------
  // privacy.sys.mjs has already stopped the page from loading; this covers the tab with the choice
  function showLookalike(browser, url, like) {
    const stack = browser.parentElement;
    stack.querySelector(".ns-guard")?.remove();
    const host = new URL(url).hostname;
    const guard = h("div", { class: "ns-guard", role: "alertdialog", "aria-label": "Possible fake site" },
      h("div", { class: "ns-card ns-guard-card" },
        h("img", { class: "ns-guard-icon", src: "chrome://global/skin/icons/warning.svg", alt: "" }),
        h("h2", {}, "Is this the site you meant?"),
        h("p", {}, h("b", {}, host), ` looks a lot like `, h("b", {}, like), `. Fake sites copy popular names to steal passwords and card numbers.`),
        h("div", { class: "ns-actions" },
          btn("ns-link", `Open ${host} anyway`, () => {
            privacy.allowLookalike(host);
            guard.remove();
            browser.fixupAndLoadURIString(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          }),
          btn("ns-secondary", "Go back", () => {
            guard.remove();
            if (browser.canGoBack) browser.goBack();
            else browser.fixupAndLoadURIString(FJORD.newtab, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          }),
          btn("ns-primary", `Go to ${like}`, () => {
            guard.remove();
            browser.fixupAndLoadURIString(`https://${like}/`, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          }))));
    stack.append(guard);
    if (browser === gBrowser.selectedBrowser) guard.querySelector(".ns-primary").focus();
  }

  // ---------- Sidebar apps ----------
  // Each app is a panel in Firefox's own sidebar, registered the way extension sidebars are, then pointed at
  // Fjord's webpanel.html. Apps keep their sign-in when Ghost mode clears everything else.
  const apps = ChromeUtils.importESModule("resource://fjord/apps.sys.mjs");
  const appCommand = app => `fjord-app-${app.id}`;
  async function registerSidebarApps() {
    if (!window.SidebarController) return;
    await SidebarController.promiseInitialized;
    const list = apps.enabled();
    for (const id of [...SidebarController.sidebars.keys()]) {
      if (id.startsWith("fjord-app-") && !list.some(a => appCommand(a) === id)) SidebarController.removeExtension(id);
    }
    for (const app of list) {
      const id = appCommand(app), iconUrl = await apps.icon(app);
      if (SidebarController.sidebars.has(id)) SidebarController.setExtensionAttributes(id, { iconUrl, label: app.name }, false);
      else SidebarController.registerExtension(id, { title: app.name, iconUrl, extensionId: id, menuId: `menu-${id}` });
      SidebarController.sidebars.get(id).url = `chrome://fjord/content/webpanel.html?app=${encodeURIComponent(app.id)}`;
      const principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin(new URL(app.url).origin);
      Services.perms.addFromPrincipal(principal, "persist-data-on-shutdown", ALLOW_ACTION);
    }
  }
  registerSidebarApps().catch(console.error);
  const appsObserver = { observe: () => registerSidebarApps().catch(console.error) };
  prefs.addObserver("fjord.sidebar.apps", appsObserver);
  window.addEventListener("unload", () => prefs.removeObserver("fjord.sidebar.apps", appsObserver));

  // Settings rows for the sidebar section
  async function appRow(app, preset, reopen) {
    const label = h("span", { class: "ns-app-name" }, h("img", { src: await apps.icon(app), alt: "" }), h("span", {}, h("b", {}, app.name), h("span", {}, new URL(app.url).hostname)));
    if (!preset) return h("div", { class: "ns-list-row ns-app-row" }, label, btn("ns-link", "Remove", () => { apps.remove(app.id); reopen(); }));
    const input = h("input", { type: "checkbox", role: "switch", "aria-label": `Show ${app.name} in the sidebar` });
    input.checked = apps.enabled().some(a => a.id === app.id);
    input.addEventListener("change", () => apps.setPreset(app.id, input.checked));
    return h("label", { class: "ns-switch-row ns-app-row" }, label, input);
  }
  function addSiteForm(reopen) {
    const name = h("input", { type: "text", placeholder: "Name (optional)", "aria-label": "Name" });
    const address = h("input", { type: "text", placeholder: "Address, like music.apple.com", "aria-label": "Address" });
    const status = h("p", { class: "ns-quiet", role: "status" });
    const add = btn("ns-secondary", "Add", () => {
      if (!address.value.trim()) return address.focus();
      if (!apps.addCustom(name.value, address.value.trim())) status.textContent = "That doesn't look like a web address.";
      else reopen();
    });
    address.addEventListener("keydown", e => { if (e.key === "Enter") add.click(); });
    return h("div", { class: "ns-add-site" }, h("div", { class: "ns-row" }, name, address, add), status);
  }

  // A short notice over one tab's page (top right), gone after a few seconds
  function toast(browser, text, action, ms = 7000) {
    const stack = browser.parentElement;
    stack.querySelector(".ns-toast")?.remove();
    const el = h("div", { class: "ns-toast", role: "status" }, h("span", {}, text),
      action ? btn("ns-link", action[0], () => { el.remove(); action[1](); }) : null);
    stack.append(el);
    setTimeout(() => el.remove(), ms);
  }

  window.Fjord = {
    h, on, btn, icon, badge, choices, switchRow, prefSwitch, toast, showSettings, showLookalike, FPP_STRICT, applyTheme, THEMES,
    siteOf: host => privacy.baseDomain(host),
    sections: {}, // settings sections from the feature scripts: { key: { label, desc, keys, after, render(ctx) } }
  };
  Services.scriptloader.loadSubScript("resource://fjord/shields.js", window);
  for (const f of ["memory", "mist", "proveit", "report", "permissions", "design", "spaces", "proxy", "applock", "youtube", "hide", "commandbar", "glance", "sync", "split", "calm", "folders"]) {
    try {
      Services.scriptloader.loadSubScript(`resource://fjord/features/${f}.js`, window);
    } catch (e) {
      console.error(`Fjord feature ${f}:`, e);
    }
  }
  if (!prefs.getBoolPref("fjord.setup.done", false) && !PrivateBrowsingUtils.isWindowPrivate(window)) showSetup();

  // ---------- Once per session ----------
  if (FJORD.sessionChecked) return;
  FJORD.sessionChecked = true;

  // Copies from before randomising (1.0.6) get it at their protection level
  if (!prefs.getBoolPref("fjord.fingerprint.applied", false)) {
    applyFingerprinting();
    prefs.setBoolPref("fjord.fingerprint.applied", true);
  }

  // Reader view in Fjord's look (reader.css); registered sheets reach every tab
  const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
  const readerSheet = Services.io.newURI("resource://fjord/reader.css");
  if (!sss.sheetRegistered(readerSheet, sss.AUTHOR_SHEET)) sss.loadAndRegisterSheet(readerSheet, sss.AUTHOR_SHEET);

  // Shields replaces uBlock's toolbar button; uBlock moves to the extensions menu once
  if (!prefs.getBoolPref("fjord.ublock.moved", false)) {
    CustomizableUI.addWidgetToArea("ublock0_raymondhill_net-browser-action", CustomizableUI.AREA_ADDONS);
    prefs.setBoolPref("fjord.ublock.moved", true);
  }
  // Once: the Forget button in the toolbar, and DuckDuckGo in private windows (both can be changed in settings)
  if (!prefs.getBoolPref("fjord.forget.added", false)) {
    showForgetButton(true);
    prefs.setBoolPref("fjord.forget.added", true);
  }
  // shortcut: Firefox resets this pref's default to false at startup after Fjord.cfg sets it, so it's switched on
  // once as the user's own setting; find what resets it if more prefs behave like this
  if (!prefs.getBoolPref("fjord.breachAlerts.set", false)) {
    prefs.setBoolPref("signon.management.page.breach-alerts.enabled", true);
    prefs.setBoolPref("fjord.breachAlerts.set", true);
  }
  if (!prefs.getBoolPref("fjord.privateSearch.set", false)) {
    setPrivateEngine("DuckDuckGo").then(() => prefs.setBoolPref("fjord.privateSearch.set", true), console.error);
  }

  // Windows names taskbar buttons (and its pin prompt) after the Start menu shortcut that carries the window's taskbar ID.
  // Only for the installed profile, so test profiles don't take it over.
  FJORD.shortcut = Promise.resolve();
  const gre = Services.dirsvc.get("GreD", Ci.nsIFile);
  if (AppConstants.platform == "win" && installedProfile()) {
    const shell = Cc["@mozilla.org/browser/shell-service;1"].getService(Ci.nsIWindowsShellService);
    const taskbarID = Cc["@mozilla.org/windows-taskbar;1"].getService(Ci.nsIWinTaskbar).defaultGroupId;
    const icon = gre.clone();
    icon.append("fjord");
    icon.append("fjord.ico");
    FJORD.shortcut = shell.createShortcut(Services.dirsvc.get("XREExeF", Ci.nsIFile), ["-profile", PathUtils.profileDir], "Fjord",
      icon, 0, taskbarID, "Programs", "Fjord.lnk").catch(console.error);
  }

  // Fjord turns off Firefox's updater and updates itself (the updater task, or the build scripts).
  // Firefox ships fixes every few weeks, so a build this old means updating has stopped working.
  const id = Services.appinfo.appBuildID; // yyyymmddhhmmss
  const ageDays = (Date.now() - Date.UTC(id.slice(0, 4), id.slice(4, 6) - 1, id.slice(6, 8))) / 864e5;
  if (ageDays > 49) {
    gNotificationBox.appendNotification("fjord-outdated", {
      label: `Fjord hasn't updated in ${Math.round(ageDays)} days and may be missing security fixes. Reinstall Fjord or run its updater to fix this.`,
      priority: gNotificationBox.PRIORITY_WARNING_HIGH,
    });
  }

  // ---------- What's new, once after Fjord updated itself ----------
  // whatsnew.json has a few lines per version; release.ps1 uses the same lines for the release notes
  const newer = (a, b) => {
    const [x, y] = [a, b].map(v => v.split(".").map(Number));
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  };
  (async () => {
    const now = await fjordVersion();
    const seen = prefs.getStringPref("fjord.version.seen", "");
    if (!now || seen === now) return;
    prefs.setStringPref("fjord.version.seen", now);
    // A new install has nothing to catch up on. Copies from before 1.0.5 never saved a version: they get this one's lines
    if (!prefs.getBoolPref("fjord.setup.done", false) || PrivateBrowsingUtils.isWindowPrivate(window)) return;
    const notes = await fetch("resource://fjord/whatsnew.json").then(r => r.json());
    const lines = Object.entries(notes).filter(([v]) => seen ? newer(v, seen) && !newer(v, now) : v === now).flatMap(([, l]) => l);
    if (lines.length) showWhatsNew(now, lines);
  })().catch(console.error);

  function showWhatsNew(version, lines) {
    if (!claimOverlay()) return;
    const close = () => { overlay.remove(); FJORD.overlayOpen = false; };
    const overlay = openOverlay("What's new in Fjord", h("div", { class: "ns-card ns-whatsnew" },
      h("div", { class: "ns-about" }, h("img", { src: LOGO, alt: "" }),
        h("span", {}, h("h2", {}, `Fjord updated to ${version}`), h("span", {}, "Here's what's new."))),
      h("ul", { class: "ns-summary" }, ...lines.map(t => h("li", { class: "ns-yes" }, icon("check"), t))),
      h("div", { class: "ns-actions" },
        btn("ns-link", "All changes", () => {
          close();
          gBrowser.selectedTab = gBrowser.addTrustedTab(`https://github.com/Elias-Mathisen/fjord/releases/tag/v${version}`);
        }),
        btn("ns-primary", "Got it", close))));
    on(overlay, "keydown", e => { if (e.key === "Escape") close(); });
    on(overlay, "click", e => { if (e.target === overlay) close(); });
    overlay.querySelector(".ns-primary").focus();
  }
})();
