import AppKit
import PDFKit
import PerydaKit
import SwiftUI
import XCTest

/// Fifty threads on one page: how long layout, a drag frame, a scroll frame and a zoom step take.
/// A frame at 120 Hz has 8.3 ms; at 60 Hz 16.7 ms.
@MainActor
final class ManyThreadsTests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    var store: LibraryStore!
    var reader: ReaderModel!
    var window: NSWindow!
    var world: WorldView!

    override func setUp() async throws {
        store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-many-\(UUID().uuidString)"))
        let data = try Data(contentsOf: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf"))
        let book = try store.importBook(data: data, fileName: "okuma.pdf", title: "Yavaş Okuma", author: nil, pageCount: 1)
        reader = try XCTUnwrap(ReaderModel(book: book, store: store, lang: .tr, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), streamer: InstantStreamer()))
        let reader = self.reader!
        world = WorldView(model: reader) { id in AnyView(YarnCardView(cardId: id, reader: reader, lang: .tr, openSettings: {})) }
        window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 1400, height: 900), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = world
        window.orderFrontRegardless()
        window.layoutIfNeeded()
    }

    override func tearDown() async throws { window.orderOut(nil) }

    func ms(_ start: UInt64) -> Double { Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000 }

    func addThreads(_ n: Int) async {
        for i in 0..<n {
            let y = 0.05 + 0.9 * Double(i) / Double(n)
            let r = NormalizedRect(x: 0.1, y: y, width: 0.6, height: 0.015)
            let text = "İlmek \(i + 1): " + String(repeating: "uzunca bir seçili metin parçası ", count: 1 + i % 4)
            reader.pending = PendingSelection(anchors: [YarnAnchor(sourceType: .pdfText, bookId: reader.book.id, pageNumber: 1, selectedText: text, lineRects: [r], boundingRect: r)], rect: .zero)
            reader.create(color: YarnColor.allCases[i % 5], kind: .quick(YarnColor.allCases[i % 5]))
        }
        reader.pending = nil
        await reader.cards.waitForIdle()
    }

    func testFiftyThreadsOnOnePage() async throws {
        var t = DispatchTime.now().uptimeNanoseconds
        await addThreads(50)
        world.sync()
        for _ in 0..<5 {
            window.displayIfNeeded()
            try await Task.sleep(for: .milliseconds(50))
            world.sync()
        }
        let settle = ms(t)
        XCTAssertEqual(reader.heights.count, 50, "every card measured itself")

        t = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<20 { _ = reader.placements }
        let placements = ms(t) / 20

        t = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<20 { world.sync() }
        let sync = ms(t) / 20

        // Drag one card for 60 frames, yarn ropes included.
        let id = try XCTUnwrap(reader.cards.cards.first?.id)
        t = DispatchTime.now().uptimeNanoseconds
        for i in 1...60 {
            world.cardDragChanged(id, translation: CGSize(width: Double(i) * 3, height: Double(i)))
            world.refreshYarns(dt: 1.0 / 120)
            window.displayIfNeeded()
        }
        let drag = ms(t) / 60
        world.cardDragEnded(id, translation: CGSize(width: 180, height: 60))

        // Scroll down the lane and back, drawing each frame.
        let clip = world.scrollView.contentView
        t = DispatchTime.now().uptimeNanoseconds
        for i in 0..<120 {
            clip.scroll(to: CGPoint(x: clip.bounds.minX, y: Double(i < 60 ? i : 120 - i) * 40))
            world.scrollView.reflectScrolledClipView(clip)
            window.displayIfNeeded()
        }
        let scroll = ms(t) / 120

        // Zoom out and in step by step, drawing each step.
        t = DispatchTime.now().uptimeNanoseconds
        for i in 0..<40 {
            world.scrollView.magnification = i < 20 ? 1 - Double(i) * 0.035 : 0.3 + Double(i - 20) * 0.035
            window.displayIfNeeded()
        }
        let zoom = ms(t) / 40

        // One answer streaming in while the other 49 sit there.
        t = DispatchTime.now().uptimeNanoseconds
        reader.cards.ask(id, "Biraz daha aç")
        await reader.cards.waitForIdle()
        world.sync()
        window.displayIfNeeded()
        let ask = ms(t)

        let report = String(format: "PERF 50 threads: settle %.0f ms, placements %.2f ms, sync %.2f ms, drag frame %.2f ms, scroll frame %.2f ms, zoom frame %.2f ms, follow-up %.0f ms", settle, placements, sync, drag, scroll, zoom, ask)
        print(report)
        XCTAssertLessThan(drag, 16.7, report)
        XCTAssertLessThan(scroll, 16.7, report)
        // With fifty threads on one page they now fill both margin lanes, so zoomed out about twice as
        // many cards are on screen at once (14 ms a frame with all of them in the right lane, 27 ms in
        // two lanes on the reference Mac). A frame under 33 ms keeps pinching at 30 fps or better.
        XCTAssertLessThan(zoom, 33.4, report)
    }
}

