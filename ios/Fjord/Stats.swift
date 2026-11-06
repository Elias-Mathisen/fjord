// The new tab's tracker stats: addresses pages tried to load (PageScripts.watcher) that are on Fjord's tracker list
// (tracker-companies.json, made by tools/prepare.py from the desktop's src/fjord/trackers.sys.mjs), counted when the block
// lists stopped them. Kept on this device only, a day at a time for the new tab's week and the privacy report (five
// weeks). Which sites the companies were on is a kind of history, so it isn't kept with Forget everything on, and is
// cleared with history. Time and data saved use the desktop's estimates: about 50 ms and 40 KB for every tracker that
// didn't load.
import Foundation

@MainActor
final class TrackerStats: ObservableObject {
    static let shared = TrackerStats()
    private static let key = "trackerStats"

    private struct Saved: Codable {
        var since: Date?
        var total = 0
        var days: [String: Int] = [:]                 // yyyy-MM-dd -> trackers stopped
        var companies: [String: [String: Int]] = [:]  // yyyy-MM-dd -> company -> trackers stopped
        var sites: [String: [String: [String: Int]]]? // yyyy-MM-dd -> site -> company -> trackers stopped (since 2.0)
    }
    static let weeks = 5
    @Published private var saved: Saved
    private var dirty = false

    // domain -> company, for the domain and all its subdomains
    private let companyOf: [String: String] = {
        guard let url = Bundle.main.url(forResource: "tracker-companies", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let byCompany = try? JSONDecoder().decode([String: [String]].self, from: data) else { return [:] }
        var map: [String: String] = [:]
        for (company, domains) in byCompany { for d in domains { map[d] = company } }
        return map
    }()

    private init() {
        saved = UserDefaults.standard.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(Saved.self, from: $0) } ?? Saved()
    }

    private static let dayFormat: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static func day(_ date: Date) -> String { dayFormat.string(from: date) }

    func company(for host: String) -> String? {
        var h = Substring(host.lowercased())
        while true {
            if let c = companyOf[String(h)] { return c }
            guard let dot = h.firstIndex(of: ".") else { return nil }
            h = h[h.index(after: dot)...]
            if !h.contains(".") { return nil }
        }
    }

    // Hosts a page on `page` tried to load from, one per address
    func record(_ hosts: [String], on page: String) {
        let site = Privacy.baseDomain(page)
        let today = Self.day(.now)
        let keepSite = !UserDefaults.standard.bool(forKey: Setting.ghost)
        var added = 0
        for host in hosts where Privacy.baseDomain(host) != site {
            guard let owner = company(for: host), owner != company(for: page) else { continue } // a company's own sites
            saved.companies[today, default: [:]][owner, default: 0] += 1
            if keepSite {
                if saved.sites == nil { saved.sites = [:] }
                saved.sites?[today, default: [:]][site, default: [:]][owner, default: 0] += 1
            }
            added += 1
        }
        guard added > 0 else { return }
        if saved.since == nil { saved.since = .now }
        saved.total += added
        saved.days[today, default: 0] += added
        // The report goes back five weeks; older days only count towards the total
        let oldest = Self.day(.now.addingTimeInterval(Double(-7 * Self.weeks - 1) * 86400))
        saved.days = saved.days.filter { $0.key >= oldest }
        saved.companies = saved.companies.filter { $0.key >= oldest }
        saved.sites = saved.sites?.filter { $0.key >= oldest }
        scheduleSave()
    }

    /// Clearing history forgets every site, "Forget this site now" just that one; the counts per company stay
    func forgetSites(_ site: String? = nil) {
        if let site {
            for day in saved.sites?.keys.sorted() ?? [] { saved.sites?[day]?[site] = nil }
        } else {
            saved.sites = nil
        }
        scheduleSave()
    }
    private func scheduleSave() {
        guard !dirty else { return }
        dirty = true
        Task {
            try? await Task.sleep(for: .seconds(3))
            dirty = false
            if let data = try? JSONEncoder().encode(saved) { UserDefaults.standard.set(data, forKey: Self.key) }
        }
    }

    var total: Int { saved.total }
    var since: Date? { saved.since }
    var timeSaved: TimeInterval { Double(saved.total) * 0.05 }
    var bytesSaved: Int64 { Int64(saved.total) * 40_000 }
    /// The last seven days, oldest first
    var week: [(date: Date, count: Int)] {
        (0..<7).reversed().map { i in
            let date = Calendar.current.date(byAdding: .day, value: -i, to: .now)!
            return (date, saved.days[Self.day(date)] ?? 0)
        }
    }
    var weekTotal: Int { week.reduce(0) { $0 + $1.count } }
    struct Entry: Identifiable {
        let name: String
        let count: Int
        let with: [String] // the sites a company was on, or the companies on a site, most first
        var id: String { name }
    }
    struct Report {
        let days: [(date: Date, count: Int)]
        let companies: [Entry]
        let sites: [Entry]
        var total: Int { days.reduce(0) { $0 + $1.count } }
    }
    /// The seven days ending `weeksAgo` weeks before today
    func report(weeksAgo: Int) -> Report {
        var companies: [String: (count: Int, with: [String: Int])] = [:], sites = companies
        let days = (0..<7).reversed().map { i in
            let date = Calendar.current.date(byAdding: .day, value: -(7 * weeksAgo + i), to: .now)!
            let key = Self.day(date)
            for (c, n) in saved.companies[key] ?? [:] { companies[c, default: (0, [:])].count += n }
            for (site, byCompany) in saved.sites?[key] ?? [:] {
                for (c, n) in byCompany {
                    sites[site, default: (0, [:])].count += n
                    sites[site, default: (0, [:])].with[c, default: 0] += n
                    companies[c, default: (0, [:])].with[site, default: 0] += n
                }
            }
            return (date: date, count: saved.days[key] ?? 0)
        }
        func entries(_ map: [String: (count: Int, with: [String: Int])]) -> [Entry] {
            map.map { Entry(name: $0.key, count: $0.value.count, with: $0.value.with.sorted { $0.value > $1.value }.map(\.key)) }
                .sorted { $0.count > $1.count }
        }
        return Report(days: days, companies: entries(companies), sites: entries(sites))
    }
    /// The first day counted, for how far back the report can go
    var firstDay: Date? { saved.days.keys.min().flatMap { Self.dayFormat.date(from: $0) } }

    var topCompanies: [String] {
        var sum: [String: Int] = [:]
        for date in week.map(\.date) { for (c, n) in saved.companies[Self.day(date)] ?? [:] { sum[c, default: 0] += n } }
        return sum.sorted { $0.value > $1.value }.prefix(3).map(\.key)
    }
}
