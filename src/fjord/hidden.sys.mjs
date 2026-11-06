// Parts of pages you hid ("Hide this…" in the right-click menu, features/hide.js): CSS selectors per site, kept in
// the profile and handed to every tab's page-frame.js, which hides them before the page shows.
const FILE = PathUtils.join(PathUtils.profileDir, "fjord-hidden.json");
let sites = {}; // site -> { selectors: [...], unlockScroll }
const publish = () => {
  Services.ppmm.sharedData.set("Fjord:hidden", sites);
  Services.ppmm.sharedData.flush();
};
export const ready = IOUtils.readJSON(FILE).then(j => { sites = j.sites ?? {}; }, () => {}).then(publish);
const save = () => IOUtils.writeJSON(FILE, { sites }, { tmpPath: FILE + ".tmp" }).catch(console.error);

// unlockScroll: the hidden part covered the page (a cookie wall, say), and those often stop the page from scrolling
export function add(site, selector, unlockScroll) {
  const s = sites[site] ??= { selectors: [], unlockScroll: false };
  if (!s.selectors.includes(selector)) s.selectors.push(selector);
  s.unlockScroll ||= !!unlockScroll;
  publish();
  save();
}
export function remove(site, selector) {
  const s = sites[site];
  if (!s) return;
  s.selectors = selector ? s.selectors.filter(x => x !== selector) : [];
  if (!s.selectors.length) delete sites[site];
  publish();
  save();
}
export const forSite = site => sites[site]?.selectors ?? [];
export const all = () => Object.entries(sites).map(([site, s]) => ({ site, count: s.selectors.length }));
export const selectors = () => Object.fromEntries(Object.entries(sites).map(([site, s]) => [site, [...s.selectors]])); // for sync.sys.mjs

Services.mm.addMessageListener("Fjord:Hide", m => {
  if (m.target.browsingContext?.usePrivateBrowsing) return; // hidden for this visit only, nothing saved
  add(String(m.data.site), String(m.data.selector), m.data.unlockScroll);
});
Services.mm.addMessageListener("Fjord:Unhide", m => remove(String(m.data.site), String(m.data.selector)));
