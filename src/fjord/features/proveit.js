// "Prove it": a settings page listing every connection Fjord itself makes (not the sites you open), grouped by
// what it's for, updating live while open. The log is kept by privacy.sys.mjs. Loaded into each window by browser.js.
(() => {
  const { h } = Fjord;
  const privacy = ChromeUtils.importESModule("resource://fjord/privacy.sys.mjs");
  const ago = t => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  };

  function list() {
    const groups = new Map();
    for (const c of privacy.connections()) {
      const g = groups.get(c.purpose) ?? { purpose: c.purpose, hosts: [], count: 0, last: 0 };
      g.hosts.push(c.host);
      g.count += c.count;
      g.last = Math.max(g.last, c.last);
      groups.set(c.purpose, g);
    }
    if (!groups.size) return h("p", { class: "ns-quiet" }, "No connections yet.");
    return h("div", { class: "ns-group" }, ...[...groups.values()].sort((a, b) => b.last - a.last).map(g =>
      h("div", { class: "ns-list-row ns-conn-row" },
        h("span", {}, h("b", {}, g.purpose), h("span", {}, g.hosts.slice(0, 4).join(", ") + (g.hosts.length > 4 ? ` and ${g.hosts.length - 4} more` : ""))),
        h("span", { class: "ns-conn-count" }, h("b", {}, g.count.toLocaleString()), h("span", {}, ago(g.last))))));
  }

  Fjord.sections.proveit = {
    label: "Fjord's connections", after: "connection",
    desc: "Every connection Fjord makes on its own, apart from the sites you open. None of them send your browsing history.",
    keys: "prove it connections telemetry tracking background network requests phone home",
    render: () => {
      const sinceText = () => `Since Fjord started ${ago(privacy.watchingSince)}. Updates live.`;
      const since = h("p", { class: "ns-quiet" }, sinceText());
      const box = h("div", {}, list());
      // Stops once the section is closed or another one is opened
      const timer = setInterval(() => {
        if (!box.isConnected) return clearInterval(timer);
        since.textContent = sinceText();
        box.replaceChildren(list());
      }, 2000);
      return [since, h("h3", {}, "Connections"), box];
    },
  };
})();
