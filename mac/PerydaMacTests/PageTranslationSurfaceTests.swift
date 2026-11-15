import AppKit
import PDFKit
import PerydaKit
import SwiftUI
import XCTest

/// Google's batch service, played locally: records jobs, answers as told.
actor TestBatcher: PageBatching {
    var jobs: [[GeminiBatch.Item]] = []
    var status: GeminiBatch.Status = .waiting
    var createError: Error?
    var cancelled: [String] = []
    var deleted: [String] = []

    func set(_ s: GeminiBatch.Status) { status = s }
    func failCreating(_ e: Error?) { createError = e }

    func create(apiKey: String, model: String, items: [GeminiBatch.Item]) async throws -> String {
        if let createError { throw createError }
        jobs.append(items)
        return "batches/test-\(jobs.count)"
    }

    func status(apiKey: String, name: String) async throws -> GeminiBatch.Status { status }
    func cancel(apiKey: String, name: String) async { cancelled.append(name) }
    func delete(apiKey: String, name: String) async { deleted.append(name) }
}

/// Answers at once and keeps the requests, to check what was sent.
final class RecordingInstantStreamer: AnswerStreaming, @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [AIRequest] = []
    var requests: [AIRequest] { lock.withLock { _requests } }

    func stream(_ request: AIRequest) -> AsyncThrowingStream<String, Error> {
        lock.withLock { _requests.append(request) }
        return AsyncThrowingStream { c in
            c.yield("# Yavaş okumanın sanatı\n\nBir metni gerçekten okumak, gözün satırlar üzerinde kaymasından çok daha fazlasıdır.\n\n- Dikkat sınırlı bir kaynaktır.")
            c.finish()
        }
    }
}

