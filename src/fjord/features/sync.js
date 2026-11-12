// Sync, in Fjord settings: pairing an iPhone by QR code or another computer by its code, the paired devices, the
// folder to sync through away from home, and the tabs open on the other devices. The syncing itself is
// sync.sys.mjs: straight over the home network, or through the folder. Loaded into each window by browser.js.
(() => {
  const { h, btn, switchRow } = Fjord;
  const sync = ChromeUtils.importESModule("resource://fjord/sync.sys.mjs");
  const lib = {};
  Services.scriptloader.loadSubScript("resource://fjord/vendor/qrcode.js", lib);

  const ago = ms => {
    if (!ms) return "Not synced yet";
    const min = Math.round((Date.now() - ms) / 60e3);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    return `Synced ${min < 1 ? "just now" : min < 60 ? rtf.format(-min, "minute") : min < 1440 ? rtf.format(-Math.round(min / 60), "hour") : rtf.format(-Math.round(min / 1440), "day")}`;
  };
  const copy = text => {
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
    Fjord.toast(gBrowser.selectedBrowser, "Code copied.");
  };

  // The code as an image: dark squares on white, whatever the theme, so the camera reads it
  function qrImage(text) {
    const qr = lib.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
    return h("img", { class: "ns-sync-qr", src: `data:image/svg+xml,${encodeURIComponent(svg)}`, alt: "Pairing code" });
  }

  function devices() {
    const list = sync.paired();
    if (!list.length) return [];
    return [
      h("h3", {}, "Paired"),
      h("div", { class: "ns-group" }, ...list.flatMap(d => [
        h("div", { class: "ns-list-row" },
          h("span", { class: "ns-sync-name" }, h("b", {}, d.name),
            h("span", { class: "ns-quiet" }, `${d.kind === "computer" ? "Computer" : "iPhone"} · ${ago(d.lastSync)}`)),
          btn("ns-link", "Unpair", () => sync.unpair(d.id))),
        d.kind === "computer" ? switchRow("Passwords", `Saved passwords are shared with ${d.name}, sealed with your pairing's key.`,
          d.passwords, v => sync.setPasswords(d.id, v)) : null,
      ])),
      ...list.filter(d => d.tabs.length).flatMap(d => [
        h("h3", {}, `Open on ${d.name}`),
        h("div", { class: "ns-group" }, ...d.tabs.slice(0, 50).map(t => {
          const row = btn("ns-list-row ns-sync-tab", "", () => window.openTrustedLinkIn(t.url, "tab"));
          row.append(h("b", {}, t.title || t.url), h("span", { class: "ns-quiet" }, new URL(t.url).host.replace(/^www\./, "")));
          return row;
        })),
      ]),
    ];
  }

  function chooseFolder() {
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(window.browsingContext, "Choose a folder to sync through", Ci.nsIFilePicker.modeGetFolder);
    fp.open(r => { if (r === Ci.nsIFilePicker.returnOK) sync.setFolder(fp.file.path).catch(e => Fjord.toast(gBrowser.selectedBrowser, e.message)); });
  }
  function folder() {
    const path = sync.folder();
    return [
      h("h3", {}, "Away from home"),
      h("p", {}, "Sync through a folder you already have, like iCloud Drive, Dropbox, OneDrive or a USB stick. Each device writes only its own file there, sealed with your pairing's key, so whoever stores the folder sees only scrambled data. Choose the same folder on your other devices."),
      h("div", { class: "ns-group" }, path
        ? h("div", { class: "ns-list-row" }, h("span", { class: "ns-sync-name" }, h("b", {}, PathUtils.filename(path)), h("span", { class: "ns-quiet" }, path)),
          h("span", { class: "ns-row" }, btn("ns-link", "Change", chooseFolder),
            btn("ns-link", "Stop", () => sync.setFolder(null).catch(e => Fjord.toast(gBrowser.selectedBrowser, e.message)))))
        : h("div", { class: "ns-list-row" }, h("span", { class: "ns-quiet" }, "Only over your home Wi-Fi for now."),
          btn("ns-secondary", "Choose a folder…", chooseFolder))),
    ];
  }

  Fjord.sections.sync = {
    label: "Sync", after: "import",
    desc: "Open tabs, history, bookmarks and hidden page parts, shared with Fjord on your iPhone and your other computers. Passwords and settings go between computers. No account, and nothing goes through a server.",
    keys: "sync iphone ipad phone computer pair qr code tabs history bookmarks passwords settings wifi devices folder icloud dropbox onedrive usb",
    render: async () => {
      const box = h("div", { class: "ns-sync" });
      let pairing = null, before = 0; // the code being shown, and how many devices were paired when it was made
      const draw = () => {
        const pairBtn = btn("ns-primary", sync.paired().length ? "Pair another device" : "Pair a device", async () => {
          try {
            before = sync.paired().length;
            pairing = await sync.startPairing();
          } catch (e) {
            pairing = null;
            Fjord.toast(gBrowser.selectedBrowser, e.message);
          }
          draw();
        });
        const input = h("input", { type: "text", placeholder: "fjord-sync:1?…", "aria-label": "Pairing code from your other computer", spellcheck: "false" });
        const join = () => sync.join(input.value).then(() => Fjord.toast(gBrowser.selectedBrowser, "Paired. Your computers sync through the folder from now on."), e => Fjord.toast(gBrowser.selectedBrowser, e.message));
        input.addEventListener("keydown", e => { if (e.key === "Enter") join(); });
        box.replaceChildren(
          ...(pairing ? [h("div", { class: "ns-sync-pair" }, qrImage(pairing),
            h("div", {},
              h("b", {}, "On your iPhone"),
              h("ol", {},
                h("li", {}, "Open Fjord on your iPhone, on the same Wi-Fi as this computer."),
                h("li", {}, "Go to Settings, then Sync with computer, and tap Pair with a computer."),
                h("li", {}, "Point the camera at this code.")),
              h("b", {}, "On another computer"),
              h("p", {}, "Copy the code, then paste it under Pair with a code in Fjord's settings there. Both computers need to sync through the same folder."),
              h("div", { class: "ns-row" }, btn("ns-secondary", "Copy code", () => copy(pairing)),
                btn("ns-secondary", "Cancel", () => { pairing = null; sync.cancelPairing(); draw(); })),
              h("p", { class: "ns-quiet" }, `The code works for 10 minutes and only once. ${AppConstants.platform == "win"
                ? "If Windows asks whether Fjord can use your network, allow it on private networks." : "If your computer asks whether Fjord can accept incoming connections, allow it."}`)))]
            : [pairBtn,
              h("h3", {}, "Pair with a code"),
              h("p", {}, "Got a code from Fjord on your other computer? Paste it here."),
              h("div", { class: "ns-add-site" }, h("div", { class: "ns-row" }, input, btn("ns-secondary", "Pair", join)))]),
          ...devices(),
          ...folder());
      };
      // A new pairing, a sync, an unpair or a new folder redraws the section while it's open
      const obs = () => {
        if (!box.isConnected) return Services.obs.removeObserver(obs, "fjord-sync-changed");
        if (pairing && sync.paired().length > before) pairing = null; // the other device has paired, so the code is used up
        draw();
      };
      Services.obs.addObserver(obs, "fjord-sync-changed");
      draw();
      return [
        box,
        h("p", { class: "ns-quiet ns-sync-foot" },
          "Your devices talk only to each other, encrypted with a key made when you pair. History isn't shared while it's off or in Ghost mode, and private windows and Mist tabs never are."),
      ];
    },
  };
})();
