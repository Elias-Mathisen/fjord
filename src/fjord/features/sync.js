// Sync with iPhone, in Fjord settings: pairing by QR code, the paired iPhones, and the tabs open on them. The syncing
// itself is sync.sys.mjs, straight over the home network. Loaded into each window by browser.js.
(() => {
  const { h, btn } = Fjord;
  const sync = ChromeUtils.importESModule("resource://fjord/sync.sys.mjs");
  const lib = {};
  Services.scriptloader.loadSubScript("resource://fjord/vendor/qrcode.js", lib);

  const ago = ms => {
    if (!ms) return "Not synced yet";
    const min = Math.round((Date.now() - ms) / 60e3);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    return `Synced ${min < 1 ? "just now" : min < 60 ? rtf.format(-min, "minute") : min < 1440 ? rtf.format(-Math.round(min / 60), "hour") : rtf.format(-Math.round(min / 1440), "day")}`;
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
      h("div", { class: "ns-group" }, ...list.map(d => h("div", { class: "ns-list-row" },
        h("span", { class: "ns-sync-name" }, h("b", {}, d.name), h("span", { class: "ns-quiet" }, ago(d.lastSync))),
        btn("ns-link", "Unpair", () => sync.unpair(d.id))))),
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

  Fjord.sections.sync = {
    label: "Sync with iPhone", after: "import",
    desc: "Open tabs, history, bookmarks and hidden page parts, shared with Fjord on your iPhone straight over your home Wi-Fi. No account, and nothing goes through the internet.",
    keys: "sync iphone ipad phone pair qr code tabs history bookmarks wifi devices",
    render: async () => {
      const box = h("div", { class: "ns-sync" });
      let pairing = null, before = 0; // the code being shown, and how many iPhones were paired when it was made
      const draw = () => {
        const pairBtn = btn("ns-primary", sync.paired().length ? "Pair another iPhone" : "Pair an iPhone", async () => {
          try {
            before = sync.paired().length;
            pairing = await sync.startPairing();
          } catch (e) {
            pairing = null;
            Fjord.toast(e.message);
          }
          draw();
        });
        box.replaceChildren(
          ...(pairing ? [h("div", { class: "ns-sync-pair" }, qrImage(pairing),
            h("div", {},
              h("b", {}, "Scan this with your iPhone"),
              h("ol", {},
                h("li", {}, "Open Fjord on your iPhone, on the same Wi-Fi as this computer."),
                h("li", {}, "Go to Settings, then Sync with computer, and tap Pair with a computer."),
                h("li", {}, "Point the camera at this code.")),
              h("p", { class: "ns-quiet" }, `The code works for 10 minutes and only once. ${AppConstants.platform == "win"
                ? "If Windows asks whether Fjord can use your network, allow it on private networks." : "If your computer asks whether Fjord can accept incoming connections, allow it."}`),
              btn("ns-secondary", "Cancel", () => { pairing = null; sync.cancelPairing(); draw(); })))]
            : [pairBtn]),
          ...devices());
      };
      // A new pairing, a sync or an unpair redraws the section while it's open
      const obs = () => {
        if (!box.isConnected) return Services.obs.removeObserver(obs, "fjord-sync-changed");
        if (pairing && sync.paired().length > before) pairing = null; // the iPhone has paired, so the code is used up
        draw();
      };
      Services.obs.addObserver(obs, "fjord-sync-changed");
      draw();
      return [
        box,
        h("p", { class: "ns-quiet ns-sync-foot" },
          "Your devices talk only to each other on your network, encrypted with a key made when you pair. History isn't shared while it's off or in Ghost mode, and private windows and Mist tabs never are."),
      ];
    },
  };
})();
