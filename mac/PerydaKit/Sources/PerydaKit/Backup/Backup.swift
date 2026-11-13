import CryptoKit
import Foundation
import ZIPFoundation

/// One-file backup of the library, in the same format as the web engine (web/src/data/backup.ts):
/// a ZIP with `peryda.json` (books, threads, journal, positions, preferences) and `books/<id>.<ext>`.
/// AI keys live in the Keychain and are never part of it, so a backup made on the Mac opens in the
/// browser and the other way round.
public enum Backup {
    public static let format = "peryda-backup"
    public static let version = 1

    struct Manifest: Codable {
        var format: String
        var version: Int
        var createdAt: Double
        var books: [BookRecord]
        var cards: [YarnCard]
        var journal: [JournalRecord]
        var positions: [ReadingPosition]
        var prefs: [Pref]
    }

    struct Pref: Codable {
        var key: String
        var value: AnyCodable
    }

    public enum Failure: Error, Equatable { case notABackup, newerVersion }

    /// How much a backup may unpack: generous for real libraries, a stop for a crafted file.
    public struct Limits: Sendable {
        public var manifest: UInt64
        public var book: UInt64

        public init(manifest: UInt64 = 200 * 1024 * 1024, book: UInt64 = 2 * 1024 * 1024 * 1024) {
            self.manifest = manifest
            self.book = book
        }

        public static let standard = Limits()
    }

    struct TooLarge: Error {}

    /// Writes the backup ZIP to `url`.
    public static func export(store: LibraryStore, to url: URL, now: Date = Date()) throws {
        let books = store.books()
        let manifest = Manifest(
            format: format,
            version: version,
            createdAt: now.timeIntervalSince1970 * 1000,
            books: books,
            cards: books.flatMap { store.cards(for: $0.id) },
            journal: books.flatMap { store.journal(for: $0.id) },
            positions: books.compactMap { store.position(for: $0.id) },
            prefs: []
        )
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        let archive = try Archive(url: url, accessMode: .create)
        let json = try JSONEncoder().encode(manifest)
        try archive.addEntry(with: "peryda.json", type: .file, uncompressedSize: Int64(json.count), compressionMethod: .deflate) { position, size in
            json.subdata(in: Int(position)..<Int(position) + size)
        }
        for book in books {
            guard let file = try? store.fileURL(for: book), FileManager.default.fileExists(atPath: file.path) else { continue }
            try archive.addEntry(with: "books/\(book.id).\(book.format.rawValue)", fileURL: file, compressionMethod: .none)
        }
    }

