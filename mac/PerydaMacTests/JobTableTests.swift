import AppKit
import PerydaKit
import SwiftUI
import XCTest

/// Owner, 17 Nov 2026: Settings show which model and thinking level each job uses, the recommended
/// combination chosen by default, and an (i) with the estimated cost of one request.
@MainActor
final class JobTableTests: XCTestCase {
    static let outDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())

    func testTheWordsExistInEveryLanguage() {
        for lang in Lang.allCases {
            let t = UIText(lang)
            for key in ["jobsTitle", "comboNote", "comboNoteUntested", "jobThread", "jobArea", "jobTranslation", "jobScan", "jobSummary", "jobModel", "jobEffort",
                        "effort_low", "effort_medium", "effort_high", "effortProviderDefault", "resetRecommended", "usingRecommended",
                        "costInfo", "costUnit_question", "costUnit_page", "costUnit_summary", "costEstimate", "costBatch", "costUnknown"] {
                XCTAssertNotEqual(t[key], key, "\(key) in \(lang)")
            }
        }
    }

    func testTheCostNoteSaysItIsAnEstimate() {
        let t = UIText(.tr)
        var settings = ByokSettings()
        let binding = Binding(get: { settings }, set: { settings = $0 })
        let row = JobRow(provider: .gemini, task: .translation, settings: binding, loaded: [], t: t)
        let text = row.costText(model: settings.model(for: .gemini, task: .translation))
        XCTAssertTrue(text.contains("tahmin"), text)
        XCTAssertTrue(text.contains("sağlayıcının panelinde"), text)
        XCTAssertTrue(text.contains("0,011"), text)
        XCTAssertTrue(text.hasSuffix(t["costBatch"]), "Gemini page jobs mention the batch")
        let deepseek = JobRow(provider: .deepseek, task: .thread, settings: binding, loaded: [], t: t)
        XCTAssertEqual(deepseek.costText(model: "deepseek-v4-pro"), t["costUnknown"])
    }

    func testTheTableShowsTheRecommendedCombination() async throws {
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-jobs-\(UUID().uuidString)"))
        let app = AppModel(store: store, settings: ByokSettings(), lang: .tr)
        var settings = ByokSettings(geminiApiKey: "AIza-placeholder-not-a-key-0000")
        let binding = Binding(get: { settings }, set: { settings = $0 })
        let host = NSHostingView(rootView: Form { ProviderSection(provider: .gemini, settings: binding) }.formStyle(.grouped).environment(app).frame(width: 560, height: 520))
        let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 560, height: 520), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        try await Task.sleep(for: .milliseconds(300))
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent("peryda-mac-job-table.png"))
        XCTAssertTrue(settings.usesRecommended(.gemini))
        settings.useRecommended(for: .gemini)
        XCTAssertEqual(settings.model(for: .gemini, task: .thread), "gemini-4-hydrogen")
    }
}
