// The first-time setup: history, a search engine and a couple of extras, over a new-tab photo at the start and end
// like Fjord's new tab. Every choice is saved as it's made, to the same settings as Fjord's settings screen, so
// Skip leaves things as they were. Settings > Run setup again shows it again.
import SwiftUI

struct SetupView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(Setting.setupDone) private var setupDone = false
    @AppStorage(Setting.history) private var history = true
    @AppStorage(Setting.ghost) private var ghost = false
    @AppStorage(Setting.engine) private var engine = "DuckDuckGo"
    @AppStorage(Setting.appLock) private var appLock = false
    @AppStorage(Setting.youtube) private var youtube = false
    @State private var step = 0
    @State private var forward = true
    @State private var photo = Photo.all.randomElement()
    private let last = 4

    init() {
        #if DEBUG // Simulator tests: -FjordSetupStep <n> starts on that step
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-FjordSetupStep"), i + 1 < args.count, let n = Int(args[i + 1]) { _step = State(initialValue: n) }
        #endif
    }

    enum Keep: CaseIterable { case history, noHistory, nothing }
    private var keep: Binding<Keep> {
        Binding(get: { ghost ? .nothing : history ? .history : .noHistory }, set: { choice in
            history = choice == .history
            ghost = choice == .nothing
            if choice != .history { History.shared.forget(); TrackerStats.shared.forgetSites() }
        })
    }

    var body: some View {
        ZStack {
            if step == 0 || step == last { backdrop.transition(.opacity) }
            Group {
                switch step {
                case 0: welcome
                case 1: page("History", "The address bar can suggest sites you've been to as you type. History stays on this iPhone.") { historyChoices }
                case 2: page("Search engine", "Used when you search from the address bar.") { engines }
                case 3: page("A few more", "You can change these and everything else in Fjord's settings.") { extras }
                default: done
                }
            }
            .id(step)
            .transition(reduceMotion ? .opacity : .asymmetric(
                insertion: .opacity.combined(with: .offset(x: forward ? 40 : -40)),
                removal: .opacity.combined(with: .offset(x: forward ? -40 : 40))))
        }
        .animation(.fjord(reduced: reduceMotion), value: step)
        .onAppear { go(step) }
        #if DEBUG
        .task { // Simulator tests: -FjordSetupWalk goes on a step every 3 seconds, as Continue does
            guard ProcessInfo.processInfo.arguments.contains("-FjordSetupWalk") else { return }
            while step < last {
                try? await Task.sleep(for: .seconds(3))
                go(step + 1)
            }
        }
        #endif
    }

    private func go(_ to: Int) {
        forward = to > step
        step = to
        StatusBar.style = to == 0 || to == last ? .lightContent : .default
    }
    private func finish() { setupDone = true }

    // ---------- The photo steps ----------
    private var backdrop: some View {
        GeometryReader { geo in
            ZStack {
                if let image = photo?.image {
                    Image(uiImage: image).resizable().scaledToFill().frame(width: geo.size.width, height: geo.size.height).clipped()
                } else {
                    Color(.darkGray)
                }
                LinearGradient(colors: [.black.opacity(0.2), .clear, .black.opacity(0.45), .black.opacity(0.75)], startPoint: .top, endPoint: .bottom)
            }
        }
        .ignoresSafeArea()
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()
            if let logo = Bundle.main.url(forResource: "logo", withExtension: "png").flatMap({ UIImage(contentsOfFile: $0.path) }) {
                Image(uiImage: logo).resizable().frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
                    .padding(.bottom, 22)
            }
            Text("Welcome to Fjord").font(.system(size: 36, weight: .bold)).tracking(-0.6)
            Text("Ads and trackers are blocked from the first page you open. Make a few choices and you're set.")
                .font(.title3).foregroundStyle(.white.opacity(0.85)).padding(.top, 10)
            Button { go(1) } label: { Text("Get started").frame(maxWidth: .infinity) }
                .buttonStyle(SetupButton(light: true)).padding(.top, 36)
            Button("Skip setup", action: finish)
                .font(.body.weight(.medium)).foregroundStyle(.white.opacity(0.85))
                .frame(maxWidth: .infinity, minHeight: 44).padding(.top, 6)
        }
        .foregroundStyle(.white)
        .shadow(color: .black.opacity(0.25), radius: 10)
        .padding(.horizontal, 28).padding(.bottom, 20)
        .frame(maxWidth: 520)
    }

    private var done: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()
            Text("You're all set").font(.system(size: 36, weight: .bold)).tracking(-0.6)
            VStack(alignment: .leading, spacing: 12) {
                ForEach(["Ads and trackers blocked", "Fake sites stopped", "Tracking removed from links",
                         "A different fingerprint for every site"], id: \.self) { line in
                    Label(line, systemImage: "checkmark").font(.body.weight(.medium))
                }
            }
            .padding(.top, 20)
            Text("Fjord's settings are behind the gear in the toolbar.")
                .font(.subheadline).foregroundStyle(.white.opacity(0.8)).padding(.top, 22)
            Button(action: finish) { Text("Start browsing").frame(maxWidth: .infinity) }
                .buttonStyle(SetupButton(light: true)).padding(.top, 30)
                .padding(.bottom, 50) // where Skip setup was, so the button doesn't jump between the photo steps
        }
        .foregroundStyle(.white)
        .shadow(color: .black.opacity(0.25), radius: 10)
        .padding(.horizontal, 28).padding(.bottom, 20)
        .frame(maxWidth: 520)
    }

    // ---------- The choice steps ----------
    private func page<Content: View>(_ title: String, _ text: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                ForEach(1..<last, id: \.self) { i in
                    Capsule().fill(i <= step ? Color.primary : Color.secondary.opacity(0.3)).frame(width: i == step ? 22 : 7, height: 7)
                }
            }
            .animation(.fjord(reduced: reduceMotion), value: step)
            .padding(.top, 14)
            .accessibilityElement().accessibilityLabel("Step \(step) of \(last - 1)")
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(title).font(.largeTitle.weight(.bold)).tracking(-0.4)
                    Text(text).font(.body).foregroundStyle(.secondary).padding(.top, 8)
                    content().padding(.top, 28)
                }
                .padding(.horizontal, 24).padding(.top, 34).padding(.bottom, 24)
                .frame(maxWidth: 560, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            HStack {
                Button("Back") { go(step - 1) }.font(.body.weight(.medium)).frame(minWidth: 64, minHeight: 44)
                Spacer()
                Button { go(step + 1) } label: { Text("Continue").padding(.horizontal, 26) }.buttonStyle(SetupButton(light: false))
            }
            .padding(.horizontal, 20).padding(.bottom, 12)
            .frame(maxWidth: 600)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    private var historyChoices: some View {
        VStack(spacing: 10) {
            choice(keep.wrappedValue == .history, "Keep history", "The address bar suggests sites you've been to and finishes their names for you.", "clock.arrow.circlepath") { keep.wrappedValue = .history }
            choice(keep.wrappedValue == .noHistory, "Don't keep history", "Fjord doesn't remember which sites you visit. You stay signed in to sites.", "clock.badge.xmark") { keep.wrappedValue = .noHistory }
            choice(keep.wrappedValue == .nothing, "Forget everything", "No history, cookies or site data: every tab starts fresh, and you're signed out of sites when you close it.", "wind") { keep.wrappedValue = .nothing }
        }
    }

    private static let about = ["DuckDuckGo": "Doesn't keep your searches", "Startpage": "Google's results, without the tracking",
                                "Brave Search": "Its own index of the web, no tracking", "Google": "Keeps your searches, with ads",
                                "Bing": "Microsoft's search, with ads"]
    private var engines: some View {
        VStack(spacing: 10) {
            ForEach(SearchEngine.all) { e in
                choice(engine == e.name, e.name, Self.about[e.name] ?? "", nil) { engine = e.name }
            }
        }
    }

    private var extras: some View {
        VStack(spacing: 10) {
            toggle("Lock with \(AppLock.method)", "Fjord asks for \(AppLock.method) when you come back to it, and hides your tabs in the app switcher.", $appLock)
            toggle("Private YouTube player", "YouTube videos play on their own, without recommendations or comments, and stay out of your YouTube history.", $youtube)
        }
    }

    // A card you pick, with a check when it's the one
    private func choice(_ on: Bool, _ title: String, _ text: String, _ symbol: String?, pick: @escaping () -> Void) -> some View {
        Button(action: pick) {
            HStack(alignment: .top, spacing: 14) {
                if let symbol {
                    Image(systemName: symbol).font(.title3).frame(width: 28).padding(.top, 1)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.headline)
                    if !text.isEmpty { Text(text).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                }
                Spacer(minLength: 8)
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .font(.title3).foregroundStyle(on ? Color.primary : Color.secondary.opacity(0.5))
                    .contentTransition(.symbolEffect(.replace))
            }
            .multilineTextAlignment(.leading)
            .padding(16)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(on ? Color.primary : .clear, lineWidth: 1.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScale())
        .accessibilityAddTraits(on ? .isSelected : [])
        .animation(.easeOut(duration: 0.15), value: on)
    }

    private func toggle(_ title: String, _ text: String, _ value: Binding<Bool>) -> some View {
        Toggle(isOn: value) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(text).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

// The big rounded buttons: white on the photo, the text colour on the choice steps
struct SetupButton: ButtonStyle {
    let light: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(light ? Color.black : Color(.systemBackground))
            .frame(minHeight: 50)
            .background(light ? Color.white : Color.primary, in: Capsule())
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
            .shadow(color: .black.opacity(light ? 0.15 : 0), radius: 10, y: 3)
    }
}

struct PressScale: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
    }
}
