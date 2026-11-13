import AppKit
import PDFKit
import PerydaKit
import SwiftUI
import XCTest

/// The page in the middle with room on both sides, page-by-page reading, and the whole reading
/// surface drawn for a visual check. All in an off-screen window.
@MainActor
final class LayoutAndPagingTests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let outDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())

    var store: LibraryStore!
    var reader: ReaderModel!
    var window: NSWindow!
    var world: WorldView!

    override func setUp() async throws {
        UserDefaults.standard.removeObject(forKey: "pagedReading")
        store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-layout-\(UUID().uuidString)"))
        let source = try XCTUnwrap(PDFDocument(url: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf")))
        let doc = PDFDocument()
        for i in 0..<3 { doc.insert(try XCTUnwrap(source.page(at: 0)?.copy() as? PDFPage), at: i) }
        let book = try store.importBook(data: try XCTUnwrap(doc.dataRepresentation()), fileName: "uc.pdf", title: "Üç Sayfa", author: nil, pageCount: 3)
        reader = try XCTUnwrap(ReaderModel(book: book, store: store, lang: .tr, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), streamer: InstantStreamer()))
        let reader = self.reader!
        world = WorldView(model: reader) { id in AnyView(YarnCardView(cardId: id, reader: reader, lang: .tr, openSettings: {})) }
        window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 1400, height: 900), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = world
        window.orderFrontRegardless()
        window.layoutIfNeeded()
        world.layoutSubtreeIfNeeded()
    }

    override func tearDown() async throws {
        window.orderOut(nil)
        UserDefaults.standard.removeObject(forKey: "pagedReading")
    }

    func anchor(page: Int, y: Double, text: String) -> YarnAnchor {
        let r = NormalizedRect(x: 0.1, y: y, width: 0.6, height: 0.02)
        return YarnAnchor(sourceType: .pdfText, bookId: reader.book.id, pageNumber: page, selectedText: text, lineRects: [r], boundingRect: r)
    }

    func makeCard(_ anchors: [YarnAnchor], color: YarnColor = .mint) async throws -> YarnCard {
        reader.pending = PendingSelection(anchors: anchors, rect: .zero)
        reader.create(color: color, kind: .quick(color))
        await reader.cards.waitForIdle()
        reader.pending = nil
        world.sync()
        return try XCTUnwrap(reader.cards.cards.last)
    }

    func pageView(_ n: Int) throws -> PageView {
        try XCTUnwrap(world.documentView.subviews.compactMap { $0 as? PageView }.first { $0.number == n })
    }

    func testThePageStaysCentredWhenZoomedOut() throws {
        for m in [0.3, 0.5, 0.77, 1.0] {
            world.scrollView.magnification = m
            world.perform(.focus, animated: false)
            world.scrollView.magnification = m
            world.scrollView.reflectScrolledClipView(world.scrollView.contentView)
            let page = try pageView(1)
            let mid = page.convert(CGPoint(x: page.bounds.midX, y: 0), to: nil).x
            XCTAssertEqual(mid, window.frame.width / 2, accuracy: 2, "page centre at \(Int(m * 100))%")
        }
        let w = reader.worldRect
        XCTAssertEqual(w.midX, Geometry.pageWorldWidth / 2, accuracy: 0.01, "room on both sides")
        XCTAssertLessThan(w.minX, -400)
    }

    func testACardMovedLeftOfThePageTakesItsYarnOnTheRight() async throws {
        let card = try await makeCard([anchor(page: 1, y: 0.3, text: "Kavramlar sınırlarda netleşir.")])
        reader.cards.pin(card.id, x: -520, y: 200)
        world.sync()
        let seg = try XCTUnwrap(reader.segments.first)
        XCTAssertEqual(seg.to.x, -520 + card.width, accuracy: 0.01, "yarn ends on the card's right edge")
        XCTAssertEqual(seg.from.x, reader.pages[0].x + 0.1 * reader.pages[0].width, accuracy: 0.01, "from the passage's left end")
        XCTAssertLessThan(reader.worldRect.minX, -520)
        XCTAssertEqual(reader.worldRect.midX, Geometry.pageWorldWidth / 2, accuracy: 0.01)
    }

    /// Beyond the outermost thread or translation there is always plenty of room, on both sides.
    func testThereIsRoomBeyondTheOutermostThingOnBothSides() async throws {
        let card = try await makeCard([anchor(page: 1, y: 0.3, text: "Kavramlar sınırlarda netleşir.")])
        reader.cards.pin(card.id, x: 2600, y: 200)
        world.sync()
        let w = reader.worldRect
        XCTAssertGreaterThanOrEqual(w.maxX - (2600 + card.width), ReaderModel.roomAround - 0.5, "room right of the farthest card")
        XCTAssertGreaterThanOrEqual(0 - w.minX, ReaderModel.roomAround, "and as much on the left")
        XCTAssertEqual(w.midX, Geometry.pageWorldWidth / 2, accuracy: 0.01, "the page stays in the middle")
        // The camera fits the content, not the empty room.
        XCTAssertLessThan(reader.centredContentWidth, w.width - 2 * ReaderModel.roomAround + 100)
    }

    func testPageByPageShowsOnePageAndItsThreads() async throws {
        let first = try await makeCard([anchor(page: 1, y: 0.3, text: "Birinci sayfa")])
        let across = try await makeCard([anchor(page: 1, y: 0.97, text: "son satır"), anchor(page: 2, y: 0.03, text: "ilk satır")], color: .sky)
        let second = try await makeCard([anchor(page: 2, y: 0.4, text: "İkinci sayfa")], color: .coral)
        XCTAssertEqual(reader.homePage(of: across), 1, "a thread across two pages belongs to the first")

        reader.currentPage = 1
        reader.pagedReading = true
        world.sync()
        XCTAssertFalse(try pageView(1).isHidden)
        XCTAssertTrue(try pageView(2).isHidden)
        XCTAssertEqual(Set(reader.segments.map(\.cardId)), [first.id, across.id])
        // The view cannot scroll off the page.
        world.scrollView.contentView.scroll(to: CGPoint(x: 0, y: reader.pages[1].y + 200))
        world.scrollView.reflectScrolledClipView(world.scrollView.contentView)
        XCTAssertLessThan(world.scrollView.contentView.bounds.minY, reader.pages[1].y)

        world.turnPage(1)
        XCTAssertEqual(reader.currentPage, 2)
        XCTAssertTrue(try pageView(1).isHidden)
        XCTAssertFalse(try pageView(2).isHidden)
        XCTAssertEqual(reader.segments.map(\.cardId), [second.id])
        // Each page lays out its own threads: the second page's card sits level with its passage.
        let anchorY = Geometry.anchorWorldPoint(second.anchors[0].boundingRect, page: reader.pages[1]).y
        XCTAssertEqual(try XCTUnwrap(reader.placements[second.id]).y, anchorY - 14, accuracy: 0.5)

        world.turnPage(5)
        XCTAssertEqual(reader.currentPage, 3, "turning stops at the last page")
        reader.pagedReading = false
        world.sync()
        XCTAssertFalse(try pageView(1).isHidden)
        XCTAssertEqual(reader.segments.count, 4)
    }

    /// The whole reading surface, toolbar aside, for a look: page centred, a card on each side, the
    /// floating camera bar.
    func testSurfaceSnapshot() async throws {
        let app = AppModel(store: store, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), lang: .tr)
        let long = "Hoca vize hakkında şunları söyledi: sınav 60 dakika sürer, çoktan seçmeli ve boşluk doldurma sorularından oluşur ve 1–6. dersleri kapsar. Hoca genel değerlendirmede bazı kavram çiftlerini özellikle sık karıştırılan kavramlar olarak ayırdı."
        _ = try await makeCard([anchor(page: 1, y: 0.2, text: long)], color: .amber)
        let left = try await makeCard([anchor(page: 1, y: 0.45, text: "Kavramlar sınırlarda netleşir.")], color: .sky)
        reader.cards.pin(left.id, x: -470, y: 330)
        let surface = ReaderSurface(reader: reader).environment(app)
        window.contentView = NSHostingView(rootView: surface)
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(400))
        reader.cameraCommand = .overview
        try await Task.sleep(for: .milliseconds(400))
        let content = try XCTUnwrap(window.contentView)
        content.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent("peryda-mac-layout.png"))

        reader.currentPage = 1
        reader.pagedReading = true
        reader.cameraCommand = .map
        try await Task.sleep(for: .milliseconds(500))
        content.layoutSubtreeIfNeeded()
        let paged = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: paged)
        try paged.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent("peryda-mac-paged.png"))
    }
}
