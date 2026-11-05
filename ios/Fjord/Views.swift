// Fjord's screens: the page with the address bar at the bottom, the new tab, tabs, Shields, the fake-site warning,
// settings and the lock screen. Neutral greys like Fjord on the desktop; the system font, as iOS apps do.
// Motion: springs without overshoot for what Fjord moves on its own, a little bounce only after a flick; with Reduce
// Motion on, short cross-fades instead.
import SwiftUI
import WebKit
import LocalAuthentication
import AVKit

extension Animation {
    static let fjord = Animation.spring(response: 0.36, dampingFraction: 1)
    static let fjordFlick = Animation.spring(response: 0.34, dampingFraction: 0.82)
    static func fjord(reduced: Bool) -> Animation { reduced ? .easeInOut(duration: 0.18) : .fjord }
}

extension StatusBar {
    // Light text over the photo new tab and dark sites, dark text over light ones
    static func style(for tab: Tab) -> UIStatusBarStyle {
        if tab.warning != nil || tab.error != nil { return .default }
        return tab.isNewTab ? .lightContent : over(tab.topColor)
    }
}

struct BrowserView: View {
    @EnvironmentObject var browser: Browser
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sheet: Sheet?
    enum Sheet: String, Identifiable { case shields, settings; var id: String { rawValue } }

    var body: some View {
        ZStack {
            if let tab = browser.current {
                // The page steps back as the tabs come forward, and returns the same way
                PageView(tab: tab, sheet: $sheet).id(tab.id)
                    .scaleEffect(browser.showingTabs && !reduceMotion ? 0.9 : 1)
                    .opacity(browser.showingTabs ? 0 : 1)
                    .allowsHitTesting(!browser.showingTabs)
            }
            if browser.showingTabs {
                TabsView()
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 1.06)))
                    .zIndex(1)
            }
        }
        .animation(.fjord(reduced: reduceMotion), value: browser.showingTabs)
        .sheet(item: $sheet) { which in
            switch which {
            case .shields: if let tab = browser.current { ShieldsSheet(tab: tab).presentationDetents([.medium]) }
            case .settings: SettingsView()
            }
        }
        .onChange(of: browser.showingTabs) { _, showing in
            StatusBar.style = showing ? .default : browser.current.map(StatusBar.style(for:)) ?? .default
        }
        #if DEBUG
        .task { // Simulator tests: -FjordOpen <address> opens a page, -FjordShow settings|shields|tabs a sheet
            let args = ProcessInfo.processInfo.arguments
            if let i = args.firstIndex(of: "-FjordOpen"), i + 1 < args.count { browser.go(args[i + 1]) }
            if let i = args.firstIndex(of: "-FjordShow"), i + 1 < args.count {
                try? await Task.sleep(for: .seconds(4))
                switch ProcessInfo.processInfo.arguments[i + 1] {
                case "tabs": browser.showTabs()
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
        ZStack(alignment: .bottom) {
            if tab.isNewTab { NewTabView().transition(.opacity) }
            // The page runs under the bottom bar, as in Safari, so shrinking the bar shows more of it
            ZStack {
                WebView(webView: tab.webView)
                    .opacity(tab.isNewTab ? 0 : 1)
                    .allowsHitTesting(!tab.isNewTab)
                if let warning = tab.warning { LookalikeView(tab: tab, warning: warning) }
                else if let error = tab.error { ErrorView(tab: tab, message: error) }
            }
            .ignoresSafeArea(edges: .bottom)
            BottomBar(tab: tab, sheet: $sheet)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                    // The page can scroll its end above the full bar; that end brings the bar back anyway
                    guard !tab.barCollapsed else { return }
                    tab.webView.scrollView.contentInset.bottom = height
                    tab.webView.scrollView.verticalScrollIndicatorInsets.bottom = height
                }
        }
        // Behind the status bar: the colour of the top of the site
        .background(Color(uiColor: tab.isNewTab ? .systemBackground : (tab.topColor ?? .systemBackground)).ignoresSafeArea())
        .animation(.easeInOut(duration: 0.25), value: tab.isNewTab)
        .animation(.easeInOut(duration: 0.3), value: tab.topColor)
        .onAppear { StatusBar.style = StatusBar.style(for: tab) }
        .onChange(of: tab.topColor) { StatusBar.style = StatusBar.style(for: tab) }
        .onChange(of: tab.isNewTab) { StatusBar.style = StatusBar.style(for: tab) }
        .onChange(of: tab.error) { StatusBar.style = StatusBar.style(for: tab) }
    }
}

