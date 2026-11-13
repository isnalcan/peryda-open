import Foundation
import Testing
import ZIPFoundation
@testable import PerydaKit

@Suite("Backup (same format as the web engine)")
struct BackupTests {
    func seeded() throws -> (LibraryStore, BookRecord) {
        let store = try tempStore()
        let book = try store.importBook(data: Data("%PDF-1.7 backup".utf8), fileName: "deneme.pdf", title: "Deneme", author: nil, pageCount: 2)
        try store.addJournal(JournalRecord(bookId: book.id, source: .clip, quote: "alıntı", text: "", pageNumber: 2))
        var card = YarnCard(bookId: book.id, color: .amber, kind: .quick(.amber), anchors: [])
        card.messages = [YarnMessage(role: .user, content: "Sınav")]
        try store.saveCards([card], for: book.id)
        store.savePosition(ReadingPosition(bookId: book.id, panX: 1, panY: 2, scale: 1.5, page: 2, updatedAt: 3))
        return (store, book)
    }

    @Test func roundTripsIntoAnEmptyLibraryAndSkipsDuplicates() throws {
        let (store, book) = try seeded()
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("peryda-backup-\(UUID().uuidString).zip")
        try Backup.export(store: store, to: file)
        let fresh = try tempStore()
        #expect(try Backup.restore(store: fresh, from: file) == 1)
        #expect(fresh.books().first?.id == book.id)
        #expect(fresh.journal(for: book.id).count == 1)
        #expect(fresh.cards(for: book.id).first?.kind == .quick(.amber))
        #expect(fresh.position(for: book.id)?.scale == 1.5)
        #expect(try Data(contentsOf: fresh.fileURL(for: book)) == Data("%PDF-1.7 backup".utf8))
        #expect(try Backup.restore(store: fresh, from: file) == 0)
    }

    @Test func manifestUsesTheWebFieldNames() throws {
        let (store, _) = try seeded()
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("peryda-backup-\(UUID().uuidString).zip")
        try Backup.export(store: store, to: file)
        let archive = try ZIPFoundation.Archive(url: file, accessMode: .read)
        var json = Data()
        _ = try archive.extract(try #require(archive["peryda.json"])) { json.append($0) }
        let object = try #require(try JSONSerialization.jsonObject(with: json) as? [String: Any])
        #expect(object["format"] as? String == "peryda-backup")
        for key in ["books", "cards", "journal", "positions", "prefs", "createdAt", "version"] { #expect(object[key] != nil, "\(key)") }
    }

    @Test func refusesOtherFiles() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("not-a-backup-\(UUID().uuidString).zip")
        try Data("nope".utf8).write(to: file)
        #expect(throws: Backup.Failure.notABackup) { try Backup.restore(store: try tempStore(), from: file) }
    }
}

@Suite("Backup made in the browser")
struct WebBackupFixtureTests {
    @Test func restoresOnTheMac() throws {
        let fixture = Vectors.sharedDir.appendingPathComponent("fixtures/web-backup.zip")
        let store = try tempStore()
        #expect(try Backup.restore(store: store, from: fixture) == 1)
        let book = try #require(store.books().first)
        #expect(book.title == "Kenar Notları")
        let card = try #require(store.cards(for: book.id).first)
        #expect(card.kind == .quick(.lavender))
        #expect(card.collapsed)
        #expect(card.messages.last?.provider == .gemini)
        #expect(card.archiveLinks?.first?.bookTitle == "Bilgi Kuramı")
        #expect(store.journal(for: book.id).first?.source == .thread)
        #expect(store.position(for: book.id)?.scale == 0.8)
        #expect(try Data(contentsOf: store.fileURL(for: book)) == Data("%PDF-1.7\n".utf8))
    }
}
