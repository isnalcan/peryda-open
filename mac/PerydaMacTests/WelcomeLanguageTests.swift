import AppKit
import PerydaKit
import SwiftUI
import XCTest

/// Owner, 16 Nov: the first run asks for the language first, and the app goes on in the one chosen.
@MainActor
final class WelcomeLanguageTests: XCTestCase {
    static let outDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())
    var window: NSWindow?

    override func tearDown() async throws {
        window?.orderOut(nil)
        UserDefaults.standard.removeObject(forKey: "lang")
    }

    func testTheMacsLanguageIsOfferedFirst() {
        XCTAssertEqual(WelcomeView.languages(first: .de), [.de, .tr, .en, .es])
        XCTAssertEqual(WelcomeView.languages(first: .tr), [.tr, .en, .de, .es])
    }

    func testChoosingALanguageGoesOnInIt() async throws {
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-welcome-\(UUID().uuidString)"))
        let app = AppModel(store: store, settings: ByokSettings(), lang: .en)
        let host = NSHostingView(rootView: WelcomeView(onAddKey: {}, onLater: {}).environment(app).background(Color.paper))
        let w = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 460, height: 520), styleMask: [.borderless], backing: .buffered, defer: false)
        w.contentView = host
        w.orderFrontRegardless()
        window = w
        try await Task.sleep(for: .milliseconds(300))
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent("peryda-mac-welcome-language.png"))
        // The language rows are SwiftUI buttons drawn by AppKit, top to bottom in the order offered.
        func buttons(_ v: NSView) -> [NSView] {
            (String(describing: type(of: v)).contains("Button") ? [v] : []) + v.subviews.flatMap(buttons)
        }
        let rows = buttons(host).filter { $0.frame.height >= 38 }.sorted { $0.convert($0.bounds, to: nil).maxY > $1.convert($1.bounds, to: nil).maxY }
        XCTAssertGreaterThanOrEqual(rows.count, 4, "four languages")
        let index = try XCTUnwrap(WelcomeView.languages(first: Lang.preferred()).firstIndex(of: .de))
        let row = rows[index]
        let p = row.convert(CGPoint(x: row.bounds.midX, y: row.bounds.midY), to: nil)
        func ev(_ type: NSEvent.EventType) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        CardButtonTests.deliverQueuedMouseEvents(to: nil)
        NSApp.postEvent(ev(.leftMouseUp), atStart: false)
        w.sendEvent(ev(.leftMouseDown))
        CardButtonTests.deliverQueuedMouseEvents(to: w)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(app.lang, .de, "the app goes on in German")
        XCTAssertEqual(UserDefaults.standard.string(forKey: "lang"), "de", "and remembers it")
        let after = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: after)
        try after.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent("peryda-mac-welcome-de.png"))
    }
}