/// Whole-page translation on the reading surface, in an off-screen window.
@MainActor
final class PageTranslationSurfaceTests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let outDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())

    var store: LibraryStore!
    var reader: ReaderModel!
    var batcher: TestBatcher!
    var streamer: RecordingInstantStreamer!
    var window: NSWindow!
    var world: WorldView!

    override func setUp() async throws {
        UserDefaults.standard.removeObject(forKey: "pagedReading")
        store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-ptrans-\(UUID().uuidString)"))
        let source = try XCTUnwrap(PDFDocument(url: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf")))
        let doc = PDFDocument()
        for i in 0..<4 { doc.insert(try XCTUnwrap(source.page(at: 0)?.copy() as? PDFPage), at: i) }
        let book = try store.importBook(data: try XCTUnwrap(doc.dataRepresentation()), fileName: "dort.pdf", title: "Dört Sayfa", author: nil, pageCount: 4)
        batcher = TestBatcher()
        streamer = RecordingInstantStreamer()
        reader = try XCTUnwrap(ReaderModel(book: book, store: store, lang: .tr, settings: ByokSettings(activeProvider: .gemini, geminiApiKey: "AIza-placeholder-not-real"), streamer: streamer, batcher: batcher))
        let reader = self.reader!
        var worldRef: WorldView?
        world = WorldView(model: reader) { id in
            let select: (String, String, CGRect) -> Void = { id, text, rect in worldRef?.cardTextSelected(id, text: text, windowRect: rect) }
            if reader.cards.cards.first(where: { $0.id == id })?.translatedPage != nil {
                return AnyView(TranslatedPageView(cardId: id, reader: reader, lang: .tr, openSettings: {}, onSelectText: select))
            }
            return AnyView(YarnCardView(cardId: id, reader: reader, lang: .tr, openSettings: {}, onSelectText: select, resizable: true))
        }
        worldRef = world
        window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 1600, height: 1000), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = world
        window.orderFrontRegardless()
        window.layoutIfNeeded()
    }

    override func tearDown() async throws {
        window.orderOut(nil)
        UserDefaults.standard.removeObject(forKey: "translateLang:\(reader.book.id)")
    }

    func settle() async {
        await reader.cards.waitForIdle()
        world.sync()
        for _ in 0..<3 {
            window.displayIfNeeded()
            try? await Task.sleep(for: .milliseconds(40))
            world.sync()
        }
    }

    func waitUntil(_ timeout: Double = 5, _ check: () async -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if await check() { return }
            try await Task.sleep(for: .milliseconds(40))
        }
        XCTFail("timed out")
    }

    func translatedPages() -> [Int] { reader.cards.cards.compactMap(\.translatedPage).sorted() }

    /// "Translate this page" translates that page only (owner, 14 Nov: the next page is not translated
    /// unasked); a range goes through "Translate pages…".
    func testThisPageAloneIsTranslatedDirectlyAndSitsBesideItsPage() async throws {
        reader.startTranslating(at: 1)
        try await waitUntil { self.streamer.requests.count == 1 }
        try await waitUntil { self.reader.translation(of: 1)?.messages.last?.role == .assistant && self.reader.translation(of: 1)?.messages.last?.state == nil }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(translatedPages(), [1])
        XCTAssertEqual(streamer.requests.count, 1)
        reader.translate([2])
        try await waitUntil { self.reader.translation(of: 2)?.messages.last?.role == .assistant && self.reader.translation(of: 2)?.messages.last?.state == nil }
        let jobs = await batcher.jobs
        XCTAssertTrue(jobs.isEmpty, "one page at a time: no batch")
        XCTAssertEqual(reader.cameraCommand, .showTranslation(page: 1))
        let req = try XCTUnwrap(streamer.requests.first)
        guard case .text(let prompt) = req.turns[0].parts[0] else { return XCTFail("text") }
        XCTAssertTrue(prompt.hasPrefix("[Dört Sayfa · Sayfa 1/4]"), prompt)
        XCTAssertTrue(prompt.contains("YAVAŞ OKUMANIN SANATI"), "the page's own text goes to the model")
        await settle()
        for n in [1, 2] {
            let t = try XCTUnwrap(reader.translation(of: n))
            let p = try XCTUnwrap(reader.placements[t.id])
            let page = reader.pages[n - 1]
            XCTAssertEqual(p.y, page.y, accuracy: 0.5, "level with its page")
            XCTAssertEqual(p.x, page.x + page.width + 60, accuracy: 0.5, "no threads: just right of the page")
            XCTAssertEqual(t.width, page.width, accuracy: 0.5, "same size as the page")
            XCTAssertEqual(try XCTUnwrap(t.height), page.height, accuracy: 0.5)
        }
        XCTAssertTrue(reader.segments.isEmpty, "a translation hangs on no yarn")

        // Owner, 16 Nov: resized pages take their translations with them, at the new size.
        reader.beginPageResize()
        reader.resizePages(scale: 1.5)
        reader.endPageResize()
        defer { UserDefaults.standard.removeObject(forKey: "pageScale:\(reader.book.id)") }
        await settle()
        let t = try XCTUnwrap(reader.translation(of: 1))
        let page = reader.pages[0]
        XCTAssertEqual(reader.displayWidth(t), page.width, accuracy: 0.5)
        XCTAssertEqual(try XCTUnwrap(reader.translationHeight(t)), page.height, accuracy: 0.5)
        let p = try XCTUnwrap(reader.placements[t.id])
        XCTAssertEqual(p.x, page.width + 60, accuracy: 0.5, "beside the larger page")
        let view = try XCTUnwrap(world.documentView.subviews.first { $0 is ZoomedHostingView<AnyView> && abs($0.frame.minX - p.x) < 1 && abs($0.frame.minY - p.y) < 1 })
        XCTAssertEqual(view.frame.width, page.width, accuracy: 0.5, "drawn at the page's size")
    }

    /// A range of more than two pages goes to Gemini as one batch, and fills in by itself.
    func testARangeGoesAsOneBatchAndFillsInByItself() async throws {
        reader.pollStart = .milliseconds(100)
        reader.translateRange(1...4)
        try await waitUntil { await self.batcher.jobs.count == 1 }
        try await waitUntil { self.reader.cards.waitingTranslations.count == 4 }
        let job = await batcher.jobs[0]
        XCTAssertEqual(job.count, 4)
        XCTAssertTrue(streamer.requests.isEmpty)
        let ids = (1...4).compactMap { reader.translation(of: $0)?.id }
        await batcher.set(.done(texts: Dictionary(uniqueKeysWithValues: ids.map { ($0, "Çeviri.") }), errors: [:]))
        try await waitUntil(3) { self.reader.cards.waitingTranslations.isEmpty }
        XCTAssertEqual(reader.translation(of: 4)?.messages.last?.content, "Çeviri.")
    }

    /// A page without a text layer goes as a picture at 1.6× for the model to read.
    func testAPageWithoutTextGoesAsAPicture() throws {
        XCTAssertTrue(ReaderModel.hasTextLayer(String(repeating: "ab ", count: 13)), "26 letters")
        XCTAssertFalse(ReaderModel.hasTextLayer(String(repeating: "a ", count: 24)), "24 letters")
        XCTAssertFalse(ReaderModel.hasTextLayer(" \n abc  \n"))
        let text = try XCTUnwrap(reader.pageSource(1))
        XCTAssertNil(text.imageDataURL)
        XCTAssertTrue(text.text.contains("YAVAŞ OKUMANIN SANATI"))
        let image = NSImage(size: CGSize(width: 600, height: 800))
        image.lockFocus(); NSColor.white.setFill(); CGRect(x: 0, y: 0, width: 600, height: 800).fill(); image.unlockFocus()
        let scanned = PageGeometry(page: try XCTUnwrap(PDFPage(image: image)))
        let url = try XCTUnwrap(scanned.jpegDataURL(scale: 1.6, quality: 0.86))
        XCTAssertTrue(url.hasPrefix("data:image/jpeg;base64,"))
        let data = try XCTUnwrap(Data(base64Encoded: String(url.dropFirst("data:image/jpeg;base64,".count))))
        let rep = try XCTUnwrap(NSBitmapImageRep(data: data))
        XCTAssertEqual(Double(rep.pixelsHigh), Double(scanned.page.bounds(for: .cropBox).height * 1.6), accuracy: 2)
    }

    func testWithThreadsTheTranslationSitsRightOfThem() async throws {
        let r = NormalizedRect(x: 0.1, y: 0.3, width: 0.6, height: 0.02)
        reader.pending = PendingSelection(anchors: [YarnAnchor(sourceType: .pdfText, bookId: reader.book.id, pageNumber: 1, selectedText: "Kavramlar", lineRects: [r], boundingRect: r)], rect: .zero)
        reader.create(color: .mint, kind: .quick(.mint))
        await settle()
        let lane = try XCTUnwrap(reader.cards.cards.first)
        reader.translate([1])
        try await waitUntil { self.reader.translation(of: 1) != nil }
        await settle()
        let t = try XCTUnwrap(reader.translation(of: 1))
        let lp = try XCTUnwrap(reader.placements[lane.id])
        XCTAssertEqual(try XCTUnwrap(reader.placements[t.id]).x, lp.x + lane.width + 60, accuracy: 0.5)
    }

    /// Staying on a translated page starts nothing by itself.
    func testNothingIsTranslatedWithoutBeingAsked() async throws {
        reader.startTranslating(at: 1)
        try await waitUntil { self.streamer.requests.count == 1 }
        reader.currentPage = 2
        try await Task.sleep(for: .milliseconds(150))
        reader.currentPage = 1
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(translatedPages(), [1])
        XCTAssertEqual(streamer.requests.count, 1)
        XCTAssertEqual(reader.pendingTranslations, 0)
    }

    func testTheTranslationArrivesAndThreadsOpenFromItsText() async throws {
        reader.translate([1])
        try await waitUntil { self.reader.translation(of: 1)?.messages.last?.role == .assistant && self.reader.translation(of: 1)?.messages.last?.state == nil }
        let id = try XCTUnwrap(reader.translation(of: 1)?.id)
        world.scrollView.magnification = 0.63
        let place = try XCTUnwrap(reader.placements[id])
        world.scrollView.contentView.scroll(to: CGPoint(x: place.x - 100, y: place.y))
        world.scrollView.reflectScrolledClipView(world.scrollView.contentView)
        await settle()
        let host = try XCTUnwrap(world.documentView.subviews.first { $0 is ZoomedHostingView<AnyView> })
        host.layoutSubtreeIfNeeded()
        func find(_ v: NSView) -> AnswerTextView? { (v as? AnswerTextView) ?? v.subviews.lazy.compactMap(find).first }
        let text = try XCTUnwrap(find(host))
        XCTAssertTrue(text.string.contains("gözün satırlar üzerinde"))
        XCTAssertFalse(text.string.contains("#"), "headings are set as headings")

        try await snapshot("peryda-mac-translation.png")

        // Select words in the translation, as a reader would.
        CardButtonTests.deliverQueuedMouseEvents(to: nil)
        let line = text.layoutManager!.lineFragmentRect(forGlyphAt: 30, effectiveRange: nil)
        let start = text.convert(CGPoint(x: 2, y: line.midY), to: nil)
        let end = text.convert(CGPoint(x: 160, y: line.midY), to: nil)
        func ev(_ type: NSEvent.EventType, _ p: CGPoint) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        let down = ev(.leftMouseDown, start)
        NSApp.postEvent(ev(.leftMouseDragged, end), atStart: false)
        NSApp.postEvent(ev(.leftMouseUp, end), atStart: false)
        window.sendEvent(down)
        while let e = NSApp.nextEvent(matching: [.leftMouseUp, .leftMouseDragged], until: Date(), inMode: .default, dequeue: true) { window.sendEvent(e) }
        let pending = try XCTUnwrap(reader.pending, "the selection menu opened on the translation")
        XCTAssertEqual(pending.parentCardId, id)
        reader.create(color: .lavender, kind: .quick(.lavender))
        await settle()
        // (Reading the translated page also starts the next page's translation; find the thread itself.)
        let thread = try XCTUnwrap(reader.cards.cards.first { $0.parentCardId == id })
        let tp = try XCTUnwrap(reader.placements[id])
        XCTAssertEqual(try XCTUnwrap(reader.placements[thread.id]).x, tp.x + reader.pages[0].width + Geometry.g.subLaneGap, accuracy: 0.5, "the thread opens right of the translation")
        let yarn = try XCTUnwrap(reader.segments.first { $0.cardId == thread.id })
        XCTAssertEqual(yarn.from.x, tp.x + reader.pages[0].width, accuracy: 0.5, "its yarn leaves the translation's edge")

        // The passage is marked in the thread's colour in the translation (owner test 14 Nov).
        await settle()
        let marked = try XCTUnwrap(find(host))
        XCTAssertEqual(marked.marks.count, 1)
        XCTAssertEqual(marked.marks.first?.text, thread.anchors.first?.selectedText)
        XCTAssertEqual(marked.marks.first?.multiply, true)

        // A new selection opens the menu; a click elsewhere in the text closes it. (Mouse events left
        // in the queue by earlier steps would end the text view's drag early: drop them first.)
        CardButtonTests.deliverQueuedMouseEvents(to: nil)
        NSApp.postEvent(ev(.leftMouseDragged, end), atStart: false)
        NSApp.postEvent(ev(.leftMouseUp, end), atStart: false)
        window.sendEvent(ev(.leftMouseDown, start))
        while let e = NSApp.nextEvent(matching: [.leftMouseUp, .leftMouseDragged], until: Date(), inMode: .default, dequeue: true) { window.sendEvent(e) }
        XCTAssertNotNil(reader.pending)
        CardButtonTests.deliverQueuedMouseEvents(to: nil)
        let elsewhere = text.convert(CGPoint(x: 40, y: text.layoutManager!.lineFragmentRect(forGlyphAt: 120, effectiveRange: nil).midY), to: nil)
        NSApp.postEvent(ev(.leftMouseUp, elsewhere), atStart: false)
        window.sendEvent(ev(.leftMouseDown, elsewhere))
        while let e = NSApp.nextEvent(matching: [.leftMouseUp, .leftMouseDragged], until: Date(), inMode: .default, dequeue: true) { window.sendEvent(e) }
        XCTAssertNil(reader.pending, "a click in other text closes the menu")

        // Deleting the thread takes its mark away.
        reader.cards.remove(thread.id)
        await settle()
        XCTAssertTrue(try XCTUnwrap(find(host)).marks.isEmpty)
        reader.pending = PendingSelection(anchors: thread.anchors, rect: .zero, parentCardId: id)
        reader.create(color: .lavender, kind: .quick(.lavender))
        await settle()
        let again = try XCTUnwrap(reader.cards.cards.first { $0.parentCardId == id })

        // Hiding threads leaves the translation; page by page shows it on its own page only.
        reader.hideThreads = true
        XCTAssertTrue(reader.isShown(try XCTUnwrap(reader.translation(of: 1))))
        XCTAssertFalse(reader.isShown(again))
        reader.hideThreads = false
        reader.pagedReading = true
        reader.currentPage = 2
        XCTAssertFalse(reader.isShown(try XCTUnwrap(reader.translation(of: 1))))
        reader.pagedReading = false
    }

    /// "Read with Pery" in "Extract page text": the page's picture goes with the transcription prompt;
    /// the reading is kept with the book.
    func testReadWithPerySendsThePagesPicture() async throws {
        let readings = try XCTUnwrap(reader.readings)
        readings.read(1...1, lang: .tr)
        try await waitUntil { readings.readings[1]?.state == .done }
        let req = try XCTUnwrap(streamer.requests.last)
        XCTAssertEqual(req.system, Compose.pageTranscriptionSystem(.tr))
        guard case .image(let mime, let data) = req.turns[0].parts[0] else { return XCTFail("the page's picture first") }
        XCTAssertEqual(mime, "image/jpeg")
        XCTAssertGreaterThan(data.count, 1000)
        guard case .text(let prompt) = req.turns[0].parts[1] else { return XCTFail("then the instruction") }
        XCTAssertTrue(prompt.contains("Dört Sayfa"), prompt)
        XCTAssertNil(reader.pagePicture(9), "no such page")
        XCTAssertEqual(store.readings(for: reader.book.id).first?.page, 1)
    }

    /// The extract window with a range read by Pery, for a look.
    func testExtractWindowSnapshot() async throws {
        let readings = try XCTUnwrap(reader.readings)
        readings.read(1...2, lang: .tr)
        try await waitUntil { readings.done.count == 2 }
        let app = AppModel(store: store, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), lang: .tr)
        let sheet = NSHostingView(rootView: ExtractedTextSheet(reader: reader, page: 1, lang: .tr).environment(app).frame(width: 780, height: 560))
        let w = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 780, height: 560), styleMask: [.borderless], backing: .buffered, defer: false)
        w.contentView = sheet
        w.orderFrontRegardless()
        defer { w.orderOut(nil) }
        try await Task.sleep(for: .milliseconds(600))
        sheet.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(sheet.bitmapImageRepForCachingDisplay(in: sheet.bounds))
        sheet.cacheDisplay(in: sheet.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent("peryda-mac-extract.png"))
    }

    /// The page range form with typeable page numbers, for a look (owner test 15 Nov).
    func testRangeSheetSnapshot() async throws {
        let app = AppModel(store: store, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), lang: .tr)
        let sheet = NSHostingView(rootView: TranslateRangeSheet(reader: reader, t: UIText(.tr)).environment(app))
        let w = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 460, height: 420), styleMask: [.borderless], backing: .buffered, defer: false)
        w.contentView = sheet
        w.orderFrontRegardless()
        defer { w.orderOut(nil) }
        try await Task.sleep(for: .milliseconds(500))
        sheet.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(sheet.bitmapImageRepForCachingDisplay(in: sheet.bounds))
        sheet.cacheDisplay(in: sheet.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent("peryda-mac-range.png"))
    }

    /// A page waiting in a batch job offers "Translate now" at once (owner, 15 Nov: batches can take
    /// long; the button used to appear only after a minute). A real click translates that page directly
    /// while the others stay in the job.
    func testTranslateNowIsOfferedAtOnceAndWorksWhenClicked() async throws {
        reader.pollStart = .seconds(60)
        reader.translateRange(1...4)
        // The range's camera move would scroll the page under the click; this test places the view itself.
        reader.cameraCommand = nil
        try await waitUntil { await self.batcher.jobs.count == 1 }
        try await waitUntil { self.reader.cards.waitingTranslations.count == 4 }
        let id = try XCTUnwrap(reader.translation(of: 2)?.id)
        XCTAssertTrue(reader.cards.isWaitingForBatch(id))
        world.scrollView.magnification = 0.74
        let place = try XCTUnwrap(reader.placements[id])
        world.scrollView.contentView.scroll(to: CGPoint(x: place.x - 100, y: place.y - 40))
        world.scrollView.reflectScrolledClipView(world.scrollView.contentView)
        await settle()
        let host = try XCTUnwrap(world.documentView.subviews.first { $0 is ZoomedHostingView<AnyView> && abs($0.frame.minX - place.x) < 1 && abs($0.frame.minY - place.y) < 1 })
        host.layoutSubtreeIfNeeded()
        func controls(_ v: NSView) -> [NSControl] { ((v as? NSControl).map { [$0] } ?? []) + v.subviews.flatMap(controls) }
        // The header's controls sit in its top 60 units; the waiting area's button below them.
        let now = try XCTUnwrap(controls(host).first { $0.convert($0.bounds, to: host).minY > 60 }, "Translate now is there at once")
        let before = streamer.requests.count
        await click(now.convert(CGPoint(x: now.bounds.midX, y: now.bounds.midY), to: nil))
        try await waitUntil { self.streamer.requests.count == before + 1 }
        try await waitUntil { self.reader.translation(of: 2)?.messages.last?.state == nil }
        XCTAssertFalse(reader.cards.isWaitingForBatch(id))
        XCTAssertEqual(reader.cards.waitingTranslations.count, 3, "the others stay in the job")
    }

    func testAScannedPageIsReadOnTheMac() async throws {
        // A page that is only a picture of text, as from a scanner.
        let size = CGSize(width: 1200, height: 800)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.white.setFill()
        CGRect(origin: .zero, size: size).fill()
        ("Concepts become clear at their borders." as NSString).draw(at: CGPoint(x: 60, y: 600), withAttributes: [.font: NSFont.systemFont(ofSize: 48), .foregroundColor: NSColor.black])
        ("Attention is a limited resource." as NSString).draw(at: CGPoint(x: 60, y: 480), withAttributes: [.font: NSFont.systemFont(ofSize: 48), .foregroundColor: NSColor.black])
        image.unlockFocus()
        let page = try XCTUnwrap(PDFPage(image: image))
        XCTAssertTrue((page.string ?? "").isEmpty, "no text layer")
        let read = await PageText.read(PageGeometry(page: page), lang: .en)
        XCTAssertTrue(read.recognized)
        XCTAssertTrue(read.text.contains("Concepts become clear"), read.text)
        XCTAssertTrue(read.text.contains("limited resource"), read.text)
    }

    func testCleanPageTextRejoinsWordsBrokenWithAnyUsualHyphen() {
        // PDFKit reports the line-end hyphen of many fonts as "‐" (U+2010), not "-".
        for hyphen in ["-", "\u{2010}", "\u{AD}"] {
            XCTAssertEqual(PageText.clean("aus seiner selbstver\(hyphen)\nschuldeten Unmündigkeit"), "aus seiner selbstverschuldeten Unmündigkeit", hyphen)
        }
        XCTAssertEqual(PageText.clean("Ost-\nWest"), "Ost- West")
        XCTAssertEqual(PageText.clean("first line\nsecond line\n\nnext paragraph"), "first line second line\n\nnext paragraph")
    }

    /// The translated page's own buttons, clicked through the window at the zoom a reader uses:
    /// Retranslate asks again, Close removes it. (Owner test 14 Nov: neither did anything.)
    func testTheTranslatedPagesButtonsWorkWhenClicked() async throws {
        reader.translate([1])
        try await waitUntil { self.reader.translation(of: 1)?.messages.last?.role == .assistant && self.reader.translation(of: 1)?.messages.last?.state == nil }
        let id = try XCTUnwrap(reader.translation(of: 1)?.id)
        for m in [0.74, 1.0] {
            world.scrollView.magnification = m
            let place = try XCTUnwrap(reader.placements[id])
            world.scrollView.contentView.scroll(to: CGPoint(x: place.x - 100, y: place.y - 40))
            world.scrollView.reflectScrolledClipView(world.scrollView.contentView)
            await settle()
            let host = try XCTUnwrap(world.documentView.subviews.first { $0 is ZoomedHostingView<AnyView> && abs($0.frame.minX - place.x) < 1 })
            host.layoutSubtreeIfNeeded()
            let before = streamer.requests.count
            await click(world.documentView.convert(CGPoint(x: host.frame.maxX - 44 - 11 - 22 - 8, y: host.frame.minY + 20 + 11), to: nil))
            try await waitUntil { self.streamer.requests.count == before + 1 }
            await settle()
        }
        let place = try XCTUnwrap(reader.placements[id])
        let host = try XCTUnwrap(world.documentView.subviews.first { $0 is ZoomedHostingView<AnyView> && abs($0.frame.minX - place.x) < 1 })

        // A− and A+ sit left of Retranslate and size the translation's text (owner test 15 Nov).
        func fitting() -> FittingTextView? {
            func walk(_ v: NSView) -> FittingTextView? { (v as? FittingTextView) ?? v.subviews.lazy.compactMap(walk).first }
            return walk(host)
        }
        reader.translationTextScale = 1
        await settle()
        let fitted = try XCTUnwrap(fitting()).shownSize
        for m in [0.74, 1.0] {
            world.scrollView.magnification = m
            world.scrollView.contentView.scroll(to: CGPoint(x: place.x - 100, y: place.y - 40))
            world.scrollView.reflectScrolledClipView(world.scrollView.contentView)
            await settle()
            let larger = world.documentView.convert(CGPoint(x: host.frame.maxX - 44 - 11 - 2 * (22 + 8), y: host.frame.minY + 20 + 11), to: nil)
            let before = reader.translationTextScale
            await click(larger)
            XCTAssertGreaterThan(reader.translationTextScale, before, "A+ at \(Int(m * 100))%")
        }
        await settle()
        host.layoutSubtreeIfNeeded()
        let grown = try XCTUnwrap(fitting())
        grown.layoutSubtreeIfNeeded()
        XCTAssertGreaterThan(grown.shownSize, fitted, "the text grows past the size that fits")
        try await snapshot("peryda-mac-translation-larger.png")
        world.scrollView.magnification = 1
        world.scrollView.contentView.scroll(to: CGPoint(x: place.x - 100, y: place.y - 40))
        world.scrollView.reflectScrolledClipView(world.scrollView.contentView)
        await settle()
        let smaller = world.documentView.convert(CGPoint(x: host.frame.maxX - 44 - 11 - 3 * (22 + 8), y: host.frame.minY + 20 + 11), to: nil)
        await click(smaller)
        XCTAssertEqual(reader.translationTextScale, 1.15, accuracy: 0.001, "A− takes one step back")
        XCTAssertEqual(UserDefaults.standard.double(forKey: "translationTextScale:\(reader.book.id)"), 1.15, accuracy: 0.001, "kept per book")
        reader.translationTextScale = 1
        await settle()

        await click(world.documentView.convert(CGPoint(x: host.frame.maxX - 44 - 11, y: host.frame.minY + 20 + 11), to: nil))
        XCTAssertNil(reader.translation(of: 1), "Close removes the translation")
    }

    func click(_ windowPoint: CGPoint) async {
        CardButtonTests.deliverQueuedMouseEvents(to: nil)
        func ev(_ type: NSEvent.EventType) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: windowPoint, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        NSApp.postEvent(ev(.leftMouseUp), atStart: false)
        window.sendEvent(ev(.leftMouseDown))
        CardButtonTests.deliverQueuedMouseEvents(to: window)
        try? await Task.sleep(for: .milliseconds(150))
    }

    func snapshot(_ name: String) async throws {
        world.scrollView.magnification = 0.5
        world.scrollView.contentView.scroll(to: CGPoint(x: -60, y: 0))
        world.scrollView.reflectScrolledClipView(world.scrollView.contentView)
        await settle()
        let content = try XCTUnwrap(window.contentView)
        let rep = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent(name))
        world.scrollView.magnification = 0.63
        let id = try XCTUnwrap(reader.translation(of: 1)?.id)
        let place = try XCTUnwrap(reader.placements[id])
        world.scrollView.contentView.scroll(to: CGPoint(x: place.x - 100, y: place.y))
        world.scrollView.reflectScrolledClipView(world.scrollView.contentView)
        await settle()
    }
}
