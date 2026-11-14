import CryptoKit
import Foundation
import Testing
import ZIPFoundation
@testable import PerydaKit

/// Answers after a pause, so work can be interrupted while it streams.
struct SlowStreamer: AnswerStreaming {
    func stream(_ request: AIRequest) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { c in
            Task {
                try? await Task.sleep(for: .milliseconds(120))
                c.yield("Tamam.")
                c.finish()
            }
        }
    }
}

/// A batch service that, when a job is deleted, looks at what the library holds at that moment.
actor DiskCheckingBatcher: PageBatching {
    let store: LibraryStore
    let bookId: String
    var status: GeminiBatch.Status = .waiting
    var created = 0
    var onDiskAtDelete: [String] = []

    init(store: LibraryStore, bookId: String) {
        self.store = store
        self.bookId = bookId
    }

    func set(_ s: GeminiBatch.Status) { status = s }

    func create(apiKey: String, model: String, items: [GeminiBatch.Item]) async throws -> String {
        created += 1
        return "batches/job-\(created)"
    }

    func status(apiKey: String, name: String) async throws -> GeminiBatch.Status { status }
    func cancel(apiKey: String, name: String) async {}
    func delete(apiKey: String, name: String) async {
        onDiskAtDelete = store.cards(for: bookId).compactMap { $0.messages.last?.content } + store.readings(for: bookId).map(\.text)
    }
}

/// Fixes from the 15 Nov re-audit (MR-1 … MR-8, KR-1, KR-2, WR-1, WR-2, MA-4 and MA-11 leftovers).
@Suite("Re-audit fixes")
@MainActor
struct RecheckFixesTests {
    func pdf(_ store: LibraryStore, _ tag: String = UUID().uuidString) throws -> BookRecord {
        try store.importBook(data: Data("%PDF-1.4 \(tag)".utf8), fileName: "k.pdf", title: "K", author: nil, pageCount: 10)
    }

