import Foundation
import Testing
@testable import PerydaKit

/// "Read with Pery" in "Extract page text": one page directly, a range as a Gemini batch, kept with
/// the book, stoppable (owner test 14 Nov).
@Suite("Page readings")
@MainActor
struct PageReadingsTests {
    static let picture = "data:image/jpeg;base64," + String(repeating: "QUJD", count: 400)

    func model(_ settings: ByokSettings = keyed, streamer: AnswerStreaming = RecordingStreamer(), batcher: FakeBatcher = FakeBatcher(), store: LibraryStore? = nil) -> PageReadings {
        let m = PageReadings(bookId: "book", bookTitle: "Freud", pageCount: 20, settings: settings, store: store, streamer: streamer, batcher: batcher) { _ in Self.picture }
        m.pollStart = .milliseconds(20)
        return m
    }

    func until(_ check: () -> Bool) async {
        for _ in 0..<200 where !check() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func onePageIsReadDirectlyFromItsPicture() async throws {
        let streamer = RecordingStreamer()
        let m = model(streamer: streamer)
        m.read(3...3, lang: .tr)
        await until { m.readings[3]?.state == .done }
        #expect(m.readings[3]?.text == "Kavramlar, sınırlarında netleşir.")
        let req = try #require(streamer.requests.first)
        #expect(req.system == Compose.pageTranscriptionSystem(.tr))
        guard case .image(let mime, _) = req.turns[0].parts[0] else { Issue.record("picture first"); return }
        #expect(mime == "image/jpeg")
        #expect(m.pending == 0)
    }

    @Test func aRangeGoesToGeminiAsABatchAndFillsInByItself() async throws {
        let streamer = RecordingStreamer()
        let batcher = FakeBatcher()
        let m = model(streamer: streamer, batcher: batcher)
        m.read(2...5, lang: .tr)
        await until { m.inBatch == 4 }
        #expect(streamer.requests.isEmpty, "no direct requests for a batch")
        let created = await batcher.created
        #expect(created.count == 1)
        #expect(created.first?.items.map(\.key) == ["2", "3", "4", "5"])
        await batcher.setStatus(.done(texts: ["2": "İki", "3": "Üç", "5": "Beş"], errors: ["4": "blocked"]))
        await until { m.pending == 0 }
        #expect(m.done.map(\.page) == [2, 3, 5])
        #expect(m.readings[4]?.state == .failed)
        #expect(m.readings[4]?.error == "blocked")
        #expect(await batcher.deleted == ["batches/job-1"], "Google need not keep the pages")
    }

    @Test func otherProvidersReadARangeFourAtATime() async throws {
        let streamer = RecordingStreamer()
        let m = model(ByokSettings(activeProvider: .openai, openaiApiKey: "sk-placeholder-not-real-123"), streamer: streamer)
        m.read(1...6, lang: .en)
        await until { m.done.count == 6 }
        #expect(streamer.requests.count == 6)
        #expect(streamer.requests.allSatisfy { $0.provider == .openai })
    }

    @Test func withoutAKeyEachPageSaysSo() {
        let m = model(ByokSettings())
        m.read(1...2, lang: .tr)
        #expect(m.readings[1]?.state == .failed)
        #expect(m.readings[1]?.error == "no-key")
    }

    @Test func stopCancelsTheJobAndKeepsWhatWasRead() async throws {
        let batcher = FakeBatcher()
        let m = model(batcher: batcher)
        m.read(1...1, lang: .tr)
        await until { m.readings[1]?.state == .done }
        m.read(4...8, lang: .tr)
        await until { m.inBatch == 5 }
        #expect(m.stop() == 5)
        #expect(m.pending == 0)
        #expect(m.done.map(\.page) == [1], "what was read stays")
        await until { true }
        try await Task.sleep(for: .milliseconds(50))
        #expect(await batcher.cancelled == ["batches/job-1"])
    }

    @Test func readingsAreKeptWithTheBookAndAJobStillLands() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("peryda-readings-\(UUID().uuidString)")
        let store = try LibraryStore(root: root)
        let batcher = FakeBatcher()
        let first = model(batcher: batcher, store: store)
        first.read(1...1, lang: .tr)
        await until { first.readings[1]?.state == .done }
        first.read(5...7, lang: .tr)
        await until { first.inBatch == 3 }
        // The book is closed and opened again; the job finishes meanwhile.
        await batcher.setStatus(.done(texts: ["5": "Beş", "6": "Altı", "7": "Yedi"], errors: [:]))
        let again = model(batcher: batcher, store: store)
        #expect(again.readings[1]?.text == "Kavramlar, sınırlarında netleşir.")
        await until { again.pending == 0 }
        #expect(again.done.map(\.page) == [1, 5, 6, 7])
        #expect(store.readings(for: "book").count == 4)
        try store.deleteBook("book")
    }