struct WebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

// ---------- Address bar and toolbar ----------
// While you scroll down the bar shrinks to the site's name, like Safari's; scrolling up or a tap brings it back
struct BottomBar: View {
    @EnvironmentObject var browser: Browser
    @ObservedObject var tab: Tab
    @Binding var sheet: BrowserView.Sheet?
    @State private var text = ""
    @FocusState private var editing: Bool
    @AppStorage(Setting.blocking) private var blocking = true
    @ObservedObject private var airplay = AirPlayRoutes.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var shieldsOn: Bool { blocking && (tab.host.map(Shields.isOn) ?? true) }
    private var shownAddress: String {
        guard let host = tab.host else { return "" }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
    private var collapsed: Bool { tab.barCollapsed && !editing && !tab.isNewTab }

    // One shape throughout: the address field, which shrinks to a small rounded square around the site's name and
    // grows back from it, while the toolbar and the bar's own background fade and slide away under it
    var body: some View {
        VStack(spacing: 10) {
            field
            if !collapsed {
                toolbar.transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, collapsed ? 0 : 10)
        .padding(.bottom, collapsed ? 2 : 4)
        .frame(maxWidth: .infinity)
        .background {
            Rectangle().fill(.bar).ignoresSafeArea()
                .overlay(alignment: .top) { ProgressLine(tab: tab) }
                .opacity(collapsed ? 0 : 1)
        }
        .animation(.fjord(reduced: reduceMotion), value: collapsed)
        .onAppear { text = shownAddress }
        .onChange(of: tab.url) { if !editing { text = shownAddress } }
        .onChange(of: editing) { _, now in text = now ? (tab.url?.absoluteString ?? "") : shownAddress }
    }

    private var field: some View {
        ZStack {
            if collapsed {
                Button { tab.barCollapsed = false } label: {
                    HStack(spacing: 5) {
                        if !shieldsOn { Image(systemName: "shield.slash").font(.caption2.weight(.semibold)) }
                        Text(shownAddress).font(.footnote.weight(.semibold)).lineLimit(1)
                    }
                    .padding(.horizontal, 14)
                    .frame(height: 32)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(shownAddress). Show the toolbar")
                .transition(.opacity)
            } else {
                addressBar.transition(.opacity)
            }
        }
        .frame(maxWidth: collapsed ? nil : .infinity)
        .background {
            RoundedRectangle(cornerRadius: collapsed ? 11 : 24, style: .continuous)
                .fill(collapsed ? AnyShapeStyle(.regularMaterial) : AnyShapeStyle(Color(.secondarySystemBackground)))
                .shadow(color: .black.opacity(collapsed ? 0.14 : 0), radius: 10, y: 3)
        }
        .overlay(alignment: .bottom) {
            if collapsed { ProgressLine(tab: tab).padding(.horizontal, 10) }
        }
    }

    private var addressBar: some View {
        HStack(spacing: 10) {
            Button { sheet = .shields } label: {
                Image(systemName: shieldsOn ? "shield.lefthalf.filled" : "shield.slash")
                    .contentTransition(.symbolEffect(.replace))
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
                    .transition(.opacity)
            } else if tab.url != nil {
                Button { tab.reload() } label: { Image(systemName: "arrow.clockwise").frame(width: 28, height: 28) }
                    .accessibilityLabel("Reload")
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 48)
        .animation(.easeOut(duration: 0.15), value: tab.isLoading)
        .animation(.fjord(reduced: reduceMotion), value: editing)
    }

    private var toolbar: some View {
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
            if let url = tab.url, Cast.video(inPlayer: url) != nil {
                Spacer()
                CastButton(tab: tab).frame(width: 28, height: 28).accessibilityLabel("Cast to a Chromecast")
            }
            if airplay.available {
                Spacer()
                AirPlayButton().frame(width: 28, height: 28).accessibilityLabel("AirPlay")
            }
            Spacer()
            Button { browser.newTab() } label: { Image(systemName: "plus") }.accessibilityLabel("New tab")
            Spacer()
            Button { browser.showTabs() } label: {
                Text("\(browser.tabs.count)").font(.system(size: 13, weight: .semibold))
                    .contentTransition(.numericText())
                    .frame(width: 22, height: 22)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(.primary, lineWidth: 1.6))
            }
            .accessibilityLabel("Tabs, \(browser.tabs.count) open")
            Spacer()
            Button { sheet = .settings } label: { Image(systemName: "gearshape") }.accessibilityLabel("Fjord settings")
        }
        .font(.system(size: 19))
        .padding(.horizontal, 10)
        .animation(.fjord, value: browser.tabs.count)
    }
}

// Loading: a thin line along the top of the bar that fills as the page arrives, then fades
struct ProgressLine: View {
    @ObservedObject var tab: Tab
    var body: some View {
        GeometryReader { geo in
            Capsule().fill(.primary.opacity(0.55))
                .frame(width: geo.size.width * max(0.04, tab.progress), height: 2)
                .animation(.easeOut(duration: 0.25), value: tab.progress)
        }
        .frame(height: 2)
        .opacity(tab.isLoading ? 1 : 0)
        .animation(.easeOut(duration: 0.3), value: tab.isLoading)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// ---------- AirPlay ----------
// The toolbar's AirPlay button, only while there's an Apple TV or AirPlay speaker nearby. Videos also have the
// button in their own controls.
@MainActor
final class AirPlayRoutes: ObservableObject {
    static let shared = AirPlayRoutes()
    @Published private(set) var available = false
    private let detector = AVRouteDetector()
    private var token: NSObjectProtocol?

    private init() {
        detector.isRouteDetectionEnabled = true
        available = detector.multipleRoutesDetected
        token = NotificationCenter.default.addObserver(forName: .AVRouteDetectorMultipleRoutesDetectedDidChange, object: detector,
                                                       queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.available = self?.detector.multipleRoutesDetected ?? false }
        }
    }
}

struct AirPlayButton: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let picker = AVRoutePickerView()
        picker.prioritizesVideoDevices = true
        picker.tintColor = .label
        picker.activeTintColor = .label
        return picker
    }
    func updateUIView(_ view: AVRoutePickerView, context: Context) {}
}

// ---------- New tab: a photo, the time, the trackers Fjord stopped, and who took the photo ----------
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
                LinearGradient(colors: [.black.opacity(0.35), .clear, .black.opacity(0.15), .black.opacity(0.6)], startPoint: .top, endPoint: .bottom)
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
                    .padding(.top, geo.size.height * 0.14)
                    StatsCard().padding(.top, 26).padding(.horizontal, 24)
                    Spacer()
                    if let photo {
                        Link(destination: URL(string: photo.page) ?? URL(string: "https://unsplash.com")!) {
                            Text("Photo by \(photo.by) on Unsplash").font(.footnote)
                        }
                        .foregroundStyle(.white.opacity(0.8))
                        .padding(.top, 14)
                    }
                    Spacer().frame(height: 130) // the bottom bar
                }
            }
        }
        .ignoresSafeArea()
    }
}

