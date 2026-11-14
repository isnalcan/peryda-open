import CryptoKit
import Foundation
import Testing
@testable import PerydaKit

/// Draws page pictures, holding chosen pages until released, so work can be changed mid-drawing.
@MainActor
final class PictureGate {
    var drawing: Set<Int> = []
    var held: Set<Int> = []
    var size = 4

    func picture(_ page: Int) async -> String? {
        drawing.insert(page)
        while held.contains(page) { try? await Task.sleep(for: .milliseconds(5)) }
        return "data:image/jpeg;base64," + String(repeating: "A", count: size)
    }

    func until(_ check: () -> Bool) async {
        for _ in 0..<400 where !check() { try? await Task.sleep(for: .milliseconds(5)) }
    }
}

/// Fixes from the final check of 15 Nov (F-3, F-5, F-6, F-11).
@Suite("Final check fixes")
@MainActor
struct FinalFixesTests {
    func scanned(_ n: Int) -> CardsModel.PageSource {
        CardsModel.PageSource(page: n, text: "", scanned: true, width: 760, height: 983)
    }

    func model(streamer: AnswerStreaming = RecordingStreamer(), batcher: FakeBatcher) -> CardsModel {
        let m = CardsModel(bookId: "book", bookTitle: "Freud", lang: .tr, settings: keyed, store: nil, streamer: streamer, batcher: batcher)
        m.pageCount = 20
        return m
    }

    /// "Translate now" on the very page whose picture is being drawn: sent once, directly (F-3).
    @Test func translateNowOnThePageBeingDrawnSendsItOnce() async throws {
        let streamer = RecordingStreamer()
        let batcher = FakeBatcher()
        let m = model(streamer: streamer, batcher: batcher)
        let gate = PictureGate()
        gate.held = [2]
        m.pagePicture = { await gate.picture($0) }
        let ids = m.translatePages((1...3).map(scanned), target: .tr)
        await gate.until { gate.drawing.contains(2) }
        m.translateNow(ids[1])
        gate.held = []
        for _ in 0..<300 where await batcher.created.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        let sent = await batcher.created.flatMap { $0.items.map(\.key) }
        #expect(sent == [ids[0], ids[2]], "not in the job")
        await m.waitForIdle()
        #expect(streamer.requests.count == 1, "sent once, directly")
    }

    /// A key change while a page is drawn, just as a full group would go out: no job is made with the
    /// old key, and no failed page holds a job nobody asks about (F-3).
    @Test func aKeyChangeAsAGroupFillsMakesNoJob() async throws {
        let batcher = FakeBatcher()
        let m = model(batcher: batcher)
        let gate = PictureGate()
        gate.size = 9_000_000 // two pages are over the 15 MB of one job
        gate.held = [2]
        m.pagePicture = { await gate.picture($0) }
        m.translatePages((1...3).map(scanned), target: .tr)
        await gate.until { gate.drawing.contains(2) }
        #expect(m.detachBatchJobs(code: "key-changed").isEmpty)
        gate.held = []
        try await Task.sleep(for: .milliseconds(300))
        #expect(await batcher.created.isEmpty, "nothing sent with the old key")
        #expect(m.cards.allSatisfy { $0.batchJob == nil })
        #expect(m.unfinishedTranslations.isEmpty)
    }

    /// The restore check is linear: a chain of 16,000 threads took 27.7 s before (F-5).
    @Test func aLongChainOfThreadsIsCheckedQuickly() {
        let cards = (0..<16_000).map { i in
            YarnCard(id: "c\(i)", bookId: "b", color: .mint, kind: .quick(.mint), anchors: [], parentCardId: i == 0 ? nil : "c\(i - 1)", messages: [])
        }
        let m = Backup.Manifest(format: Backup.format, version: Backup.version, createdAt: 0, books: [], cards: cards, journal: [], positions: [], prefs: [])
        let start = Date()
        let out = Backup.sane(m).cards
        #expect(Date().timeIntervalSince(start) < 3)
        #expect(out.count == 16_000)
    }

    /// A loop of parents loses exactly the link that closes it; a thread leading into it keeps its own.
    @Test func aLoopOfParentsLosesOneLink() {
        func card(_ id: String, _ parent: String?) -> YarnCard {
            YarnCard(id: id, bookId: "b", color: .mint, kind: .quick(.mint), anchors: [], parentCardId: parent, messages: [])
        }
        let m = Backup.Manifest(format: Backup.format, version: Backup.version, createdAt: 0, books: [], cards: [card("tail", "a"), card("a", "b"), card("b", "c"), card("c", "a")], journal: [], positions: [], prefs: [])
        let out = Dictionary(uniqueKeysWithValues: Backup.sane(m).cards.map { ($0.id, $0.parentCardId) })
        #expect(out["tail"] == "a")
        #expect(out.values.filter { $0 == nil }.count == 1, "one link cut")
        for start in out.keys {
            var seen: Set<String> = [start]
            var current = out[start] ?? nil
            while let p = current {
                #expect(seen.insert(p).inserted, "no loop left")
                if !seen.insert(p).inserted && seen.count > 10 { break }
                current = out[p] ?? nil
            }
        }
    }

    /// A delete that fails leaves the book as it was, saving normally (F-6).
    @Test func aFailedDeleteLeavesTheBookSaving() throws {
        let store = try tempStore()
        let book = try store.importBook(data: Data("%PDF-1.4 f6".utf8), fileName: "f.pdf", title: "F", author: nil, pageCount: 1)
        let url = store.root.appendingPathComponent("library.json")
        var list = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [Any])
        list.append(["id": 1])
        let damaged = try JSONSerialization.data(withJSONObject: list)
        try damaged.write(to: url)
        let tag = SHA256.hash(data: damaged).prefix(6).map { String(format: "%02x", $0) }.joined()
        // Something already in the copy's place: the file is protected and cannot be written.
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent().appendingPathComponent("library.json.unreadable-\(tag)"), withIntermediateDirectories: true)
        #expect(store.books().map(\.id) == [book.id])
        #expect(throws: LibraryStore.Protected.self) { try store.deleteBook(book.id) }
        let card = YarnCard(bookId: book.id, color: .mint, kind: .quick(.mint), anchors: [], messages: [YarnMessage(role: .user, content: "Not")])
        try store.saveCards([card], for: book.id)
        #expect(store.cards(for: book.id).count == 1, "saved, not refused")
    }

    /// Export refuses a book with more finished readings than a restore takes (F-11).
    @Test func exportRefusesMoreReadingsThanRestoreTakes() throws {
        let store = try tempStore()
        let book = try store.importBook(data: Data("%PDF-1.4 f11".utf8), fileName: "r.pdf", title: "R", author: nil, pageCount: 3000)
        try store.saveReadings((1...(Backup.maxReadings + 1)).map { PageReading(page: $0, text: "t", state: .done) }, for: book.id)
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("peryda-f11-\(UUID().uuidString).zip")
        #expect(throws: Backup.Failure.tooLarge) { try Backup.export(store: store, to: out) }
        try store.saveReadings((1...Backup.maxReadings).map { PageReading(page: $0, text: "t", state: .done) }, for: book.id)
        try Backup.export(store: store, to: out)
        try? FileManager.default.removeItem(at: out)
    }
}
