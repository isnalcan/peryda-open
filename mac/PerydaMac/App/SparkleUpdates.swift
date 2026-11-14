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
    /// and any build made without the update key or with a feed that is neither HTTPS nor this Mac's own
    /// 127.0.0.1 (the update rehearsal, scripts/update-rehearsal.sh; the feed and the update are signed
    /// either way, and release.sh ships only the GitHub feed).
    static func start(into updates: Updates) -> SparkleUpdates? {
        #if DEBUG
        return nil
        #else
        let info = Bundle.main.infoDictionary ?? [:]
        guard let key = info["SUPublicEDKey"] as? String, !key.isEmpty,
              let feed = info["SUFeedURL"] as? String, feed.hasPrefix("https://") || feed.hasPrefix("http://127.0.0.1:")
        else { return nil }
        return SparkleUpdates(updates)
        #endif
    }

    private init(_ updates: Updates) {
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        let updater = controller.updater
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
