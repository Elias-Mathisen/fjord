// "Your own VPN or proxy" in Fjord settings > Connection: send Fjord's traffic through the computer's settings (how
// most VPN apps work), straight out, a proxy server (SOCKS5 or HTTP, DNS through it too), or a setup address (PAC).
// Uses Firefox's own proxy prefs. With a proxy set, Fjord can refuse to connect without it (no leaks if it goes down);
// WebRTC already only goes through a proxy when there is one (Fjord.cfg). Loaded into each window by browser.js.
(() => {
  const { h, btn, choices, switchRow } = Fjord;
  const prefs = Services.prefs;
  const P = "network.proxy.";
  const MODES = [
    { value: 5, name: "Same as this computer", text: "The default. If a VPN app is running, Fjord goes through it like everything else." },
    { value: 0, name: "Direct", text: "Fjord ignores the computer's proxy settings." },
    { value: 1, name: "A proxy server", text: "SOCKS5 or HTTP, from Mullvad, Proton, your work or your own server." },
    { value: 2, name: "A setup address (PAC)", text: "A web address that tells Fjord which proxy to use, often given by work or school." },
  ];
  let picked = null; // a mode chosen but not saved yet (proxy server and PAC need details first)

  function applyProxy({ kind, host, port }) {
    for (const p of ["http", "http_port", "ssl", "ssl_port", "socks", "socks_port"]) prefs.clearUserPref(P + p);
    if (kind === "socks") {
      prefs.setStringPref(P + "socks", host);
      prefs.setIntPref(P + "socks_port", port);
      prefs.setIntPref(P + "socks_version", 5);
      prefs.setBoolPref(P + "socks_remote_dns", true); // site names are looked up by the proxy, not by your network
      prefs.setBoolPref(P + "share_proxy_settings", false);
    } else {
      for (const p of ["http", "ssl"]) {
        prefs.setStringPref(P + p, host);
        prefs.setIntPref(`${P}${p}_port`, port);
      }
      prefs.setBoolPref(P + "share_proxy_settings", true);
    }
    prefs.setIntPref(P + "type", 1);
    prefs.setBoolPref(P + "failover_direct", false);
  }
  function applyPac(url) {
    prefs.setStringPref(P + "autoconfig_url", url);
    prefs.setIntPref(P + "type", 2);
    prefs.setBoolPref(P + "failover_direct", false);
  }

  // Which IP address sites see now, from Mullvad's checker (it works for any connection, not only Mullvad)
  async function checkIp(out) {
    out.textContent = "Checking…";
    try {
      const r = await (await fetch("https://am.i.mullvad.net/json", { credentials: "omit", cache: "no-store" })).json();
      const place = [r.city, r.country].filter(Boolean).join(", ");
      out.textContent = `Sites see ${r.ip}${place ? ` in ${place}` : ""}${r.mullvad_exit_ip ? " (a Mullvad server)" : ""}.`;
    } catch {
      out.textContent = "Couldn't connect. If you set a proxy, check its address and that it's running.";
    }
  }

  Fjord.proxySettings = ({ reopen }) => {
    const type = prefs.getIntPref(P + "type", 5);
    const mode = picked ?? (MODES.some(m => m.value === type) ? type : 5);
    const nodes = [
      h("h3", {}, "Your own VPN or proxy"),
      h("p", {}, "Already have a VPN or a proxy? Send Fjord through it."),
      choices("ns-options", MODES.map(m => ({ value: m.value, content: [h("span", {}, h("b", {}, m.name), h("span", {}, m.text))] })), mode, v => {
        if (v === 5 || v === 0) {
          picked = null;
          prefs.setIntPref(P + "type", v);
          prefs.clearUserPref(P + "failover_direct");
        } else picked = v;
        reopen();
      }),
    ];
    const status = h("p", { class: "ns-quiet", role: "status" });
    if (mode === 1) {
      const kind = h("select", { "aria-label": "Proxy type" }, h("option", { value: "socks" }, "SOCKS5"), h("option", { value: "http" }, "HTTP / HTTPS"));
      const socks = prefs.getStringPref(P + "socks", "");
      kind.value = socks || !prefs.getStringPref(P + "http", "") ? "socks" : "http";
      const host = h("input", { type: "text", placeholder: "Server, like 10.64.0.1", "aria-label": "Proxy server" });
      const port = h("input", { type: "text", inputmode: "numeric", placeholder: "Port", "aria-label": "Port" });
      host.value = kind.value === "socks" ? socks : prefs.getStringPref(P + "http", "");
      const savedPort = prefs.getIntPref(kind.value === "socks" ? P + "socks_port" : P + "http_port", 0);
      port.value = savedPort ? String(savedPort) : "";
      const save = btn("ns-secondary", "Save", () => {
        const n = Number(port.value);
        const server = host.value.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
        if (!server || !/^[\w.\-:\[\]]+$/.test(server)) return (status.textContent = "Enter the proxy's address, like 10.64.0.1 or proxy.example.com.");
        if (!Number.isInteger(n) || n < 1 || n > 65535) return (status.textContent = "The port is a number from 1 to 65535.");
        applyProxy({ kind: kind.value, host: server, port: n });
        picked = null;
        reopen();
      });
      nodes.push(h("div", { class: "ns-add-site ns-proxy-form" }, h("div", { class: "ns-row" }, kind, host, port, save), status),
        h("p", { class: "ns-quiet ns-note" }, "Proxies that need a username and password: choose HTTP, and Fjord asks for them when it connects. Mullvad's SOCKS5 proxy is 10.64.0.1, port 1080, while the Mullvad app is connected."));
    } else if (mode === 2) {
      const url = h("input", { type: "text", placeholder: "https://example.com/proxy.pac", "aria-label": "Setup address" });
      url.value = prefs.getStringPref(P + "autoconfig_url", "");
      const save = btn("ns-secondary", "Save", () => {
        let u;
        try { u = new URL(url.value.trim()); } catch {}
        if (!u || !/^(https?|file):$/.test(u.protocol)) return (status.textContent = "Enter the full address, starting with https://.");
        applyPac(u.href);
        picked = null;
        reopen();
      });
      nodes.push(h("div", { class: "ns-add-site" }, h("div", { class: "ns-row" }, url, save), status));
    }
    if (type === 1 || type === 2) {
      nodes.push(h("div", { class: "ns-group" }, switchRow("Block connections if the proxy stops working",
        "Nothing leaks out without it. Turn off to fall back to a direct connection instead.",
        !prefs.getBoolPref(P + "failover_direct", true), v => prefs.setBoolPref(P + "failover_direct", !v))));
    }
    const ip = h("span", { class: "ns-quiet", role: "status" });
    nodes.push(h("div", { class: "ns-row ns-ip-check" }, btn("ns-secondary", "Check what sites see", () => checkIp(ip)), ip),
      h("p", { class: "ns-quiet ns-note" }, "The check asks am.i.mullvad.net, Mullvad's free checker, and only when you press the button."));
    return nodes;
  };
})();
