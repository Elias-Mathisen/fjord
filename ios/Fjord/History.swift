// The sites you've been to, for the address bar's suggestions and its completion as you type (youtube.com from
// "you"). Kept in a file on this device only while Keep history is on and Forget everything is off; turning Keep
// history off or Clear history empties it, and Forget this site removes that site. Until you've been somewhere,
// a short list of well-known sites fills in.
import Foundation

@MainActor
final class History {
    static let shared = History()
    struct Visit: Codable {
        var url: URL
        var title: String
        var visits: Int
        var last: Date
    }
    enum Kind { case visited, bookmark, wellKnown }
    struct Suggestion: Identifiable {
        let url: URL
        let title: String
        let address: String // without https:// and www., as it's typed
        let kind: Kind
        var id: String { url.absoluteString }
    }

    private static let file = URL.applicationSupportDirectory.appending(path: "history.json")
    private static let limit = 2000
    private var visits: [String: Visit] // by address
    private var dirty = false

    private init() {
        let saved = (try? Data(contentsOf: Self.file)).flatMap { try? JSONDecoder().decode([Visit].self, from: $0) } ?? []
        visits = Dictionary(saved.map { (Self.address($0.url), $0) }, uniquingKeysWith: { a, b in a.last > b.last ? a : b })
    }

    static var keeping: Bool {
        UserDefaults.standard.bool(forKey: Setting.history) && !UserDefaults.standard.bool(forKey: Setting.ghost)
    }

    static func address(_ url: URL) -> String { address(url.absoluteString) }
    static func address(_ typed: String) -> String {
        var s = typed
        for prefix in ["https://", "http://"] where s.hasPrefix(prefix) { s.removeFirst(prefix.count) }
        if s.hasPrefix("www.") { s.removeFirst(4) }
        if s.hasSuffix("/") { s.removeLast() }
        return s
    }

    func add(_ url: URL, title: String) {
        guard Self.keeping, url.scheme == "https" || url.scheme == "http", url.host != nil else { return }
        let key = Self.address(url)
        var visit = visits[key] ?? Visit(url: url, title: "", visits: 0, last: .now)
        visit.url = url
        if !title.isEmpty { visit.title = title }
        visit.visits += 1
        visit.last = .now
        visits[key] = visit
        if visits.count > Self.limit + 100 { // the least used, longest ago go first
            let keep = visits.sorted { Self.score($0.value) > Self.score($1.value) }.prefix(Self.limit)
            visits = Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
        }
        scheduleSave()
    }

    /// Clear history empties it, Forget this site removes that site and its subdomains
    func forget(site: String? = nil) {
        if let site {
            visits = visits.filter { guard let host = $0.value.url.host else { return true }
                return host != site && !host.hasSuffix("." + site) }
        } else {
            visits = [:]
        }
        scheduleSave()
    }

    /// This iPhone's visits since `date`, most recent first, for Sync
    func visits(since date: Date) -> [Visit] {
        Array(visits.values.filter { $0.last > date }.sorted { $0.last > $1.last }.prefix(5000))
    }

    /// Visits from the computer (Sync): new sites are added, known ones take the later visit and a missing title
    func merge(_ list: [(url: URL, title: String, time: Date)]) {
        guard Self.keeping, !list.isEmpty else { return }
        for v in list where v.url.scheme == "https" || v.url.scheme == "http" {
            let key = Self.address(v.url)
            var visit = visits[key] ?? Visit(url: v.url, title: v.title, visits: 0, last: .distantPast)
            if v.time > visit.last {
                visit.last = min(v.time, .now)
                visit.visits += 1
            }
            if visit.title.isEmpty { visit.title = v.title }
            visits[key] = visit
        }
        if visits.count > Self.limit + 100 {
            let keep = visits.sorted { Self.score($0.value) > Self.score($1.value) }.prefix(Self.limit)
            visits = Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
        }
        scheduleSave()
    }

    // Visited often and lately counts most: a visit loses half its weight in a fortnight
    private static func score(_ v: Visit) -> Double {
        Double(v.visits) * pow(0.5, -v.last.timeIntervalSinceNow / (14 * 86400))
    }

    // What's typed can start at any part of a site's name, since iPhones get sent to m.youtube.com and
    // en.m.wikipedia.org: "you" matches "m.youtube.com/watch" from "youtube.com/watch" (but not from just "com")
    private static func match(_ address: String, _ text: String) -> Substring? {
        let host = address.prefix { $0 != "/" }
        var start = address.startIndex
        while true {
            let rest = address[start...]
            if rest.lowercased().hasPrefix(text) { return rest }
            guard let dot = host[start...].firstIndex(of: "."), host[host.index(after: dot)...].contains(".") else { return nil }
            start = address.index(after: dot)
        }
    }

