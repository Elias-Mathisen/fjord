// The command bar (Ctrl+K, ⌘K on a Mac): one box that finds Fjord's actions ("Lockdown on this site", "New Mist
// tab", "Forget this site"), your open tabs, bookmarks and history. Also the Shortcuts section of Fjord settings,
// which has the link preview switch too (features/glance.js). Loaded into each window by browser.js.
(() => {
  const { h, on, switchRow, prefSwitch } = Fjord;
  const prefs = Services.prefs;
  const ON = "fjord.commandBar.enabled";
  const MAC = AppConstants.platform == "macosx";
  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");

  // Firefox's own commands, by the id of their <command>
  const command = id => document.getElementById(id) && (() => document.getElementById(id).doCommand());
  const SECTIONS = [["privacy", "Privacy"], ["appearance", "Appearance"], ["sidebar", "Sidebar"], ["workspaces", "Spaces"], ["newtab", "New tab"],
    ["connection", "Connection"], ["search", "Search"], ["import", "Import"], ["shortcuts", "Shortcuts"], ["about", "About"]];

  function actions() {
    const b = gBrowser.selectedBrowser;
    const host = /^https?$/.test(b.currentURI.scheme) ? b.currentURI.host : null;
    const site = host && Fjord.siteOf(host);
    const s = Fjord.siteActions;
    const list = [
      { label: "New tab", keys: "open blank", run: command("cmd_newNavigatorTab") },
      { label: "New Mist tab", keys: "container throwaway forget cookies", run: () => Fjord.openMistTab() },
      { label: "New private window", keys: "incognito", run: () => OpenBrowserWindow({ private: true }) },
      ...(Fjord.workspaces?.actions() ?? []), // features/spaces.js
      ...(site ? [
        { label: `Forget ${site} now`, keys: "delete cookies data history sign out clear site", run: s.forget },
        ...Object.entries(s.LEVELS).map(([level, [name, desc]]) => ({
          label: `Shields ${name} on ${site}`, keys: `protection level dial block ${desc}`, run: () => s.setLevel(level) })),
        { label: `Hide part of ${site}…`, keys: "remove cookie banner popup element distraction sidebar", run: () => Fjord.hidePicker() },
      ] : []),
      gBrowser.selectedTab.splitview
        ? { label: "Undo split view", keys: "side by side separate unsplit close", run: command("Browser:SeparateTabSplitView") }
        : { label: "Split view", keys: "side by side two tabs", run: command("Browser:AddTabSplitView") },
      { label: "Reader view", keys: "read article text", run: command("View:ReaderView") },
      { label: "Picture-in-picture", keys: "video float pip", run: command("View:PictureInPicture") },
      { label: "Bookmark this page", keys: "save star favourite", run: command("Browser:AddBookmarkAs") },
      ...(Fjord.designTools ?? []).map(t => ({ label: t.label, keys: `design ${t.desc}`, run: t.run })),
      { label: "Downloads", keys: "files saved", run: command("Tools:Downloads") },
      { label: "History", keys: "visited pages", run: command("Browser:ShowAllHistory") },
      { label: "Passwords", keys: "logins saved", run: () => LoginHelper.openPasswordManager(window, { entryPoint: "mainmenu" }) },
      { label: "Clear recent history", keys: "delete forget cookies cache", run: command("Tools:Sanitize") },
      ...(prefs.getBoolPref("fjord.appLock.enabled", false) ? [{ label: "Lock Fjord", keys: "app lock away", run: command("key_fjordLock") }] : []),
      ...Fjord.THEMES.map(t => ({ label: `${t.name} theme`, keys: "appearance mode colour color", run: () => Fjord.applyTheme(t.value) })),
      { label: "Fjord settings", keys: "preferences options", run: () => Fjord.showSettings() },
      ...SECTIONS.map(([key, name]) => ({ label: `Settings: ${name}`, keys: "preferences options", run: () => Fjord.showSettings(key) })),
    ];
    return list.filter(a => a.run).map(a => ({ ...a, kind: "Action" }));
  }

  const words = q => q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text, ws) => { const t = text.toLowerCase(); return ws.every(w => t.includes(w)); };

  async function places(q) {
    const db = await PlacesUtils.promiseDBConnection();
    const like = `%${db.escapeStringForLIKE(q, "/")}%`;
    const rows = await db.executeCached(`
      SELECT h.url, h.title, EXISTS (SELECT 1 FROM moz_bookmarks b WHERE b.fk = h.id) AS bookmarked
      FROM moz_places h
      WHERE h.hidden = 0 AND h.url_hash BETWEEN hash('http', 'prefix_lo') AND hash('https', 'prefix_hi')
        AND (h.title LIKE :like ESCAPE '/' OR h.url LIKE :like ESCAPE '/')
      ORDER BY bookmarked DESC, h.frecency DESC LIMIT 6`, { like });
    return rows.map(r => ({ label: r.getResultByName("title") || r.getResultByName("url"), detail: r.getResultByName("url"),
      kind: r.getResultByName("bookmarked") ? "Bookmark" : "History", open: r.getResultByName("url") }));
  }

  const looksLikeAddress = q => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i.test(q) && !/\s/.test(q);

  let overlay = null;
  async function open() {
    if (overlay) return close();
    if (FJORD.overlayOpen || document.documentElement.hasAttribute("fjord-locked")) return;
    const input = h("input", { type: "text", class: "ns-cmd-input", role: "combobox", "aria-expanded": "true", "aria-controls": "ns-cmd-list",
      "aria-label": "Search tabs, bookmarks, history and actions", placeholder: "Search tabs, bookmarks, history and actions", spellcheck: "false" });
    const list = h("div", { class: "ns-cmd-list", id: "ns-cmd-list", role: "listbox" });
    overlay = h("div", { class: "ns-overlay ns-cmd-overlay" }, h("div", { class: "ns-card ns-cmd", role: "dialog", "aria-label": "Command bar" },
      h("div", { class: "ns-cmd-field" }, h("img", { src: "resource://fjord/illustrations/icons/search.svg", alt: "" }), input), list));
    document.body.append(overlay);
    FJORD.overlayOpen = true;
    FJORD.overlayOwner = window;
    let items = [], picked = 0, asked = 0;

    const draw = () => {
      list.replaceChildren(...items.map((it, i) => {
        const row = h("div", { class: "ns-cmd-item", role: "option", id: `ns-cmd-${i}`, "aria-selected": String(i === picked) },
          it.icon ? h("img", { src: it.icon, alt: "" }) : h("i"),
          h("span", {}, h("b", {}, it.label), it.detail ? h("span", {}, it.detail) : null),
          h("em", {}, it.kind));
        on(row, "mousemove", () => { if (picked !== i) { picked = i; mark(); } });
        on(row, "click", () => run(it));
        return row;
      }));
      input.setAttribute("aria-activedescendant", items.length ? `ns-cmd-${picked}` : "");
    };
    const mark = () => {
      [...list.children].forEach((r, i) => r.setAttribute("aria-selected", String(i === picked)));
      list.children[picked]?.scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", `ns-cmd-${picked}`);
    };

    async function update() {
      const q = input.value.trim(), ws = words(q), me = ++asked;
      const tabs = gBrowser.visibleTabs.filter(t => !t.selected && (!ws.length || matches(`${t.label} ${t.linkedBrowser.currentURI.spec}`, ws)))
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)).slice(0, ws.length ? 5 : 6)
        .map(t => ({ label: t.label, detail: t.linkedBrowser.currentURI.spec.replace(/^https?:\/\//, ""), kind: "Tab", icon: t.image || null, tab: t }));
      const acts = actions().filter(a => !ws.length ? false : matches(`${a.label} ${a.keys}`, ws)).slice(0, 6);
      const go = looksLikeAddress(q) ? [{ label: `Go to ${q}`, kind: "Open", open: /^https?:/i.test(q) ? q : `https://${q}` }] : [];
      items = [...go, ...acts, ...tabs];
      if (q) items.push({ label: `Search for “${q}”`, detail: (await SearchService.getDefault()).name, kind: "Search", search: q });
      if (me !== asked) return;
      picked = 0;
      draw();
      if (ws.length) {
        const found = await places(q).catch(e => (console.error(e), []));
        if (me !== asked || !found.length) return;
        items.splice(items.length - 1, 0, ...found.filter(f => !tabs.some(t => t.detail === f.detail.replace(/^https?:\/\//, ""))));
        draw();
      }
    }

    async function run(it) {
      close();
      if (it.tab) gBrowser.selectedTab = it.tab;
      else if (it.open) openTrustedLinkIn(it.open, "tab");
      else if (it.search) {
        const engine = await SearchService.getDefault();
        openTrustedLinkIn(engine.getSubmission(it.search).uri.spec, "tab");
      } else it.run?.();
    }

    on(input, "input", update);
    on(input, "keydown", e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (items.length) { picked = (picked + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length; mark(); }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (items[picked]) run(items[picked]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    on(overlay, "click", e => { if (e.target === overlay) close(); });
    await update();
    input.focus();
  }
  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    FJORD.overlayOpen = false;
  }
  Fjord.openCommandBar = open;

  // Ctrl+K is Firefox's "search the web" shortcut, which the address bar (Ctrl+L, Ctrl+E) does too
  const key = document.createXULElement("key");
  key.id = "key_fjordCommandBar";
  key.setAttribute("key", "K");
  key.setAttribute("modifiers", "accel");
  key.addEventListener("command", () => { if (prefs.getBoolPref(ON, true)) open(); else document.getElementById("Tools:Search")?.doCommand(); });
  document.getElementById("key_search")?.setAttribute("disabled", "true");
  document.getElementById("mainKeyset").append(key);

  Fjord.sections.shortcuts = {
    label: "Shortcuts", after: "appearance",
    desc: "Faster ways to get around Fjord.",
    keys: "command bar palette ctrl k keyboard link preview shift click glance peek hide hidden parts",
    render: ({ reopen }) => {
      const hidden = ChromeUtils.importESModule("resource://fjord/hidden.sys.mjs");
      const sites = hidden.all();
      return [
        h("div", { class: "ns-group" },
          prefSwitch("Command bar", `${MAC ? "⌘K" : "Ctrl+K"} finds open tabs, bookmarks, history and Fjord's actions, like Lockdown for this site or a new Mist tab.`, ON),
          prefSwitch("Link preview", "Shift-click a link to open it in a window over the page. Open it as a tab from there, or press Esc to close it.",
            "fjord.glance.enabled")),
        h("h3", {}, "Hidden parts of sites"),
        h("p", {}, "Right-click a part of a page and choose “Hide this” to hide it on that site from now on."),
        h("div", { class: "ns-group" }, ...(sites.length ? sites.map(({ site, count }) =>
          h("div", { class: "ns-list-row" }, h("span", {}, site, h("span", { class: "ns-quiet" }, ` · ${count} hidden`)),
            Fjord.btn("ns-link", "Show again", () => { hidden.remove(site); reopen(); })))
          : [h("p", { class: "ns-quiet ns-list-row" }, "Nothing hidden yet.")])),
      ];
    },
  };
})();
