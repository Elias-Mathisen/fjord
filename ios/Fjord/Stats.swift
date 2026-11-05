// The new tab's tracker stats: addresses pages tried to load (PageScripts.watcher) that are on Fjord's tracker list
// (tracker-companies.json, made by tools/prepare.py from the desktop's src/fjord/trackers.sys.mjs), counted when the block
// lists stopped them. Kept on this device only, a day at a time for the week view. Time and data saved use the
// desktop's estimates: about 50 ms and 40 KB for every tracker that didn't load.
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
    }
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
        var added = 0
        for host in hosts where Privacy.baseDomain(host) != site {
            guard let owner = company(for: host), owner != company(for: page) else { continue } // a company's own sites
            saved.companies[today, default: [:]][owner, default: 0] += 1
            added += 1
        }
        guard added > 0 else { return }
        if saved.since == nil { saved.since = .now }
        saved.total += added
        saved.days[today, default: 0] += added
        // Only the last week is shown; older days only count towards the total
        let oldest = Self.day(.now.addingTimeInterval(-8 * 86400))
        saved.days = saved.days.filter { $0.key >= oldest }
        saved.companies = saved.companies.filter { $0.key >= oldest }
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
    var topCompanies: [String] {
        var sum: [String: Int] = [:]
        for date in week.map(\.date) { for (c, n) in saved.companies[Self.day(date)] ?? [:] { sum[c, default: 0] += n } }
        return sum.sorted { $0.value > $1.value }.prefix(3).map(\.key)
    }
}