// The trackers Fjord stopped, under the clock: straight on the photo, with a soft shadow to keep it readable
struct StatsCard: View {
    @ObservedObject private var stats = TrackerStats.shared

    var body: some View {
        VStack(spacing: 10) {
            if stats.total == 0 {
                Text("Trackers Fjord stops will be counted here.")
                    .font(.footnote.weight(.medium)).foregroundStyle(.white.opacity(0.85))
            } else {
                VStack(spacing: 1) {
                    Text(stats.total.formatted())
                        .font(.system(size: 26, weight: .semibold)).monospacedDigit()
                        .contentTransition(.numericText())
                    Text(since).font(.footnote.weight(.medium)).foregroundStyle(.white.opacity(0.85))
                }
                Text("\(duration(stats.timeSaved)) and \(ByteCountFormatter.string(fromByteCount: stats.bytesSaved, countStyle: .file)) saved")
                    .font(.caption.weight(.medium)).monospacedDigit().foregroundStyle(.white.opacity(0.8))
                WeekBars(week: stats.week).frame(width: 168)
                if !stats.topCompanies.isEmpty {
                    Text("Tried most this week: \(stats.topCompanies.formatted(.list(type: .and)))")
                        .font(.caption).foregroundStyle(.white.opacity(0.75))
                }
            }
        }
        .multilineTextAlignment(.center)
        .foregroundStyle(.white)
        .shadow(color: .black.opacity(0.35), radius: 8, y: 1)
        .frame(maxWidth: 360)
        .animation(.fjord, value: stats.total)
        .accessibilityElement(children: .combine)
    }

