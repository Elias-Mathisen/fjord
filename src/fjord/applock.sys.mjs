// App lock, once per session: Fjord covers every window until you unlock with the computer's own sign-in (Windows
// Hello face, fingerprint or PIN; Touch ID or the password on a Mac). It locks when Fjord opens and after you've been
// away (no keyboard or mouse) for the chosen time. Windows follow the "fjord-applock" notification.
const ON = "fjord.appLock.enabled", IDLE = "fjord.appLock.idleMinutes";
const enabled = () => Services.prefs.getBoolPref(ON, false);
export let locked = enabled();

function set(value) {
  locked = value;
  Services.obs.notifyObservers(null, "fjord-applock", value ? "locked" : "unlocked");
}
export const lock = () => enabled() && set(true);

// The system's sign-in dialog, over the given window. Resolves "ok", "cancelled" or "no-password" (the computer has
// no PIN or password, so there's nothing to check against).
export async function verify(win, reason) {
  const reauth = Cc["@mozilla.org/security/osreauthenticator;1"].getService(Ci.nsIOSReauthenticator);
  try {
    const [ok, blank] = await reauth.asyncReauthenticateUser(reason, "Fjord", win);
    return blank ? "no-password" : ok ? "ok" : "cancelled";
  } catch {
    return "cancelled";
  }
}

export async function unlock(win) {
  const result = await verify(win, "Unlock Fjord");
  if (result !== "cancelled") set(false); // no system password: nothing to unlock with, so don't trap the user
  return result;
}

// Locks after the chosen minutes without keyboard or mouse input
const idle = Cc["@mozilla.org/widget/useridleservice;1"].getService(Ci.nsIUserIdleService);
const idleObserver = { observe: (s, topic) => topic === "idle" && lock() };
let watching = 0;
function watchIdle() {
  if (watching) idle.removeIdleObserver(idleObserver, watching);
  const minutes = Services.prefs.getIntPref(IDLE, 15);
  watching = enabled() && minutes > 0 ? minutes * 60 : 0;
  if (watching) idle.addIdleObserver(idleObserver, watching);
}
watchIdle();
Services.prefs.addObserver(IDLE, watchIdle);
Services.prefs.addObserver(ON, () => {
  watchIdle();
  if (!enabled() && locked) set(false);
});
