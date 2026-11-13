import Foundation
import Testing
@testable import PerydaKit

struct FakeStreamer: AnswerStreaming {
    var pieces: [String] = ["Mer", "haba"]
    var error: AIError?

    func stream(_ request: AIRequest) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { c in
            for p in pieces { c.yield(p) }
            if let error { c.finish(throwing: error) } else { c.finish() }
        }
    }
}

func tempStore() throws -> LibraryStore {
    try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-tests-\(UUID().uuidString)"))
}

let keyed = ByokSettings(activeProvider: .gemini, geminiApiKey: "AIza-placeholder-not-real")

@Suite("Library store")
struct LibraryStoreTests {
    @Test func importsOnceAndDeletesEverything() throws {
        let store = try tempStore()
        let data = Data("%PDF-1.7 sample".utf8)
        let a = try store.importBook(data: data, fileName: "Kitap_adi.pdf", title: nil, author: nil, pageCount: 3)
        let b = try store.importBook(data: data, fileName: "kopya.pdf", title: "Başka", author: nil, pageCount: 3)
        #expect(a.id == b.id)
        #expect(a.title == "Kitap adi")
        #expect(store.books().count == 1)
        try store.addJournal(JournalRecord(bookId: a.id, source: .clip, quote: "q", text: "", pageNumber: 1))
        try store.deleteBook(a.id)
        #expect(store.books().isEmpty)
        #expect(store.journal(for: a.id).isEmpty)
        let file = try store.fileURL(for: a)
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }

    @Test func refusesOtherFiles() throws {
        let store = try tempStore()
        #expect(throws: LibraryStore.ImportError.self) {
            try store.importBook(data: Data("x".utf8), fileName: "notes.txt", title: nil, author: nil, pageCount: 0)
        }
    }

    @Test func cardsUseTheWebFieldNames() throws {
        let card = YarnCard(bookId: "b", color: .mint, kind: .question, anchors: [])
        let json = String(decoding: try JSONEncoder().encode(card), as: UTF8.self)
        for field in ["\"isPinned\"", "\"collapsed\"", "\"kind\":\"question\"", "\"color\":\"mint\"", "\"bookId\""] {
            #expect(json.contains(field))
        }
    }

    @Test func memoryVaultRoundTrips() throws {
        let vault = MemoryVault()
        try vault.save(keyed)
        #expect(vault.load() == keyed)
        try vault.clear()
        #expect(vault.load() == ByokSettings())
    }
}

@MainActor
@Suite("Cards model")
struct CardsModelTests {
    let anchor = YarnAnchor(sourceType: .pdfText, bookId: "book", pageNumber: 2, selectedText: "Kavramlar sınırlarda netleşir.", lineRects: [], boundingRect: .zero)

    @Test func quickThreadStreamsAndSaves() async throws {
        let store = try tempStore()
        let model = CardsModel(bookId: "book", bookTitle: "Deneme", lang: .tr, settings: keyed, store: store, streamer: FakeStreamer())
        let card = model.create(color: .mint, kind: .quick(.mint), anchors: [anchor])
        await model.waitForIdle()
        let saved = try #require(model.cards.first)
        #expect(saved.messages.count == 2)
        #expect(saved.messages[1].content == "Merhaba")
        #expect(saved.messages[1].state == nil)
        #expect(store.cards(for: "book").first?.id == card.id)
    }

    @Test func noKeyAsksForSettings() async {
        let model = CardsModel(bookId: "book", bookTitle: "Deneme", lang: .tr, settings: ByokSettings(), store: nil, streamer: FakeStreamer())
        model.create(color: .coral, kind: .quick(.coral), anchors: [anchor])
        await model.waitForIdle()
        #expect(model.cards[0].messages.last?.content == "no-key")
        #expect(model.cards[0].messages.last?.state == .error)
    }

    @Test func ownNoteNeverCallsTheProvider() async {
        let model = CardsModel(bookId: "book", bookTitle: "Deneme", lang: .tr, settings: keyed, store: nil, streamer: FakeStreamer(error: AIError(.unknown)))
        model.create(color: .cream, kind: .quick(.cream), anchors: [anchor], text: "Benim notum")
        await model.waitForIdle()
        #expect(model.cards[0].messages.map(\.content) == ["Benim notum"])
    }

    @Test func providerErrorsAreKeptForRetry() async {
        let model = CardsModel(bookId: "book", bookTitle: "Deneme", lang: .tr, settings: keyed, store: nil, streamer: FakeStreamer(pieces: [], error: AIError(.quota)))
        let card = model.create(color: .sky, kind: .question, anchors: [anchor], text: "Neden?")
        await model.waitForIdle()
        #expect(model.cards[0].messages.last?.content == "quota")
        model.retry(card.id)
        await model.waitForIdle()
        #expect(model.cards[0].messages.filter { $0.state == .error }.count == 1)
    }

    @Test func removingAParentRemovesItsThreads() async {
        let model = CardsModel(bookId: "book", bookTitle: "Deneme", lang: .tr, settings: keyed, store: nil, streamer: FakeStreamer())
        let parent = model.create(color: .mint, kind: .quick(.mint), anchors: [anchor])
        let childAnchor = YarnAnchor(sourceType: .card, bookId: "book", pageNumber: 0, selectedText: "x", lineRects: [], boundingRect: .zero, sourceCardId: parent.id)
        model.create(color: .sky, kind: .quick(.sky), anchors: [childAnchor], parentCardId: parent.id)
        await model.waitForIdle()
        model.remove(parent.id)
        #expect(model.cards.isEmpty)
    }

    @Test func interruptedAnswersAreRepairedOnLoad() throws {
        let store = try tempStore()
        var card = YarnCard(bookId: "book", color: .mint, kind: .question, anchors: [anchor])
        card.messages = [YarnMessage(role: .user, content: "Soru"), YarnMessage(role: .assistant, content: "Yarım", state: .streaming)]
        try store.saveCards([card], for: "book")
        let model = CardsModel(bookId: "book", bookTitle: "Deneme", lang: .tr, settings: keyed, store: store, streamer: FakeStreamer())
        #expect(model.cards[0].messages[1].content == "Yarım …")
        #expect(model.cards[0].messages[1].state == nil)
    }
}
