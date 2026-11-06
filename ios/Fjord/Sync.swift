// Sync with Fjord on a computer, straight over the home Wi-Fi (src/fjord/sync.sys.mjs on the computer): no account, no
// cloud, nothing through the internet. Pairing scans the QR code in the computer's settings, which holds a new random
// key; every message both ways is encrypted and signed with it (AES-GCM). A sync sends this iPhone's history since the
// last one, its open tabs and hidden page parts, and brings back the computer's history, bookmarks, open tabs and
// hidden parts. History isn't sent or taken in while it isn't kept here, and nothing at all is sent from Forget
// everything tabs. If the computer's address has changed, the iPhone looks for it on the Wi-Fi's own network.
// Messages: [4-byte length] [16-byte pairing id] [12-byte nonce] [ciphertext] [tag], the id as additional data;
// answers: [4-byte length] [12-byte nonce] [ciphertext] [tag].
import Foundation
import UIKit
import Network
import CryptoKit
import Security

@MainActor
final class Sync: ObservableObject {
    static let shared = Sync()

    struct Computer: Codable {
        var id: Data
        var key: Data
        var name: String
        var port: UInt16
        var addresses: [String] // the last one that answered first
        var lastSync: Date?
        var cursor = 0.0        // the computer's clock (ms) at the last sync: its history since then comes next
        var sentUntil: Date?    // this iPhone's history up to here has been sent
    }
    struct Page: Codable, Identifiable, Equatable {
        let url: URL
        let title: String
        var id: String { url.absoluteString }
    }
    enum Status: Equatable { case idle, syncing, failed(String) }

    @Published private(set) var computer: Computer?
    @Published private(set) var tabs: [Page] = []      // open on the computer
    @Published private(set) var bookmarks: [Page] = []
    @Published private(set) var status = Status.idle
    weak var browser: Browser?

    private static let file = URL.applicationSupportDirectory.appending(path: "sync.json")
    private struct Saved: Codable { var tabs: [Page]; var bookmarks: [Page] }

    private init() {
        computer = Keychain.read().flatMap { try? JSONDecoder().decode(Computer.self, from: $0) }
        if computer != nil, let data = try? Data(contentsOf: Self.file), let saved = try? JSONDecoder().decode(Saved.self, from: data) {
            tabs = saved.tabs
            bookmarks = saved.bookmarks
        }
    }

    // ---------- Pairing ----------
    enum PairError: LocalizedError {
        case notFjord
        var errorDescription: String? { "That isn't a Fjord pairing code. Open Sync with iPhone in Fjord's settings on your computer." }
    }

