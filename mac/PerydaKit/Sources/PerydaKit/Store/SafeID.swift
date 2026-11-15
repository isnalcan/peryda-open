import Foundation

/// The one shape an id may have before it becomes part of a file name, a cache folder or a
/// preferences key: what the web (`crypto.randomUUID()`) and the Mac (`UUID`) make, and the shared
/// fixture's `fixture-book`. Anything else (a backup saying `../library`) is refused.
public enum SafeID {
    public struct Invalid: Error, Equatable {}

    /// `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, checked byte by byte so no Unicode look-alike gets through.
    public static func isValid(_ id: String) -> Bool {
        let bytes = Array(id.utf8)
        guard (1...64).contains(bytes.count) else { return false }
        func alnum(_ b: UInt8) -> Bool { (48...57).contains(b) || (65...90).contains(b) || (97...122).contains(b) }
        return alnum(bytes[0]) && bytes.dropFirst().allSatisfy { alnum($0) || $0 == 95 || $0 == 45 }
    }

    /// `parent/<id><suffix>`: only for a valid id, and only when it really is a direct child of `parent`.
    public static func url(in parent: URL, id: String, suffix: String = "", isDirectory: Bool = false) throws -> URL {
        guard isValid(id), !suffix.contains("/") else { throw Invalid() }
        let url = parent.appendingPathComponent(id + suffix, isDirectory: isDirectory)
        guard isDirectChild(url, of: parent) else { throw Invalid() }
        return url
    }

    /// Whether `url`, once `.` and `..` are resolved, sits directly inside `parent`.
    public static func isDirectChild(_ url: URL, of parent: URL) -> Bool {
        let child = url.standardizedFileURL
        let base = parent.standardizedFileURL.path
        return !child.lastPathComponent.isEmpty && child.lastPathComponent != ".." && child.deletingLastPathComponent().path == base
    }

    /// A per-book preferences key (`translateLang:<id>`), or nil for an id that is not a plain id.
    public static func defaultsKey(_ prefix: String, _ id: String) -> String? {
        isValid(id) ? "\(prefix):\(id)" : nil
    }

    /// Every per-book preferences key the app writes; removed with the book.
    public static let perBookDefaults = ["translateLang", "journalSummary", "cardTextScale", "translationTextScale"]
}
