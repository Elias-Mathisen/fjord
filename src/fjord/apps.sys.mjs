// Fjord's sidebar apps: sites like Spotify or WhatsApp in Firefox's sidebar. The list lives in the
// fjord.sidebar.apps pref (ids of built-in apps, plus the user's own sites); icons are fetched once from each
// site and kept in the profile, so the sidebar doesn't contact anyone on every start.
// Apps with phone: true are shown as their phone site (a phone user agent), which fits the narrow sidebar.
export const PRESETS = [
  { id: "spotify", name: "Spotify", url: "https://open.spotify.com/", phone: true },
  { id: "whatsapp", name: "WhatsApp", url: "https://web.whatsapp.com/" },
  { id: "discord", name: "Discord", url: "https://discord.com/app" },
  { id: "telegram", name: "Telegram", url: "https://web.telegram.org/a/" },
  { id: "messenger", name: "Messenger", url: "https://www.messenger.com/" },
  { id: "slack", name: "Slack", url: "https://app.slack.com/client" },
  { id: "gmail", name: "Gmail", url: "https://mail.google.com/" },
  { id: "protonmail", name: "Proton Mail", url: "https://mail.proton.me/" },
  { id: "outlook", name: "Outlook", url: "https://outlook.live.com/mail/" },
  { id: "notion", name: "Notion", url: "https://www.notion.so/" },
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/" },
  { id: "claude", name: "Claude", url: "https://claude.ai/" },
  { id: "youtubemusic", name: "YouTube Music", url: "https://music.youtube.com/" },
  { id: "x", name: "X", url: "https://x.com/" },
  { id: "instagram", name: "Instagram", url: "https://www.instagram.com/" },
];
const PREF = "fjord.sidebar.apps";
const v = parseInt(Services.appinfo.version);
export const PHONE_UA = `Mozilla/5.0 (Android 15; Mobile; rv:${v}.0) Gecko/${v}.0 Firefox/${v}.0`;
const DEFAULT = [{ id: "spotify" }, { id: "whatsapp" }, { id: "discord" }];

// Stored entries are { id } for built-in apps and { id, name, url } for the user's own sites
function stored() {
  try {
    const list = JSON.parse(Services.prefs.getStringPref(PREF, ""));
    if (Array.isArray(list)) return list;
  } catch {}
  return DEFAULT;
}
const save = list => Services.prefs.setStringPref(PREF, JSON.stringify(list));

// The apps in the sidebar, in order, with names and addresses filled in
export function enabled() {
  return stored().map(a => a.url ? a : PRESETS.find(p => p.id === a.id)).filter(Boolean);
}
export const byId = id => enabled().find(a => a.id === id);

export function setPreset(id, on) {
  const list = stored().filter(a => a.id !== id);
  if (on) list.push({ id });
  save(list);
}

// The user's own site. Returns the new app, or null when the address isn't a web address.
export function addCustom(name, address) {
  let url;
  try {
    url = new URL(/^https?:\/\//.test(address) ? address : `https://${address}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const app = { id: `site-${Date.now()}`, name: name.trim() || url.hostname.replace(/^www\./, ""), url: url.href };
  save([...stored(), app]);
  return app;
}
export function remove(id) {
  save(stored().filter(a => a.id !== id));
}

// ---------- Icons ----------
const ICONS = PathUtils.join(PathUtils.profileDir, "fjord-app-icons.json");
let icons = null; // origin -> data: URL
const loaded = IOUtils.readJSON(ICONS).then(j => { icons = j; }, () => { icons = {}; });

// A letter on a grey tile, for sites whose icon can't be fetched
function letterIcon(name) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#5a5a5f"/>` +
    `<text x="16" y="21.5" text-anchor="middle" font-family="sans-serif" font-size="16" font-weight="600" fill="#fff">${(name[0] ?? "?").toUpperCase()}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function fetchImage(url) {
  const res = await fetch(url, { credentials: "omit" });
  const blob = await res.blob();
  if (!res.ok || !blob.type.startsWith("image/") || blob.size > 200000) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:${blob.type};base64,${btoa(bin)}`;
}

// The site's /favicon.ico, or else the icon its page links to
export async function icon(app) {
  await loaded;
  const { origin } = new URL(app.url);
  if (icons[origin]) return icons[origin];
  try {
    let data = await fetchImage(`${origin}/favicon.ico`).catch(() => null);
    if (!data) {
      const html = await (await fetch(app.url, { credentials: "omit" })).text();
      const link = html.match(/<link[^>]+rel=["'][^"']*\bicon\b[^"']*["'][^>]*>/i)?.[0];
      const href = link?.match(/href=["']([^"']+)["']/i)?.[1];
      if (href) data = await fetchImage(new URL(href.replace(/&amp;/g, "&"), app.url).href);
    }
    if (!data) throw new Error("no icon");
    icons[origin] = data;
    IOUtils.writeJSON(ICONS, icons, { tmpPath: ICONS + ".tmp" }).catch(console.error);
    return data;
  } catch {
    return letterIcon(app.name); // not cached, so the next start tries again
  }
}
