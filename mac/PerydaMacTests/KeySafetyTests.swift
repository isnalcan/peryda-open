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
}
