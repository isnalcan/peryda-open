import AppKit
import PDFKit
import PerydaKit
import XCTest

/// Records which key each batch call used.
actor KeyRecordingBatcher: PageBatching {
    var created = 0
    var cancelled: [(key: String, name: String)] = []
    var deleted: [(key: String, name: String)] = []
    var asked: [(key: String, name: String)] = []
    /// What Google says about each job (waiting unless set).
    var statuses: [String: GeminiBatch.Status] = [:]

    func set(_ status: GeminiBatch.Status, for name: String) { statuses[name] = status }

    func create(apiKey: String, model: String, items: [GeminiBatch.Item]) async throws -> String {
        created += 1
        return "batches/open-\(created)"
    }
    func status(apiKey: String, name: String) async throws -> GeminiBatch.Status {
        asked.append((apiKey, name))
        return statuses[name] ?? .waiting
    }
    func cancel(apiKey: String, name: String) async { cancelled.append((apiKey, name)) }
    func delete(apiKey: String, name: String) async { deleted.append((apiKey, name)) }
}

/// Holds questions asked with one key until released, to open a book while they are out.
actor HoldingBatcher: PageBatching {
    let heldKey: String
    var released = false
    var asked: [(key: String, name: String)] = []
    var statuses: [String: GeminiBatch.Status] = [:]

    init(heldKey: String) { self.heldKey = heldKey }

    func set(_ status: GeminiBatch.Status, for name: String) { statuses[name] = status }
    func release() { released = true }

    func create(apiKey: String, model: String, items: [GeminiBatch.Item]) async throws -> String { "batches/new" }
    func status(apiKey: String, name: String) async throws -> GeminiBatch.Status {
        asked.append((apiKey, name))
        while apiKey == heldKey, !released { try? await Task.sleep(for: .milliseconds(5)) }
        return statuses[name] ?? .waiting
    }
    func cancel(apiKey: String, name: String) async {}
    func delete(apiKey: String, name: String) async {}
}

/// A Keychain that refuses every change.
struct RefusingVault: KeyVault {
    func load() -> ByokSettings { ByokSettings() }
    func save(_ settings: ByokSettings) throws { throw NSError(domain: NSOSStatusErrorDomain, code: -25308) }
    func clear() throws { throw NSError(domain: NSOSStatusErrorDomain, code: -25308) }
}

