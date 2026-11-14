import Foundation
import Testing
@testable import PerydaKit

/// A backup Peryda makes must restore in Peryda; a crafted one must not make a book slow or stuck
/// (audit MA-2, MA-11, MA-14, 15 Nov).
@Suite("Backup size and restore checks")
struct BackupLimitsTests {
    func store() throws -> LibraryStore {
        try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-blimits-\(UUID().uuidString)"))
    }

    func translation(_ book: String, page: Int, picture: String) -> YarnCard {
        let anchor = YarnAnchor(sourceType: .pdfArea, bookId: book, pageNumber: page, selectedText: "", lineRects: [], boundingRect: .zero, croppedImage: picture)
        var card = YarnCard(bookId: book, color: .sky, kind: .translate, anchors: [anchor], messages: [YarnMessage(role: .user, content: "ÇEVİRİ"), YarnMessage(role: .assistant, content: "Sayfa \(page)")])
        card.translatedPage = page
        card.translationLanguage = "tr"
        return card
    }

    @Test func pagePicturesStayOutOfTheBackupSoItRestores() throws {
        let source = try store()
        let book = try source.importBook(data: Data("%PDF-1.4 kitap".utf8), fileName: "k.pdf", title: "K", author: nil, pageCount: 42)
        let picture = "data:image/jpeg;base64," + String(repeating: "A", count: 5_000_000)
        try source.saveCards((1...42).map { translation(book.id, page: $0, picture: picture) }, for: book.id)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("peryda-roundtrip-\(UUID().uuidString).zip")
        try Backup.export(store: source, to: file)
        let target = try store()
        #expect(try Backup.restore(store: target, from: file) == 1)
        let cards = target.cards(for: book.id)
        #expect(cards.count == 42)
        #expect(cards.allSatisfy { $0.anchors.first?.croppedImage == nil })
        #expect(cards.first { $0.translatedPage == 7 }?.messages.last?.content == "Sayfa 7")
    }

    @Test func aLibraryTooLargeToRestoreIsNotWrittenAndTheOldBackupStays() throws {
        let source = try store()
        let book = try source.importBook(data: Data("%PDF-1.4 kitap".utf8), fileName: "k.pdf", title: "K", author: nil, pageCount: 1)
        var card = YarnCard(bookId: book.id, color: .mint, kind: .quick(.mint), anchors: [], messages: [YarnMessage(role: .assistant, content: String(repeating: "x", count: 3_000))])
        card.translatedPage = nil
        try source.saveCards([card], for: book.id)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("peryda-old-\(UUID().uuidString).zip")
        try Data("previous backup".utf8).write(to: file)
        #expect(throws: Backup.Failure.tooLarge) { try Backup.export(store: source, to: file, limits: .init(manifest: 1_000)) }
        #expect(try Data(contentsOf: file) == Data("previous backup".utf8), "a failed export leaves the old file")
        try Backup.export(store: source, to: file)
        #expect(try Backup.restore(store: try store(), from: file) == 1)
    }

    @Test func restoreDropsDuplicatesLoopsAndHugeTexts() throws {
        let a = YarnCard(id: "card-a", bookId: "b", color: .mint, kind: .quick(.mint), anchors: [], parentCardId: "card-b", messages: [YarnMessage(role: .assistant, content: String(repeating: "y", count: Backup.maxText + 10))])
        let b = YarnCard(id: "card-b", bookId: "b", color: .mint, kind: .quick(.mint), anchors: [], parentCardId: "card-a", messages: [])
        let selfParent = YarnCard(id: "card-c", bookId: "b", color: .mint, kind: .quick(.mint), anchors: [], parentCardId: "card-c", messages: [])
        let duplicate = YarnCard(id: "card-a", bookId: "b", color: .coral, kind: .quick(.coral), anchors: [], messages: [])
        let entry = JournalRecord(id: "j", bookId: "b", source: .note, quote: "", text: "bir", pageNumber: 1)
        let m = Backup.Manifest(format: Backup.format, version: Backup.version, createdAt: 0, books: [], cards: [a, b, selfParent, duplicate], journal: [entry, entry], positions: [], prefs: [])
        let out = Backup.sane(m)
        #expect(out.cards.map(\.id) == ["card-a", "card-b", "card-c"], "one per id, the first")
        #expect(out.cards[0].color == .mint)
        #expect(out.cards.first { $0.id == "card-c" }?.parentCardId == nil, "not its own parent")
        // The loop a → b → a is broken.
        let parents = Dictionary(uniqueKeysWithValues: out.cards.map { ($0.id, $0.parentCardId) })
        #expect((parents["card-a"] ?? nil) == nil || (parents["card-b"] ?? nil) == nil)
        #expect(out.cards[0].messages[0].content.count == Backup.maxText)
        #expect(out.journal.count == 1)
    }
}
