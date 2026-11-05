// Fjord's privacy watch, one per session (an ES module is loaded once):
//  - which tracking companies each page contacts, for Shields' privacy label
//  - per-day counts (blocked, and contacts per company) for the new tab's weekly summary. Only counts are kept,
//    never which sites you visited, and private windows aren't recorded.
//  - the lookalike-site check: stops pages whose name copies a popular site (paypa1.com) before they load
import { TRACKERS } from "resource://fjord/trackers.sys.mjs";
import { setInterval, clearInterval } from "resource://gre/modules/Timer.sys.mjs";
import * as youtube from "resource://fjord/youtube.sys.mjs";

const COMPANY = new Map();
for (const [name, domains] of Object.entries(TRACKERS)) for (const d of domains) COMPANY.set(d, name);

// The site part of a host name: "www.news.bbc.co.uk" -> "bbc.co.uk"
export function baseDomain(host) {
  try {
    return Services.eTLD.getBaseDomainFromHost(host);
  } catch {
    return host; // IP addresses and single-word hosts
  }
}

export function companyOf(host) {
  for (let h = host; h; h = h.slice(h.indexOf(".") + 1 || h.length)) {
    if (COMPANY.has(h)) return COMPANY.get(h);
    if (!h.includes(".")) break;
  }
  return null;
}

// ---------- Per page ----------
const pages = new Map(); // browserId -> { site, owner, companies: Map(name -> requests) }

// Companies the page in this tab contacted, most first. Not counting the site's own company (Google on youtube.com).
export function pageCompanies(browserId) {
  const page = pages.get(browserId);
  return page ? [...page.companies].sort((a, b) => b[1] - a[1]) : [];
}

// ---------- Per day ----------
const FILE = PathUtils.join(PathUtils.profileDir, "fjord-week.json");
const KEEP_DAYS = 35;
let days = {}; // "2026-11-03" -> { blocked, total, companies: { Google: 12 } }
let dirty = false;
const today = () => new Date().toLocaleDateString("sv"); // yyyy-mm-dd in local time
const day = () => (days[today()] ??= { blocked: 0, companies: {} });
const ready = IOUtils.readJSON(FILE).then(d => { days = d.days ?? {}; }, () => {});

function save() {
  if (!dirty) return;
  dirty = false;
  const keep = Object.keys(days).sort().slice(-KEEP_DAYS);
  days = Object.fromEntries(keep.map(k => [k, days[k]]));
  IOUtils.writeJSON(FILE, { days }, { tmpPath: FILE + ".tmp" }).catch(console.error);
}
const saveTimer = setInterval(save, 60000);
Services.obs.addObserver(() => { clearInterval(saveTimer); save(); }, "quit-application-granted");

// Fed the running "blocked since install" total (Firefox's tracker blocking + uBlock); a day's count is how much
// it grew that day.
export async function recordBlocked(total) {
  await ready;
  const d = day();
  const before = Object.keys(days).sort().filter(k => k < today()).at(-1);
  const start = d.start ?? days[before]?.total ?? total;
  d.start = total < start ? total : start; // the total went down: uBlock's stats were reset
  d.total = total;
  d.blocked = total - d.start;
  dirty = true;
}