    func zip() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("peryda-recheck-\(UUID().uuidString).zip") }

    func page(_ n: Int) -> CardsModel.PageSource {
        CardsModel.PageSource(page: n, text: "Page \(n): concepts become clear at their borders.", width: 760, height: 983)
    }

    func model(_ settings: ByokSettings = keyed, streamer: AnswerStreaming = RecordingStreamer(), batcher: PageBatching = FakeBatcher(), store: LibraryStore? = nil, bookId: String = "book") -> CardsModel {
        let m = CardsModel(bookId: bookId, bookTitle: "Freud", lang: .tr, settings: settings, store: store, streamer: streamer, batcher: batcher)
        m.pageCount = 20
        return m
    }

    // MARK: Library and backup

    @Test func aBookDeletedAndRestoredInOneRunSavesNormally() throws {
        let store = try tempStore()
        let book = try pdf(store)
        try store.saveCards([YarnCard(bookId: book.id, color: .mint, kind: .quick(.mint), anchors: [], messages: [YarnMessage(role: .assistant, content: "bir")])], for: book.id)
        try store.addJournal(JournalRecord(bookId: book.id, source: .note, quote: "", text: "not", pageNumber: 1))
        store.savePosition(ReadingPosition(bookId: book.id, cfi: nil, panX: 0, panY: 0, scale: 1, page: 2, updatedAt: 0))
        try store.saveReadings([PageReading(page: 3, text: "okundu", state: .done)], for: book.id)
        let file = zip()
        try Backup.export(store: store, to: file)
        try store.deleteBook(book.id)
        #expect(try Backup.restore(store: store, from: file) == 1)
        #expect(store.cards(for: book.id).count == 1)
        #expect(store.journal(for: book.id).count == 1)
        #expect(store.position(for: book.id)?.page == 2)
        #expect(store.readings(for: book.id).map(\.text) == ["okundu"], "readings travel in the backup (WR-1)")
        try store.addJournal(JournalRecord(bookId: book.id, source: .note, quote: "", text: "yeni", pageNumber: 1))
        #expect(store.journal(for: book.id).count == 2, "and what is written after the restore is kept")
    }

    /// A backup made by the web engine: its finished readings come back, nothing else from that row.
    @Test func aWebBackupsReadingsRestoreFinishedOnly() throws {
        let id = UUID().uuidString.lowercased()
        let bytes = Data("%PDF-1.4 web".utf8)
        let book = BookRecord(id: id, title: "Web", author: "", format: .pdf, pageCount: 9, size: bytes.count, fingerprint: LibraryStore.fingerprint(bytes), addedAt: 0, openedAt: 0)
        let rows: [[String: Any]] = [
            ["page": 2, "text": "iki", "state": "done", "createdAt": 5],
            ["page": 3, "text": "", "state": "done"],
            ["page": 4, "text": "x", "state": "waiting", "job": "batches/x"],
            ["page": 2, "text": "ikinci kez", "state": "done"],
            ["page": 2.5, "text": "yarım", "state": "done"],
            ["page": 7, "text": "yedi", "state": "done", "job": "batches/y"],
        ]
        let manifest: [String: Any] = [
            "format": "peryda-backup", "version": 1, "createdAt": 0,
            "books": [try JSONSerialization.jsonObject(with: JSONEncoder().encode(book))],
            "cards": [], "journal": [], "positions": [],
            "prefs": [["key": "readings:\(id)", "value": rows], ["key": "launches", "value": 3]],
        ]
        let json = try JSONSerialization.data(withJSONObject: manifest)
        let file = zip()
        let archive = try Archive(url: file, accessMode: .create)
        try archive.addEntry(with: "peryda.json", type: .file, uncompressedSize: Int64(json.count)) { p, s in json.subdata(in: Int(p)..<Int(p) + s) }
        try archive.addEntry(with: "books/\(id).pdf", type: .file, uncompressedSize: Int64(bytes.count)) { p, s in bytes.subdata(in: Int(p)..<Int(p) + s) }
        let store = try tempStore()
        #expect(try Backup.restore(store: store, from: archive.url) == 1)
        let readings = store.readings(for: id)
        #expect(readings.map(\.page) == [2, 7])
        #expect(readings.map(\.text) == ["iki", "yedi"])
        #expect(readings.allSatisfy { $0.state == .done && $0.job == nil })
    }

    @Test func deletingABookRemovesItsUnreadableCopies() throws {
        let store = try tempStore()
        let book = try pdf(store)
        let folder = store.root.appendingPathComponent("cards")
        try Data("[{\"id\": 1}, 2]".utf8).write(to: folder.appendingPathComponent("\(book.id).json"))
        _ = store.cards(for: book.id)
        #expect(try FileManager.default.contentsOfDirectory(atPath: folder.path).contains { $0.hasPrefix("\(book.id).json.unreadable-") })
        try store.deleteBook(book.id)
        #expect(try FileManager.default.contentsOfDirectory(atPath: folder.path).allSatisfy { !$0.hasPrefix(book.id) })
    }

    @Test func whenTheCopyCannotBeMadeTheOriginalIsNotWrittenOver() throws {
        let store = try tempStore()
        let book = try pdf(store)
        let url = store.root.appendingPathComponent("cards/\(book.id).json")
        let original = Data("[{\"id\": 1}]".utf8)
        try original.write(to: url)
        let tag = SHA256.hash(data: original).prefix(6).map { String(format: "%02x", $0) }.joined()
        // Something already in the copy's place that is not a copy.
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent().appendingPathComponent("\(book.id).json.unreadable-\(tag)"), withIntermediateDirectories: true)
        #expect(store.cards(for: book.id).isEmpty)
        #expect(throws: LibraryStore.Protected.self) { try store.saveCards([], for: book.id) }
        #expect(try Data(contentsOf: url) == original)
        #expect(store.unreadableFiles().contains("\(book.id).json"))
    }

    @Test func exportAndRestoreAgreeOnHowManyThreadsABookMayHave() throws {
        let store = try tempStore()
        let a = try pdf(store, "a")
        let b = try pdf(store, "b")
        func threads(_ book: String, _ n: Int) -> [YarnCard] { (0..<n).map { _ in YarnCard(bookId: book, color: .mint, kind: .quick(.mint), anchors: [], messages: []) } }
        try store.saveCards(threads(a.id, 15_000), for: a.id)
        try store.saveCards(threads(b.id, 6_000), for: b.id)
        let file = zip()
        try Backup.export(store: store, to: file)
        let target = try tempStore()
        #expect(try Backup.restore(store: target, from: file) == 2)
        #expect(target.cards(for: a.id).count == 15_000, "limits are per book")
        #expect(target.cards(for: b.id).count == 6_000)
        try store.saveCards(threads(a.id, Backup.maxCards + 1), for: a.id)
        #expect(throws: Backup.Failure.tooLarge) { try Backup.export(store: store, to: zip()) }
    }

    @Test func aVeryDeepChainOfThreadsIsCut() {
        let cards = (0..<250).map { i in
            YarnCard(id: "c\(i)", bookId: "b", color: .mint, kind: .quick(.mint), anchors: [], parentCardId: i == 0 ? nil : "c\(i - 1)", messages: [])
        }
        let m = Backup.Manifest(format: Backup.format, version: Backup.version, createdAt: 0, books: [], cards: cards, journal: [], positions: [], prefs: [])
        let out = Backup.sane(m).cards
        let byId = Dictionary(uniqueKeysWithValues: out.map { ($0.id, $0) })
        #expect(byId["c199"]?.parentCardId == "c198")
        #expect(byId["c200"]?.parentCardId == nil, "cut past \(Backup.maxDepth)")
        #expect(byId["c249"]?.parentCardId == "c248")
        for card in out {
            var depth = 1
            var current = card.parentCardId
            while let p = current { depth += 1; current = byId[p]?.parentCardId }
            #expect(depth <= Backup.maxDepth)
        }
    }

    // MARK: Page translations and the Gemini key

    @Test func aKeyChangeWhileARangeIsDrawnMakesNoJobWithTheOldKey() async throws {
        let batcher = FakeBatcher()
        let m = model(batcher: batcher)
        m.pagePicture = { _ in
            try? await Task.sleep(for: .milliseconds(60))
            return "data:image/jpeg;base64,QUJD"
        }
        m.translatePages((1...5).map { CardsModel.PageSource(page: $0, text: "", scanned: true, width: 760, height: 983) }, target: .tr)
        try await Task.sleep(for: .milliseconds(90))
        #expect(m.detachBatchJobs(code: "key-changed").isEmpty)
        try await Task.sleep(for: .milliseconds(500))
        #expect(await batcher.created.isEmpty, "no job made with the old key")
        #expect(m.unfinishedTranslations.isEmpty)
        #expect(m.pageTranslation(page: 4, target: .tr)?.messages.last?.content == "key-changed")
    }

    @Test func translateNowWhileARangeIsDrawnSendsThePageOnce() async throws {
        let streamer = RecordingStreamer()
        let batcher = FakeBatcher()
        let m = model(streamer: streamer, batcher: batcher)
        m.pagePicture = { _ in
            try? await Task.sleep(for: .milliseconds(40))
            return "data:image/jpeg;base64,QUJD"
        }
        let ids = m.translatePages((1...5).map { CardsModel.PageSource(page: $0, text: "", scanned: true, width: 760, height: 983) }, target: .tr)
        try await Task.sleep(for: .milliseconds(50))
        m.translateNow(ids[3])
        for _ in 0..<300 where await batcher.created.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        let sent = await batcher.created.flatMap { $0.items.map(\.key) }
        #expect(!sent.contains(ids[3]), "not in the job")
        #expect(sent.count == 4)
        await m.waitForIdle()
        #expect(streamer.requests.count == 1, "sent once, directly")
        #expect(m.cards.first { $0.id == ids[3] }?.batchJob == nil)
    }

    @Test func aKeyChangeLeavesDirectTranslationsAlone() async throws {
        let m = model(ByokSettings(activeProvider: .openai, openaiApiKey: "sk-placeholder-not-real-123"), streamer: SlowStreamer())
        m.translatePages([page(1), page(2), page(3)], target: .tr)
        try await Task.sleep(for: .milliseconds(30))
        #expect(m.detachBatchJobs(code: "key-changed").isEmpty)
        await m.waitForIdle()
        for n in 1...3 { #expect(m.pageTranslation(page: n, target: .tr)?.messages.last?.content == "Tamam.") }
    }

    @Test func aKeyChangeKeepsFinishedResultsAndRemovesUnfinishedJobs() async throws {
        let batcher = FakeBatcher()
        let m = model(batcher: batcher)
        let ids = m.translatePages((1...4).map { page($0) }, target: .tr)
        for _ in 0..<200 where m.waitingTranslations.count < 4 { try await Task.sleep(for: .milliseconds(10)) }
        #expect(m.detachBatchJobs(code: "key-changed") == ["batches/job-1"])
        #expect(m.waitingTranslations.count == 4, "still waiting until the job is settled")
        // Polling with the new key leaves a job being settled alone.
        m.settings = ByokSettings(activeProvider: .gemini, geminiApiKey: "AIza-new-placeholder-000")
        await m.pollBatches()
        #expect(await batcher.statusAsked.isEmpty)
        await batcher.setStatus(.done(texts: [ids[0]: "Bir", ids[1]: "İki"], errors: [ids[2]: "blocked"]))
        let outcome = await batcher.settle(apiKey: "AIza-old-placeholder", name: "batches/job-1")
        m.apply(outcome, of: "batches/job-1", code: "key-changed")
        #expect(m.pageTranslation(page: 1, target: .tr)?.messages.last?.content == "Bir")
        #expect(m.pageTranslation(page: 2, target: .tr)?.messages.last?.content == "İki")
        #expect(m.pageTranslation(page: 3, target: .tr)?.messages.last?.content == "blocked")
        #expect(m.pageTranslation(page: 4, target: .tr)?.messages.last?.content == "unknown")
        #expect(await batcher.cancelled.isEmpty, "a finished job is collected, not cancelled")
        // An unfinished job is cancelled and removed, and its pages can be sent again.
        let b2 = FakeBatcher()
        let m2 = model(batcher: b2)
        m2.translatePages((1...3).map { page($0) }, target: .tr)
        for _ in 0..<200 where m2.waitingTranslations.count < 3 { try await Task.sleep(for: .milliseconds(10)) }
        let jobs = m2.detachBatchJobs(code: "key-changed")
        for job in jobs { m2.apply(await b2.settle(apiKey: "AIza-old-placeholder", name: job), of: job, code: "key-changed") }
        #expect(await b2.cancelled == ["batches/job-1"])
        #expect(await b2.deleted == ["batches/job-1"])
        #expect(m2.pageTranslation(page: 2, target: .tr)?.messages.last?.content == "key-changed")
        #expect(m2.waitingTranslations.isEmpty)
    }

    @Test func collectedTranslationsAreOnDiskBeforeTheJobIsDeleted() async throws {
        let store = try tempStore()
        let batcher = DiskCheckingBatcher(store: store, bookId: "book")
        let m = model(batcher: batcher, store: store)
        let ids = m.translatePages((1...3).map { page($0) }, target: .tr)
        for _ in 0..<200 where m.waitingTranslations.count < 3 { try await Task.sleep(for: .milliseconds(10)) }
        await batcher.set(.done(texts: Dictionary(uniqueKeysWithValues: ids.map { ($0, "Çeviri \($0.prefix(4))") }), errors: [:]))
        await m.pollBatches()
        let seen = await batcher.onDiskAtDelete
        #expect(ids.allSatisfy { id in seen.contains("Çeviri \(id.prefix(4))") })
    }

    // MARK: Page readings and the Gemini key

    func readings(_ settings: ByokSettings = keyed, streamer: AnswerStreaming = RecordingStreamer(), batcher: PageBatching = FakeBatcher(), store: LibraryStore? = nil, picture: @escaping @MainActor (Int) async -> String? = { _ in "data:image/jpeg;base64,QUJD" }) -> PageReadings {
        let r = PageReadings(bookId: "book", bookTitle: "Freud", pageCount: 20, settings: settings, store: store, streamer: streamer, batcher: batcher, picture: picture)
        r.pollStart = .seconds(30)
        return r
    }

    @Test func aKeyChangeLeavesDirectReadingsAlone() async throws {
        let r = readings(ByokSettings(activeProvider: .claude, claudeApiKey: "sk-ant-placeholder-not-real"), streamer: SlowStreamer())
        r.read(1...2, lang: .tr)
        try await Task.sleep(for: .milliseconds(30))
        #expect(r.detachBatchJobs(code: "key-changed").isEmpty)
        for _ in 0..<300 where r.done.count < 2 { try await Task.sleep(for: .milliseconds(10)) }
        #expect(r.done.map(\.text) == ["Tamam.", "Tamam."])
    }

    @Test func aKeyChangeKeepsFinishedReadingsAndTheyAreOnDiskFirst() async throws {
        let store = try tempStore()
        let batcher = DiskCheckingBatcher(store: store, bookId: "book")
        let r = readings(batcher: batcher, store: store)
        r.read(4...6, lang: .tr)
        for _ in 0..<300 where r.inBatch < 3 { try await Task.sleep(for: .milliseconds(10)) }
        let jobs = r.detachBatchJobs(code: "key-changed")
        #expect(jobs == ["batches/job-1"])
        await batcher.set(.done(texts: ["4": "Dört", "5": "Beş"], errors: [:]))
        let outcome = await batcher.settle(apiKey: "AIza-old-placeholder", name: "batches/job-1")
        r.apply(outcome, of: "batches/job-1", code: "key-changed")
        #expect(r.done.map(\.text) == ["Dört", "Beş"])
        #expect(r.readings[6]?.error == "unknown")
        // Collected by polling: on disk before the job is deleted.
        r.read(8...10, lang: .tr)
        for _ in 0..<300 where r.inBatch < 3 { try await Task.sleep(for: .milliseconds(10)) }
        await batcher.set(.done(texts: ["8": "Sekiz", "9": "Dokuz", "10": "On"], errors: [:]))
        await r.poll()
        #expect(await batcher.onDiskAtDelete.contains("Dokuz"))
    }

    /// A book that is not open: its stored pages get the outcome.
    @Test func aClosedBooksPagesGetTheOutcome() throws {
        let store = try tempStore()
        let book = try pdf(store)
        var card = YarnCard(id: "t1", bookId: book.id, color: .sky, kind: .translate, anchors: [], messages: [YarnMessage(role: .user, content: "ÇEVİRİ"), YarnMessage(role: .assistant, content: "", state: .streaming)])
        card.translatedPage = 1
        card.batchJob = "batches/j"
        try store.saveCards([card], for: book.id)
        try store.saveReadings([PageReading(page: 2, state: .waiting, job: "batches/j"), PageReading(page: 3, state: .waiting, job: "batches/k")], for: book.id)
        #expect(store.batchJobs(bookId: book.id) == ["batches/j", "batches/k"])
        store.applyBatchOutcome(bookId: book.id, job: "batches/j", outcome: .done(texts: ["t1": "Bir", "2": "İki"], errors: [:]), code: "key-changed")
        store.applyBatchOutcome(bookId: book.id, job: "batches/k", outcome: .unfinished, code: "key-changed")
        #expect(store.cards(for: book.id).first?.messages.last?.content == "Bir")
        let stored = store.readings(for: book.id)
        #expect(stored.first { $0.page == 2 }?.text == "İki")
        #expect(stored.first { $0.page == 3 }?.error == "key-changed")
        #expect(store.batchJobs(bookId: book.id).isEmpty)
    }
}
