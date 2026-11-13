// The popped-out video window (Firefox's picture-in-picture player), loaded into it by Fjord.cfg: Fjord's look for
// its top buttons (pip.css), and a pin at the top right that keeps the window above other windows or lets it go
// behind them. Firefox always keeps it on top and has no switch for it, so the pin asks Windows or macOS directly.
// The choice is remembered for the next video.
(() => {
  const ON_TOP = "fjord.pip.onTop";
  const XHTML = "http://www.w3.org/1999/xhtml";
  const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
  const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
  const mac = AppConstants.platform === "macosx";

  const sheet = document.createElementNS(XHTML, "link");
  sheet.rel = "stylesheet";
  sheet.href = "resource://fjord/pip.css";
  (document.head ?? document.documentElement).append(sheet);

  // The window's own handle: an HWND on Windows, an NSWindow (or its NSView) on a Mac
  const handle = () => {
    const h = window.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle;
    return h ? ctypes.voidptr_t(ctypes.UInt64(h)) : null;
  };

  let setOnTop = null;
  if (AppConstants.platform === "win") {
    setOnTop = on => {
      const user32 = ctypes.open("user32.dll");
      try {
        const SetWindowPos = user32.declare("SetWindowPos", ctypes.winapi_abi, ctypes.int32_t,
          ctypes.voidptr_t, ctypes.voidptr_t, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t, ctypes.uint32_t);
        const after = ctypes.cast(ctypes.intptr_t(on ? -1 : -2), ctypes.voidptr_t); // HWND_TOPMOST / HWND_NOTOPMOST
        SetWindowPos(handle(), after, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
      } finally { user32.close(); }
    };
  } else if (mac) {
    setOnTop = on => {
      const objc = ctypes.open("/usr/lib/libobjc.A.dylib");
      try {
        const id = ctypes.voidptr_t;
        const sel = objc.declare("sel_registerName", ctypes.default_abi, id, ctypes.char.ptr);
        const send = objc.declare("objc_msgSend", ctypes.default_abi, id, id, id);
        const sendSel = objc.declare("objc_msgSend", ctypes.default_abi, ctypes.bool, id, id, id);
        const sendLong = objc.declare("objc_msgSend", ctypes.default_abi, ctypes.void_t, id, id, ctypes.long);
        let target = handle();
        if (!target || target.isNull()) return;
        // The handle can be the window's view; NSView answers "window" with its NSWindow
        if (!sendSel(target, sel("respondsToSelector:"), sel("setLevel:"))) target = send(target, sel("window"));
        if (target.isNull() || !sendSel(target, sel("respondsToSelector:"), sel("setLevel:"))) return;
        sendLong(target, sel("setLevel:"), on ? 3 : 0); // NSFloatingWindowLevel / NSNormalWindowLevel
      } finally { objc.close(); }
    };
  }
  if (!setOnTop) return; // Linux: no pin, the window stays on top as Firefox makes it

  const pin = document.createElementNS(XHTML, "button");
  pin.id = "fjord-pin";
  pin.className = "control-item control-button tooltip-under-controls";
  if (mac) pin.setAttribute("mac", "true");
  document.getElementById("controls")?.append(pin);

  function apply(on) {
    try { setOnTop(on); } catch (e) { console.error("Fjord pin:", e); return; }
    pin.toggleAttribute("pinned", on);
    pin.setAttribute("aria-pressed", String(on));
    const tip = on ? "Kept on top of other windows. Click to let it go behind them." : "Keep on top of other windows";
    pin.setAttribute("aria-label", tip);
    pin.setAttribute("tooltip", tip);
  }
  pin.addEventListener("click", () => {
    const on = !pin.hasAttribute("pinned");
    Services.prefs.setBoolPref(ON_TOP, on);
    apply(on);
  });
  // After Firefox has shown the window on top, so the remembered choice wins
  setTimeout(() => apply(Services.prefs.getBoolPref(ON_TOP, true)), 300);
})();