    private var since: String {
        guard let date = stats.since else { return "trackers stopped" }
        return "trackers stopped since \(date.formatted(.dateTime.day().month()))"
    }
    private func duration(_ s: TimeInterval) -> String {
        if s < 60 { return "\(Int(s)) s" }
        if s < 3600 { return "\(Int(s / 60)) min" }
        return "\(Int(s / 3600)) h \(Int(s.truncatingRemainder(dividingBy: 3600) / 60)) min"
    }
}

struct WeekBars: View {
    let week: [(date: Date, count: Int)]
    var body: some View {
        let most = max(1, week.map(\.count).max() ?? 1)
        HStack(alignment: .bottom, spacing: 8) {
            ForEach(Array(week.enumerated()), id: \.offset) { _, day in
                VStack(spacing: 4) {
                    Capsule().fill(.white.opacity(Calendar.current.isDateInToday(day.date) ? 0.95 : 0.55))
                        .frame(width: 6, height: max(3, 26 * CGFloat(day.count) / CGFloat(most)))
                    Text(day.date, format: .dateTime.weekday(.narrow)).font(.system(size: 10, weight: .medium)).foregroundStyle(.white.opacity(0.7))
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(height: 42, alignment: .bottom)
        .accessibilityLabel("This week: \(week.map { "\($0.count)" }.joined(separator: ", ")) trackers a day")
    }
}

// ---------- Tabs ----------
// Each tab as a card with how it looked, largest first on screen like Safari's: tap to go back to it, swipe it away
// or tap ✕ to close it
struct TabsView: View {
    @EnvironmentObject var browser: Browser
    private let columns = [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)]

    var body: some View {
        ZStack(alignment: .bottom) {
            Color(.systemGroupedBackground).ignoresSafeArea()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 22) {
                        ForEach(browser.tabs) { tab in TabCard(tab: tab).id(tab.id) }
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 12)
                    .padding(.bottom, 96)
                    .animation(.fjord, value: browser.tabs.map(\.id))
                }
                .onAppear { if let id = browser.current?.id { proxy.scrollTo(id, anchor: .center) } }
            }
            HStack {
                Button { browser.newTab(); browser.showingTabs = false } label: {
                    Image(systemName: "plus").font(.system(size: 20, weight: .medium)).frame(width: 44, height: 44)
                }
                .accessibilityLabel("New tab")
                Spacer()
                Text("\(browser.tabs.count) \(browser.tabs.count == 1 ? "Tab" : "Tabs")")
                    .font(.subheadline.weight(.semibold))
                    .contentTransition(.numericText())
                Spacer()
                Button("Done") { browser.showingTabs = false }
                    .font(.body.weight(.semibold)).frame(minWidth: 44, minHeight: 44)
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .background(.bar)
        }
    }
}