// The last 7 days for the new tab: blocked per day, and the companies most often contacted
export async function weekSummary() {
  await ready;
  const list = [];
  const companies = {};
  for (let i = 6; i >= 0; i--) {
    const date = new Date(Date.now() - i * 864e5);
    const d = days[date.toLocaleDateString("sv")];
    list.push({ day: date.toLocaleDateString(undefined, { weekday: "short" }), blocked: d?.blocked ?? 0 });
    for (const [name, n] of Object.entries(d?.companies ?? {})) companies[name] = (companies[name] ?? 0) + n;
  }
  return {
    since: Object.keys(days).sort()[0], // the first day Fjord counted, in local time
    blocked: list.reduce((sum, d) => sum + d.blocked, 0),
    days: list,
    companies: Object.entries(companies).sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

// ---------- Lookalike sites ----------
// Popular sites that fake copies are named after. A site matches when its name, ignoring the ending (.com, .no),
// is the same after swapping lookalike characters (paypa1, g00gle, rnicrosoft), or one typo away for names of
// 6+ letters (gooogle, amazom). Also catches the popular name used as the start of another site (paypal.com.evil.net).
const POPULAR = ["google.com", "youtube.com", "gmail.com", "facebook.com", "instagram.com", "whatsapp.com", "messenger.com",
  "twitter.com", "linkedin.com", "tiktok.com", "snapchat.com", "pinterest.com", "reddit.com", "discord.com", "telegram.org",
  "wikipedia.org", "amazon.com", "ebay.com", "etsy.com", "walmart.com", "target.com", "bestbuy.com", "aliexpress.com",
  "alibaba.com", "shopify.com", "apple.com", "icloud.com", "microsoft.com", "outlook.com", "office.com", "live.com",
  "netflix.com", "spotify.com", "twitch.tv", "steampowered.com", "steamcommunity.com", "epicgames.com", "roblox.com",
  "playstation.com", "xbox.com", "nintendo.com", "paypal.com", "stripe.com", "venmo.com", "wise.com", "revolut.com",
  "klarna.com", "chase.com", "bankofamerica.com", "wellsfargo.com", "citibank.com", "capitalone.com", "americanexpress.com",
  "hsbc.com", "barclays.co.uk", "santander.com", "nordea.com", "danskebank.com", "dnb.no", "vipps.no", "bankid.no",
  "coinbase.com", "binance.com", "kraken.com", "metamask.io", "blockchain.com", "ledger.com", "trezor.io", "github.com",
  "gitlab.com", "dropbox.com", "adobe.com", "docusign.com", "zoom.us", "slack.com", "notion.so", "openai.com",
  "chatgpt.com", "claude.ai", "anthropic.com", "yahoo.com", "proton.me", "protonmail.com", "duckduckgo.com",
  "mozilla.org", "booking.com", "airbnb.com", "expedia.com", "uber.com", "doordash.com", "dhl.com", "fedex.com",
  "ups.com", "usps.com", "irs.gov", "intuit.com", "wetransfer.com", "mega.nz", "tumblr.com", "medium.com"];
const LABELS = new Map(POPULAR.map(d => [d.slice(0, d.indexOf(".")), d]));
const BASES = new Set(POPULAR);
const CONFUSABLE = { 0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", i: "l", "|": "l" };
const normalize = s => s.replace(/rn/g, "m").replace(/vv/g, "w").replace(/[01345789i|]/g, c => CONFUSABLE[c]);
const NORMAL = new Map([...LABELS].map(([label, d]) => [normalize(label), d]));

// One insertion, deletion, substitution or swap of neighbours apart
function oneTypo(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// The popular site this host imitates, or null
export function lookalikeOf(host) {
  const base = baseDomain(host);
  if (BASES.has(base)) return null;
  let suffix = "";
  try { suffix = Services.eTLD.getPublicSuffixFromHost(host); } catch { return null; }
  const label = base.slice(0, base.length - suffix.length - 1);
  if (!label || label.includes(".") || LABELS.has(label)) return null; // the same name on another ending: amazon.de, google.com.au
  for (const d of POPULAR) if (`.${host}.`.includes(`.${d}.`)) return d;
  const normal = normalize(label);
  if (NORMAL.has(normal)) return NORMAL.get(normal);
  if (label.length >= 6) for (const [l, d] of LABELS) if (l.length >= 6 && oneTypo(label, l)) return d;
  return null;
}

// ---------- Clean redirect links ("debouncing") ----------
// Links that go through a tracker first (google.com/url?q=…, l.facebook.com/l.php?u=…) are opened at their real
// destination instead, so the middleman never sees the click. [host pattern, path pattern, parameter with the target]
const REDIRECTS = [
  [/(^|\.)google\.[a-z.]+$/, /^\/url$/, ["q", "url"]],
  [/^(l|lm)\.facebook\.com$/, /^\/l\.php$/, ["u"]],
  [/^l\.instagram\.com$/, /^\/$/, ["u"]],
  [/^l\.messenger\.com$/, /^\/l\.php$/, ["u"]],
  [/(^|\.)youtube\.com$/, /^\/redirect$/, ["q"]],
  [/^out\.reddit\.com$/, /^\/.*/, ["url"]],
  [/^steamcommunity\.com$/, /^\/linkfilter\/?$/, ["url", "u"]],
  [/^disq\.us$/, /^\/url$/, ["url"]],
  [/^slack-redir\.net$/, /^\/link$/, ["url"]],
  [/(^|\.)linkedin\.com$/, /^\/redir\/redirect\/?$/, ["url"]],
  [/^away\.vk\.com$/, /^\/away\.php$/, ["to"]],
  [/^t\.umblr\.com$/, /^\/redirect$/, ["z"]],
  [/(^|\.)duckduckgo\.com$/, /^\/l\/?$/, ["uddg"]],
  [/\.safelinks\.protection\.outlook\.com$/, /^\/$/, ["url"]],
  [/^exit\.sc$/, /^\/$/, ["url"]],
];
export function unwrapRedirect(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const rule = REDIRECTS.find(([host, path]) => host.test(u.hostname) && path.test(u.pathname));
  if (!rule) return null;
  for (const name of rule[2]) {
    const target = u.searchParams.get(name);
    if (target && /^https?:\/\//i.test(target)) return target;
  }
  return null;
}

// Sites the user chose to open anyway
const ALLOWED = "fjord.lookalike.allowed";
const allowed = () => Services.prefs.getStringPref(ALLOWED, "").split(",").filter(Boolean);
export function allowLookalike(host) {
  Services.prefs.setStringPref(ALLOWED, [...new Set([...allowed(), baseDomain(host)])].join(","));
}

// ---------- Fjord's own connections ("Prove it") ----------
// Requests that don't come from a page you opened: Firefox's background services and uBlock Origin's updates.
// Kept in memory for this session only.
const PURPOSES = [
  [/(^|\.)firefox\.settings\.services\.mozilla\.com$|firefox-settings-attachments\.cdn\.mozilla\.net$/, "Security lists and blocklists from Mozilla"],
  [/content-signature-2\.cdn\.mozilla\.net$/, "Checking those lists are signed by Mozilla"],
  [/(^|\.)tracking-protection\.cdn\.mozilla\.net$/, "Firefox's lists of trackers to block"],
  [/(^|\.)safebrowsing\.(googleapis|google)\.com$/, "Lists of dangerous sites (Safe Browsing). Only short fingerprints of addresses are ever sent"],
  [/(^|\.)(addons|services\.addons|versioncheck\.addons|versioncheck-bg\.addons)\.mozilla\.org$|(^|\.)addons\.cdn\.mozilla\.net$/, "Updates for uBlock Origin"],
  [/(^|\.)push\.services\.mozilla\.com$/, "Notifications from sites you allowed to send them"],
  [/^dns\.quad9\.net$|^dns\.mullvad\.net$|cloudflare-dns\.com$/, "Secure DNS: finding the sites you open"],
  [/(^|\.)(ocsp|crl)\.|\.o\.lencr\.org$|(^|\.)pki\.goog$|digicert\.com$|sectigo\.com$/, "Checking a site's security certificate is still valid"],
  [/(^|\.)aus5\.mozilla\.org$/, "Video codec updates (the Firefox updater itself is off)"],
  [/(^|\.)gvt1\.com$|(^|\.)ciscobinary\.openh264\.org$/, "Video codecs, so Netflix, Spotify and video calls work"],
  [/api\.beacondb\.net$|location\.services\.mozilla\.com$/, "Your location, only when a site asks and you allow it"],
  [/^images\.unsplash\.com$/, "New-tab photos, downloaded once (new tabs never contact Unsplash)"],
  [/(^|\.)telemetry\.mozilla\.org$/, "Usage data (should never appear: it's switched off)"],
];
const connectionsByHost = new Map(); // host -> { host, purpose, by, count, first, last }
function logConnection(host, by) {
  const purpose = by === "uBlock Origin" ? "Filter list updates for uBlock Origin"
    : PURPOSES.find(([re]) => re.test(host))?.[1] ?? "Other";
  const c = connectionsByHost.get(host) ?? { host, purpose, by, count: 0, first: Date.now() };
  c.count++;
  c.last = Date.now();
  connectionsByHost.set(host, c);
}
export const connections = () => [...connectionsByHost.values()].sort((a, b) => b.last - a.last);
export const watchingSince = Date.now();

// Runs fn(browser, window) for a tab once the load call that started a request has returned. The tab is found by its
// id, which survives process switches.
function withBrowser(browserId, fn) {
  Services.tm.dispatchToMainThread(() => {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const browser = win.gBrowser.browsers.find(b => b.browserId === browserId);
      if (browser) return fn(browser, win);
    }
  });
}

// ---------- Watching requests ----------
// http-on-opening-request comes before blocking, so it also sees requests that uBlock or Firefox then stop
function onRequest(subject) {
  let channel, info, top;
  try {
    channel = subject.QueryInterface(Ci.nsIHttpChannel);
    info = channel.loadInfo;
    top = BrowsingContext.get(info.browsingContextID)?.top;
  } catch {
    return;
  }
  const host = channel.URI.host;
  const extension = info.triggeringPrincipal?.addonPolicy?.name;
  if (!top?.browserId || extension) return logConnection(host, extension ?? "Fjord");
  // A new page in the tab (isTopLevelLoad is also true for the page's own scripts and images)
  if (info.externalContentPolicyType === Ci.nsIContentPolicy.TYPE_DOCUMENT) {
    const target = Services.prefs.getBoolPref("fjord.debounce.enabled", true) && unwrapRedirect(channel.URI.spec);
    if (target) {
      channel.cancel(Cr.NS_BINDING_ABORTED);
      withBrowser(top.browserId, browser => browser.fixupAndLoadURIString(target, {
        triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}),
        loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY, // Back skips the redirect page too
      }));
      return;
    }
    if (youtube.catches(channel.URI, info, top.browserId)) {
      channel.cancel(Cr.NS_BINDING_ABORTED);
      const video = youtube.videoOf(channel.URI);
      withBrowser(top.browserId, browser => youtube.play(browser, video));
      return;
    }
    if (Services.prefs.getBoolPref("fjord.lookalike.enabled", true)) {
      const like = lookalikeOf(host);
      if (like && !allowed().includes(baseDomain(host))) {
        channel.cancel(Cr.NS_BINDING_ABORTED);
        const url = channel.URI.spec;
        withBrowser(top.browserId, (browser, win) => win.Fjord?.showLookalike(browser, url, like));
        return;
      }
    }
    const site = baseDomain(host);
    pages.set(top.browserId, { site, owner: companyOf(site), companies: new Map() });
    return;
  }
  const page = pages.get(top.browserId);
  if (!page || baseDomain(host) === page.site) return;
  const company = companyOf(host);
  if (!company || company === page.owner) return;
  page.companies.set(company, (page.companies.get(company) ?? 0) + 1);
  if (!info.originAttributes.privateBrowsingId) {
    const counts = day().companies;
    counts[company] = (counts[company] ?? 0) + 1;
    dirty = true;
  }
}
Services.obs.addObserver(onRequest, "http-on-opening-request");
