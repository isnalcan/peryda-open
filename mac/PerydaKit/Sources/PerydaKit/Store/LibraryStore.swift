import CryptoKit
import Foundation

/// A book in the library. Field names match the web engine so the backup format is shared.
public struct BookRecord: Codable, Hashable, Identifiable, Sendable {
    public enum Format: String, Codable, Sendable { case pdf, epub }

    public var id: String
    public var title: String
    public var author: String
    public var format: Format
    public var pageCount: Int
    public var size: Int
    public var fingerprint: String
    public var addedAt: Double
    public var openedAt: Double
}

public struct JournalRecord: Codable, Hashable, Identifiable, Sendable {
    public enum Source: String, Codable, Sendable { case clip, thread, note }

    public var id: String
    public var bookId: String
    public var source: Source
    public var quote: String
    public var text: String
    public var pageNumber: Int
    public var cardId: String?
    public var createdAt: Double

    public init(id: String = UUID().uuidString.lowercased(), bookId: String, source: Source, quote: String, text: String, pageNumber: Int, cardId: String? = nil, createdAt: Double = Date().timeIntervalSince1970 * 1000) {
        self.id = id
        self.bookId = bookId
        self.source = source
        self.quote = quote
        self.text = text
        self.pageNumber = pageNumber
        self.cardId = cardId
        self.createdAt = createdAt
    }
}

public struct ReadingPosition: Codable, Hashable, Sendable {
    public var bookId: String
    public var cfi: String?
    public var panX: Double
    public var panY: Double
    public var scale: Double
    public var page: Int
    public var updatedAt: Double

    public init(bookId: String, cfi: String? = nil, panX: Double, panY: Double, scale: Double, page: Int, updatedAt: Double) {
        self.bookId = bookId
        self.cfi = cfi
        self.panX = panX
        self.panY = panY
        self.scale = scale
        self.page = page
        self.updatedAt = updatedAt
    }
}

/// The library on disk, under Application Support/Peryda. Every write is atomic.
///
///     library.json              books
///     books/<id>.<pdf|epub>     the files themselves
///     cards/<bookId>.json       threads of a book
///     journal/<bookId>.json     Book Journal entries
///     positions.json            reading positions
public final class LibraryStore: @unchecked Sendable {
    public let root: URL
    private let fm = FileManager.default
    private let queue = DispatchQueue(label: "peryda.library-store")
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    public init(root: URL) throws {
        self.root = root
        for dir in ["", "books", "cards", "journal", "readings"] {
            try fm.createDirectory(at: root.appendingPathComponent(dir), withIntermediateDirectories: true)
        }
    }