struct TabCard: View {
    @EnvironmentObject var browser: Browser
    @ObservedObject var tab: Tab
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drag: CGFloat = 0
    @State private var closed = 0

    private var selected: Bool { browser.current === tab }
    private var title: String { tab.isNewTab ? "New tab" : (tab.title.isEmpty ? (tab.host ?? "") : tab.title) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Color.clear
                .aspectRatio(0.68, contentMode: .fit)
                .overlay { preview }
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .strokeBorder(selected ? Color.primary : Color.primary.opacity(0.08), lineWidth: selected ? 3 : 1)
                }
                .overlay(alignment: .topTrailing) {
                    Button { close() } label: {
                        Image(systemName: "xmark").font(.system(size: 11, weight: .bold))
                            .frame(width: 26, height: 26)
                            .background(.regularMaterial, in: Circle())
                            .frame(width: 44, height: 44) // a comfortable target around the small button
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Close \(title)")
                }
                .shadow(color: .black.opacity(0.12), radius: 12, y: 5)
            HStack(spacing: 6) {
                if let icon = tab.favicon {
                    Image(uiImage: icon).resizable().scaledToFit().frame(width: 16, height: 16)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                }
                Text(title).font(.caption.weight(.semibold)).lineLimit(1)
            }
            .padding(.horizontal, 4)
        }
        .contentShape(Rectangle())
        .offset(x: drag)
        .opacity(1 - min(abs(drag) / 320, 0.7))
        .onTapGesture { browser.select(tab) }
        .simultaneousGesture(
            DragGesture(minimumDistance: 14)
                .onChanged { value in
                    // Sideways only, so scrolling the list still works
                    guard abs(value.translation.width) > abs(value.translation.height) else { return }
                    drag = value.translation.width
                }
                .onEnded { value in
                    if value.predictedEndTranslation.width < -160 || value.translation.width < -120 {
                        close(from: value.velocity.width)
                    } else {
                        withAnimation(.fjordFlick) { drag = 0 }
                    }
                }
        )
        .sensoryFeedback(.impact(weight: .light), trigger: closed)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
        .accessibilityAction(named: "Close") { close() }
    }

    @ViewBuilder private var preview: some View {
        if tab.isNewTab {
            ZStack {
                LinearGradient(colors: [Color(.secondarySystemBackground), Color(.tertiarySystemBackground)], startPoint: .top, endPoint: .bottom)
                Image(systemName: "plus.square.on.square").font(.system(size: 26)).foregroundStyle(.secondary)
            }
        } else if let image = tab.snapshot {
            Image(uiImage: image).resizable().scaledToFill()
                .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .top)
                .clipped()
        } else {
            ZStack {
                Color(uiColor: tab.topColor ?? .secondarySystemBackground)
                Text(tab.host ?? "").font(.footnote.weight(.medium)).foregroundStyle(.secondary).padding(8)
            }
        }
    }

    // Slides off the way you swiped (or to the left), then the others close the gap
    private func close(from velocity: CGFloat = 0) {
        closed += 1
        withAnimation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.3, dampingFraction: 1, blendDuration: 0)) {
            drag = -480
        }
        Task {
            try? await Task.sleep(for: .milliseconds(reduceMotion ? 150 : 220))
            withAnimation(.fjord) { browser.close(tab) }
        }
    }
}

