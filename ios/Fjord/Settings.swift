// Fjord's settings (UserDefaults keys), search engines and Shields' per-site switch
import Foundation

enum Setting {
    static let blocking = "blockAdsAndTrackers"
    static let redirects = "cleanRedirectLinks"
    static let lookalikes = "fakeSiteWarnings"
    static let ghost = "ghostMode"          // new tabs keep nothing: no cookies, history or site data
    static let engine = "searchEngine"
    static let appLock = "appLock"
    static let shieldsOff = "shieldsOffSites"
    static let openedAnyway = "lookalikesOpenedAnyway"
    static let randomise = "randomiseFingerprint"
    static let youtube = "privateYouTubePlayer"
    static let hidden = "hiddenParts"           // [site: [selector]]
    static let unlockScroll = "hiddenUnlocksScroll" // sites where a hidden part covered the page
    static let history = "keepHistory"          // the sites you've been to, for the address bar's suggestions
    static let setupDone = "setupDone"          // the first-time setup was finished or skipped

    static func register() {
        UserDefaults.standard.register(defaults: [blocking: true, redirects: true, lookalikes: true, ghost: false,
                                                  engine: "DuckDuckGo", appLock: false, randomise: true, youtube: false,
                                                  history: true])
    }
}

// Parts of sites you hid (Shields > Hide part of this page), by base domain like Shields
enum Hidden {
    private static var all: [String: [String]] { UserDefaults.standard.dictionary(forKey: Setting.hidden) as? [String: [String]] ?? [:] }
    private static var unlocking: [String] { UserDefaults.standard.stringArray(forKey: Setting.unlockScroll) ?? [] }
    static func selectors(for host: String) -> [String] { all[Shields.site(host)] ?? [] }
    static func unlocksScroll(_ host: String) -> Bool { unlocking.contains(Shields.site(host)) }
    static func add(_ selector: String, for host: String, unlockScroll: Bool) {
        let site = Shields.site(host)
        var list = all
        list[site] = (list[site] ?? []).filter { $0 != selector } + [selector]
        UserDefaults.standard.set(list, forKey: Setting.hidden)
        if unlockScroll, !unlocking.contains(site) { UserDefaults.standard.set(unlocking + [site], forKey: Setting.unlockScroll) }
    }
    static func remove(_ site: String) {
        var list = all
        list[site] = nil
        UserDefaults.standard.set(list, forKey: Setting.hidden)
        UserDefaults.standard.set(unlocking.filter { $0 != site }, forKey: Setting.unlockScroll)
    }
    static var sites: [(site: String, count: Int)] { all.map { ($0.key, $0.value.count) }.sorted { $0.site < $1.site } }
}

struct SearchEngine: Identifiable {
    let name: String
    let template: String
    var id: String { name }

    static let all = [
        SearchEngine(name: "DuckDuckGo", template: "https://duckduckgo.com/?q=%s"),
        SearchEngine(name: "Startpage", template: "https://www.startpage.com/do/search?q=%s"),
        SearchEngine(name: "Brave Search", template: "https://search.brave.com/search?q=%s"),
        SearchEngine(name: "Google", template: "https://www.google.com/search?q=%s"),
        SearchEngine(name: "Bing", template: "https://www.bing.com/search?q=%s"),
    ]
    static var current: SearchEngine {
        all.first { $0.name == UserDefaults.standard.string(forKey: Setting.engine) } ?? all[0]
    }
}

// Shields can be turned off for one site (by its base domain, so www. and m. count as the same site)
enum Shields {
    private static var off: [String] { UserDefaults.standard.stringArray(forKey: Setting.shieldsOff) ?? [] }
    static func site(_ host: String) -> String { Privacy.baseDomain(host) }
    static func isOn(for host: String) -> Bool { !off.contains(site(host)) }
    static func set(_ on: Bool, for host: String) {
        var list = off.filter { $0 != site(host) }
        if !on { list.append(site(host)) }
        UserDefaults.standard.set(list, forKey: Setting.shieldsOff)
    }
    static var sitesOff: [String] { off.sorted() }
    static func remove(_ site: String) { UserDefaults.standard.set(off.filter { $0 != site }, forKey: Setting.shieldsOff) }
}
