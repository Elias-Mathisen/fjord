// Fjord Shields for Safari: two content blockers ("Fjord Ads" and "Fjord Trackers", one per list, since Safari takes
// at most 150,000 rules each) that hand Safari the same lists the Fjord app blocks with. Safari applies them itself:
// the blocker never sees which pages are open.
import Foundation

final class ContentBlocker: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        // io.github.eliasmathisen.fjord.ads -> ads.json
        let list = Bundle.main.bundleIdentifier?.components(separatedBy: ".").last ?? ""
        let item = NSExtensionItem()
        if let url = Bundle.main.url(forResource: list, withExtension: "json") {
            item.attachments = [NSItemProvider(contentsOf: url)].compactMap { $0 }
        }
        context.completeRequest(returningItems: [item])
    }
}