    /// Restores what is missing; books already in the library (same id or same file) keep their own data.
    /// The file is not trusted: a backup with an id that is not a plain id is refused as a whole, each
    /// book's fingerprint and size are worked out from its bytes, a book that is not what it says is
    /// left out, and numbers are kept within sane bounds.
    @discardableResult
    public static func restore(store: LibraryStore, from url: URL, limits: Limits = .standard) throws -> Int {
        let archive: Archive
        do {
            archive = try Archive(url: url, accessMode: .read)
        } catch {
            throw Failure.notABackup
        }
        guard let entry = archive["peryda.json"], entry.type == .file, entry.uncompressedSize <= limits.manifest else { throw Failure.notABackup }
        var json = Data()
        do {
            // The declared size can lie, so the bytes are counted as they come.
            _ = try archive.extract(entry) { chunk in
                json.append(chunk)
                if UInt64(json.count) > limits.manifest { throw TooLarge() }
            }
        } catch {
            throw Failure.notABackup
        }
        let manifest: Manifest
        do {
            manifest = try JSONDecoder().decode(Manifest.self, from: json)
        } catch {
            throw Failure.notABackup
        }
        guard manifest.format == format else { throw Failure.notABackup }
        guard manifest.version <= version else { throw Failure.newerVersion }
        guard idsAreSafe(manifest) else { throw Failure.notABackup }

        let existing = store.books()
        var restored = 0
        for declared in manifest.books {
            if existing.contains(where: { $0.id == declared.id || $0.fingerprint == declared.fingerprint }) { continue }
            guard let fileEntry = archive["books/\(declared.id).\(declared.format.rawValue)"], fileEntry.type == .file,
                  fileEntry.uncompressedSize <= limits.book
            else { continue }
            let temp = FileManager.default.temporaryDirectory.appendingPathComponent("peryda-restore-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: temp) }
            guard let unpacked = try? unpack(fileEntry, from: archive, to: temp, limit: limits.book), looksLike(declared.format, temp) else { continue }
            var book = declared
            book.fingerprint = unpacked.fingerprint
            book.size = unpacked.size
            book.pageCount = min(max(book.pageCount, 0), 100_000)
            book.addedAt = finite(book.addedAt, 1e15)
            book.openedAt = finite(book.openedAt, 1e15)
            guard try store.restoreBook(book, movingFile: temp) else { continue }
            let cards = manifest.cards.filter { $0.bookId == book.id }.map(clamped)
            if !cards.isEmpty { try store.saveCards(cards, for: book.id) }
            for record in manifest.journal where record.bookId == book.id { try store.addJournal(clamped(record)) }
            if let position = manifest.positions.first(where: { $0.bookId == book.id }) { store.savePosition(clamped(position)) }
            restored += 1
        }
        return restored
    }

    /// Every id that ends up in a file name, a folder or a preferences key must be a plain id.
    static func idsAreSafe(_ m: Manifest) -> Bool {
        m.books.allSatisfy { SafeID.isValid($0.id) }
            && m.cards.allSatisfy { SafeID.isValid($0.id) && SafeID.isValid($0.bookId) }
            && m.journal.allSatisfy { SafeID.isValid($0.id) && SafeID.isValid($0.bookId) }
            && m.positions.allSatisfy { SafeID.isValid($0.bookId) }
    }

    /// Streams a book out of the backup into `file`, hashing and counting as it goes.
    static func unpack(_ entry: Entry, from archive: Archive, to file: URL, limit: UInt64) throws -> (fingerprint: String, size: Int) {
        guard FileManager.default.createFile(atPath: file.path, contents: nil) else { throw Failure.notABackup }
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        var size: UInt64 = 0
        _ = try archive.extract(entry) { chunk in
            size += UInt64(chunk.count)
            guard size <= limit else { throw TooLarge() }
            hasher.update(data: chunk)
            try handle.write(contentsOf: chunk)
        }
        return (hasher.finalize().map { String(format: "%02x", $0) }.joined(), Int(size))
    }

    /// A PDF starts with `%PDF` (within its first kilobyte); an EPUB is a ZIP whose `mimetype` says
    /// `application/epub+zip` (or, for a book without one, that has an EPUB container).
    static func looksLike(_ format: BookRecord.Format, _ file: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return false }
        let head = (try? handle.read(upToCount: 1024)) ?? Data()
        try? handle.close()
        switch format {
        case .pdf:
            return head.range(of: Data("%PDF".utf8)) != nil
        case .epub:
            guard head.starts(with: [0x50, 0x4B, 0x03, 0x04]), let archive = try? Archive(url: file, accessMode: .read, pathEncoding: nil) else { return false }
            guard let mimetype = archive["mimetype"] else { return archive["META-INF/container.xml"] != nil }
            guard mimetype.uncompressedSize <= 64 else { return false }
            var data = Data()
            guard (try? archive.extract(mimetype, consumer: { chunk in
                data.append(chunk)
                if data.count > 64 { throw TooLarge() }
            })) != nil else { return false }
            return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) == "application/epub+zip"
        }
    }

    static func finite(_ value: Double, _ limit: Double = 1_000_000) -> Double {
        value.isFinite ? min(max(value, -limit), limit) : 0
    }

    static func clamped(_ rect: NormalizedRect) -> NormalizedRect {
        func unit(_ v: Double) -> Double { v.isFinite ? min(max(v, -1), 2) : 0 }
        return NormalizedRect(x: unit(rect.x), y: unit(rect.y), width: unit(rect.width), height: unit(rect.height))
    }

    /// A card as restored: on-screen sizes within the card limits (a page translation is as large as
    /// its page), positions finite, a batch job only with a name Google could have given.
    static func clamped(_ card: YarnCard) -> YarnCard {
        var c = card
        let translation = c.translatedPage != nil
        let widths: ClosedRange<Double> = translation ? 100...5_000 : CardsModel.widthRange
        let heights: ClosedRange<Double> = translation ? 100...50_000 : CardsModel.heightRange
        c.width = c.width.isFinite ? min(max(c.width, widths.lowerBound), widths.upperBound) : widths.lowerBound
        c.height = c.height.map { $0.isFinite ? min(max($0, heights.lowerBound), heights.upperBound) : heights.lowerBound }
        c.x = finite(c.x)
        c.y = finite(c.y)
        c.translatedPage = c.translatedPage.map { min(max($0, 1), 100_000) }
        if let job = c.batchJob, !GeminiBatch.isValidName(job) { c.batchJob = nil }
        c.anchors = c.anchors.map { a in
            var a = a
            a.pageNumber = min(max(a.pageNumber, 0), 100_000)
            a.boundingRect = clamped(a.boundingRect)
            a.lineRects = a.lineRects.map(clamped)
            return a
        }
        c.createdAt = finite(c.createdAt, 1e15)
        c.updatedAt = finite(c.updatedAt, 1e15)
        return c
    }

    static func clamped(_ record: JournalRecord) -> JournalRecord {
        var r = record
        r.pageNumber = min(max(r.pageNumber, 0), 100_000)
        r.createdAt = finite(r.createdAt, 1e15)
        return r
    }

    static func clamped(_ position: ReadingPosition) -> ReadingPosition {
        var p = position
        p.panX = finite(p.panX)
        p.panY = finite(p.panY)
        p.scale = p.scale.isFinite ? min(max(p.scale, 0.1), 8) : 1
        p.page = min(max(p.page, 0), 100_000)
        p.updatedAt = finite(p.updatedAt, 1e15)
        return p
    }

    public static func fileName(_ date: Date = Date()) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return "peryda-yedek-\(f.string(from: date)).zip"
    }
}

/// Holds any JSON value so preference rows written by the web engine survive a round trip.
struct AnyCodable: Codable {
    let value: Any?

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { value = nil }
        else if let b = try? c.decode(Bool.self) { value = b }
        else if let d = try? c.decode(Double.self) { value = d }
        else if let s = try? c.decode(String.self) { value = s }
        else if let a = try? c.decode([AnyCodable].self) { value = a.map(\.value) }
        else if let o = try? c.decode([String: AnyCodable].self) { value = o.mapValues(\.value) }
        else { value = nil }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case let b as Bool: try c.encode(b)
        case let d as Double: try c.encode(d)
        case let s as String: try c.encode(s)
        default: try c.encodeNil()
        }
    }
}
