// A sidebar app's page: loads the site in a content browser, like Firefox's own AI chat panel does.
// shortcut: Firefox's sidebar shows one panel at a time and reloads it when you switch, so music in Spotify stops
// when you open another sidebar app; keeping panels alive would need our own sidebar instead of Firefox's.
(async () => {
  const win = window.browsingContext.topChromeWindow;
  const apps = ChromeUtils.importESModule("resource://fjord/apps.sys.mjs");
  const app = apps.byId(new URLSearchParams(location.search).get("app"));
  const box = document.getElementById("box");
  if (!app) {
    box.innerHTML = "<p>This app was removed from the sidebar.</p>";
    return;
  }
  document.title = app.name;
  document.getElementById("name").textContent = app.name;
  document.getElementById("icon").src = await apps.icon(app);

  const browser = document.createXULElement("browser");
  for (const [k, v] of Object.entries({ type: "content", remote: "true", maychangeremoteness: "true",
    messagemanagergroup: "fjord-sidebar-app", nodefaultsrc: "true" })) browser.setAttribute(k, v);
  box.append(browser);
  // The browser can take a moment to be ready to load (its webNavigation appears once it's set up)
  for (let i = 0; i < 100 && !browser.webNavigation; i++) await new Promise(r => setTimeout(r, 20));
  if (app.phone) browser.browsingContext.customUserAgent = apps.PHONE_UA;
  browser.fixupAndLoadURIString(app.url, { triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}) });

  const on = (id, fn) => document.getElementById(id).addEventListener("click", fn);
  on("back", () => browser.canGoBack && browser.goBack());
  on("reload", () => browser.reload());
  on("open", () => win.openTrustedLinkIn(browser.currentURI.spec, "tab"));
  on("close", () => win.SidebarController.hide());
})();
