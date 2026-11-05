// Chromecast for the private YouTube player: the cast button in the toolbar while a video is open in the player
// connects to a Chromecast with Google's Cast kit, which starts the YouTube app on the TV; the video is then handed
// to that app the way YouTube's own phone app does it (the "lounge"), and keeps playing there.
// shortcut: the lounge isn't a documented API (the steps follow pychromecast and casttube); if YouTube changes it,
// casting connects but the video doesn't start. Only the private player casts; other sites' videos can use AirPlay.
import SwiftUI
import GoogleCast

@MainActor
final class Cast: NSObject, ObservableObject {
    static let shared = Cast()
    static let youtubeApp = "233637DE" // YouTube's app on Chromecasts
    private let namespace = "urn:x-cast:com.google.youtube.mdx"
    private var channel: GCKGenericChannel?
    private var looking = false
    /// The tab whose player the cast button was pressed in
    weak var tab: Tab?

    // At launch: no looking for Chromecasts yet (that waits for a video in the player), and none of the Cast kit's
    // diagnostic data sent to Google
    func setUp() {
        let options = GCKCastOptions(discoveryCriteria: GCKDiscoveryCriteria(applicationID: Self.youtubeApp))
        options.disableAnalyticsLogging = true
        options.physicalVolumeButtonsWillControlDeviceVolume = true
        GCKCastContext.setSharedInstanceWith(options)
        GCKCastContext.sharedInstance().sessionManager.add(self)
    }

    // The first time this runs, iOS asks whether Fjord may look for devices on the local network
    func startLooking() {
        guard !looking else { return }
        looking = true
        GCKCastContext.sharedInstance().discoveryManager.startDiscovery()
    }

    var connected: Bool { GCKCastContext.sharedInstance().sessionManager.hasConnectedCastSession() }

    // A video opened in the player while connected goes to the TV too
    func playerOpened(_ tab: Tab) {
        self.tab = tab
        if connected { castCurrent() }
    }

    // ---------- Handing the video to YouTube on the TV ----------
    private func castCurrent() {
        guard let tab, let url = tab.url, let video = Self.video(inPlayer: url) else { return }
        // Carry on from where the phone was, then stop the phone's copy
        tab.webView.evaluateJavaScript("(() => { const v = document.querySelector('video'); const t = v ? v.currentTime : 0; v && v.pause(); return t; })()") { time, _ in
            Task { @MainActor in self.askScreen(video.id, start: Int((time as? Double) ?? Double(video.start))) }
        }
    }
    private var pending: (id: String, start: Int)?
    // The YouTube app on the TV answers with its screen id, which the lounge needs. The channel can take a moment to
    // open after the TV starts YouTube, so this tries for a few seconds.
    private func askScreen(_ id: String, start: Int, tries: Int = 10) {
        pending = (id, start)
        var error: GCKError?
        if channel?.isConnected == true, channel?.sendTextMessage(#"{"type":"getMdxSessionStatus"}"#, error: &error) == true { return }
        guard tries > 1, connected else { return print("Fjord cast: YouTube on the TV didn't answer \(error.map { "(\($0))" } ?? "")") }
        Task {
            try? await Task.sleep(for: .milliseconds(500))
            askScreen(id, start: start, tries: tries - 1)
        }
    }

    static func video(inPlayer url: URL) -> (id: String, start: Int)? {
        guard url.host?.hasSuffix("youtube-nocookie.com") == true, url.path.hasPrefix("/embed/") else { return nil }
        let id = String(url.path.dropFirst("/embed/".count).prefix(11))
        let start = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "start" }?.value.flatMap { Int($0) } ?? 0
        return id.count == 11 ? (id, start) : nil
    }

