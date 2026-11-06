// Fjord for iPhone and iPad: a private browser on WebKit (Apple requires WebKit for iOS browsers), with Fjord's ad
// and tracker blocking, fake-site warning, clean redirect links, randomised fingerprint, private YouTube player,
// hidden parts of sites, Forget this site, AirPlay and Chromecast, a photo new tab with tracker stats, and app lock.
// UIKit hosts the SwiftUI screens, because only a view controller can switch the status bar's text between light
// and dark to stay readable over each site's own colour (StatusBar).
import SwiftUI
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        #if DEBUG
        Privacy.selfCheck()
        History.selfCheck()
        Sync.selfCheck()
        #endif
        Cast.shared.setUp()
        let bar = UINavigationBar.appearance()
        bar.titleTextAttributes = [.font: UIFont.fjord(17, .semibold)]
        bar.largeTitleTextAttributes = [.font: UIFont.fjord(34, .bold)]
        return true
    }
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: session.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

@MainActor
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private let browser = Browser()
    private let lock = AppLock()

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = FjordHostingController(rootView: AnyView(RootView().environmentObject(browser).environmentObject(lock)))
        window.makeKeyAndVisible()
        self.window = window
        for context in options.urlContexts { browser.handle(context.url) }
    }
    // fjord://open?url=… and web links from other apps
    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        for context in contexts { browser.handle(context.url) }
    }
    private var syncTimer: Timer?
    // Sync with the paired computer when Fjord comes to the front, and every 5 minutes while it's open
    func sceneDidBecomeActive(_ scene: UIScene) {
        lock.phaseChanged(.active)
        Sync.shared.browser = browser
        Sync.shared.syncIfDue()
        syncTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in MainActor.assumeIsolated { Sync.shared.syncIfDue() } }
    }
    func sceneWillResignActive(_ scene: UIScene) {
        lock.phaseChanged(.inactive)
        syncTimer?.invalidate()
    }
}

struct RootView: View {
    @EnvironmentObject var browser: Browser
    @EnvironmentObject var lock: AppLock
    @AppStorage(Setting.setupDone) private var setupDone = false
    var body: some View {
        ZStack {
            BrowserView()
            if !setupDone { SetupView().transition(.opacity).zIndex(1) }
            if lock.locked { LockView().transition(.opacity).zIndex(2) }
        }
        .animation(.easeInOut(duration: 0.2), value: lock.locked)
        .animation(.easeInOut(duration: 0.3), value: setupDone)
        .onChange(of: setupDone) { _, done in
            guard done, let tab = browser.current else { return }
            StatusBar.style = StatusBar.style(for: tab)
            // The first tab opened before setup; with Forget everything picked, it's swapped for one that keeps nothing
            if UserDefaults.standard.bool(forKey: Setting.ghost), tab.isNewTab, tab.webView.configuration.websiteDataStore.isPersistent {
                browser.newTab()
                browser.close(tab)
            }
        }
        .tint(.primary)
        .font(.fjord(.body)) // Geist for everything that doesn't pick its own size
    }
}

// The status bar's text: light over dark sites, the photo new tab and the lock screen, dark over light ones
final class FjordHostingController: UIHostingController<AnyView> {
    override var preferredStatusBarStyle: UIStatusBarStyle { StatusBar.style }
}

@MainActor
enum StatusBar {
    static var style: UIStatusBarStyle = .default {
        didSet {
            guard style != oldValue else { return }
            for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
                for window in scene.windows {
                    UIView.animate(withDuration: 0.2) { window.rootViewController?.setNeedsStatusBarAppearanceUpdate() }
                }
            }
        }
    }
    static func over(_ color: UIColor?) -> UIStatusBarStyle {
        guard let color else { return .default }
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard color.resolvedColor(with: .current).getRed(&r, green: &g, blue: &b, alpha: &a), a > 0.5 else { return .default }
        return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.55 ? .lightContent : .darkContent
    }
}
