// Fjord for iPhone and iPad: a private browser on WebKit (Apple requires WebKit for iOS browsers), with Fjord's ad
// and tracker blocking, fake-site warning, clean redirect links, photo new tab and app lock
import SwiftUI

@main
struct FjordApp: App {
    @StateObject private var browser = Browser()
    @StateObject private var lock = AppLock()
    @Environment(\.scenePhase) private var phase

    init() {
        #if DEBUG
        Privacy.selfCheck()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            ZStack {
                BrowserView()
                if lock.locked { LockView() }
            }
            .environmentObject(browser)
            .environmentObject(lock)
            .tint(.primary)
            .onOpenURL { browser.handle($0) }
            .onChange(of: phase) { _, now in lock.phaseChanged(now) }
        }
    }
}
