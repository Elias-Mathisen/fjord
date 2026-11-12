// Spaces (on unless switched off in settings): separate sets of tabs such as Work and Personal, each with its own
// colour. Each space except Personal is a Firefox container, so it has its own cookies and sign-ins; switching hides
// the other spaces' tabs. Pinned tabs, and tabs in containers no space owns (like Mist tabs), show everywhere.
// Switched from the button at the start of the tabs, the command bar, or by selecting a tab of another space.
// The prefs keep their old fjord.workspaces names (Spaces were called Workspaces before 2.0). Loaded into each window
// by browser.js.
(() => {
  const { h, btn, switchRow } = Fjord;
  const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
  const { CustomizableUI } = ChromeUtils.importESModule("moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs");
  const prefs = Services.prefs;
  const ON = "fjord.workspaces.enabled", LIST = "fjord.workspaces.list", CURRENT = "fjord.workspaces.current";
  const WIDGET = "fjord-spaces-button";
  const PERSONAL = { id: "personal", name: "Personal", userContextId: 0 };
  // Firefox's container colours, so a space's tabs get the same colour line
  const COLORS = { blue: "#37adff", turquoise: "#00c79a", green: "#51cd00", yellow: "#ffcb00", orange: "#ff9f00",
    red: "#ff613d", pink: "#ff4bda", purple: "#af51f5" };
  const GREY = "#8f8f9d";
  const system = () => Services.scriptSecurityManager.getSystemPrincipal();

  const enabled = () => prefs.getBoolPref(ON, true);
  function list() {
    try {
      const l = JSON.parse(prefs.getStringPref(LIST, ""));
      if (Array.isArray(l) && l.length) return l;
    } catch {}
    return [{ ...PERSONAL }];
  }
  const save = l => prefs.setStringPref(LIST, JSON.stringify(l));
  let current = prefs.getStringPref(CURRENT, "personal");
  const currentWs = () => list().find(w => w.id === current) ?? list()[0];
  const owner = tab => list().find(w => w.userContextId === tab.userContextId); // undefined: shows in every space
  // Whether a tab shows in a space. The tabs of a split view stay together: in every space any of them belongs to.
  const here = (tab, ws = currentWs()) => (tab.splitview?.tabs ?? [tab]).some(t => t.pinned || !owner(t) || owner(t).id === ws.id);
  // Spaces from before 2.0 have no colour of their own; their container's
  const colorName = ws => ws.color ?? (ws.userContextId ? ContextualIdentityService.getPublicIdentityFromId(ws.userContextId)?.color : null);
  const colorOf = ws => COLORS[colorName(ws)] ?? GREY;
  const dot = ws => h("span", { class: "ns-space-dot", style: `--c: ${colorOf(ws)}` });
  const changed = () => Services.obs.notifyObservers(null, "fjord-spaces-changed"); // every window updates its button

  function apply() {
    const ws = currentWs();
    for (const tab of gBrowser.tabs) {
      if (!enabled() || here(tab, ws)) gBrowser.showTab(tab);
      else if (!tab.selected) gBrowser.hideTab(tab);
    }
    // A tab folder (Firefox's tab groups) shows in the spaces its tabs are in, not as an empty label elsewhere
    for (const group of gBrowser.tabGroups ?? []) group.hidden = group.tabs.every(t => t.hidden);
  }

  function switchTo(id) {
    current = id;
    prefs.setStringPref(CURRENT, id);
    const ws = currentWs();
    if (!here(gBrowser.selectedTab, ws)) {
      // Go to one of this space's tabs, or open a new one in it
      const tab = gBrowser.tabs.find(t => !t.pinned && owner(t)?.id === ws.id);
      gBrowser.selectedTab = tab ?? gBrowser.addTab(BROWSER_NEW_TAB_URL, { userContextId: ws.userContextId, triggeringPrincipal: system() });
    }
    apply();
    changed();
  }

  function add(name) {
    name = name.trim();
    if (!name) return;
    const used = new Set(list().map(colorName));
    const color = Object.keys(COLORS).find(c => !used.has(c)) ?? Object.keys(COLORS)[list().length % 8];
    const { userContextId } = ContextualIdentityService.create(name, "circle", color);
    const ws = { id: `ws-${Date.now()}`, name, userContextId, color };
    save([...list(), ws]);
    switchTo(ws.id);
  }

  // Changes the name or colour; a container space's container follows, so its tabs' colour line does too
  function edit(id, { name = null, color = null }) {
    const l = list(), ws = l.find(w => w.id === id);
    if (!ws) return;
    if (name?.trim()) ws.name = name.trim();
    if (color in COLORS) ws.color = color;
    if (ws.userContextId) {
      const icon = ContextualIdentityService.getPublicIdentityFromId(ws.userContextId)?.icon ?? "circle";
      ContextualIdentityService.update(ws.userContextId, ws.name, icon, colorName(ws) ?? "toolbar");
    }
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

  // Reopens the tabs in the other space's container (a container can't change once a tab is open), next to where
  // they were. They lose their back history and anything typed into the page.
  function moveTabs(tabs, id) {
    const ws = list().find(w => w.id === id);
    for (const tab of tabs) {
      if (tab.pinned || tab.userContextId === ws.userContextId) continue;
      const moved = gBrowser.addTab(tab.linkedBrowser.currentURI.spec, { userContextId: ws.userContextId, index: tab._tPos + 1,
        triggeringPrincipal: system() });
      if (ws.id !== currentWs().id) gBrowser.hideTab(moved);
      gBrowser.removeTab(tab);
    }
    changed();
  }

  const count = id => {
    const ws = list().find(w => w.id === id);
    return ws ? gBrowser.tabs.filter(t => !t.pinned && t.userContextId === ws.userContextId).length : 0;
  };
  // For the command bar
  const actions = () => !enabled() ? [] : [
    ...list().filter(ws => ws.id !== currentWs().id).map(ws => ({ label: `Switch to ${ws.name}`, keys: "space spaces workspace", run: () => switchTo(ws.id) })),
    { label: "New space", keys: "spaces workspace add create", run: () => openPanel(true) },
  ];
  Fjord.workspaces = { list, currentWs, switchTo, add, edit, remove, moveTabs, count, enabled, actions };

  // New tabs open in the current space
  if (window.BrowserCommands?.openTab) {
    const openTab = BrowserCommands.openTab.bind(BrowserCommands);
    BrowserCommands.openTab = (options = {}) => {
      const ws = currentWs();
      if (!enabled() || !ws.userContextId || options.url) return openTab(options);
      return openTrustedLinkIn(BROWSER_NEW_TAB_URL, "tab", { userContextId: ws.userContextId });
    };
  }
  // A tab from another space that opens in the background is tucked away; selecting one switches space
  gBrowser.tabContainer.addEventListener("TabOpen", e => setTimeout(() => {
    if (enabled() && !e.target.selected && !here(e.target)) gBrowser.hideTab(e.target);
    changed();
  }, 0));
  gBrowser.tabContainer.addEventListener("TabSelect", e => {
    if (enabled() && !here(e.target)) switchTo(owner(e.target).id);
  });
  gBrowser.tabContainer.addEventListener("TabClose", () => setTimeout(changed, 0));
  // Making or undoing a split view can bring a tab from another space into this one, or send it back
  for (const type of ["SplitViewTabChange", "SplitViewRemoved"]) gBrowser.tabContainer.addEventListener(type, () => setTimeout(apply, 0));

  // ---------- The button at the start of the tabs: the space's colour and name ----------
  try {
    CustomizableUI.createWidget({
      id: WIDGET, type: "button", label: "Spaces", tooltiptext: "Switch space",
      defaultArea: CustomizableUI.AREA_TABSTRIP,
      onCommand: e => e.target.ownerDocument.defaultView.Fjord.openSpaces(),
    });
    // Once, before the tabs; after that it stays where the user puts it
    if (!prefs.getBoolPref("fjord.spaces.placed", false)) {
      const tabs = CustomizableUI.getPlacementOfWidget("tabbrowser-tabs");
      if (tabs?.area === CustomizableUI.AREA_TABSTRIP) CustomizableUI.moveWidgetWithinArea(WIDGET, tabs.position);
      prefs.setBoolPref("fjord.spaces.placed", true);
    }
  } catch {} // made by the first window already

  const button = () => CustomizableUI.getWidget(WIDGET)?.forWindow(window).node;
  function updateButton() {
    const b = button();
    if (!b) return;
    const ws = currentWs();
    b.hidden = !enabled();
    b.setAttribute("label", ws.name); // for the Customize menu; the toolbar shows the name below, Firefox's label hides there
    const name = b.querySelector(".fjord-space-name") ?? b.appendChild(h("span", { class: "fjord-space-name" }));
    name.textContent = ws.name;
    b.setAttribute("tooltiptext", `${ws.name} space. Click to switch`);
    b.style.setProperty("--fjord-space", colorOf(ws));
  }

  const panel = document.createXULElement("panel");
  panel.id = "fjord-spaces";
  panel.setAttribute("type", "arrow");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Spaces");
  document.getElementById("mainPopupSet").append(panel);
  for (const [type, open] of [["popupshowing", true], ["popuphidden", false]]) {
    panel.addEventListener(type, e => { if (e.target === panel) button()?.toggleAttribute("open", open); });
  }

  function renderPanel(focusNew) {
    const cur = currentWs().id;
    const rows = list().map(ws => {
      const n = count(ws.id);
      const row = btn("ns-space-row", "", () => { panel.hidePopup(); switchTo(ws.id); });
      row.setAttribute("aria-current", String(ws.id === cur));
      row.append(dot(ws), h("b", {}, ws.name), h("span", {}, n === 1 ? "1 tab" : `${n} tabs`));
      return row;
    });
    const input = h("input", { type: "text", placeholder: "New space, like Work", "aria-label": "New space name" });
    const create = () => { panel.hidePopup(); add(input.value); };
    input.addEventListener("keydown", e => { if (e.key === "Enter") create(); });
    const edit = btn("ns-link-row", "Edit spaces", () => { panel.hidePopup(); Fjord.showSettings("workspaces"); });
    panel.replaceChildren(h("div", { class: "ns-shields ns-spaces" },
      h("div", { class: "ns-space-list" }, ...rows),
      h("div", { class: "ns-space-new" }, input, btn("ns-secondary", "Add", create)),
      edit));
    if (focusNew) panel.addEventListener("popupshown", () => input.focus(), { once: true });
  }
  function openPanel(focusNew = false) {
    if (!enabled()) return;
    renderPanel(focusNew);
    const b = button();
    if (b?.checkVisibility()) panel.openPopup(b, "bottomleft topleft");
    else panel.openPopup(document.getElementById("tabbrowser-tabs"), "bottomleft topleft"); // the button was removed
  }
  Fjord.openSpaces = openPanel;

  // ---------- "Move to space" in the tab's right-click menu ----------
  const tabMenu = document.getElementById("tabContextMenu");
  const moveMenu = document.createXULElement("menu");
  moveMenu.id = "context_fjordMoveToSpace";
  moveMenu.setAttribute("label", "Move to space");
  const movePopup = document.createXULElement("menupopup");
  moveMenu.append(movePopup);
  (document.getElementById("context_moveTabOptions") ?? tabMenu.firstElementChild)?.after(moveMenu);
  tabMenu.addEventListener("popupshowing", e => {
    if (e.target !== tabMenu) return;
    const tab = TabContextMenu.contextTab;
    const tabs = tab.multiselected ? gBrowser.selectedTabs : [tab];
    const targets = list().filter(ws => tabs.some(t => t.userContextId !== ws.userContextId));
    moveMenu.hidden = !enabled() || list().length < 2 || tabs.every(t => t.pinned);
    movePopup.replaceChildren(...targets.map(ws => {
      const item = document.createXULElement("menuitem");
      item.setAttribute("label", ws.name);
      item.addEventListener("command", () => moveTabs(tabs, ws.id));
      return item;
    }));
  });

  const onChange = { observe: () => { updateButton(); if (panel.state === "open") renderPanel(); } };
  Services.obs.addObserver(onChange, "fjord-spaces-changed");
  const onPref = { observe: () => { apply(); changed(); } };
  prefs.addObserver(ON, onPref);
  window.addEventListener("unload", () => {
    prefs.removeObserver(ON, onPref);
    Services.obs.removeObserver(onChange, "fjord-spaces-changed");
  });
  updateButton();
  // After the session's tabs are back: the space of the tab that's open
  if (enabled()) setTimeout(() => {
    const o = owner(gBrowser.selectedTab);
    if (o && o.id !== currentWs().id && !gBrowser.selectedTab.pinned) switchTo(o.id);
    else apply();
  }, 1500);

  // ---------- Settings ----------
  Fjord.sections.workspaces = {
    label: "Spaces", after: "sidebar",
    desc: "Separate sets of tabs, like Work and Personal. Each has its own cookies, so you can be signed in to two accounts at once.",
    keys: "spaces workspaces work personal profiles containers accounts tabs colour color",
    render: ({ reopen }) => {
      const input = h("input", { type: "text", placeholder: "New space, like Work", "aria-label": "New space name" });
      const create = () => { add(input.value); reopen(); };
      input.addEventListener("keydown", e => { if (e.key === "Enter") create(); });
      const swatches = ws => h("div", { class: "ns-swatches", role: "radiogroup", "aria-label": `${ws.name} colour` },
        ...Object.entries(COLORS).map(([name, hex]) => {
          const b = btn("ns-swatch", "", () => { edit(ws.id, { color: name }); reopen(); });
          b.setAttribute("style", `--c: ${hex}`);
          b.setAttribute("role", "radio");
          b.setAttribute("aria-checked", String(colorName(ws) === name));
          b.setAttribute("aria-label", name);
          b.setAttribute("title", name[0].toUpperCase() + name.slice(1));
          return b;
        }));
      const rename = ws => {
        const out = { value: ws.name };
        if (Services.prompt.prompt(window, "Rename space", "Name", out, null, {})) { edit(ws.id, { name: out.value }); reopen(); }
      };
      return [
        h("div", { class: "ns-group" }, switchRow("Spaces", "Switch between them with the button at the start of your tabs, or from the command bar.",
          enabled(), v => { prefs.setBoolPref(ON, v); reopen(); })),
        enabled() ? h("h3", {}, "Your spaces") : null,
        enabled() ? h("div", { class: "ns-group" }, ...list().map(ws => h("div", { class: "ns-list-row ns-space-setting" },
          dot(ws),
          h("span", {}, h("b", {}, ws.name), h("span", {}, [count(ws.id) === 1 ? "1 tab" : `${count(ws.id)} tabs`,
            ws.id === currentWs().id ? "open now" : null].filter(Boolean).join(" · "))),
          swatches(ws),
          btn("ns-link", "Rename", () => rename(ws)),
          ws.id === "personal" ? h("span") : btn("ns-link", "Delete", async () => { await remove(ws.id); reopen(); })))) : null,
        enabled() ? h("div", { class: "ns-add-site" }, h("div", { class: "ns-row" }, input, btn("ns-secondary", "Add", create))) : null,
      ];
    },
  };
})();
