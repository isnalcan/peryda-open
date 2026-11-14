import Foundation
import PerydaUpdater

/// Connects Sparkle to `Updates`. Sparkle asks the reader before the first automatic check (no
/// SUEnableAutomaticChecks in Info.plist), sends no system profile, and installs only updates signed
/// with the key whose public half is SUPublicEDKey.
@MainActor
final class SparkleUpdates {
    private let controller: SPUStandardUpdaterController
    private var observations: [NSKeyValueObservation] = []

    /// Starts the updater, or returns nil for builds that must not update themselves: development builds,
    /// and any build made without the update key or with a feed that is not allowed (`feedAllowed`).
    static func start(into updates: Updates) -> SparkleUpdates? {
        #if DEBUG
        return nil
        #else
        let info = Bundle.main.infoDictionary ?? [:]
        guard let key = info["SUPublicEDKey"] as? String, !key.isEmpty,
              let feed = info["SUFeedURL"] as? String, feedAllowed(feed, rehearsal: info["PerydaUpdateRehearsal"] as? String == "YES")
        else { return nil }
        return SparkleUpdates(updates)
        #endif
    }

    /// HTTPS; or this Mac's own 127.0.0.1, only in an update-rehearsal build (scripts/update-rehearsal.sh
    /// sets PerydaUpdateRehearsal). A release build never accepts a plain-HTTP feed (audit MA-5).
    nonisolated static func feedAllowed(_ feed: String, rehearsal: Bool) -> Bool {
        feed.hasPrefix("https://") || (rehearsal && feed.hasPrefix("http://127.0.0.1:"))
    }

    private init(_ updates: Updates) {
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil)
        let updater = controller.updater
        // Sparkle lets a SUFeedURL in the app's preferences override Info.plist; anything that can write
        // those preferences could point the check elsewhere. Only the feed the app was built with is used.
        _ = updater.clearFeedURLFromUserDefaults()
        controller.startUpdater()
        updates.available = true
        updates.setAutomatic = { updater.automaticallyChecksForUpdates = $0 }
        updates.checkNow = { [controller] in controller.checkForUpdates(nil) }
        // Sparkle's own prompt and Settings both change these; Settings shows the current values. Sparkle
        // changes them on the main thread, where these observers then run.
        observations = [
            updater.observe(\.automaticallyChecksForUpdates, options: [.initial, .new]) { [weak updates] updater, _ in
                MainActor.assumeIsolated { updates?.checksAutomatically = updater.automaticallyChecksForUpdates }
            },
            updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak updates] updater, _ in
                MainActor.assumeIsolated { updates?.canCheckNow = updater.canCheckForUpdates }
            },
        ]
    }
}
