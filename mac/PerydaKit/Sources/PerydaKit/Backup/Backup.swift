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

    public enum Failure: Error, Equatable {
        case notABackup, newerVersion
        /// The library's threads and journal are larger than a backup may hold (`Limits.manifest`):
        /// such a file would be refused when restored, so it is not written (audit MA-2).
        case tooLarge
    }

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

    /// Writes the backup ZIP to `url`. A scanned page's picture is left out of its translation (it is
    /// drawn again from the book, which the backup carries), so pictures do not push a library past
    /// what a restore accepts; a library that is still too large is refused here, not at restore
    /// (audit MA-2). The file is made aside and put in place when complete, so a failed export
    /// does not cost the reader their previous backup (audit MA-14).
    public static func export(store: LibraryStore, to url: URL, now: Date = Date(), limits: Limits = .standard) throws {
        let books = store.books()
        let cards = books.flatMap { store.cards(for: $0.id) }.map { card -> YarnCard in
            guard card.translatedPage != nil, card.anchors.first?.sourceType == .pdfArea else { return card }
            var c = card
            for i in c.anchors.indices { c.anchors[i].croppedImage = nil }
            return c
        }
        let journal = books.flatMap { store.journal(for: $0.id) }
        // A book with more threads, entries or finished readings than a restore takes, or a library
        // with more threads in all, is refused here, so export and restore always agree and nothing is
        // dropped silently (audit recheck MR-4, final F-11).
        var cardsPerBook: [String: Int] = [:]
        for card in cards { cardsPerBook[card.bookId, default: 0] += 1 }
        var journalPerBook: [String: Int] = [:]
        for record in journal { journalPerBook[record.bookId, default: 0] += 1 }
        if cards.count > maxTotalCards || cardsPerBook.values.contains(where: { $0 > maxCards }) || journalPerBook.values.contains(where: { $0 > maxJournal }) {
            throw Failure.tooLarge
        }
        for book in books where store.readings(for: book.id).filter({ $0.state == .done && !$0.text.isEmpty }).count > maxReadings {
            throw Failure.tooLarge
        }
        let manifest = Manifest(
            format: format,
            version: version,
            createdAt: now.timeIntervalSince1970 * 1000,
            books: books,
            cards: cards,
            journal: journal,
            positions: books.compactMap { store.position(for: $0.id) },
            prefs: books.compactMap { readingsPref(store.readings(for: $0.id), bookId: $0.id) } + books.compactMap { pageScalePref(bookId: $0.id) }
        )
        let json = try JSONEncoder().encode(manifest)
        guard UInt64(json.count) <= limits.manifest else { throw Failure.tooLarge }
        let fm = FileManager.default
        let temp = fm.temporaryDirectory.appendingPathComponent("peryda-export-\(UUID().uuidString).zip")
        defer { try? fm.removeItem(at: temp) }
        do {
            let archive = try Archive(url: temp, accessMode: .create)
            try archive.addEntry(with: "peryda.json", type: .file, uncompressedSize: Int64(json.count), compressionMethod: .deflate) { position, size in
                json.subdata(in: Int(position)..<Int(position) + size)
            }
            for book in books {
                guard let file = try? store.fileURL(for: book), fm.fileExists(atPath: file.path) else { continue }
                try archive.addEntry(with: "books/\(book.id).\(book.format.rawValue)", fileURL: file, compressionMethod: .none)
            }
        }
        if fm.fileExists(atPath: url.path) {
            do {
                _ = try fm.replaceItemAt(url, withItemAt: temp)
                return
            } catch {
                try fm.removeItem(at: url)
            }
        }
        try fm.copyItem(at: temp, to: url)
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
        // A crafted file of a few megabytes could declare thousands of books and unpack far more than
        // any library (audit 16 Nov, K16-2): the number of books and the bytes unpacked are capped.
        guard manifest.books.count <= Self.maxBooks else { throw Failure.tooLarge }
        let checked = sane(manifest)
        // Each book's records, found once rather than by scanning everything for every book.
        let cardsByBook = Dictionary(grouping: checked.cards, by: \.bookId)
        let journalByBook = Dictionary(grouping: checked.journal, by: \.bookId)

        let existing = store.books()
        var restored = 0
        var unpackedTotal: UInt64 = 0
        for declared in manifest.books {
            if existing.contains(where: { $0.id == declared.id || $0.fingerprint == declared.fingerprint }) { continue }
            guard let fileEntry = archive["books/\(declared.id).\(declared.format.rawValue)"], fileEntry.type == .file,
                  fileEntry.uncompressedSize <= limits.book
            else { continue }
            let temp = FileManager.default.temporaryDirectory.appendingPathComponent("peryda-restore-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: temp) }
            guard unpackedTotal + fileEntry.uncompressedSize <= Self.maxTotalBytes else { throw Failure.tooLarge }
            guard let unpacked = try? unpack(fileEntry, from: archive, to: temp, limit: limits.book), looksLike(declared.format, temp) else { continue }
            unpackedTotal += UInt64(unpacked.size)
            var book = declared
            book.fingerprint = unpacked.fingerprint
            book.size = unpacked.size
            book.pageCount = min(max(book.pageCount, 0), 100_000)
            book.addedAt = finite(book.addedAt, 1e15)
            book.openedAt = finite(book.openedAt, 1e15)
            // Threads, journal, readings and position go down before the book's own record (audit
            // recheck MR-6); a book deleted earlier in this run saves normally again (MR-1).
            let data = LibraryStore.RestoredData(
                cards: (cardsByBook[book.id] ?? []).map(clamped),
                journal: (journalByBook[book.id] ?? []).map { clamped($0, pageCount: book.pageCount) },
                position: checked.positions.first(where: { $0.bookId == book.id }).map(clamped),
                readings: readings(from: manifest.prefs, bookId: book.id)
            )
            guard try store.restoreBook(book, movingFile: temp, with: data) else { continue }
            // The book's page size comes back with it: the threads the reader placed were saved where
            // they sit beside pages of that size.
            if let scale = pageScale(from: manifest.prefs, bookId: book.id), let key = SafeID.defaultsKey("pageScale", book.id) {
                UserDefaults.standard.set(scale, forKey: key)
            }
            restored += 1
        }
        return restored
    }

    /// The most threads, journal entries and characters a restore takes, per book: far above real
    /// libraries, a stop for a crafted file that would make a book slow or stuck to open (audit MA-11;
    /// per book since the recheck, MR-4). Export refuses a book above them.
    static let maxCards = 20_000
    static let maxJournal = 50_000
    /// Highlights per book: each draws on its pages every time they are drawn (audit 16 Nov, M16-3).
    static let maxHighlights = 5_000
    /// Books in one backup, and the bytes of book files it may unpack in all (audit 16 Nov, K16-2; the
    /// web keeps 5,000 books and 2 GB, held in memory there).
    static let maxBooks = 5_000
    static let maxTotalBytes: UInt64 = 50_000_000_000
    /// Threads in the whole library: with the checks below linear, a stop for a crafted file that
    /// would otherwise keep Restore busy (audit final F-5).
    static let maxTotalCards = 400_000
    static let maxText = 2_000_000
    static let maxQuote = 200_000
    /// The longest chain of threads opened inside threads (a link deeper than this is cut).
    static let maxDepth = 200
    /// Pages Pery read, per book, and the longest text kept for one (as the web engine).
    static let maxReadings = 2_000
    static let maxReadingText = 1_000_000

    /// A book's page size (`pageScale:<bookId>`, a multiple of the standard width) as a backup row, when
    /// the reader changed it (as the web engine keeps it).
    static func pageScalePref(bookId: String, defaults: UserDefaults = .standard) -> Pref? {
        guard let key = SafeID.defaultsKey("pageScale", bookId) else { return nil }
        let scale = defaults.double(forKey: key)
        guard scale > 0, abs(scale - 1) > 0.0001 else { return nil }
        return Pref(key: "pageScale:\(bookId)", value: AnyCodable(Geometry.clampPageScale(scale)))
    }

    /// The page size a backup brings for a book, within the allowed range; nil when none or not a number.
    static func pageScale(from prefs: [Pref], bookId: String) -> Double? {
        guard let row = prefs.first(where: { $0.key == "pageScale:\(bookId)" }), let v = row.value.value as? Double, v.isFinite, v > 0 else { return nil }
        return Geometry.clampPageScale(v)
    }

    /// A book's finished page readings as a backup preference row (`readings:<bookId>`), in the web
    /// engine's shape: page, text, state "done", createdAt; never a job name (audit WR-1).
    static func readingsPref(_ readings: [PageReading], bookId: String) -> Pref? {
        let done = readings.filter { $0.state == .done && !$0.text.isEmpty }.sorted { $0.page < $1.page }.prefix(maxReadings)
        guard !done.isEmpty else { return nil }
        let rows: [Any?] = done.map { r -> Any? in
            ["page": Double(r.page), "text": String(r.text.prefix(maxReadingText)), "state": "done", "createdAt": r.createdAt] as [String: Any?]
        }
        return Pref(key: "readings:\(bookId)", value: AnyCodable(rows))
    }

    /// The finished readings a backup brings for a book (from the Mac or the web), checked as the web
    /// engine checks them: whole pages 1…100,000, once each, text present, at most 2,000.
    static func readings(from prefs: [Pref], bookId: String) -> [PageReading] {
        guard let row = prefs.first(where: { $0.key == "readings:\(bookId)" }), let list = row.value.value as? [Any?] else { return [] }
        var pages = Set<Int>()
        var out: [PageReading] = []
        for item in list {
            guard out.count < maxReadings, let r = item as? [String: Any?],
                  let pageNumber = r["page"] as? Double, pageNumber.rounded() == pageNumber, pageNumber >= 1, pageNumber <= 100_000,
                  r["state"] as? String == "done",
                  let text = r["text"] as? String, !text.isEmpty
            else { continue }
            let page = Int(pageNumber)
            guard pages.insert(page).inserted else { continue }
            let createdAt = (r["createdAt"] as? Double).map { finite($0, 1e15) } ?? 0
            out.append(PageReading(page: page, text: String(text.prefix(maxReadingText)), state: .done, createdAt: createdAt))
        }
        return out
    }

    /// The manifest as restored: one record per id (the first), no thread that is its own parent or
    /// part of a loop of parents, counts and texts within the limits above.
    static func sane(_ m: Manifest) -> Manifest {
        var out = m
        var seen = Set<String>()
        var perBook: [String: Int] = [:]
        var total = 0
        var cards = m.cards.filter { seen.insert($0.id).inserted }.filter { card in
            perBook[card.bookId, default: 0] += 1
            guard perBook[card.bookId]! <= maxCards, total < maxTotalCards else { return false }
            total += 1
            return true
        }.map { card -> YarnCard in
            var c = card
            if c.parentCardId == c.id { c.parentCardId = nil }
            c.messages = c.messages.map { msg in
                var m = msg
                if m.content.count > maxText { m.content = String(m.content.prefix(maxText)) }
                return m
            }
            c.anchors = c.anchors.map { a in
                var a = a
                if a.selectedText.count > maxQuote { a.selectedText = String(a.selectedText.prefix(maxQuote)) }
                if let ctx = a.context, ctx.count > maxQuote { a.context = String(ctx.prefix(maxQuote)) }
                if a.sourceCardId == c.id { a.sourceCardId = nil }
                return a
            }
            return c
        }
        // Parents that loop back to a thread lose the link that closes the loop. Each thread has one
        // parent, so one walk per thread that stops at any thread already walked finds every loop in
        // linear time (audit final F-5: walking each thread's whole chain was quadratic).
        let index = Dictionary(uniqueKeysWithValues: cards.enumerated().map { ($1.id, $0) })
        var state = [UInt8](repeating: 0, count: cards.count) // 0 not seen, 1 on this walk, 2 done
        for start in cards.indices where state[start] == 0 {
            var walk: [Int] = []
            var current: Int? = start
            while let i = current, state[i] == 0 {
                state[i] = 1
                walk.append(i)
                current = cards[i].parentCardId.flatMap { index[$0] }
            }
            // The walk came back to a thread on itself: the last step closed a loop.
            if let i = current, state[i] == 1, let last = walk.last { cards[last].parentCardId = nil }
            for i in walk { state[i] = 2 }
        }
        // Chains of threads opened inside threads are cut past `maxDepth` (audit recheck MA-11): a
        // book with a chain thousands deep would be very slow to open, or overflow the stack.
        var depth: [String: Int] = [:]
        for start in cards.indices {
            var chain: [Int] = []
            var current: Int? = start
            while let i = current, depth[cards[i].id] == nil {
                chain.append(i)
                current = cards[i].parentCardId.flatMap { index[$0] }
                if chain.count > cards.count { break }
            }
            var below = current.flatMap { depth[cards[$0].id] } ?? 0
            for i in chain.reversed() {
                if below + 1 > maxDepth {
                    cards[i].parentCardId = nil
                    below = 0
                }
                below += 1
                depth[cards[i].id] = below
            }
        }
        out.cards = cards
        var seenJournal = Set<String>()
        var journalPerBook: [String: Int] = [:]
        var highlightsPerBook: [String: Int] = [:]
        out.journal = m.journal.filter { seenJournal.insert($0.id).inserted }.filter { record in
            journalPerBook[record.bookId, default: 0] += 1
            if record.source == .highlight {
                highlightsPerBook[record.bookId, default: 0] += 1
                if highlightsPerBook[record.bookId]! > maxHighlights { return false }
            }
            return journalPerBook[record.bookId]! <= maxJournal
        }.map { record in
            var r = record
            if r.text.count > maxText { r.text = String(r.text.prefix(maxText)) }
            if r.quote.count > maxQuote { r.quote = String(r.quote.prefix(maxQuote)) }
            return r
        }
        return out
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
            guard head.starts(with: [0x50, 0x4B, 0x03, 0x04]), let archive = try? Archive(url: file, accessMode: .read, pathEncoding: nil),
                  !EPUBBook.hasDuplicatePaths(archive) else { return false }
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

    /// Highlights on one entry, and line rectangles in one of them, a restore keeps at most.
    static let maxMarks = 50
    static let maxMarkRects = 200

    /// A journal entry as restored. A highlight's marks are kept only where they make sense (a page of
    /// the book, rectangles inside the page, within the counts above); other entries carry none.
    /// Same rules as the web's backupValidate.
    static func clamped(_ record: JournalRecord, pageCount: Int = 100_000) -> JournalRecord {
        var r = record
        r.pageNumber = min(max(r.pageNumber, 0), 100_000)
        r.createdAt = finite(r.createdAt, 1e15)
        r.highlightColor = r.source == .highlight ? HighlightColor.stored(r.highlightColor) : nil
        guard r.source == .highlight, let marks = r.marks else {
            r.marks = nil
            return r
        }
        let pages = pageCount > 0 ? pageCount : 100_000
        let kept = marks.prefix(maxMarks).compactMap { mark -> JournalMark? in
            guard mark.pageNumber >= 1, mark.pageNumber <= pages else { return nil }
            let rects = mark.lineRects.prefix(maxMarkRects).filter(insidePage)
            return rects.isEmpty ? nil : JournalMark(pageNumber: mark.pageNumber, lineRects: Array(rects))
        }
        r.marks = kept.isEmpty ? nil : Array(kept)
        return r
    }

    /// A rectangle with finite values that lies on the page (0…1, with a hair of tolerance).
    static func insidePage(_ rect: NormalizedRect) -> Bool {
        let values = [rect.x, rect.y, rect.width, rect.height]
        guard values.allSatisfy(\.isFinite) else { return false }
        return rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= 1.001 && rect.y + rect.height <= 1.001
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

    init(_ value: Any?) { self.value = value }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case let b as Bool: try c.encode(b)
        case let d as Double: try c.encode(d)
        case let s as String: try c.encode(s)
        case let a as [Any?]: try c.encode(a.map(AnyCodable.init))
        case let o as [String: Any?]: try c.encode(o.mapValues(AnyCodable.init))
        default: try c.encodeNil()
        }
    }
}
