import AppKit
import PDFKit
import PerydaKit
import SwiftUI
import XCTest

/// The library (covers, search, opening from Finder) and the journal (notes, going to a page).
@MainActor
final class LibraryAndJournalTests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    func threePagePDF() throws -> URL {
        let source = try XCTUnwrap(PDFDocument(url: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf")))
        let doc = PDFDocument()
        for i in 0..<3 { doc.insert(try XCTUnwrap(source.page(at: 0)?.copy() as? PDFPage), at: i) }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("uc-\(UUID().uuidString).pdf")
        XCTAssertTrue(doc.write(to: url))
        return url
    }

    func testOpeningFromFinderAddsTheBookAndAsksTheLibraryToOpenIt() async throws {
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-lib-\(UUID().uuidString)"))
        let app = AppModel(store: store, settings: ByokSettings(), lang: .tr)
        app.open([try threePagePDF()])
        await app.importTask?.value
        let book = try XCTUnwrap(app.books.first)
        XCTAssertEqual(book.pageCount, 3)
        XCTAssertEqual(app.pendingOpen, book.id)
        app.updateBook(book.id, title: "Yavaş Okuma", author: "Peryda Örnek")
        XCTAssertEqual(app.books.first?.title, "Yavaş Okuma")
    }

    func testAPDFCoverIsItsFirstPage() async throws {
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-cover-\(UUID().uuidString)"))
        let book = try store.importBook(data: Data(contentsOf: try threePagePDF()), fileName: "uc.pdf", title: "Üç", author: nil, pageCount: 3)
        let cover = await Covers.load(book, store: store)
        let image = try XCTUnwrap(cover)
        XCTAssertGreaterThan(image.size.height, image.size.width, "a portrait page")
        XCTAssertNotNil(Covers.cached(book), "kept for the next look")
    }

    func testANoteGoesToTheJournalOnThePageBeingReadAndItsPageCanBeReached() async throws {
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-note-\(UUID().uuidString)"))
        let book = try store.importBook(data: Data(contentsOf: try threePagePDF()), fileName: "uc.pdf", title: "Üç", author: nil, pageCount: 3)
        let reader = try XCTUnwrap(ReaderModel(book: book, store: store, lang: .tr, settings: ByokSettings(), streamer: InstantStreamer()))
        let world = WorldView(model: reader) { _ in AnyView(EmptyView()) }
        let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 1400, height: 900), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = world
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        window.layoutIfNeeded()
        world.sync()

        world.perform(.goToPage(3), animated: false)
        XCTAssertEqual(reader.currentPage, 3)
        reader.addNote("  Bu sayfadaki fikir, ikinci bölümle çelişiyor.  ")
        reader.addNote("   ")
        XCTAssertEqual(reader.journal.count, 1, "an empty note is not saved")
        let entry = try XCTUnwrap(reader.journal.first)
        XCTAssertEqual(entry.source, .note)
        XCTAssertEqual(entry.pageNumber, 3)
        XCTAssertEqual(entry.text, "Bu sayfadaki fikir, ikinci bölümle çelişiyor.")

        world.perform(.goToPage(1), animated: false)
        XCTAssertEqual(reader.currentPage, 1)
        XCTAssertLessThan(abs(world.scrollView.contentView.bounds.minY - (reader.pages[0].y - 24)), 30, "the view is at the top of page 1")
        reader.pagedReading = true
        world.sync()
        world.perform(.goToPage(2), animated: false)
        XCTAssertEqual(reader.currentPage, 2)
        reader.pagedReading = false
        UserDefaults.standard.removeObject(forKey: "pagedReading")
    }
}

extension LibraryAndJournalTests {
    /// A cover cut short (Peryda quit while making it) is tried again at the next launch; after two
    /// attempts that never finished it is given up, so a cover that crashes the app cannot loop
    /// (audit MA-1, recheck MR-7).
    func testACoverCutShortIsTriedAgainOnceThenGivenUp() async throws {
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-cover-retry-\(UUID().uuidString)"))
        let data = try Data(contentsOf: try threePagePDF())
        let book = try store.importBook(data: data, fileName: "a.pdf", title: "A", author: nil, pageCount: 3)
        let files = try XCTUnwrap(Covers.files(book))
        try FileManager.default.createDirectory(at: Covers.folder, withIntermediateDirectories: true)
        try Data("1".utf8).write(to: files.trying)
        let cover = await Covers.load(book, store: store)
        XCTAssertNotNil(cover, "one unfinished attempt: tried again")
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.trying.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.none.path))
        Covers.remove(book)

        try Data("2".utf8).write(to: files.trying)
        let given = await Covers.load(book, store: store)
        XCTAssertNil(given, "two unfinished attempts: given up")
        XCTAssertTrue(FileManager.default.fileExists(atPath: files.none.path))
        Covers.remove(book)
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.trying.path))
    }

    func testLibrarySnapshot() async throws {
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-libsnap-\(UUID().uuidString)"))
        let app = AppModel(store: store, settings: ByokSettings(), lang: .tr)
        app.open([try threePagePDF()])
        await app.importTask?.value
        let pdf = try XCTUnwrap(app.books.first)
        app.updateBook(pdf.id, title: "Yavaş Okumanın Sanatı", author: "Peryda Örnek")
        store.savePosition(ReadingPosition(bookId: pdf.id, cfi: nil, panX: 0, panY: 0, scale: 1, page: 2, updatedAt: 0))
        store.markOpened(pdf.id)
        app.open([Self.repo.appendingPathComponent("web/dev-samples/kenar.epub")])
        await app.importTask?.value
        app.reloadBooks()
        let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 900, height: 560), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: NavigationStack { LibraryView() }.environment(app))
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(800))
        window.displayIfNeeded()
        let content = try XCTUnwrap(window.contentView)
        let rep = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: rep)
        let out = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())
        try rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent("peryda-mac-library.png"))
    }
}

