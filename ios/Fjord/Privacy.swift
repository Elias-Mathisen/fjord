// Fjord's fake-site warning and clean redirect links, ported from src/fjord/privacy.sys.mjs so both behave the same
import Foundation

enum Privacy {
    // ---------- Lookalike sites ----------
    // Popular sites that fake copies are named after. A site matches when its name, ignoring the ending (.com, .no),
    // is the same after swapping lookalike characters (paypa1, g00gle, rnicrosoft), or one typo away for names of
    // 6+ letters (gooogle, amazom). Also catches the popular name used as the start of another site (paypal.com.evil.net).
    static let popular = ["google.com", "youtube.com", "gmail.com", "facebook.com", "instagram.com", "whatsapp.com", "messenger.com",
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
        "ups.com", "usps.com", "irs.gov", "intuit.com", "wetransfer.com", "mega.nz", "tumblr.com", "medium.com"]
    private static func label(of domain: String) -> String { String(domain.prefix { $0 != "." }) }
    private static let labels = Set(popular.map(label))
    private static let bases = Set(popular)
    private static let confusable: [Character: Character] = ["0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "i": "l", "|": "l"]
    static func normalize(_ s: String) -> String {
        let t = s.replacingOccurrences(of: "rn", with: "m").replacingOccurrences(of: "vv", with: "w")
        return String(t.map { confusable[$0] ?? $0 })
    }
    private static let normal: [String: String] = {
        var map: [String: String] = [:]
        for d in popular where map[normalize(label(of: d))] == nil { map[normalize(label(of: d))] = d }
        return map
    }()

    // shortcut: a short list of two-part endings instead of the full public suffix list (Firefox has that built in;
    // iOS doesn't). Upgrade if lookalikes on other country endings get missed.
    private static let twoPart: Set<String> = ["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz",
        "co.jp", "ne.jp", "com.br", "com.mx", "com.ar", "com.tr", "co.in", "co.za", "com.cn", "com.hk", "com.sg", "co.kr",
        "com.tw", "co.il", "com.my", "com.ph", "com.vn", "co.id", "com.pl", "com.ua"]
    static func suffix(of host: String) -> String {
        let parts = host.split(separator: ".")
        if parts.count >= 3, twoPart.contains(parts.suffix(2).joined(separator: ".")) { return parts.suffix(2).joined(separator: ".") }
        return parts.last.map(String.init) ?? ""
    }
    // example.co.uk for www.shop.example.co.uk
    static func baseDomain(_ host: String) -> String {
        let host = host.lowercased()
        let end = suffix(of: host)
        guard host.count > end.count + 1 else { return host }
        let rest = host.dropLast(end.count + 1)
        guard let name = rest.split(separator: ".").last else { return host }
        return "\(name).\(end)"
    }

    // One insertion, deletion, substitution or swap of neighbours apart
    static func oneTypo(_ a: [Character], _ b: [Character]) -> Bool {
        if a == b || abs(a.count - b.count) > 1 { return false }
        var i = 0
        while i < a.count, i < b.count, a[i] == b[i] { i += 1 }
        func tail(_ x: [Character], _ from: Int) -> ArraySlice<Character> { from < x.count ? x[from...] : [] }
        if a.count == b.count {
            if tail(a, i + 1) == tail(b, i + 1) { return true }
            return i + 1 < a.count && a[i] == b[i + 1] && a[i + 1] == b[i] && tail(a, i + 2) == tail(b, i + 2)
        }
        return a.count > b.count ? tail(a, i + 1) == tail(b, i) : tail(a, i) == tail(b, i + 1)
    }

    // The popular site this host imitates, or nil
    static func lookalike(of host: String) -> String? {
        let host = host.lowercased()
        let base = baseDomain(host)
        if bases.contains(base) { return nil }
        let end = suffix(of: host)
        guard base.count > end.count + 1 else { return nil }
        let name = String(base.dropLast(end.count + 1))
        if name.isEmpty || name.contains(".") || labels.contains(name) { return nil } // the same name on another ending: amazon.de
        for d in popular where ".\(host).".contains(".\(d).") { return d }
        if let d = normal[normalize(name)] { return d }
        if name.count >= 6 {
            for d in popular where label(of: d).count >= 6 && oneTypo(Array(name), Array(label(of: d))) { return d }
        }
        return nil
    }

    // Sites the user chose to open anyway
    static func openedAnyway(_ host: String) -> Bool {
        (UserDefaults.standard.stringArray(forKey: Setting.openedAnyway) ?? []).contains(baseDomain(host))
    }
    static func openAnyway(_ host: String) {
        var list = UserDefaults.standard.stringArray(forKey: Setting.openedAnyway) ?? []
        list.append(baseDomain(host))
        UserDefaults.standard.set(list, forKey: Setting.openedAnyway)
    }

    // ---------- Clean redirect links ----------
    // Links that go through a tracker first (google.com/url?q=…, l.facebook.com/l.php?u=…) are opened at their real
    // destination instead, so the middleman never sees the click. [host pattern, path pattern, parameter with the target]
    private static let redirects: [(String, String, [String])] = [
        (#"(^|\.)google\.[a-z.]+$"#, #"^/url$"#, ["q", "url"]),
        (#"^(l|lm)\.facebook\.com$"#, #"^/l\.php$"#, ["u"]),
        (#"^l\.instagram\.com$"#, #"^/$"#, ["u"]),
        (#"^l\.messenger\.com$"#, #"^/l\.php$"#, ["u"]),
        (#"(^|\.)youtube\.com$"#, #"^/redirect$"#, ["q"]),
        (#"^out\.reddit\.com$"#, #"^/.*"#, ["url"]),
        (#"^steamcommunity\.com$"#, #"^/linkfilter/?$"#, ["url", "u"]),
        (#"^disq\.us$"#, #"^/url$"#, ["url"]),
        (#"^slack-redir\.net$"#, #"^/link$"#, ["url"]),
        (#"(^|\.)linkedin\.com$"#, #"^/redir/redirect/?$"#, ["url"]),
        (#"^away\.vk\.com$"#, #"^/away\.php$"#, ["to"]),
        (#"^t\.umblr\.com$"#, #"^/redirect$"#, ["z"]),
        (#"(^|\.)duckduckgo\.com$"#, #"^/l/?$"#, ["uddg"]),
        (#"\.safelinks\.protection\.outlook\.com$"#, #"^/$"#, ["url"]),
        (#"^exit\.sc$"#, #"^/$"#, ["url"]),
    ]
    static func unwrapRedirect(_ url: URL) -> URL? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), let host = parts.host?.lowercased() else { return nil }
        let path = parts.path.isEmpty ? "/" : parts.path
        guard let rule = redirects.first(where: {
            host.range(of: $0.0, options: .regularExpression) != nil && path.range(of: $0.1, options: .regularExpression) != nil
        }) else { return nil }
        for name in rule.2 {
            if let value = parts.queryItems?.first(where: { $0.name == name })?.value,
               value.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil,
               let target = URL(string: value) { return target }
        }
        return nil
    }

    // ---------- Private YouTube player ----------
    // A YouTube video opens in YouTube's privacy-enhanced player on its own (youtube-nocookie.com): no recommendations,
    // comments or personalised ads, and nothing in your YouTube history. The same as youtube.sys.mjs on the desktop.
    static func youtubeVideo(_ url: URL) -> (id: String, start: Int)? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), let raw = parts.host?.lowercased() else { return nil }
        let host = raw.replacingOccurrences(of: #"^(www|m)\."#, with: "", options: .regularExpression)
        let query = { (name: String) in parts.queryItems?.first(where: { $0.name == name })?.value }
        var id: String?
        if host == "youtube.com" {
            if parts.path == "/watch" { id = query("v") }
            else if let m = parts.path.range(of: #"^/(shorts|live|embed)/[\w-]{11}"#, options: .regularExpression) {
                id = String(parts.path[m].suffix(11))
            }
        } else if host == "youtu.be" {
            id = String(parts.path.dropFirst().prefix(11))
        }
        guard let id, id.range(of: #"^[\w-]{11}$"#, options: .regularExpression) != nil else { return nil }
        // t=90, t=90s or t=1m30s
        var start = 0
        if let t = query("t") ?? query("start"),
           let m = try? Regex(#"^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$"#).wholeMatch(in: t) {
            let n = { (i: Int) in m.output[i].substring.flatMap { Int($0) } ?? 0 }
            start = n(1) * 3600 + n(2) * 60 + n(3)
        }
        return (id, start)
    }
    // YouTube's player refuses to play without a referrer ("Error 153"); its documentation asks apps to name themselves
    static func youtubePlayer(_ video: (id: String, start: Int)) -> URLRequest {
        var request = URLRequest(url: URL(string: "https://www.youtube-nocookie.com/embed/\(video.id)?autoplay=1&rel=0&playsinline=1"
            + (video.start > 0 ? "&start=\(video.start)" : ""))!)
        request.setValue("https://io.github.eliasmathisen.fjord/", forHTTPHeaderField: "Referer")
        return request
    }
    static func isYouTube(_ host: String) -> Bool {
        host.range(of: #"(^|\.)(youtube\.com|youtu\.be)$"#, options: .regularExpression) != nil
    }

    static func isLocal(_ host: String) -> Bool {
        host == "localhost" || host.hasSuffix(".local") || host.range(of: #"^\d+\.\d+\.\d+\.\d+$"#, options: .regularExpression) != nil
    }

    #if DEBUG
    // The same cases as tools/test-lookalike.js and tools/test-redirects.js on the desktop
    static func selfCheck() {
        assert(lookalike(of: "paypa1.com") == "paypal.com")
        assert(lookalike(of: "g00gle.com") == "google.com")
        assert(lookalike(of: "rnicrosoft.com") == "microsoft.com")
        assert(lookalike(of: "amazom.com") == "amazon.com")
        assert(lookalike(of: "paypal.com.evil.net") == "paypal.com")
        assert(lookalike(of: "paypal.com") == nil)
        assert(lookalike(of: "www.amazon.de") == nil)
        assert(lookalike(of: "google.com.au") == nil)
        assert(lookalike(of: "news.bbc.co.uk") == nil)
        assert(unwrapRedirect(URL(string: "https://www.google.com/url?q=https://en.wikipedia.org/wiki/Fjord&sa=D")!)?.host == "en.wikipedia.org")
        assert(unwrapRedirect(URL(string: "https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2F")!)?.absoluteString == "https://example.com/")
        assert(unwrapRedirect(URL(string: "https://www.google.com/search?q=fjord")!) == nil)
        assert(youtubeVideo(URL(string: "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1m5s")!).map { $0.id == "jNQXAC9IVRw" && $0.start == 65 } == true)
        assert(youtubeVideo(URL(string: "https://youtu.be/jNQXAC9IVRw")!)?.id == "jNQXAC9IVRw")
        assert(youtubeVideo(URL(string: "https://m.youtube.com/shorts/jNQXAC9IVRw")!)?.id == "jNQXAC9IVRw")
        assert(youtubeVideo(URL(string: "https://www.youtube.com/feed/trending")!) == nil)
    }
    #endif
}
