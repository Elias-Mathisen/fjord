// Fjord's screens: the page with the address bar at the bottom, the new tab, tabs, Shields, the fake-site warning,
// settings and the lock screen. Neutral greys like Fjord on the desktop; the system font, as iOS apps do.
import SwiftUI
import WebKit
import LocalAuthentication

struct BrowserView: View {
    @EnvironmentObject var browser: Browser
    @State private var sheet: Sheet?
    enum Sheet: String, Identifiable { case shields, settings; var id: String { rawValue } }

    var body: some View {
        Group {
            if let tab = browser.current { PageView(tab: tab, sheet: $sheet).id(tab.id) }
        }
        .sheet(isPresented: $browser.showingTabs) { TabsView() }
        .sheet(item: $sheet) { which in
            switch which {
            case .shields: if let tab = browser.current { ShieldsSheet(tab: tab).presentationDetents([.height(260)]) }
            case .settings: SettingsView()
            }
        }
        #if DEBUG
        .task { // Simulator tests: -FjordOpen <address> opens a page, -FjordShow settings|shields|tabs a sheet
            let args = ProcessInfo.processInfo.arguments
            if let i = args.firstIndex(of: "-FjordOpen"), i + 1 < args.count { browser.go(args[i + 1]) }
            if let i = args.firstIndex(of: "-FjordShow"), i + 1 < args.count {
                try? await Task.sleep(for: .seconds(4))
                switch ProcessInfo.processInfo.arguments[i + 1] {
                case "tabs": browser.showingTabs = true
                case let s: sheet = Sheet(rawValue: s)
                }
            }
        }
        #endif
    }
}

struct PageView: View {
    @EnvironmentObject var browser: Browser
    @ObservedObject var tab: Tab
    @Binding var sheet: BrowserView.Sheet?

    var body: some View {
        ZStack {
            if tab.isNewTab { NewTabView() }
            VStack(spacing: 0) {
                ZStack {
                    WebView(webView: tab.webView)
                        .opacity(tab.isNewTab ? 0 : 1)
                        .allowsHitTesting(!tab.isNewTab)
                    if let warning = tab.warning { LookalikeView(tab: tab, warning: warning) }
                    else if let error = tab.error { ErrorView(tab: tab, message: error) }
                }
                BottomBar(tab: tab, sheet: $sheet)
            }
        }
        .background(Color(.systemBackground))
    }
}

struct WebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

// ---------- Address bar and toolbar ----------
struct BottomBar: View {
    @EnvironmentObject var browser: Browser
    @ObservedObject var tab: Tab
    @Binding var sheet: BrowserView.Sheet?
    @State private var text = ""
    @FocusState private var editing: Bool
    @AppStorage(Setting.blocking) private var blocking = true

    private var shieldsOn: Bool { blocking && (tab.host.map(Shields.isOn) ?? true) }
    private var shownAddress: String {
        guard let host = tab.host else { return "" }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Button { sheet = .shields } label: {
                    Image(systemName: shieldsOn ? "shield.lefthalf.filled" : "shield.slash")
                        .frame(width: 28, height: 28)
                }
                .disabled(tab.host == nil)
                .accessibilityLabel(shieldsOn ? "Shields on" : "Shields off")
                TextField("Search or enter address", text: $text)
                    .focused($editing)
                    .keyboardType(.webSearch)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .multilineTextAlignment(editing ? .leading : .center)
                    .onSubmit {
                        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                        browser.go(text)
                        editing = false
                    }
                if tab.isLoading {
                    Button { tab.webView.stopLoading() } label: { Image(systemName: "xmark").frame(width: 28, height: 28) }
                        .accessibilityLabel("Stop")
                } else if tab.url != nil {
                    Button { tab.reload() } label: { Image(systemName: "arrow.clockwise").frame(width: 28, height: 28) }
                        .accessibilityLabel("Reload")
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 48)
            .background(Capsule().fill(Color(.secondarySystemBackground)))
            .overlay(alignment: .bottom) {
                if tab.isLoading {
                    ProgressView(value: tab.progress).progressViewStyle(.linear).tint(.primary)
                        .padding(.horizontal, 22).offset(y: 2).allowsHitTesting(false)
                }
            }

            HStack {
                Button { tab.webView.goBack() } label: { Image(systemName: "chevron.backward") }
                    .disabled(!tab.canGoBack).accessibilityLabel("Back")
                Spacer()
                Button { tab.webView.goForward() } label: { Image(systemName: "chevron.forward") }
                    .disabled(!tab.canGoForward).accessibilityLabel("Forward")
                Spacer()
                if let url = tab.url {
                    ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Share")
                } else {
                    Image(systemName: "square.and.arrow.up").foregroundStyle(.tertiary)
                }
                Spacer()
                Button { browser.newTab() } label: { Image(systemName: "plus") }.accessibilityLabel("New tab")
                Spacer()
                Button { browser.showingTabs = true } label: {
                    Text("\(browser.tabs.count)").font(.system(size: 13, weight: .semibold))
                        .frame(width: 22, height: 22)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.primary, lineWidth: 1.6))
                }
                .accessibilityLabel("Tabs, \(browser.tabs.count) open")
                Spacer()
                Button { sheet = .settings } label: { Image(systemName: "gearshape") }.accessibilityLabel("Fjord settings")
            }
            .font(.system(size: 19))
            .padding(.horizontal, 10)
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 4)
        .background(.bar)
        .onAppear { text = shownAddress }
        .onChange(of: tab.url) { if !editing { text = shownAddress } }
        .onChange(of: editing) { _, now in text = now ? (tab.url?.absoluteString ?? "") : shownAddress }
    }
}

