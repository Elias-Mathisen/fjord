// The new-tab photos. One comes with Fjord (photos/photo-001.jpg, so the download stays small and the new tab has a
// photo offline); the other 99 are downloaded from Unsplash once, in the background, into the profile's
// fjord-photos folder, where newtab.html looks first. New tabs never contact Unsplash themselves. One photo at a time,
// a minute after Fjord starts, and only ones still missing; a failed one is tried again next time. Nothing is
// downloaded while the new tab's photos are switched off.
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const BUNDLED = "photo-001.jpg";
let started = false;

export function fetchPhotos() {
  if (started) return;
  started = true;
  setTimeout(() => run().catch(e => Services.console.logStringMessage("Fjord photos: " + e)), 60000);
}

async function run() {
  const fjord = PathUtils.join(Services.dirsvc.get("GreD", Ci.nsIFile).path, "fjord");
  const dir = PathUtils.join(PathUtils.profileDir, "fjord-photos");
  // photos.js is "const PHOTOS = { dark: [...], light: [...] };", written by tools/get-photos.ps1
  const text = await IOUtils.readUTF8(PathUtils.join(fjord, "photos.js"));
  const list = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  const photos = [...list.dark, ...list.light].map(p => ({ name: p.file.replace(/^photos\//, ""), src: p.src }))
    .filter(p => p.name !== BUNDLED && /^photo-\d{3}\.jpg$/.test(p.name) && /^https:\/\/images\.unsplash\.com\//.test(p.src));
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  for (const p of photos) {
    if (!Services.prefs.getBoolPref("fjord.newtab.photos", true)) return;
    const target = PathUtils.join(dir, p.name);
    if (await IOUtils.exists(target)) continue;
    // Installs before 1.0.3 downloaded them next to Fjord's files: moved over (copied on a Mac, whose app can't change)
    const old = PathUtils.join(fjord, "photos", p.name);
    if (await IOUtils.exists(old)) {
      if (AppConstants.platform == "macosx") await IOUtils.copy(old, target);
      else await IOUtils.move(old, target);
      continue;
    }
    try {
      const res = await fetch(p.src, { credentials: "omit", referrerPolicy: "no-referrer" });
      if (!res.ok || !(res.headers.get("content-type") || "").startsWith("image/")) continue;
      await IOUtils.write(target, new Uint8Array(await res.arrayBuffer()), { tmpPath: target + ".part" });
    } catch {
      // Offline or Unsplash is down: the rest wait for the next start
      return;
    }
    await new Promise(r => setTimeout(r, 1500)); // gently, one after another
  }
}
