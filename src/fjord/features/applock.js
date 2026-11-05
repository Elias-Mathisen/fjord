// App lock in each window: the lock screen (pages, tabs and toolbar are hidden, also from taskbar previews), "Lock
// Fjord" in the ☰ menu and Ctrl+Alt+L, and its settings. The lock itself is applock.sys.mjs. Loaded by browser.js.
(() => {
  if (AppConstants.platform == "linux") return; // Linux has no system sign-in check (Firefox's OS reauthentication) to unlock with
  const { h, btn, choices, switchRow } = Fjord;
  const applock = ChromeUtils.importESModule("resource://fjord/applock.sys.mjs");
  const prefs = Services.prefs;
  const MAC = AppConstants.platform == "macosx";
  const METHOD = MAC ? "Touch ID or your password" : "Windows Hello";
  let screen = null;

  // Keys do nothing while locked (no Ctrl+T, no shortcuts into the hidden pages)
  const blockKeys = e => {
    if (!screen || screen.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  // While locked the window title (also on the taskbar) says only "Fjord", not the page you're on
  const realTitle = gBrowser.getWindowTitleForBrowser.bind(gBrowser);
  gBrowser.getWindowTitleForBrowser = browser => (screen ? "Fjord" : realTitle(browser));

  function show() {
    if (screen) return;
    document.documentElement.setAttribute("fjord-locked", "true");
    setTimeout(() => gBrowser.updateTitlebar(), 0);
    const status = h("p", { class: "ns-quiet", role: "status" });
    const unlockBtn = btn("ns-primary", `Unlock with ${METHOD}`, async () => {
      unlockBtn.disabled = true;
      const result = await applock.unlock(window);
      unlockBtn.disabled = false;
      if (result === "cancelled") status.textContent = "Not unlocked. Try again.";
      if (result === "no-password") Services.prompt.alert(window, "Fjord", `Your computer has no PIN or password, so App lock can't check it's you. Set one up in your system settings, then App lock works.`);
    });
    screen = h("div", { class: "ns-overlay ns-lock", role: "dialog", "aria-modal": "true", "aria-label": "Fjord is locked" },
      h("div", { class: "ns-lock-card" },
        h("img", { src: "resource://fjord/branding/logo.png", alt: "" }),
        h("h1", {}, "Fjord is locked"),
        h("p", {}, "Your tabs are safe. Unlock to carry on."),
        unlockBtn, status));
    document.documentElement.append(screen);
    window.addEventListener("keydown", blockKeys, true);
    unlockBtn.focus();
  }
  function hide() {
    document.documentElement.removeAttribute("fjord-locked");
    screen?.remove();
    screen = null;
    window.removeEventListener("keydown", blockKeys, true);
    gBrowser.updateTitlebar();
  }
  const observer = { observe: (s, t, state) => state === "locked" ? show() : hide() };
  Services.obs.addObserver(observer, "fjord-applock");
  window.addEventListener("unload", () => Services.obs.removeObserver(observer, "fjord-applock"));
  if (applock.locked) show();

  // ☰ menu and keyboard
  document.addEventListener("ViewShowing", e => {
    if (e.target.id !== "appMenu-mainView" || document.getElementById("appMenu-lock-button")) return;
    const item = document.createXULElement("toolbarbutton");
    item.id = "appMenu-lock-button";
    item.className = "subviewbutton";
    item.setAttribute("label", "Lock Fjord");
    item.setAttribute("shortcut", MAC ? "⌥⌘L" : "Ctrl+Alt+L");
    item.addEventListener("command", () => { PanelUI.hide(); applock.lock(); });
    item.hidden = !prefs.getBoolPref("fjord.appLock.enabled", false);
    (document.getElementById("appMenu-mist-button") ?? document.getElementById("appMenu-fjord-button"))?.after(item);
  });
  document.addEventListener("ViewShowing", e => {
    const item = document.getElementById("appMenu-lock-button");
    if (e.target.id === "appMenu-mainView" && item) item.hidden = !prefs.getBoolPref("fjord.appLock.enabled", false);
  });
  const key = document.createXULElement("key");
  key.id = "key_fjordLock";
  key.setAttribute("key", "L");
  key.setAttribute("modifiers", "accel,alt");
  key.addEventListener("command", () => applock.lock());
  document.getElementById("mainKeyset").append(key);

  const TIMES = [[0, "Never"], [1, "1 minute"], [5, "5 minutes"], [15, "15 minutes"], [60, "1 hour"]];
  let notice = ""; // why turning it on didn't work, shown once after the section redraws
  Fjord.sections.applock = {
    label: "App lock", after: "privacy",
    desc: `Ask for ${METHOD} before anyone can see your tabs. Handy on a shared computer.`,
    keys: "app lock windows hello face fingerprint pin touch id password lock screen shared computer",
    render: ({ reopen }) => {
      const on = prefs.getBoolPref("fjord.appLock.enabled", false);
      const status = h("p", { class: "ns-quiet", role: "status" }, notice);
      notice = "";
      return [
        h("div", { class: "ns-group" }, switchRow(`Lock Fjord with ${METHOD}`, "Fjord asks when it opens and after you've been away. Your face or fingerprint never leave the computer.",
          on, async v => {
            if (v) {
              // Checked once first, so nobody turns it on without being able to unlock
              const result = await applock.verify(window, "Turn on App lock for Fjord");
              if (result === "ok") prefs.setBoolPref("fjord.appLock.enabled", true);
              else notice = result === "no-password"
                ? "Your computer has no PIN or password yet. Set one up in your system settings first."
                : "App lock stays off: the check was cancelled.";
            } else prefs.setBoolPref("fjord.appLock.enabled", false);
            reopen();
          })),
        status,
        on ? h("h3", {}, "Lock when I've been away for") : null,
        on ? choices("ns-pills", TIMES.map(([m, label]) => ({ value: m, content: [h("span", {}, label)] })),
          prefs.getIntPref("fjord.appLock.idleMinutes", 15), m => prefs.setIntPref("fjord.appLock.idleMinutes", m)) : null,
        on ? h("div", { class: "ns-row ns-ip-check" }, btn("ns-secondary", "Lock now", () => { document.querySelector(".ns-close")?.click(); applock.lock(); }),
          h("span", { class: "ns-quiet" }, MAC ? "Or press ⌥⌘L" : "Or press Ctrl+Alt+L")) : null,
      ];
    },
  };
})();