// ---------- New tab: a photo, the time, and who took the photo ----------
struct Photo: Decodable {
    let file: String
    let by: String
    let page: String

    static let all: [Photo] = {
        guard let url = Bundle.main.url(forResource: "photos", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([Photo].self, from: data)) ?? []
    }()
    var image: UIImage? {
        let name = (file as NSString).deletingPathExtension
        return Bundle.main.url(forResource: name, withExtension: "jpg").flatMap { UIImage(contentsOfFile: $0.path) }
    }
}

struct NewTabView: View {
    @State private var photo = Photo.all.randomElement()

    var body: some View {
        GeometryReader { geo in
            ZStack {
                if let image = photo?.image {
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: geo.size.width, height: geo.size.height).clipped()
                } else {
                    Color(.systemBackground)
                }
                LinearGradient(colors: [.black.opacity(0.35), .clear, .clear, .black.opacity(0.55)], startPoint: .top, endPoint: .bottom)
                VStack(spacing: 4) {
                    TimelineView(.everyMinute) { context in
                        VStack(spacing: 2) {
                            Text(context.date, format: .dateTime.hour().minute())
                                .font(.system(size: 76, weight: .thin))
                                .monospacedDigit()
                            Text(context.date, format: .dateTime.weekday(.wide).month(.wide).day())
                                .font(.system(size: 17, weight: .medium))
                        }
                    }
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.25), radius: 12)
                    .padding(.top, geo.size.height * 0.18)
                    Spacer()
                    if let photo {
                        Link(destination: URL(string: photo.page) ?? URL(string: "https://unsplash.com")!) {
                            Text("Photo by \(photo.by) on Unsplash").font(.footnote)
                        }
                        .foregroundStyle(.white.opacity(0.8))
                        .padding(.bottom, 150)
                    }
                }
            }
        }
        .ignoresSafeArea()
    }
}

// ---------- Tabs ----------
struct TabsView: View {
    @EnvironmentObject var browser: Browser
    private let columns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 14) {
                    ForEach(browser.tabs) { tab in TabCard(tab: tab) }
                }
                .padding(16)
            }
            .navigationTitle("\(browser.tabs.count) \(browser.tabs.count == 1 ? "tab" : "tabs")")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { browser.newTab(); browser.showingTabs = false } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New tab")
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { browser.showingTabs = false }.fontWeight(.semibold) }
            }
        }
    }
}

struct TabCard: View {
    @EnvironmentObject var browser: Browser
    @ObservedObject var tab: Tab

    var body: some View {
        Button { browser.select(tab) } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(tab.isNewTab ? "New tab" : (tab.title.isEmpty ? (tab.host ?? "") : tab.title))
                    .font(.subheadline.weight(.semibold)).lineLimit(2).multilineTextAlignment(.leading)
                Text(tab.host ?? "Fjord").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemBackground)))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(browser.current === tab ? Color.primary : .clear, lineWidth: 2))
        }
        .buttonStyle(.plain)
        .overlay(alignment: .topTrailing) {
            Button { browser.close(tab) } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).frame(width: 30, height: 30)
            }
            .accessibilityLabel("Close tab")
        }
    }
}

// ---------- Shields ----------
struct ShieldsSheet: View {
    @ObservedObject var tab: Tab
    @Environment(\.dismiss) private var dismiss
    @AppStorage(Setting.blocking) private var blocking = true
    @State private var on = true

    var body: some View {
        let site = Shields.site(tab.host ?? "")
        VStack(alignment: .leading, spacing: 14) {
            Text(site).font(.title3.weight(.semibold))
            if blocking {
                Toggle(isOn: $on) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Shields").font(.headline)
                        Text(on ? "Ads and trackers on this site are blocked before they load." : "Ads and trackers can load on this site.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .onChange(of: on) { _, now in
                    Shields.set(now, for: site)
                    tab.applyBlocking(for: tab.host)
                    tab.reload()
                }
                Text("Site not working? Turn Shields off for just this site.").font(.footnote).foregroundStyle(.secondary)
            } else {
                Text("Blocking ads and trackers is off everywhere. Turn it on in Fjord settings.").foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(24)
        .onAppear { on = Shields.isOn(for: site) }
    }
}

// ---------- Fake-site warning ----------
struct LookalikeView: View {
    @ObservedObject var tab: Tab
    let warning: Lookalike

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 34)).foregroundStyle(.orange)
            Text("Is this the site you meant?").font(.title2.weight(.semibold))
            (Text(warning.host).bold() + Text(" looks a lot like ") + Text(warning.real).bold()
                + Text(". Fake sites copy popular names to steal passwords and card numbers."))
                .foregroundStyle(.secondary)
            VStack(spacing: 10) {
                Button { tab.goToReal() } label: { Text("Go to \(warning.real)").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                Button { tab.leaveWarning() } label: { Text("Go back").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).controlSize(.large)
                Button("Open \(warning.host) anyway") { tab.openAnyway() }
                    .font(.subheadline).foregroundStyle(.secondary).padding(.top, 4)
            }
            .padding(.top, 8)
        }
        .padding(28)
        .frame(maxWidth: 460)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}