    #if DEBUG
    static func selfCheck() {
        assert(match("m.youtube.com/watch?v=1", "you") == "youtube.com/watch?v=1")
        assert(match("en.m.wikipedia.org/wiki/Fjord", "wiki") == "wikipedia.org/wiki/Fjord")
        assert(match("example.com", "exa") == "example.com")
        assert(match("example.com", "com") == nil)
        assert(address("https://www.youtube.com/") == "youtube.com")
    }
    #endif

    /// Up to `limit` sites for what's typed: addresses that start with it first, then titles with a word that does
    func suggestions(for typed: String, limit: Int = 5) -> [Suggestion] {
        let text = Self.address(typed.lowercased().trimmingCharacters(in: .whitespaces))
        guard !text.isEmpty else { return [] }
        let words = text.split(separator: " ").map(String.init)
        var byAddress: [(Suggestion, Double)] = [], byTitle: [(Suggestion, Double)] = []
        for (address, v) in visits {
            let s = Suggestion(url: v.url, title: v.title, address: address, kind: .visited)
            if Self.match(address, text) != nil {
                byAddress.append((s, Self.score(v) + (address.contains("/") ? 0 : 1000))) // a site before its pages
            } else {
                let title = v.title.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber })
                if words.allSatisfy({ w in title.contains { $0.hasPrefix(w) } }) { byTitle.append((s, Self.score(v))) }
            }
        }
        var list = byAddress.sorted { $0.1 > $1.1 }.map(\.0) + byTitle.sorted { $0.1 > $1.1 }.map(\.0)
        // Bookmarks from the computer (Sync), for sites this iPhone hasn't been to
        for b in Sync.shared.bookmarks where list.count < limit * 2 {
            let address = Self.address(b.url)
            guard !list.contains(where: { $0.address == address }) else { continue }
            let title = b.title.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            if Self.match(address, text) != nil || words.allSatisfy({ w in title.contains { $0.hasPrefix(w) } }) {
                list.append(Suggestion(url: b.url, title: b.title, address: address, kind: .bookmark))
            }
        }
        for site in Self.wellKnown where site.address.hasPrefix(text) && !list.contains(where: { $0.address == site.address }) {
            list.append(site)
        }
        return Array(list.prefix(limit))
    }

    /// What the address bar fills in for what's typed: the rest of a site's name (not a page or a search)
    func completion(for typed: String) -> String? {
        guard !typed.contains(" "), !typed.contains("/") else { return nil }
        let text = Self.address(typed.lowercased())
        guard !text.isEmpty, let site = suggestions(for: typed, limit: 8).lazy
            .compactMap({ Self.match($0.address, text).map { String($0.prefix { $0 != "/" }) } })
            .first(where: { $0.count > text.count }) else { return nil }
        return typed + site.dropFirst(text.count)
    }

    private static let wellKnown: [Suggestion] = [
        ("google.com", "Google"), ("youtube.com", "YouTube"), ("wikipedia.org", "Wikipedia"), ("reddit.com", "Reddit"),
        ("instagram.com", "Instagram"), ("facebook.com", "Facebook"), ("x.com", "X"), ("amazon.com", "Amazon"),
        ("netflix.com", "Netflix"), ("github.com", "GitHub"), ("linkedin.com", "LinkedIn"), ("twitch.tv", "Twitch"),
        ("spotify.com", "Spotify"), ("tiktok.com", "TikTok"), ("duckduckgo.com", "DuckDuckGo"), ("bbc.com", "BBC"),
        ("nytimes.com", "The New York Times"), ("theguardian.com", "The Guardian"), ("ebay.com", "eBay"),
        ("apple.com", "Apple"), ("microsoft.com", "Microsoft"), ("outlook.com", "Outlook"), ("gmail.com", "Gmail"),
        ("chatgpt.com", "ChatGPT"), ("claude.ai", "Claude"), ("pinterest.com", "Pinterest"), ("imdb.com", "IMDb"),
        ("weather.com", "The Weather Channel"), ("discord.com", "Discord"), ("paypal.com", "PayPal"),
    ].map { Suggestion(url: URL(string: "https://" + $0.0)!, title: $0.1, address: $0.0, kind: .wellKnown) }

    private func scheduleSave() {
        guard !dirty else { return }
        dirty = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            dirty = false
            let list = Array(visits.values)
            try? FileManager.default.createDirectory(at: Self.file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? JSONEncoder().encode(list).write(to: Self.file, options: .atomic)
        }
    }
}
