import Foundation
import Observation

/// The update check as Settings and the app menu see it. In the shipped app SparkleUpdates fills it in;
/// in tests and in builds without an update key it stays unavailable, and nothing is ever checked.
///
/// The reader decides: Sparkle asks before the first automatic check, and Settings can turn it on or off.
@MainActor
@Observable
final class Updates {
    /// False when this build cannot update itself (development builds, tests).
    var available = false
    /// Whether Peryda looks for a new version by itself, about once a day.
    var checksAutomatically = false
    /// False while a check is already running.
    var canCheckNow = false

    /// Set by the updater: turns automatic checks on or off.
    @ObservationIgnored var setAutomatic: (Bool) -> Void = { _ in }
    /// Set by the updater: looks for a new version now and shows the result.
    @ObservationIgnored var checkNow: () -> Void = {}

    /// The version shown in Settings, such as "0.1.0".
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
}
