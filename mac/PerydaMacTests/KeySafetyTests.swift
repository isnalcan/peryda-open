import AppKit
import PerydaKit
import SwiftUI
import XCTest

/// Owner, 16 Nov: "Is your key safe?" in Settings, in plain words.
@MainActor
final class KeySafetyTests: XCTestCase {
    static let outDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())

    func testTheNoteSaysWhereTheKeyIsAndItsLimit() throws {
        let t = UIText(.tr)
        for key in ["keySafetyTitle", "keySafetyWhereMac", "keySafetyGoes", "keySafetyYou", "keySafetyLimitMac"] {
            XCTAssertNotEqual(t[key], key, "\(key) is written in Turkish")
        }
        XCTAssertTrue(t["keySafetyWhereMac"].contains("Anahtar Zinciri"))
        XCTAssertTrue(t["keySafetyLimitMac"].contains(t["rememberKeys"]), "it names the switch as Settings shows it")
        for lang in Lang.allCases {
            XCTAssertTrue(UIText(lang)["keySafetyLimitMac"].contains(UIText(lang)["rememberKeys"]), "\(lang)")
        }
        let host = NSHostingView(rootView: Form { KeySafety(t: t, open: true) }.formStyle(.grouped).frame(width: 520, height: 360))
        let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 520, height: 360), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        window.layoutIfNeeded()
        host.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent("peryda-mac-key-safety.png"))
    }

    /// Owner, 16 Nov: the (i) beside each key says how to get one and links to the provider's key page,
    /// the same four pages as the web and Windows apps.
    func testEachProviderSaysHowToGetAKey() async throws {
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let web = try String(contentsOf: repo.appendingPathComponent("web/src/settings/keyPages.ts"), encoding: .utf8)
        for provider in ProviderID.allCases {
            let page = ProviderSection.keyPage(provider)
            XCTAssertTrue(web.contains("\(provider.rawValue): { url: '\(page.url.absoluteString)', site: '\(page.site)' }"), "\(provider) matches the web")
            XCTAssertNotEqual(UIText(.tr)[ProviderSection.helpKey(provider)], ProviderSection.helpKey(provider))
        }
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-keyhelp-\(UUID().uuidString)"))
        let app = AppModel(store: store, settings: ByokSettings(), lang: .tr)
        var settings = ByokSettings()
        let binding = Binding(get: { settings }, set: { settings = $0 })
        let host = NSHostingView(rootView: Form { ProviderSection(provider: .openai, settings: binding, helpOpen: true) }.formStyle(.grouped).environment(app).frame(width: 520, height: 300))
        let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 520, height: 300), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        try await Task.sleep(for: .milliseconds(300))
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent("peryda-mac-key-help.png"))
    }
}