    @Test func aPageStreamingWhenTheAppClosedIsMarkedUnfinished() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("peryda-readings-\(UUID().uuidString)")
        let store = try LibraryStore(root: root)
        try store.saveReadings([PageReading(page: 2, text: "Yarım", state: .reading), PageReading(page: 3, state: .waiting)], for: "book")
        let m = model(store: store)
        #expect(m.readings[2]?.state == .failed)
        #expect(m.readings[2]?.error == "interrupted")
        #expect(m.readings[3]?.state == .failed, "waiting for a direct request that never ran")
    }

    /// A long scanned range goes as several jobs, each under Google's limit, pictures drawn job by job.
    @Test func aLongRangeIsSentJobByJob() async throws {
        let batcher = FakeBatcher()
        var drawn = 0
        let m = PageReadings(bookId: "book", bookTitle: "Freud", pageCount: 20, settings: keyed, store: nil, streamer: RecordingStreamer(), batcher: batcher) { _ in
            drawn += 1
            return "data:image/jpeg;base64," + String(repeating: "C", count: 4_000_000)
        }
        m.read(1...7, lang: .tr)
        await until { m.inBatch == 7 }
        #expect(await batcher.created.map(\.items.count) == [3, 3, 1])
        #expect(drawn == 7)
    }

    /// A page read again while an old job's answer was on its way keeps its new state (audit WW-4).
    @Test func anOldJobDoesNotFailAPageReadAgain() async throws {
        let batcher = FakeBatcher()
        let m = model(batcher: batcher)
        m.read(4...6, lang: .tr)
        await until { m.inBatch == 3 }
        m.read(5...5, lang: .tr)
        await until { m.readings[5]?.state == .done }
        await batcher.setStatusError(GeminiBatch.JobGone())
        await m.poll()
        #expect(m.readings[4]?.error == "expired")
        #expect(m.readings[5]?.state == .done, "read again: untouched by the old job")
    }

    /// The Gemini key changed (or the book is being deleted): pages stop waiting and say so; the jobs
    /// come back to be removed with the old key (audit K-3).
    @Test func forgettingJobs() async throws {
        let batcher = FakeBatcher()
        let m = model(batcher: batcher)
        m.read(2...4, lang: .tr)
        await until { m.inBatch == 3 }
        #expect(m.forgetBatchJobs(code: "key-changed") == ["batches/job-1"])
        #expect(m.pending == 0)
        #expect(m.readings[3]?.error == "key-changed")
        let (stored, jobs) = PageReadings.forgettingBatchJobs([PageReading(page: 1, state: .waiting, job: "batches/x"), PageReading(page: 2, text: "t", state: .done)], code: "key-changed")
        #expect(jobs == ["batches/x"])
        #expect(stored[0].state == .failed && stored[0].job == nil && stored[1].state == .done)
    }

    /// A book deleted while one of its pages was being read is not written back (audit MA-8).
    @Test func aDeletedBookIsNotWrittenBack() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("peryda-readings-\(UUID().uuidString)")
        let store = try LibraryStore(root: root)
        let book = try store.importBook(data: Data("%PDF-1.4 x".utf8), fileName: "x.pdf", title: "X", author: nil, pageCount: 1)
        try store.deleteBook(book.id)
        try store.saveReadings([PageReading(page: 1, text: "metin", state: .done)], for: book.id)
        try store.saveCards([], for: book.id)
        try store.addJournal(JournalRecord(bookId: book.id, source: .note, quote: "", text: "not", pageNumber: 1))
        store.savePosition(ReadingPosition(bookId: book.id, cfi: nil, panX: 0, panY: 0, scale: 1, page: 1, updatedAt: 0))
        let left = try FileManager.default.subpathsOfDirectory(atPath: root.path).filter { $0.contains(book.id) }
        #expect(left.isEmpty, "\(left)")
        #expect(store.position(for: book.id) == nil)
    }
}
