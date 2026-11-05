// "Hide this…" in the right-click menu: pick a part of the page (a cookie wall, a sidebar, a floating video) and
// Fjord hides it on that site from then on. The picking happens in page-frame.js, the list is hidden.sys.mjs, and
// Shields shows it again. Loaded into each window by browser.js.
(() => {
  ChromeUtils.importESModule("resource://fjord/hidden.sys.mjs"); // starts handing the list to pages
  const onWebsite = browser => /^https?$/.test(browser.currentURI.scheme);
  Fjord.hidePicker = (browser = gBrowser.selectedBrowser) => {
    if (!onWebsite(browser)) return Fjord.toast(browser, "Hiding works on websites.");
    browser.messageManager.sendAsyncMessage("Fjord:HidePicker");
  };

  const menu = document.getElementById("contentAreaContextMenu");
  const item = document.createXULElement("menuitem");
  item.id = "context-fjord-hide";
  item.addEventListener("command", () => Fjord.hidePicker(gContextMenu.browser));
  menu.append(item);
  menu.addEventListener("popupshowing", e => {
    if (e.target !== menu) return;
    const browser = gContextMenu?.browser;
    item.hidden = !browser || !onWebsite(browser) || gContextMenu.onEditable;
    if (!item.hidden) item.setAttribute("label", `Hide this on ${Fjord.siteOf(browser.currentURI.host)}…`);
  });
})();
