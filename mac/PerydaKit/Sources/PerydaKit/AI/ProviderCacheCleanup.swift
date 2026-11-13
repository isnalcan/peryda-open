import Foundation

/// Earlier builds sent provider requests through the shared URL session. Its disk cache kept
/// each request together with its key header (and batch results with translated pages), and its
/// cookie store kept the providers' cookies. Once, at the first launch of a fixed version, all of that
/// is deleted.
public enum ProviderCacheCleanup {
    public static let doneKey = "providerCacheCleared"

    /// Deletes the old cache and cookie files under `library` (the app's Library folder) the first time
    /// it is called; returns whether it ran.
    @discardableResult
    public static func runOnce(library: URL, bundleID: String, defaults: UserDefaults, urlCache: URLCache? = nil, cookies: HTTPCookieStorage? = nil) -> Bool {
        guard !defaults.bool(forKey: doneKey), !bundleID.isEmpty, !bundleID.contains("/"), !bundleID.hasPrefix(".") else { return false }
        let fm = FileManager.default
        let caches = library.appendingPathComponent("Caches", isDirectory: true).appendingPathComponent(bundleID, isDirectory: true)
        for name in ["Cache.db", "Cache.db-shm", "Cache.db-wal", "fsCachedData"] {
            try? fm.removeItem(at: caches.appendingPathComponent(name))
        }
        let storages = library.appendingPathComponent("HTTPStorages", isDirectory: true)
        try? fm.removeItem(at: storages.appendingPathComponent(bundleID, isDirectory: true))
        try? fm.removeItem(at: storages.appendingPathComponent("\(bundleID).binarycookies"))
        // The files are gone first, so the in-memory cache starts over empty rather than reopening them.
        urlCache?.removeAllCachedResponses()
        cookies?.removeCookies(since: .distantPast)
        defaults.set(true, forKey: doneKey)
        return true
    }
}
