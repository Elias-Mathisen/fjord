// Tab folders (Firefox's tab groups): each folder's name knows how many tabs are inside, which a folded folder shows
// next to its name (chrome.css). Loaded into each window by browser.js.
(() => {
  const count = () => {
    for (const group of gBrowser.tabGroups ?? []) group.querySelector(".tab-group-label")?.setAttribute("data-count", group.tabs.length);
  };
  for (const type of ["TabGrouped", "TabUngrouped", "TabGroupCreate", "TabGroupCollapse", "TabClose", "TabOpen"]) {
    gBrowser.tabContainer.addEventListener(type, () => setTimeout(count, 0));
  }
  count();
})();