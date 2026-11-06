#!/usr/bin/env python3
"""Gets Fjord for iOS's resources ready (run by ios/build.sh on a Mac):
  - EasyList, EasyPrivacy and Peter Lowe's list turned into WebKit content-blocking rules (Fjord/Resources/ads.json, trackers.json)
  - the first 10 new-tab photos (the hand-approved ones) with their credits, sized for phones
  - the logo and the app icon
The lists are downloaded again with --refresh-lists, or when they're missing."""
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

IOS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(IOS)
RES = os.path.join(IOS, "Fjord", "Resources")
ASSETS = os.path.join(IOS, "Fjord", "Assets.xcassets")
# The same lists the desktop's uBlock Origin starts with, as far as WebKit can use them
LISTS = {"ads": ["https://easylist.to/easylist/easylist.txt",
                 "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext"],
         "trackers": ["https://easylist.to/easylist/easyprivacy.txt"]}
MAX_RULES = 145000  # WebKit takes at most 150,000 rules per list

# Adblock option -> WebKit trigger field
TYPES = {"script": "script", "image": "image", "stylesheet": "style-sheet", "font": "font", "media": "media",
         "xmlhttprequest": "raw", "websocket": "websocket", "ping": "ping", "popup": "popup",
         "subdocument": "document", "object": "other", "other": "other"}
PARTY = {"third-party": "third-party", "3p": "third-party", "~first-party": "third-party",
         "first-party": "first-party", "1p": "first-party", "~third-party": "first-party"}
HARMLESS = {"important", "match-case", "all"}
DOMAIN_RULE = re.compile(r"^\|\|([a-z0-9.\-]+)(\^|/[^\s]*)?$")
PLAIN_DOMAIN = re.compile(r"[a-z0-9.\-]+")  # WebKit rejects the whole list over one domain that isn't lowercase ASCII
# Extended selectors only uBlock understands; WebKit would reject the whole rule
UNSUPPORTED_CSS = re.compile(r":(has|-abp-|contains|xpath|style|matches-|upward|remove|watch-attr|min-text-length|nth-ancestor|if|not\(:)|\[-ext-|^\+js")


def url_filter(domain, rest):
    f = r"^[^:]+://+([^:/]+\.)?" + domain.replace(".", r"\.")
    if rest in (None, "^"):
        return f + "[/:?]"
    path = rest[:-1] if rest.endswith("^") or rest.endswith("|") else rest
    if "^" in path or "|" in path:
        return None
    return f + re.sub(r"[.?+()\[\]{}\\$]", lambda m: "\\" + m.group(0), path).replace("*", ".*")


def trigger_options(text):
    """The trigger fields for an option list like '$third-party,script,domain=a.com', or None if WebKit can't do it"""
    trigger, types = {}, []
    for opt in text.split(",") if text else []:
        if opt in PARTY:
            trigger["load-type"] = [PARTY[opt]]
        elif opt in TYPES:
            types.append(TYPES[opt])
        elif opt.startswith("domain="):
            names = opt[7:].split("|")
            inc = [d for d in names if not d.startswith("~")]
            exc = [d[1:] for d in names if d.startswith("~")]
            if (inc and exc) or not all(PLAIN_DOMAIN.fullmatch(d) for d in inc + exc):
                return None
            if inc:
                trigger["if-domain"] = ["*" + d for d in inc]
            if exc:
                trigger["unless-domain"] = ["*" + d for d in exc]
        elif opt not in HARMLESS:
            return None  # redirect, removeparam, csp, "all types but…": nothing WebKit can do
    if types:
        trigger["resource-type"] = sorted(set(types))
    return trigger


def convert(text):
    blocks, hides, exceptions = [], [], []
    generic, by_domains = [], {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("!", "[")):
            continue
        if "##" in line:
            domains, _, selector = line.partition("##")
            if UNSUPPORTED_CSS.search(selector) or "#" in domains:
                continue
            if not domains:
                generic.append(selector)
            else:
                names = domains.split(",")
                if not all(PLAIN_DOMAIN.fullmatch(d) for d in names):
                    continue  # "all sites but…" (~) and wildcard endings (google.*) have no WebKit equivalent
                by_domains.setdefault(tuple(sorted(names)), []).append(selector)
            continue
        if "#@#" in line or "#?#" in line or "#$#" in line or "#%#" in line:
            continue
        exception = line.startswith("@@")
        body = line[2:] if exception else line
        pattern, _, opts = body.partition("$")
        if exception and set(opts.split(",")) & {"document"}:
            # The whole site is allowed: nothing on it is blocked
            m = DOMAIN_RULE.match(pattern)
            if m:
                exceptions.append({"trigger": {"url-filter": ".*", "if-domain": ["*" + m.group(1)]}, "action": {"type": "ignore-previous-rules"}})
            continue
        m = DOMAIN_RULE.match(pattern)
        if not m:
            continue  # shortcut: only rules anchored to a domain (most of both lists); plain-text patterns are skipped
        f = url_filter(m.group(1), m.group(2))
        trigger = trigger_options(opts)
        if f is None or trigger is None:
            continue
        rule = {"trigger": {"url-filter": f, **trigger}, "action": {"type": "ignore-previous-rules" if exception else "block"}}
        (exceptions if exception else blocks).append(rule)
    for i in range(0, len(generic), 400):
        hides.append({"trigger": {"url-filter": ".*"}, "action": {"type": "css-display-none", "selector": ", ".join(generic[i:i + 400])}})
    for names, selectors in by_domains.items():
        hides.append({"trigger": {"url-filter": ".*", "if-domain": ["*" + d for d in names]},
                      "action": {"type": "css-display-none", "selector": ", ".join(selectors)}})
    # Exceptions last: WebKit's ignore-previous-rules only undoes rules before it
    rules = (blocks + hides)[:MAX_RULES - len(exceptions)] + exceptions
    return rules, len(blocks), len(hides), len(exceptions)