struct ErrorView: View {
    @ObservedObject var tab: Tab
    let message: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark").font(.system(size: 34)).foregroundStyle(.secondary)
            Text("Couldn't open the page").font(.title3.weight(.semibold))
            Text(message).multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button("Try again") { tab.reload() }.buttonStyle(.bordered).padding(.top, 6)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}

// ---------- Settings ----------
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(Setting.engine) private var engine = "DuckDuckGo"
    @AppStorage(Setting.blocking) private var blocking = true
    @AppStorage(Setting.lookalikes) private var lookalikes = true
    @AppStorage(Setting.redirects) private var redirects = true
    @AppStorage(Setting.ghost) private var ghost = false
    @AppStorage(Setting.appLock) private var appLock = false
    @State private var sitesOff = Shields.sitesOff
    @State private var confirmClear = false
    @State private var cleared = false

    private var unlockMethod: String {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return "your passcode"
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Block ads and trackers", isOn: $blocking)
                    Toggle("Warn about fake sites", isOn: $lookalikes)
                    Toggle("Skip tracking redirects", isOn: $redirects)
                } header: { Text("Protection") } footer: {
                    Text("Ads and trackers are blocked with the EasyList, EasyPrivacy and Peter Lowe lists, the same ones Fjord uses on computers. Fake sites are ones named to look like a popular site, like paypa1.com. Tracking redirects are links that pass through Google or Facebook before the real site.")
                }
                Section("Search") {
                    Picker("Search engine", selection: $engine) {
                        ForEach(SearchEngine.all) { Text($0.name).tag($0.name) }
                    }
                }
                Section {
                    Toggle("Forget everything", isOn: $ghost)
                    Button("Clear history, cookies and site data", role: .destructive) { confirmClear = true }
                } header: { Text("Privacy") } footer: {
                    Text(cleared ? "Cleared." : "With Forget everything on, new tabs keep no cookies, history or site data: you'll be signed out of sites.")
                }
                Section {
                    Toggle("Lock with \(unlockMethod)", isOn: $appLock)
                } header: { Text("App lock") } footer: {
                    Text("Fjord asks for \(unlockMethod) when you come back to it, and hides your tabs in the app switcher.")
                }
                if !sitesOff.isEmpty {
                    Section("Shields off for") {
                        ForEach(sitesOff, id: \.self) { Text($0) }
                            .onDelete { rows in
                                for i in rows { Shields.remove(sitesOff[i]) }
                                sitesOff = Shields.sitesOff
                            }
                    }
                }
                Section {
                    LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                } header: { Text("About") } footer: {
                    Text("Fjord on iPhone and iPad runs on WebKit, like every browser on iOS. There's no Fjord account and no usage data: settings and history stay on this device.")
                }
            }
            .navigationTitle("Fjord")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.fontWeight(.semibold) } }
            .confirmationDialog("Clear history, cookies and site data?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Clear", role: .destructive) {
                    WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
                        cleared = true
                    }
                }
            } message: { Text("You'll be signed out of sites.") }
        }
    }
}

// ---------- App lock ----------
@MainActor
final class AppLock: ObservableObject {
    @Published var locked: Bool
    private var asking = false

    init() { locked = UserDefaults.standard.bool(forKey: Setting.appLock) }

    func phaseChanged(_ phase: ScenePhase) {
        let on = UserDefaults.standard.bool(forKey: Setting.appLock)
        if phase != .active, on { locked = true }       // covers the tabs in the app switcher too
        if phase == .active, locked { unlock() }
    }
    func unlock() {
        guard !asking else { return }
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { locked = false; return } // no passcode set
        asking = true
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Fjord") { ok, _ in
            Task { @MainActor in
                self.asking = false
                if ok { self.locked = false }
            }
        }
    }
}

struct LockView: View {
    @EnvironmentObject var lock: AppLock

    var body: some View {
        VStack(spacing: 18) {
            if let logo = Bundle.main.url(forResource: "logo", withExtension: "png").flatMap({ UIImage(contentsOfFile: $0.path) }) {
                Image(uiImage: logo).resizable().frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 17))
            }
            Text("Fjord is locked").font(.title2.weight(.semibold))
            Button("Unlock") { lock.unlock() }.buttonStyle(.borderedProminent).controlSize(.large)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial)
    }
}