    // The lounge: a token for the TV's screen, a session as a remote control, then the video. No cookies go along.
    private static let lounge = URLSession(configuration: .ephemeral)
    private static func post(_ path: String, query: [String: String] = [:], form: [String: String], token: String? = nil) async throws -> String {
        var parts = URLComponents(string: "https://www.youtube.com/api/lounge/" + path)!
        if !query.isEmpty { parts.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var request = URLRequest(url: parts.url!)
        request.httpMethod = "POST"
        request.setValue("https://www.youtube.com", forHTTPHeaderField: "Origin")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue(token, forHTTPHeaderField: "X-YouTube-LoungeId-Token") }
        var body = URLComponents()
        body.queryItems = form.map { URLQueryItem(name: $0.key, value: $0.value) }
        request.httpBody = (body.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)
        let (data, response) = try await lounge.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return String(decoding: data, as: UTF8.self)
    }
    static func play(_ id: String, start: Int, onScreen screen: String) async throws {
        let tokens = try await post("pairing/get_lounge_token_batch", form: ["screen_ids": screen])
        guard let json = try JSONSerialization.jsonObject(with: Data(tokens.utf8)) as? [String: Any],
              let token = (json["screens"] as? [[String: Any]])?.first?["loungeToken"] as? String else { throw URLError(.cannotParseResponse) }
        // A new remote-control id each time, so the TV can't tell one cast from the next
        let me = String((0..<26).map { _ in "abcdefghijklmnopqrstuvwxyz".randomElement()! })
        let bound = try await post("bc/bind", query: ["RID": "0", "VER": "8", "CVER": "1"], form: [
            "device": "REMOTE_CONTROL", "id": me, "name": "Fjord", "mdx-version": "3", "pairing_type": "cast",
            "app": "android-phone-13.14.55"], token: token)
        guard let sid = bound.firstMatch(of: #/"c","(.*?)",/#)?.1, let gsession = bound.firstMatch(of: #/"S","(.*?)"]/#)?.1 else {
            throw URLError(.cannotParseResponse)
        }
        _ = try await post("bc/bind", query: ["SID": String(sid), "gsessionid": String(gsession), "RID": "1", "VER": "8", "CVER": "1"], form: [
            "req0__sc": "setPlaylist", "req0_listId": "", "req0_currentTime": String(start), "req0_currentIndex": "-1",
            "req0_audioOnly": "false", "req0_videoId": id, "count": "1"], token: token)
    }
}

extension Cast: GCKSessionManagerListener, GCKGenericChannelDelegate {
    // The channel to YouTube on the TV goes in before the session starts, as the Cast kit asks
    nonisolated func sessionManager(_ sessionManager: GCKSessionManager, willStart session: GCKCastSession) {
        MainActor.assumeIsolated {
            let channel = GCKGenericChannel(namespace: namespace)
            channel.delegate = self
            _ = session.add(channel)
            self.channel = channel
        }
    }
    nonisolated func sessionManager(_ sessionManager: GCKSessionManager, didStart session: GCKCastSession) {
        MainActor.assumeIsolated { castCurrent() }
    }
    nonisolated func sessionManager(_ sessionManager: GCKSessionManager, didEnd session: GCKCastSession, withError error: Error?) {
        MainActor.assumeIsolated { channel = nil; pending = nil }
    }

    nonisolated func cast(_ channel: GCKGenericChannel, didReceiveTextMessage message: String, withNamespace protocolNamespace: String) {
        MainActor.assumeIsolated {
            guard let json = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any],
                  json["type"] as? String == "mdxSessionStatus",
                  let screen = (json["data"] as? [String: Any])?["screenId"] as? String, let video = pending else { return }
            pending = nil
            Task {
                do { try await Self.play(video.id, start: video.start, onScreen: screen) }
                catch { print("Fjord cast: YouTube's lounge didn't take the video: \(error)") }
            }
        }
    }
}

// Google's cast button: shows the Chromecasts it finds, and the one you're casting to
struct CastButton: UIViewRepresentable {
    let tab: Tab
    func makeUIView(context: Context) -> GCKUICastButton {
        let button = GCKUICastButton(frame: CGRect(x: 0, y: 0, width: 28, height: 28))
        button.tintColor = .label
        return button
    }
    func updateUIView(_ view: GCKUICastButton, context: Context) {
        Cast.shared.tab = tab
        Cast.shared.startLooking()
    }
}