// ---------- Shields ----------
struct ShieldsSheet: View {
    @EnvironmentObject var browser: Browser
    @ObservedObject var tab: Tab
    @Environment(\.dismiss) private var dismiss
    @AppStorage(Setting.blocking) private var blocking = true
    @State private var on = true
    @State private var hiddenHere = 0

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
            Divider().padding(.vertical, 4)
            Button {
                dismiss()
                Task { try? await Task.sleep(for: .milliseconds(400)); tab.pickToHide() } // once the sheet is out of the way
            } label: {
                Label("Hide part of this page", systemImage: "eye.slash")
            }
            if hiddenHere > 0 {
                Button {
                    Hidden.remove(site)
                    hiddenHere = 0
                    tab.applyPageScripts(for: tab.host)
                    tab.reload()
                } label: {
                    Label(hiddenHere == 1 ? "Show the hidden part again" : "Show the \(hiddenHere) hidden parts again", systemImage: "eye")
                }
            }
            Button(role: .destructive) {
                tab.forget { dismiss(); browser.close(tab) }
            } label: {
                Label("Forget this site now", systemImage: "trash")
            }
            Text("Deletes its cookies and saved data, and closes the tab. You'll be signed out.").font(.footnote).foregroundStyle(.secondary)
            Spacer()
        }
        .padding(24)
        .onAppear {
            on = Shields.isOn(for: site)
            hiddenHere = Hidden.selectors(for: site).count
        }
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
    @AppStorage(Setting.randomise) private var randomise = true
    @AppStorage(Setting.youtube) private var youtube = false
    @State private var sitesOff = Shields.sitesOff
    @State private var hiddenSites = Hidden.sites
    @State private var confirmClear = false
    @State private var cleared = false
    @State private var safari: [String: Bool] = [:]
    @Environment(\.scenePhase) private var phase

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
                    Toggle("Randomise your fingerprint", isOn: $randomise)
                } header: { Text("Protection") } footer: {
                    Text("Ads and trackers are blocked with the EasyList, EasyPrivacy and Peter Lowe lists, the same ones Fjord uses on computers. Fake sites are ones named to look like a popular site, like paypa1.com. Tracking redirects are links that pass through Google or Facebook before the real site. Randomising gives every site slightly different, made-up canvas, WebGL and audio readings, new each time Fjord starts, so sites can't use them to recognise you.")
                }
                Section {
                    ForEach(Blocker.lists, id: \.self) { list in
                        LabeledContent("Fjord \(list.capitalized)", value: safari[list] == true ? "On" : "Off")
                    }
                } header: { Text("Safari") } footer: {
                    Text(safari.values.allSatisfy { $0 } && !safari.isEmpty
                         ? "Safari blocks ads and trackers with Fjord's lists. It applies them itself, so Fjord never sees what you browse there."
                         : "Fjord can block ads and trackers in Safari too: open Settings, then Apps, Safari, Extensions, and turn on Fjord Ads and Fjord Trackers. Safari applies the lists itself, so Fjord never sees what you browse there.")
                }
                .task(id: phase) { if phase == .active { safari = await SafariShields.states() } } // again when back from Settings
                Section {
                    Toggle("Private YouTube player", isOn: $youtube)
                } header: { Text("YouTube") } footer: {
                    Text("Videos play on their own in YouTube's privacy-enhanced player: no recommendations, comments or personalised ads, and nothing goes into your YouTube history. AirPlay and picture-in-picture still work, and the cast button sends the video to a Chromecast. “Watch on YouTube” in the player opens the real page.")
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
                if !hiddenSites.isEmpty {
                    Section {
                        ForEach(hiddenSites, id: \.site) { LabeledContent($0.site, value: "\($0.count) hidden") }
                            .onDelete { rows in
                                for i in rows { Hidden.remove(hiddenSites[i].site) }
                                hiddenSites = Hidden.sites
                            }
                    } header: { Text("Hidden parts of sites") } footer: { Text("Swipe a site to show its hidden parts again.") }
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
