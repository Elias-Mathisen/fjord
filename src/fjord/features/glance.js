// Link preview: Shift-click a link (page-frame.js catches it) and it opens in a window over the page, with a button
// to open it as a tab. Esc, a click beside it or the close button puts it away. The switch is in Fjord settings >
// Shortcuts (features/commandbar.js). Loaded into each window by browser.js.
(() => {
  const { h, btn } = Fjord;
  let current = null; // { overlay, browser }

  async function load(browser, url, principal) {
    // A new browser takes a moment before it can load (its webNavigation appears once it's set up)
    for (let i = 0; i < 100 && !browser.webNavigation; i++) await new Promise(r => setTimeout(r, 20));
    browser.fixupAndLoadURIString(url, { triggeringPrincipal: principal ?? Services.scriptSecurityManager.createNullPrincipal({}) });
  }
  const hostOf = url => { try { return new URL(url).hostname; } catch { return url; } };

  Fjord.glance = (source, url) => {
    if (current?.browser === source) return load(source, url, source.contentPrincipal); // a Shift-click inside the preview
    const tab = gBrowser.getTabForBrowser(source);
    if (!tab) return;
    close();
    const browser = document.createXULElement("browser");
    const attrs = { type: "content", remote: "true", maychangeremoteness: "true", messagemanagergroup: "browsers", nodefaultsrc: "true" };
    if (tab.userContextId) attrs.usercontextid = String(tab.userContextId); // same cookies as the tab: Mist tabs stay Mist
    for (const [k, v] of Object.entries(attrs)) browser.setAttribute(k, v);
    const title = h("span", {}, h("b", {}, hostOf(url)));
    const overlay = h("div", { class: "ns-glance", role: "dialog", "aria-label": "Link preview" },
      h("div", { class: "ns-glance-card" },
        h("div", { class: "ns-glance-bar" }, title,
          btn("ns-primary", "Open as tab", () => {
            const spec = browser.currentURI?.spec && browser.currentURI.spec !== "about:blank" ? browser.currentURI.spec : url;
            close();
            gBrowser.selectedTab = gBrowser.addTab(spec, {
              triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), userContextId: tab.userContextId, ownerTab: tab,
            });
          }),
          btn("", "Close", close)),
        browser));
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    browser.addEventListener("pagetitlechanged", () => {
      title.replaceChildren(h("b", {}, hostOf(browser.currentURI.spec)), browser.contentTitle ? ` · ${browser.contentTitle}` : "");
    });
    source.parentElement.append(overlay); // over this tab only
    current = { overlay, browser, tab };
    load(browser, url, source.contentPrincipal);
    browser.focus();
  };

  function close() {
    if (!current) return;
    current.overlay.remove(); // the preview's browser goes with it
    current = null;
  }
  // Esc reaches the window after the page in the preview had its turn
  window.addEventListener("keydown", e => { if (current && e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); close(); } }, true);
  gBrowser.tabContainer.addEventListener("TabClose", e => { if (current?.tab === e.target) close(); });
})();
