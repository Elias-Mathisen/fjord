// Tabs and what happens before each page loads: tracking redirects skipped, http upgraded, fake sites stopped, and
// the ad and tracker block lists switched on or off for the site (Shields)
import SwiftUI
import WebKit
import CryptoKit

@MainActor
final class Browser: ObservableObject {
    @Published var tabs: [Tab] = []
    @Published var current: Tab?
    @Published var showingTabs = false
    private(set) var blockLists: [WKContentRuleList] = []
    private var preparing: Task<Void, Never>?

    init() {
        Setting.register()
        newTab()
        preparing = Task { await prepare() }
    }

    private func prepare() async {
        blockLists = await Blocker.load()
        for tab in tabs { tab.applyBlocking(for: tab.url?.host) }
    }
    // Pages wait for the block lists, which take a moment to compile the first time Fjord runs, so a link that
    // opens Fjord doesn't load its ads first
    func whenReady(_ load: @escaping @MainActor () -> Void) {
        Task { await preparing?.value; load() }
    }

    @discardableResult func newTab(_ url: URL? = nil) -> Tab {
        let tab = Tab(browser: self)
        tabs.append(tab)
        current = tab
        if let url { whenReady { tab.load(url) } }
        return tab
    }
    func close(_ tab: Tab) {
        tabs.removeAll { $0 === tab }
        if current === tab { current = tabs.last }
        if tabs.isEmpty { newTab() }
    }
    func select(_ tab: Tab) {
        current = tab
        showingTabs = false
    }

    // Text typed in the address bar: an address, or a search with the chosen engine
    func go(_ text: String) {
        guard let tab = current else { return }
        let url = Self.url(for: text)
        whenReady { tab.load(url) }
    }
    static func url(for text: String) -> URL {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https", u.host != nil { return u }
        if !s.contains(" "), s.contains("."), let u = URL(string: "https://" + s), u.host?.contains(".") == true { return u }
        let query = s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+=?#"))) ?? s
        return URL(string: SearchEngine.current.template.replacingOccurrences(of: "%s", with: query))!
    }

    // fjord://open?url=… opens a page in a new tab (Shortcuts, and the simulator tests); so does a plain web link
    func handle(_ url: URL) {
        if url.scheme == "fjord" {
            if let target = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "url" })?.value {
                newTab(Self.url(for: target))
            }
        } else if url.scheme == "http" || url.scheme == "https" {
            newTab(url)
        }
    }
}

// A page Fjord stopped because its name imitates a popular site
struct Lookalike: Equatable {
    let url: URL
    let host: String
    let real: String
}

@MainActor
final class Tab: NSObject, ObservableObject, Identifiable {
    let id = UUID()
    let webView: WKWebView
    weak var browser: Browser?
    @Published var url: URL?
    @Published var title = ""
    @Published var progress = 0.0
    @Published var isLoading = false
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var warning: Lookalike?
    @Published var error: String?
    private var observations: [NSKeyValueObservation] = []

    var isNewTab: Bool { url == nil && warning == nil && error == nil }
    var host: String? { url?.host }

    init(browser: Browser) {
        self.browser = browser
        let config = WKWebViewConfiguration()
        // Ghost mode: this tab keeps nothing once it's gone
        config.websiteDataStore = UserDefaults.standard.bool(forKey: Setting.ghost) ? .nonPersistent() : .default()
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        #if DEBUG
        webView.isInspectable = true
        #endif
        // KVO fires on the main thread
        observations = [
            webView.observe(\.url) { [weak self] w, _ in MainActor.assumeIsolated { if w.url != nil { self?.url = w.url } } },
            webView.observe(\.title) { [weak self] w, _ in MainActor.assumeIsolated { self?.title = w.title ?? "" } },
            webView.observe(\.estimatedProgress) { [weak self] w, _ in MainActor.assumeIsolated { self?.progress = w.estimatedProgress } },
            webView.observe(\.isLoading) { [weak self] w, _ in MainActor.assumeIsolated { self?.isLoading = w.isLoading } },
            webView.observe(\.canGoBack) { [weak self] w, _ in MainActor.assumeIsolated { self?.canGoBack = w.canGoBack } },
            webView.observe(\.canGoForward) { [weak self] w, _ in MainActor.assumeIsolated { self?.canGoForward = w.canGoForward } },
        ]
        applyBlocking(for: nil)
    }

