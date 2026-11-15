import AppKit
import PerydaKit
import SwiftUI
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

    /// A thread goes into the journal once; after the conversation goes on, saving again updates that
    /// one entry (owner test 14 Nov: it could be saved again and again).
    func testAThreadIsSavedOnceAndItsEntryKeptUpToDate() async throws {
        let (_, reader) = try makeReader()
        reader.pending = PendingSelection(anchors: [anchor(reader, "Dikkat sınırlı bir kaynaktır.")], rect: .zero)
        reader.create(color: .mint, kind: .quick(.mint))
        await reader.cards.waitForIdle()
        let id = try XCTUnwrap(reader.cards.cards.first?.id)
        XCTAssertEqual(reader.journalState(id), .notSaved)
        reader.saveToJournal(id, lang: .tr)
        reader.saveToJournal(id, lang: .tr)
        XCTAssertEqual(reader.journal.count, 1, "saved once")
        XCTAssertEqual(reader.journalState(id), .saved)
        let entryId = try XCTUnwrap(reader.journal.first?.id)
        reader.cards.ask(id, "Bir örnek daha?")
        await reader.cards.waitForIdle()
        XCTAssertEqual(reader.journalState(id), .outdated)
        reader.saveToJournal(id, lang: .tr)
        XCTAssertEqual(reader.journal.count, 1, "still one entry")
        XCTAssertEqual(reader.journal.first?.id, entryId)
        XCTAssertTrue(reader.journal.first?.text.contains("**Bir örnek daha?**") == true)
        XCTAssertEqual(reader.journalState(id), .saved)
        XCTAssertEqual(reader.toast, "Günlükteki kayıt güncellendi")
        reader.deleteJournal(entryId)
        XCTAssertEqual(reader.journalState(id), .notSaved, "deleted from the journal: it can be saved again")
    }

    /// Long entries wrap inside the journal's width, at its narrowest and when it is widened (owner
    /// test 14 Nov: the text ran past the panel's right edge).
    func testJournalTextWrapsToThePanelsWidth() async throws {
        let (store, reader) = try makeReader()
        let long = "Metindeki somut örnekler, gelişim psikolojisinin temel taşlarını oluşturan klasik deney ve kuramsal yaklaşımların doğrudan birer yansımasıdır:\n\n- **Zihin Kuramı ve Yanlış İnanç Görevi (Alison Gopnik & Andrew Meltzoff):** Boya kalemi kutusundan mum çıkması örneği, gelişim psikolojisinde Smarties/Boya Kalemi Görevi (False-Belief Task) olarak bilinir.\n\nDüğmelerin aralığı açıldığında sayısının arttığının iddia edilmesi, Piaget'nin klasik Korunum Görevlerine (Conservation Tasks) dayanır."
        // A note: its text is always open (a thread's answer now opens on a click; the text view is the same).
        try store.addJournal(JournalRecord(bookId: reader.book.id, source: .note, quote: "Gelişim kuramcıları bunun gibi gözlemlerinden anlam çıkarmaya çalışırlar.", text: long, pageNumber: 1))
        reader.reloadJournal()
        let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 320, height: 900), styleMask: [.borderless], backing: .buffered, defer: false)
        let host = NSHostingView(rootView: JournalPanel(reader: reader, lang: .tr, openSettings: {}))
        window.contentView = host
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        for width in [320.0, 380, 520] {
            window.setContentSize(CGSize(width: width, height: 900))
            window.layoutIfNeeded()
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(200))
            window.displayIfNeeded()
            func texts(_ v: NSView) -> [AnswerTextView] { (v as? AnswerTextView).map { [$0] } ?? v.subviews.flatMap(texts) }
            let found = texts(host)
            XCTAssertFalse(found.isEmpty)
            for text in found {
                let frame = text.convert(text.bounds, to: host)
                XCTAssertLessThanOrEqual(frame.maxX, width - 15, "inside the panel at \(Int(width))")
                let used = text.layoutManager!.usedRect(for: text.textContainer!)
                XCTAssertLessThanOrEqual(used.width, frame.width + 0.5, "the text wraps to its view at \(Int(width))")
                XCTAssertLessThanOrEqual(used.height, frame.height + 0.5, "and its view is tall enough at \(Int(width))")
            }
            let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            let out = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())
            try rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent("peryda-mac-journal-\(Int(width)).png"))
        }
    }
}