    /// fjord-sync:1?i=<id>&k=<key>&p=<port>&a=<addresses>&n=<name>, from the computer's QR code
    func pair(_ code: String) async throws {
        guard let parts = URLComponents(string: code.trimmingCharacters(in: .whitespacesAndNewlines)), parts.scheme == "fjord-sync",
              parts.path == "1" else { throw PairError.notFjord }
        let q = Dictionary((parts.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        guard let id = q["i"].flatMap(Data.init(hex:)), id.count == 16,
              let key = q["k"].flatMap(Data.init(base64url:)), key.count == 32,
              let port = q["p"].flatMap(UInt16.init) else { throw PairError.notFjord }
        let addresses = (q["a"] ?? "").split(separator: ",").map(String.init).filter { !$0.isEmpty }
        let new = Computer(id: id, key: key, name: q["n"].flatMap { $0.isEmpty ? nil : $0 } ?? "Your computer", port: port, addresses: addresses)
        try await run(new) // the computer only keeps the pairing once this first sync reaches it
    }

    func unpair() {
        computer = nil
        tabs = []
        bookmarks = []
        status = .idle
        Keychain.delete()
        try? FileManager.default.removeItem(at: Self.file)
    }

    // ---------- Syncing ----------
    /// When Fjord comes to the front, and every few minutes while it's open
    func syncIfDue() {
        guard let c = computer, status != .syncing, (c.lastSync ?? .distantPast).timeIntervalSinceNow < -120 else { return }
        Task { try? await run(c) }
    }
    func syncNow() {
        guard let c = computer, status != .syncing else { return }
        Task { try? await run(c) }
    }

    private struct Visit: Codable { let url: String; let title: String?; let time: Double }
    private struct Link: Codable { let url: String; let title: String? }
    private struct Request: Codable {
        let v: Int, t: Double, name: String, since: Double
        let history: [Visit], tabs: [Link], hidden: [String: [String]]
    }
    private struct Reply: Codable {
        let v: Int, name: String, now: Double
        let history: [Visit], bookmarks: [Link], tabs: [Link], hidden: [String: [String]]
    }

    private func run(_ start: Computer) async throws {
        status = .syncing
        var c = start
        do {
            let keep = History.keeping
            let forgetting = UserDefaults.standard.bool(forKey: Setting.ghost)
            let until = Date.now
            let mine = keep ? History.shared.visits(since: c.sentUntil ?? .distantPast) : []
            let open = forgetting ? [] : (browser?.tabs ?? []).compactMap { t -> Link? in
                guard let u = t.url, u.scheme == "https" || u.scheme == "http" else { return nil }
                return Link(url: u.absoluteString, title: t.title)
            }
            let request = Request(v: 1, t: Date.now.timeIntervalSince1970 * 1000, name: UIDevice.current.name, since: c.cursor,
                                  history: mine.map { Visit(url: $0.url.absoluteString, title: $0.title, time: $0.last.timeIntervalSince1970 * 1000) },
                                  tabs: open, hidden: Hidden.everything)
            let (data, host) = try await Wire.send(try JSONEncoder().encode(request), to: c)
            let reply = try JSONDecoder().decode(Reply.self, from: data)

            if keep {
                History.shared.merge(reply.history.compactMap { v in
                    URL(string: v.url).map { (url: $0, title: v.title ?? "", time: Date(timeIntervalSince1970: v.time / 1000)) }
                })
            }
            for (site, selectors) in reply.hidden {
                for s in selectors.prefix(50) { Hidden.add(s, for: site, unlockScroll: false) }
            }
            let pages = { (links: [Link]) in links.compactMap { l in URL(string: l.url).map { Page(url: $0, title: l.title ?? "") } } }
            tabs = pages(reply.tabs)
            bookmarks = pages(reply.bookmarks)
            c.name = reply.name
            c.lastSync = .now
            c.cursor = reply.now
            if keep { c.sentUntil = until }
            c.addresses = [host] + c.addresses.filter { $0 != host }
            computer = c
            Keychain.write(try JSONEncoder().encode(c))
            try? FileManager.default.createDirectory(at: Self.file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? JSONEncoder().encode(Saved(tabs: tabs, bookmarks: bookmarks)).write(to: Self.file, options: .atomic)
            status = .idle
            #if DEBUG
            print("FJORD-SYNC synced: sent \(request.history.count) visits and \(request.tabs.count) tabs, got \(reply.history.count) visits, \(reply.bookmarks.count) bookmarks, \(reply.tabs.count) tabs")
            #endif
        } catch {
            #if DEBUG
            print("FJORD-SYNC sync failed: \(error)")
            #endif
            status = .failed(error.localizedDescription)
            throw error
        }
    }

    #if DEBUG
    static func selfCheck() {
        assert(Data(hex: "00ff10") == Data([0, 255, 16]))
        assert(Data(base64url: "-_8") == Data([251, 255]))
    }
    #endif
}

// ---------- On the network ----------
enum Wire {
    enum Failure: LocalizedError {
        case notFound, closed, timeout, notFjord
        var errorDescription: String? {
            switch self {
            case .notFound: "Couldn't find your computer. Make sure Fjord is open on it and both are on the same Wi-Fi."
            case .closed, .timeout: "The connection to your computer was lost."
            case .notFjord: "Your computer didn't recognise this iPhone. Pair them again."
            }
        }
    }

    /// The addresses that worked before first, then a look around this Wi-Fi network for Fjord's port
    @MainActor
    static func send(_ plain: Data, to c: Sync.Computer) async throws -> (Data, String) {
        let sealed = try AES.GCM.seal(plain, using: SymmetricKey(data: c.key), authenticating: c.id)
        let frame = c.id + sealed.nonce.withUnsafeBytes { Data($0) } + sealed.ciphertext + sealed.tag
        var last: Error = Failure.notFound
        for host in c.addresses {
            do { return (try await exchange(frame, host: host, c: c), host) } catch { last = error }
        }
        for host in await scan(port: c.port) where !c.addresses.contains(host) {
            do { return (try await exchange(frame, host: host, c: c), host) } catch { last = error }
        }
        throw last is Failure ? last : Failure.notFound
    }

    private static func exchange(_ frame: Data, host: String, c: Sync.Computer) async throws -> Data {
        let link = try await Link.open(host: host, port: c.port, timeout: 3)
        defer { link.close() }
        var size = UInt32(frame.count).bigEndian
        try await link.send(Data(bytes: &size, count: 4) + frame)
        let head = try await link.receive(4, timeout: 30)
        let n = head.reduce(0) { $0 << 8 | Int($1) }
        guard n > 28, n < 64 << 20 else { throw Failure.notFjord }
        let body = try await link.receive(n, timeout: 60)
        do {
            return try AES.GCM.open(try AES.GCM.SealedBox(combined: body), using: SymmetricKey(data: c.key), authenticating: c.id)
        } catch {
            throw Failure.notFjord
        }
    }

    // Every address on this Wi-Fi's network (up to 254 of them), tried at once; the ones with something on Fjord's port
    private static func scan(port: UInt16) async -> [String] {
        guard let (ip, mask) = wifiAddress() else { return [] }
        let size = min(~mask, 255) // the /24 around this iPhone on bigger networks
        let base = ip & ~size
        return await withTaskGroup(of: String?.self) { group in
            for i in 1..<size {
                let host = [24, 16, 8, 0].map { String((base | i) >> $0 & 255) }.joined(separator: ".")
                group.addTask {
                    guard let link = try? await Link.open(host: host, port: port, timeout: 1.5) else { return nil }
                    link.close()
                    return host
                }
            }
            var found: [String] = []
            for await host in group { if let host { found.append(host) } }
            return found
        }
    }

    private static func wifiAddress() -> (UInt32, UInt32)? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0 else { return nil }
        defer { freeifaddrs(list) }
        var p = list
        while let a = p?.pointee {
            defer { p = a.ifa_next }
            guard String(cString: a.ifa_name) == "en0", let addr = a.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
                  let mask = a.ifa_netmask else { continue }
            let ip = addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
            let m = mask.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
            return (ip, m)
        }
        return nil
    }
}

// One TCP connection on the local network, with timeouts
private final class Link: @unchecked Sendable {
    private let conn: NWConnection
    private static let queue = DispatchQueue(label: "fjord.sync")
    private init(_ conn: NWConnection) { self.conn = conn }

    static func open(host: String, port: UInt16, timeout: Double) async throws -> Link {
        let params = NWParameters.tcp
        params.prohibitedInterfaceTypes = [.cellular] // the home network, never mobile data
        let link = Link(NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: params))
        try await link.within(timeout) { done in
            link.conn.stateUpdateHandler = { state in
                switch state {
                case .ready: done(.success(()))
                case .failed(let e), .waiting(let e): done(.failure(e))
                case .cancelled: done(.failure(Wire.Failure.closed))
                default: break
                }
            }
            link.conn.start(queue: queue)
        }
        return link
    }
    func send(_ data: Data) async throws {
        try await within(30) { done in
            conn.send(content: data, completion: .contentProcessed { e in done(e.map { .failure($0) } ?? .success(())) })
        }
    }
    func receive(_ n: Int, timeout: Double) async throws -> Data {
        var out = Data()
        while out.count < n {
            out += try await within(timeout) { (done: @escaping (Result<Data, Error>) -> Void) in
                conn.receive(minimumIncompleteLength: 1, maximumLength: n - out.count) { data, _, complete, e in
                    if let data, !data.isEmpty { done(.success(data)) } else { done(.failure(e ?? Wire.Failure.closed)) }
                    _ = complete
                }
            }
        }
        return out
    }
    func close() { conn.cancel() }

    // Runs `start`, which calls back once; gives up after `seconds`
    private func within<T>(_ seconds: Double, _ start: (@escaping (Result<T, Error>) -> Void) -> Void) async throws -> T {
        try await withCheckedThrowingContinuation { (k: CheckedContinuation<T, Error>) in
            let once = Once(k)
            start { once.resume($0) }
            Self.queue.asyncAfter(deadline: .now() + seconds) { [conn] in
                if once.resume(.failure(Wire.Failure.timeout)) { conn.cancel() }
            }
        }
    }
    private final class Once<T>: @unchecked Sendable {
        private var k: CheckedContinuation<T, Error>?
        private let lock = NSLock()
        init(_ k: CheckedContinuation<T, Error>) { self.k = k }
        @discardableResult func resume(_ r: Result<T, Error>) -> Bool {
            lock.lock()
            let k = self.k
            self.k = nil
            lock.unlock()
            k?.resume(with: r)
            return k != nil
        }
    }
}

// The pairing, key included, in the Keychain, on this device only. Unsigned simulator builds can't use the
// Keychain, so there it's a file instead.
private enum Keychain {
    #if targetEnvironment(simulator)
    private static let file = URL.applicationSupportDirectory.appending(path: "sync-pairing.json")
    static func read() -> Data? { try? Data(contentsOf: file) }
    static func write(_ data: Data) {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }
    static func delete() { try? FileManager.default.removeItem(at: file) }
    #else
    private static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                               kSecAttrService as String: "io.github.eliasmathisen.fjord.sync"]
    static func read() -> Data? {
        var out: AnyObject?
        let q = query.merging([kSecReturnData as String: true]) { $1 }
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }
    static func write(_ data: Data) {
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemUpdate(query as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            SecItemAdd(query.merging(attrs) { $1 } as CFDictionary, nil)
        }
    }
    static func delete() { SecItemDelete(query as CFDictionary) }
    #endif
}

extension Data {
    init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var out = Data()
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 2)
            guard let b = UInt8(hex[i..<j], radix: 16) else { return nil }
            out.append(b)
            i = j
        }
        self = out
    }
    init?(base64url s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b += String(repeating: "=", count: (4 - b.count % 4) % 4)
        self.init(base64Encoded: b)
    }
}
