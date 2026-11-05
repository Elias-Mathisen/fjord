// Saved passwords locked to this Windows account. Firefox encrypts them with a key in key4.db that anyone who copies
// the profile can use, unless a Primary Password protects it. So Fjord sets a long random Primary Password nobody has
// to type, keeps it encrypted by the system's key store (Windows Credential Manager, which only this Windows account on
// this PC can read) and unlocks with it at startup. The profile holds only the encrypted copy: on another PC or account
// Firefox asks for the Primary Password as usual, and nobody knows it. A Primary Password you set yourself is left alone.
// shortcut: Windows only; nsIOSKeyStore uses the Keychain on a Mac, turn it on there once tested on the Mac build.
const LABEL = "Fjord Password Lock";
const store = Cc["@mozilla.org/security/oskeystore;1"].getService(Ci.nsIOSKeyStore);
const token = Cc["@mozilla.org/security/internalkeytoken;1"].createInstance(Ci.nsIPKCS11Token);
const file = PathUtils.join(PathUtils.profileDir, "fjord-password-lock.txt");

// Firefox 159 can only unlock by prompting, so ask NSS (already loaded) directly: true and unlocked if pw is right
const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
const nss = ctypes.open(PathUtils.join(Services.dirsvc.get("GreD", Ci.nsIFile).path, ctypes.libraryName("nss3")));
const slotPtr = ctypes.voidptr_t;
const getSlot = nss.declare("PK11_GetInternalKeySlot", ctypes.default_abi, slotPtr);
const freeSlot = nss.declare("PK11_FreeSlot", ctypes.default_abi, ctypes.void_t, slotPtr);
const checkUserPassword = nss.declare("PK11_CheckUserPassword", ctypes.default_abi, ctypes.int, slotPtr, ctypes.char.ptr);
function checkPassword(pw) {
  const slot = getSlot();
  try {
    return checkUserPassword(slot, pw) === 0; // SECSuccess
  } finally {
    freeSlot(slot);
  }
}

let password = null; // while Fjord runs, to fill in Firefox's "current password" boxes
// Still Fjord's own password (false once you set your own in Firefox's settings)
export const active = () => password !== null && checkPassword(password);

async function unlock() {
  let wrapped = await IOUtils.readUTF8(file).catch(() => null);
  if (!token.hasPassword) {
    // First run, or the Primary Password was removed: lock with a new one
    if (!(await store.asyncSecretAvailable(LABEL))) await store.asyncGenerateSecret(LABEL);
    const pw = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    wrapped = await store.asyncEncryptBytes(LABEL, Array.from(new TextEncoder().encode(pw)));
    // Saved before the password changes, so a crash can't leave a password that isn't stored anywhere
    await IOUtils.writeUTF8(file, wrapped, { tmpPath: file + ".tmp", flush: true });
    await token.changePassword("", pw);
    password = pw;
    return;
  }
  if (wrapped === null) return; // the user's own Primary Password
  let pw;
  try {
    pw = new TextDecoder().decode(new Uint8Array(await store.asyncDecryptBytes(LABEL, wrapped)));
  } catch {
    return; // another PC or Windows account: Firefox asks for the Primary Password when it needs it
  }
  if (checkPassword(pw)) password = pw;
  else await IOUtils.remove(file); // replaced by the user's own
}
export const ready = unlock().catch(e => Services.console.logStringMessage("Fjord password lock failed: " + e));

// Firefox's change/remove Primary Password dialogs ask for the current one: fill in Fjord's and hide the box
const BOXES = {
  "chrome://mozapps/content/preferences/changemp.xhtml": ["oldpw", "oldpw-container"],
  "chrome://mozapps/content/preferences/removemp.xhtml": ["password", "password-container"],
};
Services.obs.addObserver(doc => {
  const box = BOXES[doc.documentURI];
  const win = doc.defaultView;
  if (!box || !win) return;
  win.addEventListener("load", () => win.setTimeout(() => {
    if (!active()) return;
    doc.getElementById(box[0]).value = password;
    doc.getElementById(box[1]).hidden = true;
    doc.querySelector("groupbox label")?.setAttribute("hidden", "true"); // removemp's "enter your current password"
  }), { once: true });
}, "document-element-inserted");

// With the device sign-in check off, Firefox would ask for the Primary Password before showing a saved password.
// Without a Primary Password it shows it straight away, so do the same for Fjord's.
const { LoginHelper } = ChromeUtils.importESModule("resource://gre/modules/LoginHelper.sys.mjs");
const requestReauth = LoginHelper.requestReauth;
LoginHelper.requestReauth = async function (...args) {
  return active() && !this.getOSAuthEnabled() ? { isAuthorized: true } : requestReauth.apply(this, args);
};
