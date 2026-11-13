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
        for dir in ["", "books", "cards", "journal"] {
            try fm.createDirectory(at: root.appendingPathComponent(dir), withIntermediateDirectories: true)
        }
    }

    public static func defaultRoot() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return base.appendingPathComponent("Peryda", isDirectory: true)
    }

    private func read<T: Decodable>(_ type: T.Type, _ url: URL, default value: T) -> T {
        guard let data = try? Data(contentsOf: url) else { return value }
        return (try? JSONDecoder().decode(T.self, from: data)) ?? value
    }

    private func write<T: Encodable>(_ value: T, _ url: URL) throws {
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

    /// Adds a book from a backup, keeping its id so its threads and journal still belong to it. The
    /// file (already checked, its fingerprint and size worked out from its bytes) is moved into place.
    /// Returns false when the library already has this book.
    @discardableResult
    public func restoreBook(_ book: BookRecord, movingFile file: URL) throws -> Bool {
        try queue.sync {
            var list = storedBooks()
            guard !list.contains(where: { $0.id == book.id || $0.fingerprint == book.fingerprint }) else { return false }
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
    public func deleteBook(_ bookId: String) throws {
        try queue.sync {
            var list = storedBooks()
            guard let book = list.first(where: { $0.id == bookId }) else { return }
            let file = try fileURL(for: book)
            let cards = try path("cards", bookId, "json")
            let journal = try path("journal", bookId, "json")
            list.removeAll { $0.id == bookId }
            try write(list, libraryFile)
            try? fm.removeItem(at: file)
            try? fm.removeItem(at: cards)
            try? fm.removeItem(at: journal)
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
        try queue.sync { try write(cards, path("cards", bookId, "json")) }
    }

    public func journal(for bookId: String) -> [JournalRecord] {
        queue.sync {
            guard let url = try? path("journal", bookId, "json") else { return [] }
            return read([JournalRecord].self, url, default: [])
        }
    }

    public func addJournal(_ record: JournalRecord) throws {
        try queue.sync {
            let url = try path("journal", record.bookId, "json")
            var list = read([JournalRecord].self, url, default: [])
            list.append(record)
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
            var all = read([String: ReadingPosition].self, positionsFile, default: [:])
            all[position.bookId] = position
            try? write(all, positionsFile)
        }
    }
}
