import AppKit
import PDFKit
import PerydaKit
import SwiftUI
import XCTest

struct InstantStreamer: AnswerStreaming {
    func stream(_ request: AIRequest) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { c in
            c.yield("Kavram, ")
            c.yield("komşularıyla karşılaştırıldığında netleşir.")
            c.finish()
        }
    }
}

/// Exercises the reading surface in an off-screen window: nothing is shown on the user's screen.
@MainActor
final class ReaderSurfaceTests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let outDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())

    var store: LibraryStore!
    var book: BookRecord!
    var reader: ReaderModel!
    var window: NSWindow!
    var world: WorldView!

    override func setUp() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("peryda-mac-tests-\(UUID().uuidString)")
        store = try LibraryStore(root: root)
        let data = try Data(contentsOf: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf"))
        book = try store.importBook(data: data, fileName: "okuma.pdf", title: "Yavaş Okuma", author: nil, pageCount: 1)
        reader = try XCTUnwrap(ReaderModel(book: book, store: store, lang: .tr, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), streamer: InstantStreamer()))
        let reader = self.reader!
        world = WorldView(model: reader) { id in
            AnyView(YarnCardView(cardId: id, reader: reader, lang: .tr, openSettings: {}))
        }
        window = NSWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 1300, height: 900), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = world
        window.layoutIfNeeded()
        world.layoutSubtreeIfNeeded()
    }

    private func event(_ type: NSEvent.EventType, at windowPoint: CGPoint, clicks: Int = 1, flags: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: windowPoint, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
    }

    private func pageView(_ number: Int) throws -> PageView {
        try XCTUnwrap(world.documentView.subviews.compactMap { $0 as? PageView }.first { $0.number == number })
    }

    /// Window point for a point in page space.
    private func windowPoint(_ pageView: PageView, pagePoint: CGPoint) -> CGPoint {
        let n = pageView.geometry.normalized(fromPage: CGRect(origin: pagePoint, size: .zero))
        let local = CGPoint(x: n.x * pageView.bounds.width, y: n.y * pageView.bounds.height)
        return pageView.convert(local, to: nil)
    }

    private func selectSentence(_ text: String) throws -> PDFSelection {
        let found = try XCTUnwrap(reader.document!.findString(text, withOptions: []).first)
        let page = try XCTUnwrap(found.pages.first)
        let view = try pageView(reader.document!.index(for: page) + 1)
        let bounds = found.bounds(for: page)
        let start = windowPoint(view, pagePoint: CGPoint(x: bounds.minX + 1, y: bounds.midY))
        let end = windowPoint(view, pagePoint: CGPoint(x: bounds.maxX - 1, y: bounds.midY))
        view.mouseDown(with: event(.leftMouseDown, at: start))
        view.mouseDragged(with: event(.leftMouseDragged, at: CGPoint(x: (start.x + end.x) / 2, y: start.y)))
        view.mouseDragged(with: event(.leftMouseDragged, at: end))
        view.mouseUp(with: event(.leftMouseUp, at: end))
        return found
    }

    func testSelectionOpensTheMenuWithTheSentenceAndNormalizedRects() throws {
        _ = try selectSentence("Kavramlar, birbirlerinden ayrıldıkları sınırlarda netleşir.")
        let pending = try XCTUnwrap(reader.pending)
        XCTAssertEqual(pending.anchors.count, 1)
        let anchor = pending.anchors[0]
        XCTAssertTrue(anchor.selectedText.hasPrefix("Kavramlar"), anchor.selectedText)
        XCTAssertEqual(anchor.pageNumber, 1)
        XCTAssertGreaterThan(anchor.boundingRect.width, 0.2)
        XCTAssertLessThan(anchor.boundingRect.height, 0.05)
        XCTAssertTrue((0...1).contains(anchor.boundingRect.y))
        // Sent with it: the text around the selection, at most 1200 characters (owner, 17 Nov 2026).
        let context = try XCTUnwrap(anchor.context)
        XCTAssertTrue(context.contains("Kavramlar, birbirlerinden"), context)
        XCTAssertLessThanOrEqual(context.count, YarnAnchor.contextLength)
    }

    func testThreadOpensInTheLaneLevelWithItsSentenceAndTheCameraStaysPut() async throws {
        _ = try selectSentence("Kavramlar, birbirlerinden ayrıldıkları sınırlarda netleşir.")
        let cameraBefore = (world.scrollView.contentView.bounds.origin, world.scrollView.magnification)
        reader.create(color: .mint, kind: .quick(.mint))
        await reader.cards.waitForIdle()
        world.sync()
        let card = try XCTUnwrap(reader.cards.cards.first)
        XCTAssertEqual(card.messages.last?.content, "Kavram, komşularıyla karşılaştırıldığında netleşir.")
        let place = try XCTUnwrap(reader.placements[card.id])
        XCTAssertEqual(place.x, Geometry.laneX)
        let anchorY = Geometry.anchorWorldPoint(card.anchors[0].boundingRect, page: reader.pages[0]).y
        XCTAssertEqual(place.y, anchorY - 14, accuracy: 0.001)
        XCTAssertEqual(reader.segments.count, 1)
        XCTAssertEqual(world.scrollView.contentView.bounds.origin, cameraBefore.0)
        XCTAssertEqual(world.scrollView.magnification, cameraBefore.1)
    }

    func testTwoThreadsFromOneParagraphDoNotOverlap() async throws {
        _ = try selectSentence("Kavramlar, birbirlerinden ayrıldıkları sınırlarda netleşir.")
        reader.create(color: .mint, kind: .quick(.mint))
        _ = try selectSentence("arasındaki fark, ancak ikisinin")
        reader.create(color: .coral, kind: .quick(.coral))
        await reader.cards.waitForIdle()
        reader.heights = Dictionary(uniqueKeysWithValues: reader.cards.cards.map { ($0.id, 200.0) })
        let ys = reader.cards.cards.compactMap { reader.placements[$0.id]?.y }.sorted()
        XCTAssertEqual(ys.count, 2)
        XCTAssertGreaterThanOrEqual(ys[1] - ys[0], 200 + 18 - 0.001)
    }

    func testAreaSelectionCropsTheRegionAt2x() throws {
        let view = try pageView(1)
        let start = view.convert(CGPoint(x: 40, y: 60), to: nil)
        let end = view.convert(CGPoint(x: 400, y: 200), to: nil)
        view.mouseDown(with: event(.leftMouseDown, at: start, flags: .shift))
        view.mouseDragged(with: event(.leftMouseDragged, at: end, flags: .shift))
        view.mouseUp(with: event(.leftMouseUp, at: end, flags: .shift))
        let anchor = try XCTUnwrap(reader.pending?.anchors.first)
        XCTAssertEqual(anchor.sourceType, .pdfArea)
        let png = try XCTUnwrap(anchor.croppedImage)
        let image = try XCTUnwrap(NSImage(data: Data(base64Encoded: String(png.dropFirst("data:image/png;base64,".count)))!))
        XCTAssertGreaterThanOrEqual(image.representations.first?.pixelsWide ?? 0, 700)
        XCTAssertFalse(anchor.selectedText.isEmpty)
    }

    func testFoldingAThreadLeavesAKnotAndRemovesTheYarn() async throws {
        _ = try selectSentence("Kavramlar, birbirlerinden ayrıldıkları sınırlarda netleşir.")
        reader.create(color: .lavender, kind: .quick(.lavender))
        await reader.cards.waitForIdle()
        let id = try XCTUnwrap(reader.cards.cards.first?.id)
        reader.cards.setCollapsed(id, true)
        XCTAssertTrue(reader.segments.isEmpty)
        XCTAssertEqual(reader.knots(onPage: 1, lang: .tr).first?.label, "Derinleş")
    }

    /// Draws the surface (pages, highlights, yarns, cards) to a PNG for a visual check.
    func testSnapshot() async throws {
        _ = try selectSentence("Kavramlar, birbirlerinden ayrıldıkları sınırlarda netleşir.")
        reader.create(color: .mint, kind: .quick(.mint))
        _ = try selectSentence("arasındaki fark, ancak ikisinin")
        reader.create(color: .coral, kind: .question, text: "Komşu kavram ne demek?")
        await reader.cards.waitForIdle()
        reader.pending = nil
        world.sync()
        try drawSurface("peryda-mac-surface.png", origins: reader.placements)
    }

    func drawSurface(_ name: String, origins: [String: CGPoint]) throws {
        let size = CGSize(width: 1300, height: 760)
        let image = NSImage(size: size)
        image.lockFocusFlipped(true)
        let ctx = NSGraphicsContext.current!.cgContext
        Theme.paperSunken.setFill()
        CGRect(origin: .zero, size: size).fill()
        for view in world.documentView.subviews.compactMap({ $0 as? PageView }) {
            ctx.saveGState()
            ctx.translateBy(x: view.frame.minX + 20, y: view.frame.minY + 20)
            view.draw(view.bounds)
            ctx.restoreGState()
        }
        ctx.saveGState()
        ctx.translateBy(x: 20, y: 20)
        world.yarnView.draw(world.yarnView.bounds)
        ctx.restoreGState()
        for card in reader.cards.cards {
            guard let p = origins[card.id] else { continue }
            let renderer = ImageRenderer(content: YarnCardView(cardId: card.id, reader: reader, lang: .tr, openSettings: {}).frame(width: card.width))
            renderer.scale = 1
            if let cg = renderer.cgImage {
                let rect = CGRect(x: p.x + 20, y: p.y + 20, width: CGFloat(cg.width), height: CGFloat(cg.height))
                ctx.saveGState()
                ctx.translateBy(x: 0, y: rect.maxY)
                ctx.scaleBy(x: 1, y: -1)
                ctx.draw(cg, in: CGRect(x: rect.minX, y: 0, width: rect.width, height: rect.height))
                ctx.restoreGState()
            }
        }
        image.unlockFocus()
        let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let url = Self.outDir.appendingPathComponent(name)
        try rep.representation(using: .png, properties: [:])!.write(to: url)
        print("snapshot: \(url.path)")
    }

    /// The yarn follows a dragged card at once, trails it and sags a little while held, then swings
    /// back past its curve and settles after release. Frames are stepped by hand at 120 Hz.
    func testYarnFollowsTheDraggedCardAndSwingsLikeARope() async throws {
        try XCTSkipIf(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, "Reduce Motion is on: yarns only follow")
        _ = try selectSentence("Kavramlar, birbirlerinden ayrıldıkları sınırlarda netleşir.")
        reader.create(color: .mint, kind: .quick(.mint))
        await reader.cards.waitForIdle()
        reader.pending = nil
        world.sync()
        let card = try XCTUnwrap(reader.cards.cards.first)
        let start = try XCTUnwrap(reader.placements[card.id])

        // Pull the card to the right at 360 points a second for half a second.
        for i in 1...60 {
            world.cardDragChanged(card.id, translation: CGSize(width: Double(i) * 3, height: 0))
            world.refreshYarns(dt: 1.0 / 120)
        }
        let live = CGPoint(x: start.x + 180, y: start.y)
        let seg = try XCTUnwrap(world.yarnView.segments.first { $0.cardId == card.id })
        XCTAssertEqual(seg.to, Geometry.cardAttachPoint(x: live.x, y: live.y), "the yarn ends at the card while it moves")
        let held = try XCTUnwrap(world.yarnView.bends[seg.id])
        XCTAssertLessThan(held.x, -4, "the middle trails behind the movement")
        XCTAssertGreaterThan(held.y, 8, "and sags a little")
        var origins = reader.placements
        origins[card.id] = live
        try drawSurface("peryda-mac-rope-held.png", origins: origins)

        world.cardDragEnded(card.id, translation: CGSize(width: 180, height: 0))
        XCTAssertEqual(world.yarnView.segments.first { $0.cardId == card.id }?.to, Geometry.cardAttachPoint(x: live.x, y: live.y), "no jump back on release")
        XCTAssertEqual(reader.cards.cards.first?.isPinned, true)
        var swung = false
        var frames = 0
        while !world.ropes.isSettled, frames < 600 {
            world.refreshYarns(dt: 1.0 / 120)
            if let b = world.yarnView.bends[seg.id], b.y < -0.3 { swung = true }
            if frames == 10 { try drawSurface("peryda-mac-rope-release.png", origins: origins) }
            frames += 1
        }
        XCTAssertTrue(swung, "it swings slightly past the curve")
        XCTAssertTrue(world.ropes.isSettled)
        XCTAssertLessThan(frames, 240, "and settles within two seconds")
        XCTAssertTrue(world.yarnView.bends.isEmpty)
    }
}

