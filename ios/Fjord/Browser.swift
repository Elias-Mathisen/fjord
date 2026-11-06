// Tabs and what happens before each page loads: tracking redirects skipped, http upgraded, fake sites stopped, and
// the ad and tracker block lists switched on or off for the site (Shields)
import SwiftUI
import WebKit
import CryptoKit
import SafariServices

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
        current?.takeSnapshot()
        current = tab
        showingTabs = false
    }
    // The tabs screen shows each tab as it looked when you left it
    func showTabs() {
        current?.takeSnapshot()
        showingTabs = true
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
    // The colour the page's own top has (its theme colour, or its background), for the strip behind the status bar
    @Published var topColor: UIColor?
    // The bottom bar shrinks to the site's name while you scroll down, like Safari's
    @Published var barCollapsed = false
    @Published var snapshot: UIImage?
    @Published var favicon: UIImage?
    // You picked YouTube itself from the private player ("Watch on YouTube"); the tab stays on YouTube until it leaves
    var onYouTube = false
    private var observations: [NSKeyValueObservation] = []
    private var lastOffset: CGFloat = 0

    var isNewTab: Bool { url == nil && warning == nil && error == nil }
    var host: String? { url?.host }

    init(browser: Browser) {
        self.browser = browser
        let config = WKWebViewConfiguration()
        // Ghost mode: this tab keeps nothing once it's gone
        config.websiteDataStore = UserDefaults.standard.bool(forKey: Setting.ghost) ? .nonPersistent() : .default()
        config.allowsInlineMediaPlayback = true
        // Videos can go to an Apple TV or AirPlay speaker (the player's own AirPlay button, or the one in the toolbar),
        // and float in picture-in-picture
        config.allowsAirPlayForMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(MessageProxy(self), name: "fjordHide")
        config.userContentController.add(MessageProxy(self), name: "fjordSeen")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        #if DEBUG
        webView.isInspectable = true
        #endif
        // KVO fires on the main thread
        observations = [
            webView.observe(\.url) { [weak self] w, _ in MainActor.assumeIsolated {
                guard let self, let now = w.url else { return }
                self.url = now
                self.videoInsideYouTube(now)
                if Cast.video(inPlayer: now) != nil { Cast.shared.playerOpened(self) }
            } },
            webView.observe(\.title) { [weak self] w, _ in MainActor.assumeIsolated { self?.title = w.title ?? "" } },
            webView.observe(\.estimatedProgress) { [weak self] w, _ in MainActor.assumeIsolated { self?.progress = w.estimatedProgress } },
            webView.observe(\.isLoading) { [weak self] w, _ in MainActor.assumeIsolated { self?.isLoading = w.isLoading } },
            webView.observe(\.canGoBack) { [weak self] w, _ in MainActor.assumeIsolated { self?.canGoBack = w.canGoBack } },
            webView.observe(\.canGoForward) { [weak self] w, _ in MainActor.assumeIsolated { self?.canGoForward = w.canGoForward } },
            webView.observe(\.themeColor) { [weak self] w, _ in MainActor.assumeIsolated { self?.topColor = w.themeColor ?? w.underPageBackgroundColor } },
            webView.observe(\.underPageBackgroundColor) { [weak self] w, _ in MainActor.assumeIsolated { self?.topColor = w.themeColor ?? w.underPageBackgroundColor } },
            webView.scrollView.observe(\.contentOffset) { [weak self] s, _ in MainActor.assumeIsolated { self?.scrolled(s) } },
        ]
        applyBlocking(for: nil)
        applyPageScripts(for: nil)
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

    // The randomised fingerprint, and the parts of this site you hid (PageScripts), for the page about to load
    func applyPageScripts(for host: String?) {
        let content = webView.configuration.userContentController
        content.removeAllUserScripts()
        if UserDefaults.standard.bool(forKey: Setting.randomise) {
            content.addUserScript(WKUserScript(source: PageScripts.randomise, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }
        content.addUserScript(WKUserScript(source: PageScripts.watcher, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        if let host, case let selectors = Hidden.selectors(for: host), !selectors.isEmpty {
            content.addUserScript(WKUserScript(source: PageScripts.hidden(selectors, unlockScroll: Hidden.unlocksScroll(host)),
                                               injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
    }

    // Down hides the bar to the site's name, up brings it back; so do the top and the very end of the page
    private func scrolled(_ scroll: UIScrollView) {
        let y = scroll.contentOffset.y + scroll.adjustedContentInset.top
        defer { lastOffset = y }
        guard scroll.isTracking || scroll.isDecelerating else { return }
        let atEnd = y + scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom >= scroll.contentSize.height - 4
        if y <= 0 || atEnd { if barCollapsed { barCollapsed = false } }
        else if y - lastOffset > 6, !barCollapsed { barCollapsed = true }
        else if y - lastOffset < -10, barCollapsed { barCollapsed = false }
    }

    func takeSnapshot() {
        guard !isNewTab, webView.window != nil else { return }
        let config = WKSnapshotConfiguration()
        config.snapshotWidth = 420 // small: the tabs screen shows them at about half the screen's width
        webView.takeSnapshot(with: config) { [weak self] image, _ in
            Task { @MainActor in if let image { self?.snapshot = image } }
        }
    }

    // The site's own icon for the tabs screen, fetched without cookies once the page has loaded
    private static var icons: [String: UIImage] = [:]
    private func loadFavicon() {
        guard let host else { return }
        if let known = Self.icons[host] { favicon = known; return }
        webView.evaluateJavaScript(#"(document.querySelector('link[rel~="apple-touch-icon"]') || document.querySelector('link[rel~="icon"]') || {}).href || location.origin + "/favicon.ico""#) { [weak self] href, _ in
            guard let href = href as? String, let url = URL(string: href), url.scheme == "https" else { return }
            Task { @MainActor in
                guard let (data, _) = try? await URLSession(configuration: .ephemeral).data(from: url), let image = UIImage(data: data) else { return }
                Self.icons[host] = image
                if self?.host == host { self?.favicon = image }
            }
        }
    }

    // Shields > Hide part of this page
    func pickToHide() { webView.evaluateJavaScript(PageScripts.picker) }
    fileprivate func received(_ message: WKScriptMessage) {
        if message.name == "fjordSeen", let hosts = (message.body as? [String: Any])?["hosts"] as? [String], let page = host {
            // Only what was really stopped: blocking on, Shields on here, and kept (not with Forget everything on)
            if UserDefaults.standard.bool(forKey: Setting.blocking), Shields.isOn(for: page), webView.configuration.websiteDataStore.isPersistent {
                TrackerStats.shared.record(hosts, on: page)
            }
            return
        }
        guard message.name == "fjordHide", let body = message.body as? [String: Any],
              let site = body["site"] as? String, let selector = body["selector"] as? String else { return }
        // With Forget everything on, nothing is kept: it's hidden for this visit only
        guard webView.configuration.websiteDataStore.isPersistent else { return }
        Hidden.add(selector, for: site, unlockScroll: body["unlockScroll"] as? Bool ?? false)
    }

    // Shields > Forget this site now: everything the site and its subdomains stored. The tab closes, taking the site
    // out of its back history too. Shields' setting for the site stays.
    func forget(_ done: @escaping @MainActor () -> Void) {
        guard let host else { return }
        let site = Shields.site(host)
        TrackerStats.shared.forgetSites(Privacy.baseDomain(host)) // and the privacy report's counts for it
        let store = webView.configuration.websiteDataStore
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        store.fetchDataRecords(ofTypes: types) { records in
            let mine = records.filter { $0.displayName == site || $0.displayName.hasSuffix("." + site) }
            store.removeData(ofTypes: types, for: mine) { Task { @MainActor in done() } }
        }
    }

    // A video opened inside YouTube's own page, which changes its address without loading a new page
    private func videoInsideYouTube(_ url: URL) {
        guard let host = url.host, Privacy.isYouTube(host) else { onYouTube = false; return }
        guard UserDefaults.standard.bool(forKey: Setting.youtube), !onYouTube, let video = Privacy.youtubeVideo(url) else { return }
        webView.load(Privacy.youtubePlayer(video))
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
        // A YouTube video opens in the private player, unless you came from it ("Watch on YouTube")
        if defaults.bool(forKey: Setting.youtube), !onYouTube, let video = Privacy.youtubeVideo(url) {
            if Self.fromPlayer(action) {
                onYouTube = true
            } else {
                decisionHandler(.cancel)
                webView.load(Privacy.youtubePlayer(video))
                return
            }
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
            applyPageScripts(for: host)
        }
        warning = nil
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        favicon = nil
        loadFavicon()
        barCollapsed = false
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
        if let url = action.request.url, let tab = browser?.newTab(url) {
            // The private player's "Watch on YouTube" opens real YouTube in a new tab
            tab.onYouTube = Self.fromPlayer(action)
        }
        return nil
    }

    // WebKit leaves sourceFrame out for loads the app starts itself, though Swift sees it as always there
    private static func fromPlayer(_ action: WKNavigationAction) -> Bool {
        let source: WKFrameInfo? = action.sourceFrame
        return source?.request.url?.host?.hasSuffix("youtube-nocookie.com") == true
    }
}

// Messages from page scripts reach the tab through this, so the page's message list doesn't keep the tab alive
private final class MessageProxy: NSObject, WKScriptMessageHandler {
    weak var tab: Tab?
    init(_ tab: Tab) { self.tab = tab }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { tab?.received(message) }
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
            SafariShields.reloadIfChanged(name, digest: digest)
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

// Fjord Shields for Safari (ios/Shields): the same lists as content blockers Safari applies itself. Safari asks a
// blocker for its list only when told to, so it's told once after an update brings new lists.
@MainActor
enum SafariShields {
    static func id(_ list: String) -> String { "\(Bundle.main.bundleIdentifier ?? "").\(list)" }

    static func reloadIfChanged(_ list: String, digest: String) {
        let key = "safariList.\(list)"
        guard UserDefaults.standard.string(forKey: key) != digest else { return }
        Task {
            // Fails while it's turned off in Safari: tried again next time
            if (try? await SFContentBlockerManager.reloadContentBlocker(withIdentifier: id(list))) != nil {
                UserDefaults.standard.set(digest, forKey: key)
            }
        }
    }

    /// List name -> whether its blocker is turned on in Safari's settings
    static func states() async -> [String: Bool] {
        var out: [String: Bool] = [:]
        for list in Blocker.lists {
            out[list] = (try? await SFContentBlockerManager.stateOfContentBlocker(withIdentifier: id(list)))?.isEnabled ?? false
        }
        return out
    }
}
