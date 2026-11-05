// Compiles the block lists with the Mac's own WebKit before they go into the app, so a rule WebKit rejects fails the
// build here instead of silently turning blocking off on the phone. Usage: swift tools/check-lists.swift a.json b.json
import Foundation
import WebKit

@MainActor
func check(_ path: String) async -> Bool {
    guard let json = try? String(contentsOfFile: path, encoding: .utf8), let store = WKContentRuleListStore.default() else {
        print("\(path): can't read"); return false
    }
    let id = "fjord-check-\(UUID().uuidString)"
    do {
        let start = Date()
        _ = try await store.compileContentRuleList(forIdentifier: id, encodedContentRuleList: json)
        try? await store.removeContentRuleList(forIdentifier: id)
        print("\((path as NSString).lastPathComponent): compiles (\(String(format: "%.1f", Date().timeIntervalSince(start))) s)")
        return true
    } catch {
        print("\((path as NSString).lastPathComponent): WebKit rejects it: \(error)")
        return false
    }
}

let paths = Array(CommandLine.arguments.dropFirst())
Task { @MainActor in
    var ok = true
    for p in paths { ok = await check(p) && ok }
    exit(ok ? 0 : 1)
}
RunLoop.main.run()