extension LibraryAndJournalTests {
    func testCoversCloseToTheFrameFillItAndOthersAreShownWhole() {
        XCTAssertEqual(Covers.fit(CGSize(width: 300, height: 400)), .fill, "3:4")
        XCTAssertEqual(Covers.fit(CGSize(width: 420, height: 640)), .fill, "a usual book cover")
        XCTAssertEqual(Covers.fit(CGSize(width: 612, height: 792)), .fill, "US Letter")
        XCTAssertEqual(Covers.fit(CGSize(width: 1600, height: 1000)), .letterbox, "a two-page scan")
        XCTAssertEqual(Covers.fit(CGSize(width: 300, height: 900)), .letterbox, "a tall strip")
        XCTAssertEqual(Covers.fit(.zero), .letterbox)
    }

    /// A one-page PDF whose page is a picture of the given size.
    func pdf(_ size: CGSize, _ title: String) throws -> URL {
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor(srgbRed: 0.93, green: 0.92, blue: 0.88, alpha: 1).setFill()
        CGRect(origin: .zero, size: size).fill()
        (title as NSString).draw(at: CGPoint(x: 40, y: size.height / 2), withAttributes: [.font: NSFont.systemFont(ofSize: 60, weight: .bold), .foregroundColor: NSColor.black])
        NSColor.black.setStroke()
        NSBezierPath(rect: CGRect(origin: .zero, size: size).insetBy(dx: 10, dy: 10)).stroke()
        image.unlockFocus()
        let doc = PDFDocument()
        doc.insert(try XCTUnwrap(PDFPage(image: image)), at: 0)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(title)-\(UUID().uuidString).pdf")
        XCTAssertTrue(doc.write(to: url))
        return url
    }

    /// Wide, usual and tall covers side by side, for a look: each stays in its own frame.
    func testOddCoversStayInTheirFrames() async throws {
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-covers-\(UUID().uuidString)"))
        let app = AppModel(store: store, settings: ByokSettings(), lang: .tr)
        app.open([try pdf(CGSize(width: 1800, height: 1100), "GENIS"), try pdf(CGSize(width: 600, height: 900), "KITAP"), try pdf(CGSize(width: 500, height: 1500), "UZUN"), try threePagePDF()])
        await app.importTask?.value
        app.reloadBooks()
        XCTAssertEqual(app.books.count, 4)
        let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 1100, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: NavigationStack { LibraryView() }.environment(app))
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(1200))
        window.displayIfNeeded()
        let content = try XCTUnwrap(window.contentView)
        let rep = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: rep)
        let out = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())
        try rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent("peryda-mac-covers.png"))
    }
}

extension LibraryAndJournalTests {
    /// The AI settings: four providers, the recommended models marked, the note on calibration.
    func testSettingsSnapshot() async throws {
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-settings-\(UUID().uuidString)"))
        let app = AppModel(store: store, settings: ByokSettings(activeProvider: .gemini, geminiApiKey: "AIza-placeholder-0000000", claudeApiKey: "sk-ant-placeholder-0000"), lang: .tr)
        let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 560, height: 900), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: SettingsView().environment(app).frame(width: 560, height: 900))
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(600))
        window.displayIfNeeded()
        let content = try XCTUnwrap(window.contentView)
        let rep = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: rep)
        let out = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())
        try rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent("peryda-mac-settings.png"))
    }
}

extension LibraryAndJournalTests {
    /// The quiet drawing in the library's bottom-right corner, light and dark, once it has drawn itself.
    func testLibraryArtSnapshot() async throws {
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-art-\(UUID().uuidString)"))
        let app = AppModel(store: store, settings: ByokSettings(), lang: .tr)
        app.open([try threePagePDF(), Self.repo.appendingPathComponent("web/dev-samples/kenar.epub")])
        await app.importTask?.value
        app.reloadBooks()
        let out = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())
        for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 1280, height: 800), styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: appearance)
            window.contentView = NSHostingView(rootView: NavigationStack { LibraryView() }.environment(app))
            window.orderFrontRegardless()
            defer { window.orderOut(nil) }
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(3600))
            window.displayIfNeeded()
            let content = try XCTUnwrap(window.contentView)
            let rep = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
            content.cacheDisplay(in: content.bounds, to: rep)
            try rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent("peryda-mac-library-art-\(name).png"))
        }
    }
}

extension LibraryAndJournalTests {
    /// The Privacy tab: the shared text in the reader's language, for a look.
    func testPrivacySnapshot() async throws {
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-privacy-\(UUID().uuidString)"))
        let app = AppModel(store: store, settings: ByokSettings(), lang: .tr)
        XCTAssertEqual(PrivacyText.of(.tr).title, "Gizlilik")
        for lang in Lang.allCases { XCTAssertEqual(PrivacyText.of(lang).sections.count, PrivacyText.of(.en).sections.count, "\(lang)") }
        let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 600, height: 680), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: PrivacySettings().environment(app).frame(width: 600, height: 680))
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(500))
        window.displayIfNeeded()
        let content = try XCTUnwrap(window.contentView)
        let rep = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: rep)
        let out = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())
        try rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent("peryda-mac-privacy.png"))
    }
}
