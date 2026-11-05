// Mist tabs in each window: "New Mist tab" in the ☰ menu (and Ctrl+Alt+M), "Open link in Mist tab" in the link menu.
// The container work is in mist.sys.mjs. Loaded into each window by browser.js.
(() => {
  const mist = ChromeUtils.importESModule("resource://fjord/mist.sys.mjs");

  function openMistTab(url = BROWSER_NEW_TAB_URL, select = true) {
    const userContextId = mist.create();
    const tab = gBrowser.addTab(url, { userContextId, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    if (select) gBrowser.selectedTab = tab;
  }
  Fjord.openMistTab = openMistTab;

  // ☰ menu, under "Fjord settings"
  document.addEventListener("ViewShowing", e => {
    if (e.target.id !== "appMenu-mainView" || document.getElementById("appMenu-mist-button")) return;
    const item = document.createXULElement("toolbarbutton");
    item.id = "appMenu-mist-button";
    item.className = "subviewbutton";
    item.setAttribute("label", "New Mist tab");
    item.setAttribute("shortcut", AppConstants.platform == "macosx" ? "⌥⌘M" : "Ctrl+Alt+M");
    item.addEventListener("command", () => { PanelUI.hide(); openMistTab(); });
    document.getElementById("appMenu-fjord-button")?.after(item);
  });

  const key = document.createXULElement("key");
  key.id = "key_fjordMist";
  key.setAttribute("key", "M");
  key.setAttribute("modifiers", "accel,alt");
  key.addEventListener("command", () => openMistTab());
  document.getElementById("mainKeyset").append(key);

  // Link right-click menu
  const menu = document.getElementById("contentAreaContextMenu");
  const linkItem = document.createXULElement("menuitem");
  linkItem.id = "context-openlinkinmist";
  linkItem.setAttribute("label", "Open link in Mist tab");
  linkItem.addEventListener("command", () => openMistTab(gContextMenu.linkURL, false));
  document.getElementById("context-openlinkintab")?.after(linkItem);
  menu.addEventListener("popupshowing", e => {
    if (e.target === menu) linkItem.hidden = !gContextMenu?.onLink || gContextMenu.onMailtoLink;
  });

  // Remember what Mist tabs visit (to remove from history), and forget a Mist container once its last tab closes
  gBrowser.addTabsProgressListener({
    onLocationChange(browser, webProgress, request, location) {
      if (webProgress.isTopLevel) mist.visit(browser.getAttribute("usercontextid") * 1 || 0, location.spec);
    },
  });
  gBrowser.tabContainer.addEventListener("TabClose", e => {
    const id = e.target.userContextId;
    if (mist.isMist(id)) setTimeout(() => mist.maybeForget(id).catch(console.error), 0);
  });
})();
