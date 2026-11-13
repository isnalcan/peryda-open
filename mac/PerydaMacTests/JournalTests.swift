import AppKit
import PerydaKit
import XCTest

@MainActor
final class JournalTests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    func makeReader() throws -> (LibraryStore, ReaderModel) {
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-journal-\(UUID().uuidString)"))
        let data = try Data(contentsOf: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf"))
        let book = try store.importBook(data: data, fileName: "okuma.pdf", title: "Yavaş Okuma", author: nil, pageCount: 1)
        let reader = try XCTUnwrap(ReaderModel(book: book, store: store, lang: .tr, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), streamer: InstantStreamer()))
        return (store, reader)
    }

    func anchor(_ reader: ReaderModel, _ text: String) -> YarnAnchor {
        YarnAnchor(sourceType: .pdfText, bookId: reader.book.id, pageNumber: 1, selectedText: text, lineRects: [NormalizedRect(x: 0.1, y: 0.3, width: 0.5, height: 0.02)], boundingRect: NormalizedRect(x: 0.1, y: 0.3, width: 0.5, height: 0.02))
    }

    func testClipAndSaveGoToTheJournal() async throws {
        let (_, reader) = try makeReader()
        reader.pending = PendingSelection(anchors: [anchor(reader, "Kavramlar sınırlarda netleşir.")], rect: .zero)
        reader.clip(lang: .tr)
        XCTAssertEqual(reader.journal.first?.source, .clip)
        XCTAssertEqual(reader.toast, "Kitap Günlüğü'ne eklendi")
        reader.pending = PendingSelection(anchors: [anchor(reader, "Dikkat sınırlı bir kaynaktır.")], rect: .zero)
        reader.create(color: .mint, kind: .quick(.mint))
        await reader.cards.waitForIdle()
        reader.saveToJournal(try XCTUnwrap(reader.cards.cards.first?.id), lang: .tr)
        XCTAssertEqual(reader.journal.count, 2)
        XCTAssertEqual(reader.journal.first?.source, .thread)
        XCTAssertTrue(reader.journal.first?.text.contains("komşularıyla") == true)
    }

    func testJournalSummaryStreams() async throws {
        let (_, reader) = try makeReader()
        reader.pending = PendingSelection(anchors: [anchor(reader, "Kavramlar sınırlarda netleşir.")], rect: .zero)
        reader.clip(lang: .tr)
        reader.summarize(lang: .tr)
        for _ in 0..<50 where reader.summarizing { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(reader.summary?.text, "Kavram, komşularıyla karşılaştırıldığında netleşir.")
        XCTAssertNil(reader.summaryError)
    }

    func testEmptyJournalExplainsInsteadOfCalling() throws {
        let (_, reader) = try makeReader()
        reader.summarize(lang: .tr)
        XCTAssertEqual(reader.summaryError, "Özetlemek için önce günlüğe bir şeyler ekle.")
    }
}