/// Saving keys: a Keychain failure is said, not hidden (audit K-4); a changed Gemini key stops and
/// removes, with the old key, the batch jobs made with it, in open and closed books (audit K-3).
@MainActor
final class KeyChangeTests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    func store() throws -> LibraryStore {
        try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-keychange-\(UUID().uuidString)"))
    }

    func testAKeychainFailureIsShownAndRememberKeepsItsValue() throws {
        let app = AppModel(store: try store(), settings: ByokSettings(), lang: .tr, keychain: RefusingVault())
        XCTAssertFalse(app.saveSettings(ByokSettings(geminiApiKey: "AIza-placeholder-not-real"), remember: true))
        XCTAssertEqual(app.keychainError, UIText(.tr)["keychainFailed"])
        XCTAssertFalse(app.rememberKeys, "the switch shows what is really stored")
        let fine = AppModel(store: try store(), settings: ByokSettings(), lang: .tr, keychain: MemoryVault())
        XCTAssertTrue(fine.saveSettings(ByokSettings(geminiApiKey: "AIza-placeholder-not-real"), remember: true))
        XCTAssertNil(fine.keychainError)
        XCTAssertTrue(fine.rememberKeys)
    }

    func testChangingTheGeminiKeyRemovesItsJobsWithTheOldKey() async throws {
        let store = try store()
        let batcher = KeyRecordingBatcher()
        let old = "AIza-old-placeholder-not-real"
        let app = AppModel(store: store, settings: ByokSettings(activeProvider: .gemini, geminiApiKey: old), lang: .tr, batcher: batcher)
        // A closed book waiting on a translation job and a reading job.
        let pdf = try XCTUnwrap(PDFDocument(url: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf"))?.dataRepresentation())
        let closed = try store.importBook(data: pdf, fileName: "a.pdf", title: "A", author: nil, pageCount: 1)
        var card = YarnCard(bookId: closed.id, color: .sky, kind: .translate, anchors: [], messages: [YarnMessage(role: .user, content: "ÇEVİRİ"), YarnMessage(role: .assistant, content: "", state: .streaming)])
        card.translatedPage = 1
        card.translationLanguage = "tr"
        card.batchJob = "batches/closed-cards"
        try store.saveCards([card], for: closed.id)
        try store.saveReadings([PageReading(page: 1, state: .waiting, job: "batches/closed-readings")], for: closed.id)
        // An open book reading three pages as a batch.
        let doc = PDFDocument()
        for i in 0..<3 { doc.insert(try XCTUnwrap(PDFDocument(data: pdf)?.page(at: 0)), at: i) }
        let book = try store.importBook(data: try XCTUnwrap(doc.dataRepresentation()), fileName: "b.pdf", title: "B", author: nil, pageCount: 3)
        let reader = try XCTUnwrap(ReaderModel(book: book, app: app))
        let readings = try XCTUnwrap(reader.readings)
        readings.read(1...3, lang: .tr)
        for _ in 0..<200 where readings.inBatch < 3 { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(readings.inBatch, 3)

        XCTAssertTrue(app.saveSettings(ByokSettings(activeProvider: .gemini, geminiApiKey: "AIza-new-placeholder-not-real"), remember: false))
        for task in app.pendingWork { await task.value }
        let cancelled = await batcher.cancelled
        XCTAssertEqual(Set(cancelled.map(\.name)), ["batches/closed-cards", "batches/closed-readings", "batches/open-1"])
        XCTAssertTrue(cancelled.allSatisfy { $0.key == old }, "removed with the key that made them")
        XCTAssertEqual(readings.readings[2]?.error, "key-changed")
        XCTAssertEqual(store.cards(for: closed.id).first?.messages.last?.content, "key-changed")
        XCTAssertNil(store.cards(for: closed.id).first?.batchJob)
        XCTAssertEqual(store.readings(for: closed.id).first?.state, .failed)
        _ = reader
    }

    /// A job that had already finished is collected with the old key, not thrown away (audit KR-2):
    /// its pages get their text, it is deleted (not cancelled), and an unfinished one is removed.
    func testFinishedJobsAreKeptWhenTheGeminiKeyChanges() async throws {
        let store = try store()
        let batcher = KeyRecordingBatcher()
        let old = "AIza-old-placeholder-not-real"
        let app = AppModel(store: store, settings: ByokSettings(activeProvider: .gemini, geminiApiKey: old), lang: .tr, batcher: batcher)
        let pdf = try XCTUnwrap(PDFDocument(url: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf"))?.dataRepresentation())
        let closed = try store.importBook(data: pdf, fileName: "a.pdf", title: "A", author: nil, pageCount: 1)
        app.reloadBooks()
        var card = YarnCard(id: "t-closed", bookId: closed.id, color: .sky, kind: .translate, anchors: [], messages: [YarnMessage(role: .user, content: "ÇEVİRİ"), YarnMessage(role: .assistant, content: "", state: .streaming)])
        card.translatedPage = 1
        card.translationLanguage = "tr"
        card.batchJob = "batches/finished"
        try store.saveCards([card], for: closed.id)
        try store.saveReadings([PageReading(page: 1, state: .waiting, job: "batches/unfinished")], for: closed.id)
        await batcher.set(.done(texts: ["t-closed": "Çeviri hazır"], errors: [:]), for: "batches/finished")

        XCTAssertTrue(app.saveSettings(ByokSettings(activeProvider: .gemini, geminiApiKey: "AIza-new-placeholder-not-real"), remember: false))
        for task in app.pendingWork { await task.value }
        XCTAssertEqual(store.cards(for: closed.id).first?.messages.last?.content, "Çeviri hazır", "the paid result is kept")
        XCTAssertEqual(store.readings(for: closed.id).first?.error, "key-changed")
        let asked = await batcher.asked
        XCTAssertTrue(asked.allSatisfy { $0.key == old }, "asked with the key that made the jobs")
        let cancelled = await batcher.cancelled.map(\.name)
        let deleted = await batcher.deleted.map(\.name)
        XCTAssertEqual(cancelled, ["batches/unfinished"])
        XCTAssertEqual(Set(deleted), ["batches/finished", "batches/unfinished"])
        // Saving the same key again stops nothing.
        let before = await batcher.asked.count
        XCTAssertTrue(app.saveSettings(app.settings, remember: false))
        for task in app.pendingWork { await task.value }
        let after = await batcher.asked.count
        XCTAssertEqual(before, after)
    }

    /// A book whose threads file did not decode whole: the reader is told when the book opens
    /// (audit recheck MA-4), not only for the library file at launch.
    func testAnUnreadableThreadsFileIsToldWhenTheBookOpens() throws {
        let store = try store()
        let app = AppModel(store: store, settings: ByokSettings(), lang: .tr)
        let pdf = try XCTUnwrap(PDFDocument(url: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf"))?.dataRepresentation())
        let book = try store.importBook(data: pdf, fileName: "a.pdf", title: "A", author: nil, pageCount: 1)
        try Data("[{\"id\": 1}]".utf8).write(to: store.root.appendingPathComponent("cards/\(book.id).json"))
        XCTAssertNil(app.lastError)
        let reader = try XCTUnwrap(ReaderModel(book: book, app: app))
        XCTAssertEqual(app.lastError, UIText(.tr)["unreadableFiles"])
        reader.close()
    }

    /// A book opened while its job is being settled with the old key leaves the job to that, and takes
    /// the paid result; its own next save does not write "waiting" (or "key") over it (audit final F-2).
    func testABookOpenedWhileItsJobIsSettledKeepsThePaidResult() async throws {
        let store = try store()
        let old = "AIza-old-placeholder-not-real"
        let new = "AIza-new-placeholder-not-real"
        let batcher = HoldingBatcher(heldKey: old)
        let app = AppModel(store: store, settings: ByokSettings(activeProvider: .gemini, geminiApiKey: old), lang: .tr, batcher: batcher)
        let pdf = try XCTUnwrap(PDFDocument(url: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf"))?.dataRepresentation())
        let book = try store.importBook(data: pdf, fileName: "a.pdf", title: "A", author: nil, pageCount: 1)
        app.reloadBooks()
        var card = YarnCard(id: "t-late", bookId: book.id, color: .sky, kind: .translate, anchors: [], messages: [YarnMessage(role: .user, content: "ÇEVİRİ"), YarnMessage(role: .assistant, content: "", state: .streaming)])
        card.translatedPage = 1
        card.translationLanguage = "tr"
        card.batchJob = "batches/held"
        try store.saveCards([card], for: book.id)
        await batcher.set(.done(texts: ["t-late": "Çeviri hazır"], errors: [:]), for: "batches/held")

        XCTAssertTrue(app.saveSettings(ByokSettings(activeProvider: .gemini, geminiApiKey: new), remember: false))
        for _ in 0..<400 where await batcher.asked.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        // The book opens now, with the new key, and asks about its waiting page.
        let reader = try XCTUnwrap(ReaderModel(book: book, app: app))
        await reader.cards.pollBatches()
        let askedNew = await batcher.asked.filter { $0.key == new }
        XCTAssertTrue(askedNew.isEmpty, "not asked with the new key")
        await batcher.release()
        for task in app.pendingWork { await task.value }
        XCTAssertEqual(reader.cards.cards.first?.messages.last?.content, "Çeviri hazır", "the open window has the result")
        XCTAssertEqual(store.cards(for: book.id).first?.messages.last?.content, "Çeviri hazır")
        // The window's own next save keeps it.
        reader.cards.setCollapsed("t-late", true)
        await reader.cards.waitForIdle()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(store.cards(for: book.id).first?.messages.last?.content, "Çeviri hazır")
    }
}
