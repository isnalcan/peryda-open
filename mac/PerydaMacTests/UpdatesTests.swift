import AppKit
import PerydaKit
import SwiftUI
import XCTest

/// The update check asks first, reaches only the signed feed of the latest release, and is shown in
/// Settings. Sparkle itself is not linked into the tests; its configuration is checked from the files
/// the app is built from.
@MainActor
final class UpdatesTests: XCTestCase {
    private var macFolder: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent() }

    private func plist(_ path: String) throws -> [String: Any] {
        let data = try Data(contentsOf: macFolder.appendingPathComponent(path))
        return try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    func testTheAppAsksBeforeTheFirstCheckAndAcceptsOnlySignedUpdates() throws {
        let info = try plist("PerydaMac/Info.plist")
        // No SUEnableAutomaticChecks: Sparkle asks the reader before checking at all.
        XCTAssertNil(info["SUEnableAutomaticChecks"])
        XCTAssertNil(info["SUEnableSystemProfiling"])
        XCTAssertNil(info["SUScheduledCheckInterval"])
        XCTAssertEqual(info["SUFeedURL"] as? String, "$(PERYDA_UPDATE_FEED_URL)")
        XCTAssertEqual(info["SUPublicEDKey"] as? String, "$(PERYDA_UPDATE_PUBLIC_KEY)")
        XCTAssertEqual(info["SURequireSignedFeed"] as? Bool, true)
        XCTAssertEqual(info["SUVerifyUpdateBeforeExtraction"] as? Bool, true)
        XCTAssertEqual(info["SUEnableInstallerLauncherService"] as? Bool, true)
    }

    /// The feed comes from one build setting, and every target sets it to the latest GitHub release.
    /// (Only the update rehearsal builds with another one, and release.sh refuses to ship that.)
    func testTheFeedIsTheLatestGitHubRelease() throws {
        let project = try String(contentsOf: macFolder.appendingPathComponent("PerydaMac.xcodeproj/project.pbxproj"), encoding: .utf8)
        let values = project.matches(of: /PERYDA_UPDATE_FEED_URL = "?([^";]+)"?;/).map { String($0.1) }
        XCTAssertFalse(values.isEmpty)
        XCTAssertEqual(Set(values), ["https://github.com/isnalcan/peryda-open/releases/latest/download/appcast.xml"])
    }

    func testTheSandboxOpensOnlySparklesInstallerServices() throws {
        let entitlements = try plist("PerydaMac/PerydaMac.entitlements")
        XCTAssertEqual(entitlements["com.apple.security.app-sandbox"] as? Bool, true)
        XCTAssertEqual(
            entitlements["com.apple.security.temporary-exception.mach-lookup.global-name"] as? [String],
            ["$(PRODUCT_BUNDLE_IDENTIFIER)-spks", "$(PRODUCT_BUNDLE_IDENTIFIER)-spki"]
        )
        let others = entitlements.keys.filter { $0.contains("temporary-exception") && !$0.hasSuffix("mach-lookup.global-name") }
        XCTAssertEqual(others, [])
    }

    func testWithoutTheUpdaterNothingIsOffered() throws {
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-updates-\(UUID().uuidString)"))
        XCTAssertFalse(AppModel(store: store, settings: ByokSettings(), lang: .tr).updates.available)
    }

    func testUpdateSettingsSnapshot() async throws {
        let t = UIText(.tr)
        let on = Updates()
        on.available = true
        on.checksAutomatically = true
        on.canCheckNow = true
        var turnedOff = false
        on.setAutomatic = { if !$0 { turnedOff = true } }
        let off = Updates()
        let view = Form {
            UpdateSettings(updates: on, t: t)
            UpdateSettings(updates: off, t: t)
        }
        .formStyle(.grouped)
        .frame(width: 600, height: 420)
        let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 600, height: 420), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: view)
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(500))
        window.displayIfNeeded()
        let content = try XCTUnwrap(window.contentView)
        let rep = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: rep)
        let out = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())
        try rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent("peryda-mac-updates.png"))
        XCTAssertFalse(turnedOff)
        XCTAssertTrue(t["updatesHint"].contains("GitHub"))
    }
}