    public static func defaultRoot() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return base.appendingPathComponent("Peryda", isDirectory: true)
    }

    /// Names of files that did not decode whole; each was copied aside (`<name>.unreadable-<hash>`)
    /// before anything could write over it. For the app to tell the reader once.
    private var unreadable: [String] = []
    /// Files that did not decode and could not be copied aside: never written over in this run, so
    /// nothing in them is lost (audit recheck MA-4).
    private var protected = Set<String>()

    public func unreadableFiles() -> [String] { queue.sync { unreadable } }

    /// A file a write refused because the original could not be kept aside first.
    public struct Protected: Error {}

    /// A list read record by record: one record a build does not understand (written by a later
    /// version, or damaged) no longer makes the whole list read as empty and then get written over
    /// (audit MA-4, 15 Nov). What does not decode is kept in a copy beside the file.
    private func read<T: Decodable>(_ type: [T].Type, _ url: URL, default value: [T]) -> [T] {
        guard let data = try? Data(contentsOf: url) else { return value }
        if let all = try? JSONDecoder().decode([T].self, from: data) { return all }
        keepAside(url, data)
        guard let some = try? JSONDecoder().decode([Lossy<T>].self, from: data) else { return value }
        return some.compactMap(\.value)
    }

    private func read<T: Decodable>(_ type: [String: T].Type, _ url: URL, default value: [String: T]) -> [String: T] {
        guard let data = try? Data(contentsOf: url) else { return value }
        if let all = try? JSONDecoder().decode([String: T].self, from: data) { return all }
        keepAside(url, data)
        guard let some = try? JSONDecoder().decode([String: Lossy<T>].self, from: data) else { return value }
        return some.compactMapValues(\.value)
    }

    /// Copies a file that did not decode next to itself, once per content, so the next write (which
    /// keeps only what decoded) loses nothing for good.
    private func keepAside(_ url: URL, _ data: Data) {
        let tag = SHA256.hash(data: data).prefix(6).map { String(format: "%02x", $0) }.joined()
        let copy = url.deletingLastPathComponent().appendingPathComponent("\(url.lastPathComponent).unreadable-\(tag)")
        var isFolder: ObjCBool = false
        var kept = fm.fileExists(atPath: copy.path, isDirectory: &isFolder) && !isFolder.boolValue
        if !kept {
            do {
                try data.write(to: copy, options: [.atomic])
                kept = true
            } catch {
                kept = false
            }
        }
        // Without its copy the original must not be written over (audit recheck MA-4).
        if !kept { protected.insert(url.standardizedFileURL.path) }
        let name = url.lastPathComponent
        if !unreadable.contains(name) { unreadable.append(name) }
    }

    /// One element of a list that may not decode.
    private struct Lossy<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) throws { value = try? T(from: decoder) }
    }

    private func write<T: Encodable>(_ value: T, _ url: URL) throws {
        guard !protected.contains(url.standardizedFileURL.path) else { throw Protected() }
        let data = try encoder.encode(value)
        try data.write(to: url, options: [.atomic])
    }

    private var libraryFile: URL { root.appendingPathComponent("library.json") }
    private var positionsFile: URL { root.appendingPathComponent("positions.json") }

    /// Every file named after an id (a book, its threads, its journal) is made here: the id must be a
    /// plain id and the file must stay inside the library folder, whatever a backup says.
    func path(_ dir: String, _ id: String, _ ext: String) throws -> URL {
        let url = try SafeID.url(in: root.appendingPathComponent(dir, isDirectory: true), id: id, suffix: ".\(ext)")
        guard url.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path + "/") else { throw SafeID.Invalid() }
        return url
    }

    /// The library's books. A record whose id is not a plain id is left out (and dropped at the next
    /// write), so a library poisoned by an older backup cannot reach a path through it.
    private func storedBooks() -> [BookRecord] {
        read([BookRecord].self, libraryFile, default: []).filter { SafeID.isValid($0.id) }
    }

    // MARK: Books

    public func books() -> [BookRecord] {
        queue.sync { storedBooks() }
    }

    public func fileURL(for book: BookRecord) throws -> URL {
        try path("books", book.id, book.format.rawValue)
    }

    public enum ImportError: Error { case unsupported, unreadable }

    public static func format(of url: URL) -> BookRecord.Format? {
        switch url.pathExtension.lowercased() {
        case "pdf": .pdf
        case "epub": .epub
        default: nil
        }
    }

    public static func fingerprint(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Adds a file, or returns the existing book when the same file was added before.
    public func importBook(data: Data, fileName: String, title: String?, author: String?, pageCount: Int) throws -> BookRecord {
        guard let format = Self.format(of: URL(fileURLWithPath: fileName)) else { throw ImportError.unsupported }
        let fp = Self.fingerprint(data)
        return try queue.sync {
            var list = storedBooks()
            if let existing = list.first(where: { $0.fingerprint == fp }) { return existing }
            let fallback = (fileName as NSString).deletingPathExtension.replacingOccurrences(of: "_", with: " ")
            let now = Date().timeIntervalSince1970 * 1000
            let book = BookRecord(
                id: UUID().uuidString.lowercased(),
                title: (title?.isEmpty == false ? title! : fallback),
                author: author ?? "",
                format: format,
                pageCount: pageCount,
                size: data.count,
                fingerprint: fp,
                addedAt: now,
                openedAt: 0
            )
            try data.write(to: fileURL(for: book), options: [.atomic])
            list.append(book)
            try write(list, libraryFile)
            return book
        }
    }

    /// What a backup brings for one book besides its file.
    public struct RestoredData: Sendable {
        public var cards: [YarnCard]
        public var journal: [JournalRecord]
        public var position: ReadingPosition?
        public var readings: [PageReading]

        public init(cards: [YarnCard] = [], journal: [JournalRecord] = [], position: ReadingPosition? = nil, readings: [PageReading] = []) {
            self.cards = cards
            self.journal = journal
            self.position = position
            self.readings = readings
        }
    }

    /// Adds a book from a backup, keeping its id so its threads and journal still belong to it. The
    /// file (already checked, its fingerprint and size worked out from its bytes) is moved into place.
    /// Returns false when the library already has this book.
    ///
    /// The book's threads, journal, readings and position are written first and its library record
    /// last, so quitting in the middle never leaves a book without its threads (a later restore
    /// writes them again: audit recheck MR-6). A book deleted earlier in this run saves normally
    /// again (MR-1).
    @discardableResult
    public func restoreBook(_ book: BookRecord, movingFile file: URL, with data: RestoredData = RestoredData()) throws -> Bool {
        try queue.sync {
            var list = storedBooks()
            guard !list.contains(where: { $0.id == book.id || $0.fingerprint == book.fingerprint }) else { return false }
            deleted.remove(book.id)
            let cards = data.cards.filter { $0.bookId == book.id }
            let journal = data.journal.filter { $0.bookId == book.id }
            // Left by an earlier restore that was cut short: replaced, never added to.
            for (dir, items) in [("cards", cards.isEmpty), ("journal", journal.isEmpty), ("readings", data.readings.isEmpty)] where items {
                try? fm.removeItem(at: path(dir, book.id, "json"))
            }
            if !cards.isEmpty { try write(cards, path("cards", book.id, "json")) }
            if !journal.isEmpty { try write(journal, path("journal", book.id, "json")) }
            if !data.readings.isEmpty { try write(data.readings, path("readings", book.id, "json")) }
            if var position = data.position {
                position.bookId = book.id
                var all = read([String: ReadingPosition].self, positionsFile, default: [:])
                all[book.id] = position
                try write(all, positionsFile)
            }
            let target = try fileURL(for: book)
            if fm.fileExists(atPath: target.path) { try fm.removeItem(at: target) }
            try fm.moveItem(at: file, to: target)
            list.append(book)
            try write(list, libraryFile)
            return true
        }
    }

    public func markOpened(_ bookId: String) {
        queue.sync {
            var list = storedBooks()
            guard let i = list.firstIndex(where: { $0.id == bookId }) else { return }
            list[i].openedAt = Date().timeIntervalSince1970 * 1000
            try? write(list, libraryFile)
        }
    }

    /// The reader's own title and author for a book.
    public func updateBook(_ bookId: String, title: String, author: String) {
        queue.sync {
            var list = storedBooks()
            guard let i = list.firstIndex(where: { $0.id == bookId }) else { return }
            let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { list[i].title = t }
            list[i].author = author.trimmingCharacters(in: .whitespacesAndNewlines)
            try? write(list, libraryFile)
        }
    }

    /// Removes a book and everything that belongs to it.
    /// Books deleted in this run. Work still finishing for one of them (an answer streaming in, a page
    /// being read) writes nothing back (audit MA-8, 15 Nov).
    private var deleted = Set<String>()

    public func deleteBook(_ bookId: String) throws {
        try queue.sync {
            var list = storedBooks()
            guard let book = list.first(where: { $0.id == bookId }) else { return }
            deleted.insert(bookId)
            let file = try fileURL(for: book)
            let cards = try path("cards", bookId, "json")
            let journal = try path("journal", bookId, "json")
            let readings = try path("readings", bookId, "json")
            list.removeAll { $0.id == bookId }
            try write(list, libraryFile)
            try? fm.removeItem(at: file)
            try? fm.removeItem(at: cards)
            try? fm.removeItem(at: journal)
            try? fm.removeItem(at: readings)
            // Copies kept aside of the book's files go too (audit recheck MR-3).
            for url in [cards, journal, readings] {
                let folder = url.deletingLastPathComponent()
                let prefix = "\(url.lastPathComponent).unreadable-"
                for name in (try? fm.contentsOfDirectory(atPath: folder.path)) ?? [] where name.hasPrefix(prefix) {
                    try? fm.removeItem(at: folder.appendingPathComponent(name))
                }
                protected.remove(url.standardizedFileURL.path)
            }
            var positions = read([String: ReadingPosition].self, positionsFile, default: [:])
            positions[bookId] = nil
            try write(positions, positionsFile)
        }
    }

    // MARK: Threads, journal, positions

    public func cards(for bookId: String) -> [YarnCard] {
        queue.sync {
            guard let url = try? path("cards", bookId, "json") else { return [] }
            return read([YarnCard].self, url, default: [])
        }
    }

    public func saveCards(_ cards: [YarnCard], for bookId: String) throws {
        try queue.sync {
            guard !deleted.contains(bookId) else { return }
            try write(cards, path("cards", bookId, "json"))
        }
    }

    /// For a book that is not open: page translations and readings waiting on Gemini batch jobs stop
    /// waiting (they say `code`) and the jobs' names are returned, to be cancelled and removed at
    /// Google (audit K-3: the Gemini key changed).
    public func forgetBatchJobs(bookId: String, code: String) -> Set<String> {
        queue.sync {
            guard !deleted.contains(bookId), let cardsURL = try? path("cards", bookId, "json"), let readingsURL = try? path("readings", bookId, "json") else { return [] }
            var jobs = Set<String>()
            if fm.fileExists(atPath: cardsURL.path) {
                let (cards, found) = CardsModel.forgettingBatchJobs(read([YarnCard].self, cardsURL, default: []), code: code)
                if !found.isEmpty { try? write(cards, cardsURL); jobs.formUnion(found) }
            }
            if fm.fileExists(atPath: readingsURL.path) {
                let (readings, found) = PageReadings.forgettingBatchJobs(read([PageReading].self, readingsURL, default: []), code: code)
                if !found.isEmpty { try? write(readings, readingsURL); jobs.formUnion(found) }
            }
            return jobs
        }
    }

    /// The Gemini batch jobs a book that is not open still waits on (its page translations and
    /// readings as stored).
    public func batchJobs(bookId: String) -> Set<String> {
        queue.sync {
            guard !deleted.contains(bookId), let cardsURL = try? path("cards", bookId, "json"), let readingsURL = try? path("readings", bookId, "json") else { return [] }
            var jobs = Set<String>()
            if fm.fileExists(atPath: cardsURL.path) {
                for card in read([YarnCard].self, cardsURL, default: []) where card.messages.last?.state == .streaming {
                    if let job = card.batchJob { jobs.insert(job) }
                }
            }
            if fm.fileExists(atPath: readingsURL.path) {
                jobs.formUnion(PageReadings.jobs(in: read([PageReading].self, readingsURL, default: []).filter { $0.state == .waiting }))
            }
            return jobs
        }
    }

    /// What became of a job when its key went away, for a book that is not open: finished pages are
    /// filled in, the rest say `code`. Written before the job is deleted at Google (audit KR-2, WR-2).
    public func applyBatchOutcome(bookId: String, job: String, outcome: BatchOutcome, code: String) {
        queue.sync {
            guard !deleted.contains(bookId), let cardsURL = try? path("cards", bookId, "json"), let readingsURL = try? path("readings", bookId, "json") else { return }
            if fm.fileExists(atPath: cardsURL.path) {
                let cards = read([YarnCard].self, cardsURL, default: [])
                let next = CardsModel.applying(outcome, of: job, code: code, to: cards)
                if next != cards { try? write(next, cardsURL) }
            }
            if fm.fileExists(atPath: readingsURL.path) {
                let readings = read([PageReading].self, readingsURL, default: [])
                let next = PageReadings.applying(outcome, of: job, code: code, to: readings)
                if next != readings { try? write(next, readingsURL) }
            }
        }
    }

    /// Pages read with Pery ("Extract page text"), kept with the book.
    public func readings(for bookId: String) -> [PageReading] {
        queue.sync {
            guard let url = try? path("readings", bookId, "json") else { return [] }
            return read([PageReading].self, url, default: [])
        }
    }

    public func saveReadings(_ readings: [PageReading], for bookId: String) throws {
        try queue.sync {
            guard !deleted.contains(bookId) else { return }
            try write(readings, path("readings", bookId, "json"))
        }
    }

    public func journal(for bookId: String) -> [JournalRecord] {
        queue.sync {
            guard let url = try? path("journal", bookId, "json") else { return [] }
            return read([JournalRecord].self, url, default: [])
        }
    }

    public func addJournal(_ record: JournalRecord) throws {
        try queue.sync {
            guard !deleted.contains(record.bookId) else { return }
            let url = try path("journal", record.bookId, "json")
            var list = read([JournalRecord].self, url, default: [])
            list.append(record)
            try write(list, url)
        }
    }

    /// Adds several entries to a book's journal in one write (a restore).
    public func addJournal(_ records: [JournalRecord], for bookId: String) throws {
        try queue.sync {
            guard !deleted.contains(bookId) else { return }
            let url = try path("journal", bookId, "json")
            var list = read([JournalRecord].self, url, default: [])
            list.append(contentsOf: records.filter { $0.bookId == bookId })
            try write(list, url)
        }
    }

    /// Puts a changed entry in place of the one with its id (a thread saved again after it grew).
    public func replaceJournal(_ record: JournalRecord) throws {
        try queue.sync {
            guard !deleted.contains(record.bookId) else { return }
            let url = try path("journal", record.bookId, "json")
            var list = read([JournalRecord].self, url, default: [])
            guard let i = list.firstIndex(where: { $0.id == record.id }) else { return }
            list[i] = record
            try write(list, url)
        }
    }

    public func deleteJournal(_ id: String, bookId: String) throws {
        try queue.sync {
            let url = try path("journal", bookId, "json")
            var list = read([JournalRecord].self, url, default: [])
            list.removeAll { $0.id == id }
            try write(list, url)
        }
    }

    public func allJournal() -> [JournalRecord] {
        books().flatMap { journal(for: $0.id) }
    }

    public func allCards() -> [YarnCard] {
        books().flatMap { cards(for: $0.id) }
    }

    public func position(for bookId: String) -> ReadingPosition? {
        queue.sync { read([String: ReadingPosition].self, positionsFile, default: [:])[bookId] }
    }

    public func savePosition(_ position: ReadingPosition) {
        guard SafeID.isValid(position.bookId) else { return }
        queue.sync {
            guard !deleted.contains(position.bookId) else { return }
            var all = read([String: ReadingPosition].self, positionsFile, default: [:])
            all[position.bookId] = position
            try? write(all, positionsFile)
        }
    }
}