@MainActor
final class SubThreadTests: XCTestCase {
    func testSelectingInsideACardOpensAThreadInTheNextLane() async throws {
        let base = ReaderSurfaceTests()
        try await base.setUp()
        let reader = base.reader!
        let world = base.world!
        reader.pending = PendingSelection(anchors: [YarnAnchor(sourceType: .pdfText, bookId: reader.book.id, pageNumber: 1, selectedText: "Kavramlar", lineRects: [NormalizedRect(x: 0.05, y: 0.3, width: 0.4, height: 0.02)], boundingRect: NormalizedRect(x: 0.05, y: 0.3, width: 0.4, height: 0.02))], rect: .zero)
        reader.create(color: .mint, kind: .quick(.mint))
        await reader.cards.waitForIdle()
        world.sync()
        let parent = try XCTUnwrap(reader.cards.cards.first)
        let parentPlace = try XCTUnwrap(reader.placements[parent.id])
        // A selection 60 units below the card's top, as the answer view would report it.
        let docRect = CGRect(x: parentPlace.x + 30, y: parentPlace.y + 60, width: 120, height: 18)
        let windowRect = world.documentView.convert(docRect, to: nil)
        world.cardTextSelected(parent.id, text: "komşularıyla", windowRect: windowRect)
        let pending = try XCTUnwrap(reader.pending)
        XCTAssertEqual(pending.parentCardId, parent.id)
        XCTAssertEqual(pending.anchors.first?.boundingRect.y ?? 0, 60, accuracy: 0.5)
        reader.create(color: .sky, kind: .quick(.sky))
        await reader.cards.waitForIdle()
        let child = try XCTUnwrap(reader.cards.cards.first { $0.parentCardId == parent.id })
        let childPlace = try XCTUnwrap(reader.placements[child.id])
        XCTAssertEqual(childPlace.x, Geometry.subLaneX(parentX: parentPlace.x, parentWidth: parent.width))
        XCTAssertEqual(reader.segments.filter { $0.id.hasPrefix(child.id) }.first?.from.x ?? 0, parentPlace.x + parent.width, accuracy: 0.01)
    }
}
