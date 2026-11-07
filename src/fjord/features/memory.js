// Memory saver: tabs you haven't looked at for a while are unloaded. Firefox keeps them in the tab bar (dimmed) and
// reloads them when you click one. Never unloaded: the tab you're on, pinned tabs, tabs playing sound or using the
// camera or microphone, and sites on the keep-awake list. Loaded into each window by browser.js.
(() => {
  const { h, btn, choices, switchRow } = Fjord;
  const prefs = Services.prefs;
  const ON = "fjord.memorySaver.enabled", AFTER = "fjord.memorySaver.minutes", AWAKE = "fjord.memorySaver.awake";
  const awake = () => prefs.getStringPref(AWAKE, "").split(",").filter(Boolean);
  const hostOf = tab => { try { return tab.linkedBrowser.currentURI.host; } catch { return ""; } };
  const keptAwake = host => awake().some(s => host === s || host.endsWith(`.${s}`));

  // A tab opened in the background and never looked at counts from when it opened
  const opened = new WeakMap();
  for (const tab of gBrowser.tabs) opened.set(tab, Date.now());
  gBrowser.tabContainer.addEventListener("TabOpen", e => opened.set(e.target, Date.now()));

  // About how much memory each tab uses: its processes' memory, shared out between the open tabs in each process
  // (tabs of one site share a process). Measured just before a tab sleeps, so it's what sleeping freed.
  const freed = new WeakMap();
  const pidsOf = tab => new Set((tab.linkedBrowser.browsingContext?.getAllBrowsingContextsInSubtree() ?? [])
    .map(bc => bc.currentWindowGlobal?.osPid).filter(Boolean));
  async function measure(tabs) {
    const { children } = await ChromeUtils.requestProcInfo();
    const memory = new Map(children.map(p => [p.pid, p.memory]));
    const sharing = new Map();
    for (const win of Services.wm.getEnumerator("navigator:browser"))
      for (const t of win.gBrowser.tabs) if (t.linkedPanel) for (const pid of pidsOf(t)) sharing.set(pid, (sharing.get(pid) ?? 0) + 1);
    return new Map(tabs.map(t => [t, [...pidsOf(t)].reduce((sum, pid) => sum + (memory.get(pid) ?? 0) / sharing.get(pid), 0)]));
  }
  const size = bytes => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
  const asleep = () => gBrowser.tabs.filter(t => !t.linkedPanel);
  const freedNow = () => asleep().reduce((sum, t) => sum + (freed.get(t) ?? 0), 0);

  async function sweep() {
    if (!prefs.getBoolPref(ON, true)) return;
    const limit = Date.now() - prefs.getIntPref(AFTER, 60) * 60000;
    const due = gBrowser.tabs.filter(tab => !tab.selected && !tab.pinned && tab.linkedPanel && !tab.soundPlaying && !tab.hasAttribute("sharing")
      && Math.max(tab.lastAccessed || 0, opened.get(tab) ?? 0) <= limit
      && /^https?:$/.test(tab.linkedBrowser.currentURI.scheme + ":") && !keptAwake(hostOf(tab)));
    if (!due.length) return;
    const uses = await measure(due);
    for (const tab of due) {
      if (tab.selected || !tab.linkedPanel) continue; // looked at while measuring
      gBrowser.discardBrowser(tab); // keeps the tab if the page asks before leaving (unsaved work)
      if (!tab.linkedPanel) freed.set(tab, uses.get(tab));
    }
  }
  Fjord.memorySweep = sweep; // for tests

  // A sleeping tab's preview card (on hover) says so, and about how much it freed
  const card = document.getElementById("tab-preview-panel");
  const note = card && h("div", { class: "ns-asleep-note" });
  card?.querySelector(".tab-preview-uri")?.after(note);
  gBrowser.tabContainer.addEventListener("mouseover", e => {
    const tab = e.target.closest?.("tab");
    if (!note || !tab) return;
    note.hidden = !!tab.linkedPanel;
    note.textContent = freed.get(tab) ? `Asleep, freed about ${size(freed.get(tab))}` : "Asleep, wakes when you click it";
  });
  const timer = setInterval(sweep, 60000);
  window.addEventListener("unload", () => clearInterval(timer));

  const TIMES = [[15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"]];
  Fjord.sections.performance = {
    label: "Performance", after: "newtab",
    desc: "Fjord frees memory from tabs you're not using, so the ones you are stay fast.",
    keys: "memory saver unload tabs sleep ram performance keep awake speed",
    render: ({ reopen }) => {
      const unloaded = asleep().length, bytes = freedNow();
      const sites = awake();
      const input = h("input", { type: "text", placeholder: "Site, like open.spotify.com", "aria-label": "Site to keep awake" });
      const addSite = site => {
        site = site.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
        if (site) prefs.setStringPref(AWAKE, [...new Set([...awake(), site])].join(","));
        reopen();
      };
      input.addEventListener("keydown", e => { if (e.key === "Enter") addSite(input.value); });
      const current = hostOf(gBrowser.selectedTab);
      return [
        h("div", { class: "ns-group" },
          switchRow("Memory saver", "Tabs you haven't looked at for a while are unloaded. They stay in the tab bar, dimmed, and come back when you click them.",
            prefs.getBoolPref(ON, true), v => { prefs.setBoolPref(ON, v); reopen(); })),
        h("p", { class: "ns-quiet ns-note" }, `${unloaded === 1 ? "1 tab" : `${unloaded} tabs`} asleep right now`
          + (bytes ? `, about ${size(bytes)} freed.` : ".")),
        h("h3", {}, "Unload tabs after"),
        choices("ns-pills", TIMES.map(([m, label]) => ({ value: m, content: [h("span", {}, label)] })),
          prefs.getIntPref(AFTER, 60), m => prefs.setIntPref(AFTER, m)),
        h("h3", {}, "Always keep awake"),
        h("p", {}, "Tabs playing sound, using your camera or microphone, and pinned tabs are never unloaded. Add sites that should stay ready too."),
        sites.length ? h("div", { class: "ns-group" }, ...sites.map(s => h("div", { class: "ns-list-row" }, h("span", {}, s),
          btn("ns-link", "Remove", () => { prefs.setStringPref(AWAKE, awake().filter(x => x !== s).join(",")); reopen(); })))) : null,
        h("div", { class: "ns-add-site" }, h("div", { class: "ns-row" }, input,
          btn("ns-secondary", "Add", () => addSite(input.value)),
          current && !keptAwake(current) ? btn("ns-link", `Add ${current}`, () => addSite(current)) : null)),
      ];
    },
  };
})();