    func load(_ url: URL) {
        warning = nil
        error = nil
        webView.load(URLRequest(url: url))
    }
    func reload() { error = nil; webView.reload() }

    // The block lists apply unless they're off everywhere, or Shields is off for this site
    func applyBlocking(for host: String?) {
        let content = webView.configuration.userContentController
        content.removeAllContentRuleLists()
        guard let browser, UserDefaults.standard.bool(forKey: Setting.blocking) else { return }
        if let host, !Shields.isOn(for: host) { return }
        for list in browser.blockLists { content.add(list) }
    }

    // From the fake-site warning
    func openAnyway() {
        guard let warning else { return }
        Privacy.openAnyway(warning.host)
        load(warning.url)
    }
    func goToReal() {
        guard let warning, let real = URL(string: "https://\(warning.real)") else { return }
        load(real)
    }
    func leaveWarning() {
        warning = nil
        if !webView.canGoBack { url = nil } // nothing to go back to: the new tab
    }
}

extension Tab: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard action.targetFrame?.isMainFrame ?? true, let url = action.request.url,
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return decisionHandler(.allow) }
        let defaults = UserDefaults.standard
        // A link through a tracker goes straight to the real site
        if defaults.bool(forKey: Setting.redirects), let target = Privacy.unwrapRedirect(url) {
            decisionHandler(.cancel)
            load(target)
            return
        }
        // shortcut: http is always upgraded, with no fallback for the rare site without https; add a "Load anyway"
        // like the desktop's HTTPS-only page if that comes up
        if scheme == "http", let host = url.host, !Privacy.isLocal(host),
           var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            parts.scheme = "https"
            if let secure = parts.url {
                decisionHandler(.cancel)
                webView.load(URLRequest(url: secure))
                return
            }
        }
        if let host = url.host {
            if defaults.bool(forKey: Setting.lookalikes), !Privacy.openedAnyway(host), let real = Privacy.lookalike(of: host) {
                decisionHandler(.cancel)
                warning = Lookalike(url: url, host: host, real: real)
                return
            }
            applyBlocking(for: host)
        }
        warning = nil
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return } // frame load interrupted by our own redirect
        self.error = e.localizedDescription
    }

    // Links that open a new window open a new tab
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { browser?.newTab(url) }
        return nil
    }
}

// Ads and trackers: EasyList, EasyPrivacy and Peter Lowe's list turned into WebKit's own content-blocking rules by tools/prepare.py,
// compiled once and then cached by WebKit
@MainActor
enum Blocker {
    static let lists = ["ads", "trackers"]
    static func load() async -> [WKContentRuleList] {
        guard let store = WKContentRuleListStore.default() else { return [] }
        var out: [WKContentRuleList] = []
        for name in lists {
            guard let file = Bundle.main.url(forResource: name, withExtension: "json"),
                  let data = try? Data(contentsOf: file), let json = String(data: data, encoding: .utf8) else { continue }
            // A changed list gets a new name, so it's compiled again
            let digest = SHA256.hash(data: data).prefix(6).map { String(format: "%02x", $0) }.joined()
            let id = "\(name)-\(digest)"
            if let cached = try? await store.contentRuleList(forIdentifier: id) { out.append(cached); continue }
            do {
                if let compiled = try await store.compileContentRuleList(forIdentifier: id, encodedContentRuleList: json) { out.append(compiled) }
            } catch {
                print("Fjord: couldn't compile \(name): \(error)")
            }
        }
        return out
    }
}