def lists(refresh):
    for name, urls in LISTS.items():
        out = os.path.join(RES, f"{name}.json")
        if os.path.exists(out) and not refresh:
            continue
        text = "\n".join(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Fjord iOS build"}), timeout=60)
                         .read().decode("utf-8", "replace") for u in urls)
        rules, b, h, e = convert(text)
        with open(out, "w") as f:
            json.dump(rules, f, separators=(",", ":"))
        print(f"{name}.json: {len(rules)} rules ({b} block, {h} hide, {e} exceptions)")


# The new-tab photos the app ships with, picked from the computer's list for variety (coast, desert, forest, ice,
# night sky, waterfall, flowers, one mountain): only recent Unsplash editorial picks (2025 and later; the older ones
# look like stock photos on a phone), and only dark ones so the white clock stays readable
PHONE_PHOTOS = [1, 2, 4, 7, 9, 16, 21, 32, 49, 97, 104, 105, 107, 108, 109, 110, 112, 113, 114, 118, 119, 120, 123, 124]


def photos():
    src = open(os.path.join(ROOT, "src", "fjord", "photos.js"), encoding="utf-8").read()
    data = json.loads(src[src.index("{"):src.rindex("}") + 1])
    wanted = {f"photo-{n:03}.jpg" for n in PHONE_PHOTOS}
    for old in os.listdir(RES):  # ones picked before
        if old.startswith("photo-") and old not in wanted:
            os.remove(os.path.join(RES, old))
    picked = sorted((p for p in data["dark"] + data["light"] if os.path.basename(p["file"]) in wanted), key=lambda p: p["file"])
    meta = []
    for p in picked:
        name = os.path.basename(p["file"])
        out = os.path.join(RES, name)
        if not os.path.exists(out):
            # Full resolution, cropped to the middle square: the new tab fills a tall phone screen (or an iPad) from the
            # middle of the photo, and anything smaller is stretched and looks soft
            src = os.path.join(ROOT, "src", "fjord", p["file"])
            dims = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", src], capture_output=True, text=True, check=True).stdout
            side = str(min(int(n) for n in re.findall(r"pixel(?:Width|Height): (\d+)", dims)))
            subprocess.run(["sips", "-c", side, side, "-s", "formatOptions", "74", src, "--out", out], check=True, stdout=subprocess.DEVNULL)
        meta.append({"file": name, "by": p["by"], "page": p["page"]})
    with open(os.path.join(RES, "photos.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(f"photos: {len(meta)}")


def branding():
    shutil.copy(os.path.join(ROOT, "src", "fjord", "branding", "logo.png"), os.path.join(RES, "logo.png"))
    # Geist, Fjord's font on computers (ios/Geist-Variable.ttf is src/fjord/fonts/Geist-Variable.woff2 as a TTF,
    # which iOS can load), with its licence
    shutil.copy(os.path.join(IOS, "Geist-Variable.ttf"), os.path.join(RES, "Geist-Variable.ttf"))
    shutil.copy(os.path.join(ROOT, "src", "fjord", "fonts", "Geist-LICENSE.txt"), os.path.join(RES, "Geist-LICENSE.txt"))
    icon = os.path.join(ASSETS, "AppIcon.appiconset")
    os.makedirs(icon, exist_ok=True)
    # Full-bleed, without the macOS icon's margin and corners: iOS rounds it itself (drawn by tools/make-icon.py)
    shutil.copy(os.path.join(IOS, "AppIcon.png"), os.path.join(icon, "icon-1024.png"))
    with open(os.path.join(icon, "Contents.json"), "w") as f:
        json.dump({"images": [{"filename": "icon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
                   "info": {"author": "xcode", "version": 1}}, f, indent=1)
    with open(os.path.join(ASSETS, "Contents.json"), "w") as f:
        json.dump({"info": {"author": "xcode", "version": 1}}, f, indent=1)


def trackers():
    """Fjord's list of tracker companies and their domains (src/fjord/trackers.sys.mjs), for the new tab's stats"""
    src = open(os.path.join(ROOT, "src", "fjord", "trackers.sys.mjs"), encoding="utf-8").read()
    body = src[src.index("{", src.index("TRACKERS")):src.rindex("}") + 1]
    body = re.sub(r"//[^\n]*", "", body)
    body = re.sub(r",(\s*[}\]])", r"\1", body)  # trailing commas, which JSON doesn't allow
    companies = json.loads(body)
    with open(os.path.join(RES, "tracker-companies.json"), "w") as f:
        json.dump(companies, f)
    print(f"trackers: {len(companies)} companies")


if __name__ == "__main__":
    os.makedirs(RES, exist_ok=True)
    lists("--refresh-lists" in sys.argv)
    photos()
    branding()
    trackers()
