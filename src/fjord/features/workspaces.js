// Workspaces (off unless switched on in settings): separate sets of tabs such as Work and Personal. Each workspace
// except Personal is a Firefox container, so it has its own cookies and sign-ins; switching hides the other
// workspaces' tabs. Pinned tabs, and tabs in containers no workspace owns (like Mist tabs), show everywhere.
// Switched from a Workspaces panel in the sidebar (workspaces.html). Loaded into each window by browser.js.
(() => {
  const { h, btn, switchRow } = Fjord;
  const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
  const prefs = Services.prefs;
  const ON = "fjord.workspaces.enabled", LIST = "fjord.workspaces.list", CURRENT = "fjord.workspaces.current";
  const PANEL = "fjord-workspaces";
  const PERSONAL = { id: "personal", name: "Personal", userContextId: 0 };

  const enabled = () => prefs.getBoolPref(ON, false);
  function list() {
    try {
      const l = JSON.parse(prefs.getStringPref(LIST, ""));
      if (Array.isArray(l) && l.length) return l;
    } catch {}
    return [PERSONAL];
  }
  const save = l => prefs.setStringPref(LIST, JSON.stringify(l));
  let current = prefs.getStringPref(CURRENT, "personal");
  const currentWs = () => list().find(w => w.id === current) ?? list()[0];
  const owner = tab => list().find(w => w.userContextId === tab.userContextId); // undefined: shows in every workspace
  const changed = () => window.dispatchEvent(new CustomEvent("FjordWorkspacesChanged"));

  function apply() {
    const ws = currentWs();
    for (const tab of gBrowser.tabs) {
      const o = owner(tab);
      if (!enabled() || tab.pinned || !o || o.id === ws.id) gBrowser.showTab(tab);
      else if (!tab.selected) gBrowser.hideTab(tab);
    }
  }

  function switchTo(id) {
    current = id;
    prefs.setStringPref(CURRENT, id);
    const ws = currentWs();
    const sel = gBrowser.selectedTab, o = owner(sel);
    if (o && o.id !== ws.id && !sel.pinned) {
      // Go to one of this workspace's tabs, or open a new one in it
      const tab = gBrowser.tabs.find(t => !t.pinned && owner(t)?.id === ws.id);
      gBrowser.selectedTab = tab ?? gBrowser.addTab(BROWSER_NEW_TAB_URL, { userContextId: ws.userContextId,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    }
    apply();
    changed();
  }

  function add(name) {
    name = name.trim();
    if (!name) return;
    const { userContextId } = ContextualIdentityService.create(name, "briefcase", "toolbar");
    const ws = { id: `ws-${Date.now()}`, name, userContextId };
    save([...list(), ws]);
    switchTo(ws.id);
  }

  function rename(id, name) {
    const l = list(), ws = l.find(w => w.id === id);
    if (!ws || !name.trim()) return;
    ws.name = name.trim();
    if (ws.userContextId) ContextualIdentityService.update(ws.userContextId, ws.name, "briefcase", "toolbar");
    save(l);
    changed();
  }

  async function remove(id) {
    const ws = list().find(w => w.id === id);
    if (!ws || ws.id === "personal") return;
    const n = gBrowser.tabs.filter(t => t.userContextId === ws.userContextId).length;
    if (!Services.prompt.confirm(window, `Delete ${ws.name}?`, `Its ${n} ${n === 1 ? "tab closes" : "tabs close"}, and its cookies and sign-ins are deleted.`)) return;
    if (current === id) switchTo("personal");
    save(list().filter(w => w.id !== id));
    ContextualIdentityService.closeContainerTabs(ws.userContextId);
    await new Promise(r => Services.clearData.deleteDataFromOriginAttributesPattern({ userContextId: ws.userContextId }, r));
    ContextualIdentityService.remove(ws.userContextId);
    changed();
  }

  const count = id => {
    const ws = list().find(w => w.id === id);
    return ws ? gBrowser.tabs.filter(t => !t.pinned && t.userContextId === ws.userContextId).length : 0;
  };
  Fjord.workspaces = { list, currentWs, switchTo, add, rename, remove, count, enabled };

  // New tabs open in the current workspace
  if (window.BrowserCommands?.openTab) {
    const openTab = BrowserCommands.openTab.bind(BrowserCommands);
    BrowserCommands.openTab = (options = {}) => {
      const ws = currentWs();
      if (!enabled() || !ws.userContextId || options.url) return openTab(options);
      return openTrustedLinkIn(BROWSER_NEW_TAB_URL, "tab", { userContextId: ws.userContextId });
    };
  }
  // A tab from another workspace that opens in the background is tucked away; selecting one switches workspace
  gBrowser.tabContainer.addEventListener("TabOpen", e => setTimeout(() => {
    const o = owner(e.target);
    if (enabled() && !e.target.selected && !e.target.pinned && o && o.id !== currentWs().id) gBrowser.hideTab(e.target);
    changed();
  }, 0));
  gBrowser.tabContainer.addEventListener("TabSelect", e => {
    const o = owner(e.target);
    if (enabled() && !e.target.pinned && o && o.id !== currentWs().id) switchTo(o.id);
  });
  gBrowser.tabContainer.addEventListener("TabClose", () => setTimeout(changed, 0));

  // The sidebar panel, there only while workspaces are on
  async function registerPanel() {
    if (!window.SidebarController) return;
    await SidebarController.promiseInitialized;
    if (!enabled()) {
      if (SidebarController.sidebars.has(PANEL)) SidebarController.removeExtension(PANEL);
      return;
    }
    if (!SidebarController.sidebars.has(PANEL)) {
      SidebarController.registerExtension(PANEL, { title: "Workspaces", iconUrl: "resource://fjord/illustrations/icons/workspaces.svg",
        extensionId: PANEL, menuId: `menu-${PANEL}` });
    }
    SidebarController.sidebars.get(PANEL).url = "chrome://fjord/content/workspaces.html";
  }
  const onPref = { observe: () => { apply(); registerPanel().catch(console.error); changed(); } };
  prefs.addObserver(ON, onPref);
  window.addEventListener("unload", () => prefs.removeObserver(ON, onPref));
  registerPanel().catch(console.error);
  // After the session's tabs are back
  if (enabled()) setTimeout(apply, 1500);

  Fjord.sections.workspaces = {
    label: "Workspaces", after: "sidebar",
    desc: "Separate sets of tabs, like Work and Personal. Each has its own cookies, so you can be signed in to two accounts at once.",
    keys: "workspaces spaces work personal profiles containers accounts tabs",
    render: ({ reopen }) => {
      const input = h("input", { type: "text", placeholder: "New workspace, like Work", "aria-label": "New workspace name" });
      const create = () => { add(input.value); reopen(); };
      input.addEventListener("keydown", e => { if (e.key === "Enter") create(); });
      return [
        h("div", { class: "ns-group" }, switchRow("Workspaces", "Switch between them from the Workspaces panel in the sidebar.",
          enabled(), v => { prefs.setBoolPref(ON, v); reopen(); })),
        enabled() ? h("h3", {}, "Your workspaces") : null,
        enabled() ? h("div", { class: "ns-group" }, ...list().map(ws => h("div", { class: "ns-list-row" },
          h("span", {}, h("b", {}, ws.name), h("span", { class: "ns-quiet" }, ` · ${count(ws.id)} tabs${ws.id === currentWs().id ? " · open now" : ""}`)),
          ws.id === currentWs().id ? null : btn("ns-link", "Switch", () => { switchTo(ws.id); reopen(); }),
          ws.id === "personal" ? null : btn("ns-link", "Delete", async () => { await remove(ws.id); reopen(); })))) : null,
        enabled() ? h("div", { class: "ns-add-site" }, h("div", { class: "ns-row" }, input, btn("ns-secondary", "Add", create))) : null,
      ];
    },
  };
})();
