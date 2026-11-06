// The privacy report: a settings page with one week at a time (the last five can be looked back on): how much was
// blocked each day, which companies tried to track you and on which sites, and the sites with the most trackers.
// The counts are kept by privacy.sys.mjs, on this computer only. Loaded into each window by browser.js.
(() => {
  const { h, btn } = Fjord;
  const privacy = ChromeUtils.importESModule("resource://fjord/privacy.sys.mjs");
  const WEEKS = 5; // privacy.sys.mjs keeps 35 days
  const SHOW = 8;
  const date = d => new Date(`${d}T00:00`);
  const short = d => date(d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const names = (list, one, many) => new Intl.ListFormat(undefined)
    .format(list.length <= 3 ? list : [...list.slice(0, 2), plural(list.length - 2, `other ${one}`, `other ${many}`)]);

  // Rows of name, what it was with, and its count; the rest behind "Show all"
  function rows(list, sub) {
    const group = h("div", { class: "ns-group" });
    const row = e => h("div", { class: "ns-list-row ns-conn-row" },
      h("span", {}, h("b", {}, e.name), e.with.length ? h("span", {}, sub(e.with)) : null),
      h("span", { class: "ns-conn-count" }, h("b", {}, e.count.toLocaleString())));
    group.append(...list.slice(0, SHOW).map(row));
    if (list.length <= SHOW) return [group];
    const all = btn("ns-link ns-report-more", `Show all ${list.length}`, () => { all.remove(); group.append(...list.slice(SHOW).map(row)); });
    return [group, all];
  }

  async function week(weeksAgo, show) {
    const r = await privacy.weekReport(weeksAgo);
    const first = r.days[0].date, last = r.days.at(-1).date;
    const counted = r.since && r.since <= last;
    const prev = counted && weeksAgo + 1 < WEEKS && r.since <= first ? await privacy.weekReport(weeksAgo + 1) : null;

    const older = btn("ns-report-step", "", () => show(weeksAgo + 1));
    older.append(Fjord.icon("chevron"));
    older.setAttribute("aria-label", "The week before");
    older.disabled = weeksAgo + 1 >= WEEKS || !counted || r.since >= first;
    const newer = btn("ns-report-step ns-report-next", "", () => show(weeksAgo - 1));
    newer.append(Fjord.icon("chevron"));
    newer.setAttribute("aria-label", "The week after");
    newer.disabled = weeksAgo === 0;
    const title = ["This week", "Last week"][weeksAgo] ?? `${weeksAgo} weeks ago`;
    const nav = h("div", { class: "ns-report-nav" }, older,
      h("span", {}, h("b", {}, title), h("span", {}, `${short(first)} – ${short(last)}`)), newer);
    if (!counted) return [nav, h("p", { class: "ns-quiet ns-report-empty" }, "Fjord hadn't started counting yet.")];

    const change = prev && prev.blocked ? r.blocked - prev.blocked : 0;
    const max = Math.max(1, ...r.days.map(d => d.blocked));
    const bars = h("div", { class: "ns-report-bars", role: "img",
      "aria-label": r.days.map(d => `${date(d.date).toLocaleDateString(undefined, { weekday: "long" })}: ${d.blocked}`).join(", ") },
      ...r.days.map(d => h("span", { title: `${d.blocked.toLocaleString()} blocked` },
        h("i", { style: `height: ${Math.max(3, (d.blocked / max) * 72)}px` }),
        date(d.date).toLocaleDateString(undefined, { weekday: "short" }))));

    const kept = Services.prefs.getBoolPref("places.history.enabled", true);
    return [
      nav,
      h("div", { class: "ns-report-total" },
        h("b", {}, r.blocked.toLocaleString()),
        h("span", {}, "ads and trackers blocked",
          change ? h("span", { class: "ns-quiet" }, `${Math.abs(change).toLocaleString()} ${change > 0 ? "more" : "fewer"} than the week before`) : null)),
      bars,
      h("h3", {}, "Companies that tried to track you"),
      h("p", { class: "ns-quiet" }, "How many times pages tried to send them something, and on which sites."),
      ...(r.companies.length ? rows(r.companies, s => `on ${names(s, "site", "sites")}`)
        : [h("p", { class: "ns-quiet" }, "None this week.")]),
      h("h3", {}, "Sites with the most trackers"),
      ...(r.sites.length ? rows(r.sites, c => names(c, "company", "companies"))
        : [h("p", { class: "ns-quiet" }, !r.companies.length ? "None this week."
          : kept ? "Fjord keeps which sites only while your history is kept. They're forgotten when you clear it, and in Ghost mode when Fjord closes."
          : "Fjord doesn't keep which sites, because your history is turned off.")]),
    ];
  }

  Fjord.sections.report = {
    label: "Privacy report", after: "privacy",
    desc: "Who tried to track you this week, and where. Counted on this computer and never sent anywhere.",
    keys: "privacy report trackers companies sites week weekly blocked stats google meta",
    render: async () => {
      const box = h("div", { class: "ns-report" });
      const show = async n => box.replaceChildren(...await week(n, show));
      await show(0);
      return [
        box,
        h("p", { class: "ns-quiet ns-report-foot" }, "Private windows aren't counted. Clearing your history also clears the sites here."),
        btn("ns-secondary", "Forget all sites", async e => {
          await privacy.forgetSites();
          e.target.remove();
          await show(0);
        }),
      ];
    },
  };
})();
