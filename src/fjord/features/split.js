// Split view (Firefox's own, which has no animation): the page joining a split slides in from its side, and a tab
// picked to replace the "choose a tab" page fades in where it was. The page you were on stays put. Loaded into each
// window by browser.js.
(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
  const members = new WeakMap(); // split view -> the tabs already shown in it

  function enter(tab, slide) {
    const panel = document.getElementById(tab.linkedPanel);
    if (!panel) return;
    // column 0 is the left half, except in right-to-left languages
    const side = (panel.getAttribute("column") === "0") !== (document.dir === "rtl") ? -1 : 1;
    panel.animate(slide && !reduce.matches
      ? [{ opacity: 0, transform: `translateX(${side * 32}px)` }, { opacity: 1, transform: "none" }]
      : [{ opacity: 0 }, { opacity: 1 }], { duration: slide && !reduce.matches ? 380 : 200, easing: EASE });
  }

  gBrowser.tabContainer.addEventListener("TabSplitViewActivate", e => {
    const { splitview, tabs } = e.detail;
    if (members.has(splitview)) return; // selecting a split again isn't news
    members.set(splitview, new Set([gBrowser.selectedTab]));
    for (const tab of tabs) if (!members.get(splitview).has(tab)) enter(tab, true);
    for (const tab of tabs) members.get(splitview).add(tab);
  });
  gBrowser.tabContainer.addEventListener("SplitViewTabChange", e => {
    const seen = members.get(e.target);
    if (!seen) return; // still being made; TabSplitViewActivate handles it
    for (const tab of e.target.tabs) if (!seen.has(tab)) { seen.add(tab); enter(tab, false); }
  });
})();
