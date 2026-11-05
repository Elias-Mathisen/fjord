// Permission watch in each window: a short notice when the site in a tab uses your camera, microphone, screen,
// location or clipboard, and a settings page with the history and what's allowed now. The recording is in
// perms.sys.mjs. Loaded into each window by browser.js.
(() => {
  const { h, btn, prefSwitch, toast } = Fjord;
  const perms = ChromeUtils.importESModule("resource://fjord/perms.sys.mjs");

  Fjord.permissionNotice = (browser, host, what) =>
    toast(browser, `${host} ${perms.WHAT[what]}`, ["Manage", () => Fjord.showSettings("permissions")]);

  // Clipboard hijack guard: a page replaced what you copied. Copying the real selection puts it back.
  const WALLET = /\b(0x[a-fA-F0-9]{40}|bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|T[1-9A-HJ-NP-Za-km-z]{33})\b/;
  Fjord.clipboardWarning = (browser, { host, selected, put }) => {
    const short = put.length > 40 ? `${put.slice(0, 40)}…` : put;
    const text = WALLET.test(selected) || WALLET.test(put)
      ? `${host} swapped the address you copied for “${short}”. Don't paste it.`
      : `${host} changed what you copied to “${short}”.`;
    toast(browser, text, ["Copy what I selected", () => {
      Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(selected);
    }]);
  };

  const ago = t => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const KIND = { camera: "Camera", microphone: "Microphone", screen: "Screen sharing", location: "Location", clipboard: "Clipboard" };
  // Permissions sites can be given in Firefox, as they read in the list
  const ALLOWED = { camera: "Camera", microphone: "Microphone", geo: "Location", "desktop-notification": "Notifications",
    screen: "Screen sharing", xr: "Virtual reality", midi: "MIDI devices", "persistent-storage": "Storing data" };

  Fjord.sections.permissions = {
    label: "Permissions", after: "privacy",
    desc: "See which sites used your camera, microphone, location or clipboard, and take back what you allowed.",
    keys: "permissions camera microphone location clipboard screen notifications allowed history",
    render: async ({ reopen }) => {
      const uses = await perms.recent();
      const allowed = Services.perms.all.filter(p => ALLOWED[p.type] && p.capability === Ci.nsIPermissionManager.ALLOW_ACTION);
      return [
        h("div", { class: "ns-group" }, prefSwitch("Show a notice when a site uses these",
          "A short message on the page, for example “maps.google.com asked for your location”.", "fjord.permissionWatch.notice")),
        h("h3", {}, "Recently"),
        uses.length
          ? h("div", { class: "ns-group" }, ...uses.map(u => h("div", { class: "ns-list-row" },
            h("span", {}, h("b", {}, u.host), ` · ${KIND[u.what] ?? u.what}`), h("span", { class: "ns-quiet" }, ago(u.t)))))
          : h("p", { class: "ns-quiet" }, "No site has used them yet. Private windows aren't recorded."),
        uses.length ? btn("ns-link", "Clear history", () => { perms.clear(); reopen(); }) : null,
        h("h3", {}, "Allowed right now"),
        allowed.length
          ? h("div", { class: "ns-group" }, ...allowed.map(p => h("div", { class: "ns-list-row" },
            h("span", {}, h("b", {}, p.principal.host || p.principal.origin), ` · ${ALLOWED[p.type]}`),
            btn("ns-link", "Remove", () => { Services.perms.removePermission(p); reopen(); }))))
          : h("p", { class: "ns-quiet" }, "No site has a saved permission. Firefox asks each time unless you tick “Remember”."),
      ];
    },
  };
})();
