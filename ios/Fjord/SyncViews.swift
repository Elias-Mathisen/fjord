// Sync with computer, in Settings: pairing by scanning the QR code in Fjord's settings on the computer (or pasting
// it, where there's no camera), and the paired computer with Sync now and Unpair. The syncing itself is Sync.swift.
import SwiftUI
import VisionKit

struct SyncSection: View {
    @ObservedObject private var sync = Sync.shared
    @State private var pairing = false
    @State private var confirmUnpair = false

    var body: some View {
        Section {
            if let c = sync.computer {
                LabeledContent(c.name, value: status(c))
                Button("Sync now") { sync.syncNow() }.disabled(sync.status == .syncing)
                Button("Unpair", role: .destructive) { confirmUnpair = true }
            } else {
                Button("Pair with a computer") { pairing = true }
            }
        } header: { Text("Sync with computer") } footer: {
            Text("Open tabs, history, bookmarks and hidden page parts, shared with Fjord on your computer straight over your Wi-Fi. No account, and nothing goes through the internet. History isn't shared while it's off or with Forget everything on.")
        }
        .sheet(isPresented: $pairing) { PairView().font(.fjord(.body)) }
        .confirmationDialog("Unpair from \(sync.computer?.name ?? "your computer")?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) { sync.unpair() }
        } message: { Text("What's already been synced stays. To sync again, pair again from the computer.") }
    }

    private func status(_ c: Sync.Computer) -> String {
        switch sync.status {
        case .syncing: return "Syncing…"
        case .failed(let why) where why.contains("find"): return "Not found"
        case .failed: return "Didn't sync"
        case .idle: return c.lastSync.map { "Synced \($0.formatted(.relative(presentation: .named)))" } ?? "Not synced yet"
        }
    }
}

struct PairView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var working = false
    @State private var problem: String?
    private var canScan: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                Text("On your computer, open Fjord's settings, choose Sync with iPhone, then Pair an iPhone. Keep both on the same Wi-Fi.")
                    .foregroundStyle(.secondary)
                if canScan {
                    QRScanner { found in if !working { pair(found) } }
                        .aspectRatio(1, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                        .overlay {
                            if working { ProgressView().controlSize(.large).padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18)) }
                        }
                } else {
                    // No camera (or the simulator): the code can be pasted instead
                    TextField("Pairing code", text: $code, axis: .vertical)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(14).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                    Button { pair(code) } label: { Text("Pair").frame(maxWidth: .infinity) }
                        .buttonStyle(SetupButton(light: false)).disabled(code.isEmpty || working)
                }
                if let problem { Text(problem).foregroundStyle(.red).font(.fjord(.subheadline)) }
                Spacer()
            }
            .padding(24)
            .navigationTitle("Pair with a computer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func pair(_ text: String) {
        working = true
        problem = nil
        Task {
            do {
                try await Sync.shared.pair(text)
                dismiss()
            } catch {
                problem = error.localizedDescription
            }
            working = false
        }
    }
}

// The camera, reading QR codes; reports each Fjord pairing code it sees
struct QRScanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
                                                isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }
    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(found) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        init(_ found: @escaping (String) -> Void) { self.found = found }
        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let code) in items {
                if let text = code.payloadStringValue, text.hasPrefix("fjord-sync:") { found(text) }
            }
        }
    }
}
