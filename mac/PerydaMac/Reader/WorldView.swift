import AppKit
import PDFKit
import PerydaKit
import QuartzCore
import SwiftUI

/// The reading surface: an NSScrollView whose document is the world (pages stacked at 760 units wide,
/// the thread lanes to their right). Pinch and ⌘± zoom around the cursor through the scroll view's own
/// magnification, so cards and yarns scale with the pages. The camera moves only on the reader's input.
final class WorldView: NSView {
    let scrollView = NSScrollView()
    let clipView = CenteringClipView()
    let documentView = WorldDocumentView()
    let yarnView = YarnOverlayView()
    weak var model: ReaderModel?
    var lang: Lang = .tr
    private var pageViews: [Int: PageView] = [:]
    private var cardViews: [String: ZoomedHostingView<AnyView>] = [:]
    private var clipViews: [String: ZoomedHostingView<ClipBadge>] = [:]
    private var cardContent: (String) -> AnyView = { _ in AnyView(EmptyView()) }
    private var restored = false

    // Selection state
    private var dragStart: (page: Int, point: CGPoint)?
    private var selection: PDFSelection?
    private var areaDrag: (page: Int, start: CGPoint)?
    private var dragCard: (id: String, origin: CGPoint)?
    /// Card positions from the last layout; a dragged card's live position is laid over them.
    private var lastPlacements: [String: CGPoint] = [:]
    private(set) var ropes = YarnRopes()
    private var ropeLink: CADisplayLink?
    private var lastTick: CFTimeInterval?

    override var isFlipped: Bool { true }

    init(model: ReaderModel, cardContent: @escaping (String) -> AnyView) {
        self.model = model
        self.cardContent = cardContent
        super.init(frame: .zero)
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.allowsMagnification = true
        scrollView.minMagnification = 0.15
        scrollView.maxMagnification = 4
        scrollView.contentView = clipView
        scrollView.drawsBackground = true
        scrollView.backgroundColor = Theme.paperSunken
        scrollView.documentView = documentView
        documentView.world = self
        documentView.addSubview(yarnView)
        addSubview(scrollView)
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        scrollView.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(boundsChanged), name: NSView.boundsDidChangeNotification, object: scrollView.contentView)
        NotificationCenter.default.addObserver(self, selector: #selector(magnifyEnded), name: NSScrollView.didEndLiveMagnifyNotification, object: scrollView)
        buildPages()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    deinit { NotificationCenter.default.removeObserver(self) }

    private func buildPages() {
        guard let model else { return }
        for (i, box) in model.pages.enumerated() {
            guard let page = model.document?.page(at: i) else { continue }
            let view = PageView(geometry: PageGeometry(page: page), number: i + 1)
            view.frame = CGRect(x: box.x, y: box.y, width: box.width, height: box.height)
            view.world = self
            documentView.addSubview(view, positioned: .below, relativeTo: yarnView)
            pageViews[i + 1] = view
        }
    }

    override func layout() {
        super.layout()
        if !restored, bounds.width > 0 {
            restored = true
            sync()
            restoreCamera()
        }
    }

    private func restoreCamera() {
        guard let model else { return }
        if let saved = model.savedPosition, saved.scale > 0 {
            scrollView.magnification = saved.scale
            scrollView.contentView.scroll(to: CGPoint(x: saved.panX, y: saved.panY))
            scrollView.reflectScrolledClipView(scrollView.contentView)
        } else {
            perform(.overview, animated: false)
            scrollView.contentView.scroll(to: CGPoint(x: scrollView.contentView.bounds.minX, y: -24))
            scrollView.reflectScrolledClipView(scrollView.contentView)
        }
        model.magnification = scrollView.magnification
    }

    // MARK: Syncing with the model

    func sync() {
        guard let model else { return }
        // The document sits at the world's own coordinates (its frame and bounds share an origin), so
        // scroll positions and world units stay the same thing while the page is centred.
        let world = model.worldRect
        let docFrame = CGRect(x: world.minX, y: 0, width: max(world.width, 1), height: max(world.height, 1))
        if documentView.frame != docFrame {
            documentView.frame = docFrame
            documentView.setBoundsOrigin(docFrame.origin)
        }
        clipView.contentBottom = model.contentRect.maxY
        layoutPages()
        if yarnView.frame != docFrame {
            yarnView.frame = docFrame
            yarnView.setBoundsOrigin(docFrame.origin)
        }

        // Cards
        let placements = model.placements
        lastPlacements = placements
        let visibleIds = Set(placements.keys)
        for (id, view) in cardViews where !visibleIds.contains(id) {
            view.removeFromSuperview()
            cardViews[id] = nil
        }
        for card in model.cards.cards {
            guard let p = placements[card.id] else { continue }
            let shown = model.isShown(card)
            let view: ZoomedHostingView<AnyView>
            if let existing = cardViews[card.id] {
                view = existing
            } else {
                view = ZoomedHostingView(rootView: cardContent(card.id))
                let id = card.id
                view.onClick = { [weak self] p in self?.cardClicked(id, at: p) }
                // A page translation stays level with its page: no dragging or resizing.
                if card.translatedPage == nil {
                    view.onHeaderDrag = { [weak self] t, ended in
                        if ended { self?.cardDragEnded(id, translation: t) } else { self?.cardDragChanged(id, translation: t) }
                    }
                    view.onResize = { [weak self] size, _ in self?.model?.cards.resize(id, width: size.width, height: size.height) }
                    view.onResizeReset = { [weak self] in self?.model?.cards.resize(id, width: Geometry.cardWidth, height: nil) }
                    view.onEdgeResize = { [weak self] width, left, ended in self?.cardEdgeResized(id, width: width, fromLeft: left, ended: ended) }
                    view.onEdgeReset = { [weak self] in
                        guard let card = self?.model?.cards.cards.first(where: { $0.id == id }) else { return }
                        self?.model?.cards.resize(id, width: Geometry.cardWidth, height: card.height)
                    }
                }
                view.sizingOptions = []
                documentView.addSubview(view)
                cardViews[card.id] = view
            }
            if dragCard?.id != card.id {
                view.frame = CGRect(x: p.x, y: p.y, width: model.displayWidth(card), height: model.heights[card.id] ?? 150)
            }
            if view.isHidden == shown { view.isHidden = !shown }
        }
        attachNearbyCards()
        // Focused card on top.
        if let focused = model.focusedCard, let view = cardViews[focused], documentView.subviews.last !== view {
            view.removeFromSuperview()
            documentView.addSubview(view)
        }

        // The menu closed (a press in a card's text, a new thread, Escape): the page selection goes too.
        if model.pending == nil, dragStart == nil, areaDrag == nil, selection != nil { clearSelection() }

        refreshYarns(dt: 0)
        layoutClips(placements)

        applyPaging()
        for (number, view) in pageViews {
            let highlights = model.highlights(onPage: number)
            let knots = model.knots(onPage: number, lang: lang)
            let marks = model.highlighterMarks(onPage: number)
            if view.highlights != highlights || view.knots != knots || view.marks != marks {
                view.highlights = highlights
                view.knots = knots
                view.marks = marks
                view.needsDisplay = true
                view.syncKnots()
            }
        }

        if let command = model.cameraCommand {
            DispatchQueue.main.async { [weak self] in
                self?.perform(command, animated: true)
                self?.model?.cameraCommand = nil
            }
        }
    }

    // MARK: Page size (owner, 16 Nov)

    /// Pages drawn at an older size: redrawn when they come into view (a resize stretches what was
    /// drawn, and drawing every page of a long book at once would stall).
    private var stalePages: Set<Int> = []

    /// Puts every page where the layout says (they move and grow when the pages are resized).
    private func layoutPages() {
        guard let model else { return }
        for (number, view) in pageViews where number <= model.pages.count {
            let box = model.pages[number - 1]
            let frame = CGRect(x: box.x, y: box.y, width: box.width, height: box.height)
            if view.frame != frame {
                view.frame = frame
                view.syncKnots()
                stalePages.insert(number)
            }
            view.placeGrip()
        }
    }

    /// The page being resized: its top-left corner stays put on screen while the reader drags.
    private var pageResize: (number: Int, offsetY: CGFloat, originX: CGFloat)?

    func pageResizeBegan(_ pageView: PageView) {
        guard let model, pageView.number <= model.pages.count else { return }
        model.beginPageResize()
        let page = model.pages[pageView.number - 1]
        let b = scrollView.contentView.bounds
        pageResize = (pageView.number, CGFloat(page.y) - b.minY, b.minX)
    }

    /// Resizes in proportion: the pointer, seen from the page's top-left corner, is projected on the
    /// page's diagonal, so dragging right, down or both all work.
    func pageResizeDragged(_ event: NSEvent) {
        guard let model, let r = pageResize, r.number <= model.pages.count else { return }
        let page = model.pages[r.number - 1]
        let p = documentView.convert(event.locationInWindow, from: nil)
        let dx = Double(p.x) - page.x, dy = Double(p.y) - page.y
        let t = (dx * page.width + dy * page.height) / (page.width * page.width + page.height * page.height)
        model.resizePages(scale: t * page.width / Geometry.pageWorldWidth)
        applyPageResize()
    }

    private func applyPageResize() {
        guard let model, let r = pageResize, r.number <= model.pages.count else { return }
        sync()
        let page = model.pages[r.number - 1]
        scrollView.contentView.scroll(to: CGPoint(x: r.originX, y: CGFloat(page.y) - r.offsetY))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    func pageResizeEnded() {
        guard pageResize != nil else { return }
        model?.endPageResize()
        pageResize = nil
        sync()
        redrawVisiblePages()
        savePositionSoon()
    }

    /// Double-click on the corner: the standard page size again.
    func resetPageSize(_ pageView: PageView) {
        pageResizeBegan(pageView)
        model?.resizePages(scale: 1)
        applyPageResize()
        pageResizeEnded()
    }

    // MARK: Card width from its sides (owner, 16 Nov)

    /// Where a card's right edge was when the reader began widening it from the left.
    private var edgeStart: (id: String, right: Double, y: Double)?

    /// From the right side only the width changes; from the left side the right edge stays put, and
    /// the card becomes one the reader placed.
    func cardEdgeResized(_ id: String, width: CGFloat, fromLeft: Bool, ended: Bool) {
        guard let model, let card = model.cards.cards.first(where: { $0.id == id }) else { return }
        let w = min(max(Double(width), CardsModel.widthRange.lowerBound), CardsModel.widthRange.upperBound)
        if fromLeft {
            if edgeStart?.id != id {
                let p = lastPlacements[id] ?? CGPoint(x: card.x, y: card.y)
                edgeStart = (id, Double(p.x) + card.width, Double(p.y))
            }
            if let start = edgeStart {
                model.cards.resize(id, width: w, height: card.height)
                model.cards.pin(id, x: start.right - w, y: start.y)
            }
        } else {
            model.cards.resize(id, width: w, height: card.height)
        }
        if ended { edgeStart = nil }
    }

    // MARK: Only nearby cards stay attached

    /// Cards far from the view are taken out of the view tree (and kept, with their state), so zooming
    /// and scrolling cost the same with fifty threads as with five. A card being dragged, focused,
    /// typed in or not yet measured stays.
    func attachNearbyCards() {
        guard let model else { return }
        // Cards are attached before each frame is drawn, so a small margin is enough.
        let near = clipView.bounds.insetBy(dx: -240, dy: -320)
        let editing = window?.firstResponder as? NSView
        for card in model.cards.cards {
            guard let view = cardViews[card.id] else { continue }
            let keep = model.isShown(card) && (
                view.frame.intersects(near)
                    || model.heights[card.id] == nil
                    || dragCard?.id == card.id
                    || model.focusedCard == card.id
                    || editing.map { $0.isDescendant(of: view) } == true
            )
            if keep, view.superview == nil {
                documentView.addSubview(view)
            } else if !keep, view.superview != nil {
                view.removeFromSuperview()
            }
        }
    }

    // MARK: Page by page

    /// Shows only the current page and its threads, and keeps the view on that page's band.
    private func applyPaging() {
        guard let model else { return }
        let paged = model.pagedReading
        for (number, view) in pageViews where view.isHidden != (paged && number != model.currentPage) {
            view.isHidden = paged && number != model.currentPage
        }
        clipView.band = paged ? pageBand(model.currentPage) : nil
    }

    /// The current page plus any of its threads that reach above or below it, with a margin.
    private func pageBand(_ number: Int) -> ClosedRange<CGFloat>? {
        guard let model, number >= 1, number <= model.pages.count else { return nil }
        let page = model.pages[number - 1]
        var top = page.y, bottom = page.y + page.height
        let place = lastPlacements
        for card in model.cards.cards where model.isShown(card) {
            guard let p = place[card.id] else { continue }
            top = min(top, p.y)
            bottom = max(bottom, p.y + (model.heights[card.id] ?? 150))
        }
        return (top - 32)...(bottom + 32)
    }

    func turnPage(_ delta: Int) {
        guard let model, !model.pages.isEmpty else { return }
        let next = min(max(1, model.currentPage + delta), model.pages.count)
        guard next != model.currentPage else { return }
        model.currentPage = next
        if model.pagedReading {
            fadeContent()
            applyPaging()
            if let band = clipView.band { scroll(to: CGPoint(x: clipView.bounds.minX, y: clipView.start(of: band)), animated: false) }
        } else {
            scroll(to: CGPoint(x: clipView.bounds.minX, y: model.pages[next - 1].y - 24), animated: true)
        }
        savePositionSoon()
    }

    /// A short cross-fade when the page changes (none with Reduce Motion).
    private func fadeContent() {
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        clipView.wantsLayer = true
        let fade = CATransition()
        fade.type = .fade
        fade.duration = 0.16
        clipView.layer?.add(fade, forKey: "page")
    }

    // MARK: Camera (only on explicit commands)

    private var visibleSize: CGSize { scrollView.contentView.bounds.size.applying(CGAffineTransform(scaleX: scrollView.magnification, y: scrollView.magnification)) }

    private func centerWorldY() -> CGFloat { scrollView.contentView.bounds.midY }

    func perform(_ command: CameraCommand, animated: Bool) {
        guard let model else { return }
        let viewport = scrollView.frame.size
        let cy = centerWorldY()
        /// Fits `width` world units across the window, centred on the page.
        func fit(width: CGFloat, maxScale: CGFloat) {
            let m = min(maxScale, max(0.15, (viewport.width - 48) / width))
            setMagnification(m, animated: animated)
            let visible = scrollView.contentView.bounds.size
            scroll(to: CGPoint(x: model.pageWidth / 2 - visible.width / 2, y: cy - visible.height / 2), animated: animated)
        }
        switch command {
        case .focus:
            fit(width: model.pageWidth + 48, maxScale: 2.5)
        case .overview:
            fit(width: model.centredContentWidth, maxScale: 1)
        case .map:
            fit(width: model.centredContentWidth, maxScale: 0.45)
        case .showTranslation(let number):
            // The page and the place its translation goes, side by side.
            guard number >= 1, number <= model.pages.count else { break }
            let page = model.pages[number - 1]
            let translation = model.translation(of: number).flatMap { t in model.placements[t.id].map { CGRect(x: $0.x, y: $0.y, width: model.displayWidth(t), height: page.height) } }
            let right = translation?.maxX ?? (page.x + page.width * 2 + 60)
            let width = right - page.x + 80
            let m = min(1.2, max(0.15, (viewport.width - 48) / width))
            setMagnification(m, animated: animated)
            let visible = scrollView.contentView.bounds.size
            scroll(to: CGPoint(x: (page.x + right) / 2 - visible.width / 2, y: page.y - 24), animated: animated)
        case .goToPage(let number):
            if number == model.currentPage, !model.pagedReading, number >= 1, number <= model.pages.count {
                scroll(to: CGPoint(x: clipView.bounds.minX, y: model.pages[number - 1].y - 24), animated: animated)
            } else {
                turnPage(number - model.currentPage)
            }
        case .previousPage:
            turnPage(-1)
        case .nextPage:
            turnPage(1)
        case .actualSize:
            zoom(to: 1, animated: animated)
        case .zoomIn:
            zoom(to: scrollView.magnification * 1.2, animated: animated)
        case .zoomOut:
            zoom(to: scrollView.magnification / 1.2, animated: animated)
        case .show(let cardId):
            guard let p = model.placements[cardId] else { return }
            let visible = scrollView.contentView.bounds.size
            let width = model.cards.cards.first { $0.id == cardId }.map(model.displayWidth) ?? Geometry.cardWidth
            scroll(to: CGPoint(x: p.x + width / 2 - visible.width / 2, y: p.y - 40), animated: animated)
            model.offscreenCard = nil
        }
        model.magnification = scrollView.magnification
    }

    private func zoom(to m: CGFloat, animated: Bool) {
        let center = CGPoint(x: scrollView.contentView.bounds.midX, y: scrollView.contentView.bounds.midY)
        if animated {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.22
                scrollView.animator().setMagnification(m, centeredAt: center)
            }
        } else {
            scrollView.setMagnification(m, centeredAt: center)
        }
        model?.magnification = m
        redrawVisiblePages()
    }

    private func setMagnification(_ m: CGFloat, animated: Bool) {
        scrollView.magnification = m
        redrawVisiblePages()
    }

    private func scroll(to point: CGPoint, animated: Bool) {
        if animated {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.25
                scrollView.contentView.animator().setBoundsOrigin(point)
            }
        } else {
            scrollView.contentView.scroll(to: point)
        }
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    private func redrawVisiblePages() {
        let visible = scrollView.contentView.bounds
        for view in pageViews.values where view.frame.intersects(visible) {
            view.needsDisplay = true
            stalePages.remove(view.number)
        }
    }

    /// Pages left stretched by a resize are drawn again once they are in view (not while resizing).
    private func redrawStalePagesInView() {
        guard !stalePages.isEmpty, pageResize == nil else { return }
        let visible = scrollView.contentView.bounds.insetBy(dx: 0, dy: -200)
        for number in stalePages {
            guard let view = pageViews[number], view.frame.intersects(visible) else { continue }
            view.needsDisplay = true
            stalePages.remove(number)
        }
    }

    @objc private func magnifyEnded() {
        model?.magnification = scrollView.magnification
        redrawVisiblePages()
        // Edge strips and corner grips are a few points on screen at any zoom.
        for view in cardViews.values { window?.invalidateCursorRects(for: view) }
        for view in pageViews.values { view.placeGrip() }
        savePositionSoon()
    }

    private var saveWork: DispatchWorkItem?
    private func savePositionSoon() {
        saveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, let model = self.model else { return }
            model.savePosition(origin: self.scrollView.contentView.bounds.origin, magnification: self.scrollView.magnification)
        }
        saveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    @objc private func boundsChanged() {
        guard let model else { return }
        if !model.pagedReading {
            let center = scrollView.contentView.bounds.midY
            let page = (model.pages.firstIndex { $0.y + $0.height >= center } ?? 0) + 1
            if page != model.currentPage { model.currentPage = page }
        }
        attachNearbyCards()
        redrawStalePagesInView()
        if let id = model.offscreenCard, let view = cardViews[id], scrollView.contentView.bounds.intersection(view.frame).width > view.frame.width * 0.6 {
            model.offscreenCard = nil
        }
        savePositionSoon()
    }

    // MARK: Pointer input from pages

    private func page(at docPoint: CGPoint) -> PageView? {
        pageViews.values.first { $0.frame.contains(docPoint) }
            ?? pageViews.values.min { abs($0.frame.midY - docPoint.y) < abs($1.frame.midY - docPoint.y) }
    }

    func pageMouseDown(_ pageView: PageView, event: NSEvent) {
        guard let model else { return }
        window?.makeFirstResponder(documentView)
        model.pending = nil
        clearSelection()
        AnswerTextView.clearActive()
        let local = pageView.convert(event.locationInWindow, from: nil)
        let pt = pageView.geometry.pagePoint(fromView: local, viewSize: pageView.bounds.size)
        let areaGesture = model.tool == .area || event.modifierFlags.contains(.shift) || event.modifierFlags.contains(.option) || pageView.geometry.isTextless
        if areaGesture {
            areaDrag = (pageView.number, local)
            pageView.areaRect = CGRect(origin: local, size: .zero)
            return
        }
        dragStart = (pageView.number, pt)
        let page = pageView.geometry.page
        if event.clickCount == 2 {
            selection = page.selectionForWord(at: pt)
        } else if event.clickCount >= 3 {
            selection = page.selectionForLine(at: pt)
        }
        showSelection()
    }

    func pageMouseDragged(_ pageView: PageView, event: NSEvent) {
        guard let model else { return }
        documentView.autoscroll(with: event)
        let docPoint = documentView.convert(event.locationInWindow, from: nil)
        if let area = areaDrag, let view = pageViews[area.page] {
            let local = view.convert(event.locationInWindow, from: nil)
            view.areaRect = CGRect(x: min(area.start.x, local.x), y: min(area.start.y, local.y), width: abs(local.x - area.start.x), height: abs(local.y - area.start.y)).intersection(view.bounds)
            return
        }
        guard let start = dragStart, let startView = pageViews[start.page], let target = page(at: docPoint) else { return }
        let local = target.convert(event.locationInWindow, from: nil)
        let pt = target.geometry.pagePoint(fromView: local, viewSize: target.bounds.size)
        selection = model.document?.selection(from: startView.geometry.page, at: start.point, to: target.geometry.page, at: pt)
        showSelection()
    }

    func pageMouseUp(_ pageView: PageView, event: NSEvent) {
        guard let model else { return }
        if let area = areaDrag, let view = pageViews[area.page] {
            areaDrag = nil
            let rect = view.areaRect
            view.areaRect = .zero
            guard let rect else { return }
            let n = NormalizedRect(x: rect.minX / view.bounds.width, y: rect.minY / view.bounds.height, width: rect.width / view.bounds.width, height: rect.height / view.bounds.height)
            guard Geometry.areaAccepted(n) else { return }
            let anchor = YarnAnchor(
                sourceType: .pdfArea,
                bookId: model.book.id,
                pageNumber: view.number,
                selectedText: view.geometry.text(in: n),
                lineRects: [n],
                boundingRect: n,
                croppedImage: view.geometry.croppedPNG(n),
                context: model.pageContext(view.number)
            )
            model.pending = PendingSelection(anchors: [anchor], rect: convert(rect, from: view))
            return
        }
        defer { dragStart = nil }
        guard let sel = selection else { return }
        let anchors = anchorsFrom(sel)
        guard !anchors.isEmpty, let rect = selectionRect(sel) else { return }
        model.pending = PendingSelection(anchors: anchors, rect: rect)
    }

    private func clearSelection() {
        selection = nil
        for view in pageViews.values where !view.selectionRects.isEmpty {
            view.selectionRects = []
            view.needsDisplay = true
        }
    }

    private func showSelection() {
        var byPage: [Int: [CGRect]] = [:]
        if let sel = selection {
            for line in sel.selectionsByLine() {
                for page in line.pages {
                    let index = model?.document?.index(for: page) ?? -1
                    guard index >= 0, let view = pageViews[index + 1] else { continue }
                    let n = view.geometry.normalized(fromPage: line.bounds(for: page))
                    byPage[index + 1, default: []].append(CGRect(x: n.x * view.bounds.width, y: n.y * view.bounds.height, width: n.width * view.bounds.width, height: n.height * view.bounds.height))
                }
            }
        }
        for (number, view) in pageViews {
            let rects = byPage[number] ?? []
            if view.selectionRects != rects {
                view.selectionRects = rects
                view.needsDisplay = true
            }
        }
    }

    private func anchorsFrom(_ sel: PDFSelection) -> [YarnAnchor] {
        guard let model else { return [] }
        let lines = sel.selectionsByLine()
        var out: [YarnAnchor] = []
        for page in sel.pages {
            let index = model.document?.index(for: page) ?? -1
            guard index >= 0, let view = pageViews[index + 1] else { continue }
            let pageLines = lines.filter { $0.pages.contains(page) }
            let rects = pageLines.map { view.geometry.normalized(fromPage: $0.bounds(for: page).insetBy(dx: -1, dy: -1)) }.filter { $0.width > 0 && $0.height > 0 && $0.height < 0.25 }
            let pieces = pageLines.map { SelectionText.Piece(text: $0.string ?? "", bounds: $0.bounds(for: page)) }
            let text = SelectionText.join(pieces, inLine: .space, lineBreak: " ").replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !rects.isEmpty, !text.isEmpty else { continue }
            out.append(YarnAnchor(sourceType: .pdfText, bookId: model.book.id, pageNumber: index + 1, selectedText: text, lineRects: rects, boundingRect: Geometry.union(rects), context: model.pageContext(index + 1)))
        }
        return out
    }

    /// The selection's box in this view's coordinates, for placing the menu.
    private func selectionRect(_ sel: PDFSelection) -> CGRect? {
        var rect: CGRect?
        for page in sel.pages {
            guard let model, let view = pageViews[(model.document?.index(for: page) ?? -2) + 1] else { continue }
            let n = view.geometry.normalized(fromPage: sel.bounds(for: page))
            let local = CGRect(x: n.x * view.bounds.width, y: n.y * view.bounds.height, width: n.width * view.bounds.width, height: n.height * view.bounds.height)
            let r = convert(local, from: view)
            rect = rect.map { $0.union(r) } ?? r
        }
        return rect
    }

    func knotClicked(_ cardId: String) {
        guard let model else { return }
        model.cards.setCollapsed(cardId, false)
        model.focusedCard = cardId
    }

    func highlightClicked(_ cardId: String) {
        guard let model, !cardId.isEmpty else { return }
        if model.cards.cards.first(where: { $0.id == cardId })?.collapsed == true { model.cards.setCollapsed(cardId, false) }
        // With threads hidden, a highlight brings back just its own card.
        if model.hideThreads { model.revealed.insert(cardId) }
        model.focusedCard = cardId
    }

    // MARK: Threads from inside a card

    /// A selection inside a card's answer: the anchor is stored relative to the card (world units), and
    /// the new card goes to the lane right of its parent.
    func cardTextSelected(_ cardId: String, text: String, windowRect: CGRect) {
        guard let model, let cardView = cardViews[cardId] else { return }
        let doc = documentView.convert(windowRect, from: nil)
        let rel = doc.offsetBy(dx: -cardView.frame.minX, dy: -cardView.frame.minY)
        let anchor = YarnAnchor(
            sourceType: .card,
            bookId: model.book.id,
            pageNumber: 0,
            selectedText: text,
            lineRects: [],
            boundingRect: NormalizedRect(x: rel.minX, y: rel.minY, width: rel.width, height: rel.height),
            sourceCardId: cardId,
            context: model.cardContext(cardId)
        )
        clearSelection()
        model.pending = PendingSelection(anchors: [anchor], rect: convert(windowRect, from: nil), parentCardId: cardId)
    }

    // MARK: Card clicks and dragging (pin)

    /// A click on a card brings it forward.
    func cardClicked(_ cardId: String, at point: CGPoint) {
        guard let model else { return }
        model.focusedCard = cardId
    }

    func cardDragChanged(_ cardId: String, translation: CGSize) {
        guard let view = cardViews[cardId], let p = lastPlacements[cardId] else { return }
        if dragCard?.id != cardId { dragCard = (cardId, p) }
        view.setFrameOrigin(CGPoint(x: dragCard!.origin.x + translation.width, y: dragCard!.origin.y + translation.height))
        // The yarns follow the card at once; the rope motion runs on the display clock.
        refreshYarns(dt: 0)
        startRopes()
    }

    func cardDragEnded(_ cardId: String, translation: CGSize) {
        guard let model, let start = dragCard, start.id == cardId else { return }
        dragCard = nil
        let end = CGPoint(x: start.origin.x + translation.width, y: start.origin.y + translation.height)
        // Until the next layout, draw from where the card was let go, not from where it started.
        lastPlacements[cardId] = end
        model.cards.pin(cardId, x: end.x, y: end.y)
        refreshYarns(dt: 0)
        startRopes()
    }

    // MARK: Yarns

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    /// Redraws the yarns from the current card positions and, unless motion is reduced, advances the ropes.
    func refreshYarns(dt: Double) {
        guard let model else { return }
        var place = lastPlacements
        if let drag = dragCard, let view = cardViews[drag.id] { place[drag.id] = view.frame.origin }
        let segments = model.segments(placements: place)
        if reduceMotion {
            ropes = YarnRopes()
        } else {
            let held = dragCard.map { d in Set(segments.filter { $0.cardId == d.id || $0.sourceCardId == d.id }.map(\.id)) } ?? []
            ropes.step(segments, held: held, dt: dt)
        }
        yarnView.segments = segments
        yarnView.bends = ropes.bends
        yarnView.needsDisplay = true
        if dragCard != nil { layoutClips(place) }
    }

    /// Folded threads opened inside a card, tied to that card's edge; a click unfolds them.
    private func layoutClips(_ place: [String: CGPoint]) {
        guard let model else { return }
        let clips = model.clips(placements: place, lang: lang)
        let ids = Set(clips.map(\.cardId))
        for (id, view) in clipViews where !ids.contains(id) {
            view.removeFromSuperview()
            clipViews[id] = nil
        }
        for clip in clips {
            let badge = ClipBadge(clip: clip) { [weak self] in self?.highlightClicked(clip.cardId) }
            let view = clipViews[clip.cardId] ?? {
                let v = ZoomedHostingView(rootView: badge)
                v.sizingOptions = []
                clipViews[clip.cardId] = v
                return v
            }()
            view.rootView = badge
            let size = ClipBadge.size
            // The hole sits just inside the card's edge; the knot and its tails hang outside.
            view.frame = CGRect(x: clip.right ? clip.point.x - ClipBadge.inset : clip.point.x - size.width + ClipBadge.inset, y: clip.point.y - size.height / 2, width: size.width, height: size.height)
            if view.superview == nil || documentView.subviews.last.map({ !($0 is ZoomedHostingView<ClipBadge>) }) == true {
                documentView.addSubview(view, positioned: .above, relativeTo: nil)
            }
        }
    }

    private func startRopes() {
        guard !reduceMotion, window != nil else { return }
        if ropeLink == nil {
            let link = displayLink(target: self, selector: #selector(ropeTick(_:)))
            link.add(to: .main, forMode: .common)
            ropeLink = link
        }
        ropeLink?.isPaused = false
    }

    @objc private func ropeTick(_ link: CADisplayLink) {
        let now = link.timestamp
        let dt = lastTick.map { min(1.0 / 30, max(0, now - $0)) } ?? 1.0 / 120
        lastTick = now
        refreshYarns(dt: dt)
        if dragCard == nil, ropes.isSettled {
            link.isPaused = true
            lastTick = nil
        }
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        if newWindow == nil {
            ropeLink?.invalidate()
            ropeLink = nil
        }
    }

    // MARK: Copy

    @objc func copySelection() {
        guard let text = selection?.string, !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// The world's document view: flipped so world coordinates read top-down like the web engine.
final class WorldDocumentView: NSView {
    weak var world: WorldView?
    private var panStart: (event: CGPoint, origin: CGPoint)?

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    // Dragging on empty space pans.
    override func mouseDown(with event: NSEvent) {
        guard let clip = enclosingScrollView?.contentView else { return }
        world?.model?.pending = nil
        AnswerTextView.clearActive()
        panStart = (event.locationInWindow, clip.bounds.origin)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = panStart, let scroll = enclosingScrollView else { return }
        let m = scroll.magnification
        let dx = (event.locationInWindow.x - start.event.x) / m
        let dy = (event.locationInWindow.y - start.event.y) / m
        scroll.contentView.scroll(to: CGPoint(x: start.origin.x - dx, y: start.origin.y + dy))
        scroll.reflectScrolledClipView(scroll.contentView)
        NSCursor.closedHand.set()
    }

    override func mouseUp(with event: NSEvent) {
        panStart = nil
        NSCursor.arrow.set()
    }

    @objc func copy(_ sender: Any?) { world?.copySelection() }

    override func keyDown(with event: NSEvent) {
        guard let scroll = enclosingScrollView else { return super.keyDown(with: event) }
        let page = scroll.contentView.bounds.height * 0.85
        let shift = event.modifierFlags.contains(.shift)
        switch event.keyCode {
        case 123 where world?.model?.pagedReading == true: world?.turnPage(-1) // left arrow
        case 124 where world?.model?.pagedReading == true: world?.turnPage(1) // right arrow
        case 121 where world?.model?.pagedReading == true: world?.turnPage(1)
        case 116 where world?.model?.pagedReading == true: world?.turnPage(-1)
        case 121: scrollBy(page) // page down
        case 116: scrollBy(-page) // page up
        case 49: scrollBy(shift ? -page : page) // space
        case 125: scrollBy(60) // down arrow
        case 126: scrollBy(-60) // up arrow
        default: super.keyDown(with: event)
        }
    }

    private func scrollBy(_ dy: CGFloat) {
        guard let scroll = enclosingScrollView else { return }
        var origin = scroll.contentView.bounds.origin
        origin.y += dy
        scroll.contentView.scroll(to: origin)
        scroll.reflectScrolledClipView(scroll.contentView)
    }
}

/// One PDF page in world units, with its highlights, the live selection and folded-thread knots.
final class PageView: NSView {
    let geometry: PageGeometry
    let number: Int
    weak var world: WorldView?
    var highlights: [ReaderModel.Highlight] = []
    /// The reader's own highlights ("Vurgula"), drawn in yellow under everything else.
    var marks: [[NormalizedRect]] = []
    var knots: [ReaderModel.Knot] = []
    var selectionRects: [CGRect] = []
    var areaRect: CGRect? = nil {
        didSet { needsDisplay = true }
    }
    private var knotViews: [String: ZoomedHostingView<KnotBadge>] = [:]
    /// The bottom-right corner: drag to resize the book's pages (owner, 16 Nov).
    let grip = PageResizeGrip()

    init(geometry: PageGeometry, number: Int) {
        self.geometry = geometry
        self.number = number
        super.init(frame: .zero)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        layer?.shadowOpacity = 0.12
        layer?.shadowRadius = 8
        layer?.shadowOffset = CGSize(width: 0, height: -3)
        grip.page = self
        addSubview(grip)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil))
    }

    /// The grip shows while the pointer is over the page.
    override func mouseEntered(with event: NSEvent) { grip.shown = true }
    override func mouseExited(with event: NSEvent) { grip.shown = false }

    /// The grip is about 18 points on screen at any zoom, in the page's bottom-right corner.
    func placeGrip() {
        let m = max(world?.scrollView.magnification ?? 1, 0.05)
        let side = min(80, max(10, 18 / m))
        let frame = CGRect(x: bounds.width - side, y: bounds.height - side, width: side, height: side)
        if grip.frame != frame {
            grip.frame = frame
            window?.invalidateCursorRects(for: grip)
        }
        if let t = world.map({ UIText($0.lang)["resizePage"] }), grip.toolTip != t { grip.toolTip = t }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        geometry.draw(in: ctx, size: bounds.size)
        let w = bounds.width, h = bounds.height
        func r(_ n: NormalizedRect) -> CGRect { CGRect(x: n.x * w, y: n.y * h, width: n.width * w, height: n.height * h) }
        // Highlights multiply like a real highlighter, so black text never fades.
        ctx.saveGState()
        ctx.setBlendMode(.multiply)
        if !marks.isEmpty {
            ctx.setFillColor(Theme.highlighter.cgColor)
            for rects in marks {
                for rect in rects { ctx.addPath(CGPath(roundedRect: r(rect), cornerWidth: 2, cornerHeight: 2, transform: nil)); ctx.fillPath() }
            }
        }
        for hl in highlights where !hl.area {
            ctx.setFillColor(hl.pending ? NSColor(srgbRed: 0.2, green: 0.376, blue: 0.31, alpha: 0.16).cgColor : Theme.highlight(hl.color).cgColor)
            for rect in hl.rects { ctx.addPath(CGPath(roundedRect: r(rect), cornerWidth: 2, cornerHeight: 2, transform: nil)); ctx.fillPath() }
        }
        ctx.restoreGState()
        for hl in highlights where hl.area {
            guard let rect = hl.rects.first.map(r) else { continue }
            let stroke = Theme.hex(SharedContract.tokens.tone(hl.color).light)
            ctx.setFillColor(stroke.withAlphaComponent(0.08).cgColor)
            ctx.setStrokeColor(stroke.cgColor)
            ctx.setLineWidth(1.5)
            let path = CGPath(roundedRect: rect, cornerWidth: 4, cornerHeight: 4, transform: nil)
            ctx.addPath(path)
            ctx.drawPath(using: .fillStroke)
        }
        if !selectionRects.isEmpty {
            ctx.setFillColor(NSColor.selectedTextBackgroundColor.withAlphaComponent(0.45).cgColor)
            ctx.saveGState()
            ctx.setBlendMode(.multiply)
            for rect in selectionRects { ctx.fill(rect) }
            ctx.restoreGState()
        }
        if let area = areaRect, area.width > 0 {
            ctx.setStrokeColor(Theme.hex("#33604F").cgColor)
            ctx.setFillColor(Theme.hex("#33604F").withAlphaComponent(0.08).cgColor)
            ctx.setLineDash(phase: 0, lengths: [5, 4])
            ctx.setLineWidth(1.5)
            ctx.addRect(area)
            ctx.drawPath(using: .fillStroke)
        }
    }

    func syncKnots() {
        let ids = Set(knots.map(\.cardId))
        for (id, view) in knotViews where !ids.contains(id) {
            view.removeFromSuperview()
            knotViews[id] = nil
        }
        for knot in knots {
            let badge = KnotBadge(knot: knot) { [weak self] in self?.world?.knotClicked(knot.cardId) }
            let view = knotViews[knot.cardId] ?? {
                let v = ZoomedHostingView(rootView: badge)
                addSubview(v, positioned: .below, relativeTo: grip)
                knotViews[knot.cardId] = v
                return v
            }()
            view.rootView = badge
            let size = view.fittingSize
            view.frame = CGRect(x: (knot.rect.x + knot.rect.width) * bounds.width + 6, y: (knot.rect.y + knot.rect.height / 2) * bounds.height - size.height / 2, width: size.width, height: size.height)
        }
    }

    /// Right-click on a page: translate it, or show its text.
    override func menu(for event: NSEvent) -> NSMenu? {
        guard let world, let model = world.model else { return nil }
        let t = UIText(world.lang)
        let menu = NSMenu()
        let translate = NSMenuItem(title: t["translateThisPage"], action: #selector(translateThisPage), keyEquivalent: "")
        translate.target = self
        translate.image = NSImage(systemSymbolName: "translate", accessibilityDescription: nil)
        menu.addItem(translate)
        let extract = NSMenuItem(title: t["extractText"], action: #selector(extractThisPage), keyEquivalent: "")
        extract.target = self
        extract.image = NSImage(systemSymbolName: "doc.text", accessibilityDescription: nil)
        menu.addItem(extract)
        _ = model
        return menu
    }

    @objc private func translateThisPage() { world?.model?.startTranslating(at: number) }
    @objc private func extractThisPage() { world?.model?.extractingPage = .init(page: number) }

    override func mouseDown(with event: NSEvent) {
        let local = convert(event.locationInWindow, from: nil)
        let n = CGPoint(x: local.x / bounds.width, y: local.y / bounds.height)
        if event.clickCount == 1, let hit = highlights.first(where: { h in !h.pending && h.rects.contains { CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height).contains(n) } }), world?.model?.tool == .select, !event.modifierFlags.contains(.shift) {
            // A click (not a drag) on a highlight opens its thread; a drag still selects text.
            pendingHighlightClick = hit.cardId
        }
        world?.pageMouseDown(self, event: event)
    }

    private var pendingHighlightClick: String?

    override func mouseDragged(with event: NSEvent) {
        pendingHighlightClick = nil
        world?.pageMouseDragged(self, event: event)
    }

    override func mouseUp(with event: NSEvent) {
        if let id = pendingHighlightClick {
            pendingHighlightClick = nil
            world?.highlightClicked(id)
            return
        }
        world?.pageMouseUp(self, event: event)
    }

    override func resetCursorRects() {
        let crosshair = world?.model?.tool == .area || geometry.isTextless
        addCursorRect(bounds, cursor: crosshair ? .crosshair : .iBeam)
    }
}

/// A page's bottom-right corner: dragging it resizes every page of the book (threads, highlights and
/// translations follow); a double-click returns to the standard size. Drawn only while the pointer is
/// over the page, like a window's resize corner.
final class PageResizeGrip: NSView {
    weak var page: PageView?
    var shown = false {
        didSet { if shown != oldValue { needsDisplay = true } }
    }
    private var resizing = false

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard shown || resizing, let ctx = NSGraphicsContext.current?.cgContext else { return }
        let w = bounds.width, h = bounds.height
        ctx.setStrokeColor(Theme.hex("#33604F").withAlphaComponent(0.7).cgColor)
        ctx.setLineWidth(max(1, w / 12))
        ctx.setLineCap(.round)
        for f in [0.3, 0.6] {
            ctx.move(to: CGPoint(x: w * (1 - f) - w * 0.12, y: h - w * 0.12))
            ctx.addLine(to: CGPoint(x: w - w * 0.12, y: h * (1 - f) - h * 0.12))
        }
        ctx.strokePath()
    }

    override func resetCursorRects() {
        if #available(macOS 15.0, *) {
            addCursorRect(bounds, cursor: .frameResize(position: .bottomRight, directions: .all))
        } else {
            addCursorRect(bounds, cursor: .crosshair)
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard let page, let world = page.world else { return }
        if event.clickCount == 2 {
            world.resetPageSize(page)
            return
        }
        resizing = true
        world.pageResizeBegan(page)
    }

    override func mouseDragged(with event: NSEvent) {
        guard resizing else { return }
        page?.world?.pageResizeDragged(event)
    }

    override func mouseUp(with event: NSEvent) {
        guard resizing else { return }
        resizing = false
        needsDisplay = true
        page?.world?.pageResizeEnded()
    }
}

/// Bezier yarns between anchors and cards.
final class YarnOverlayView: NSView {
    var segments: [YarnSegment] = []
    /// Rope bends by segment id (see YarnRopes).
    var bends: [String: CGPoint] = [:]

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let s = SharedContract.tokens.yarnStroke
        for seg in segments {
            let (c1, c2) = YarnRopes.controls(seg, bend: bends[seg.id])
            let path = CGMutablePath()
            path.move(to: seg.from)
            path.addCurve(to: seg.to, control1: c1, control2: c2)
            let color = Theme.yarn(seg.color).usingColorSpace(.sRGB) ?? .gray
            ctx.addPath(path)
            ctx.setStrokeColor(color.withAlphaComponent(s.haloOpacity).cgColor)
            ctx.setLineWidth(s.haloWidth)
            ctx.strokePath()
            ctx.addPath(path)
            ctx.setStrokeColor(color.withAlphaComponent(s.mainOpacity).cgColor)
            ctx.setLineWidth(s.mainWidth)
            ctx.setLineCap(.round)
            if seg.dashed { ctx.setLineDash(phase: 0, lengths: [5, 5]) } else { ctx.setLineDash(phase: 0, lengths: []) }
            ctx.strokePath()
            ctx.setLineDash(phase: 0, lengths: [])
            ctx.setFillColor(color.cgColor)
            ctx.fillEllipse(in: CGRect(x: seg.from.x - s.startKnotRadius, y: seg.from.y - s.startKnotRadius, width: s.startKnotRadius * 2, height: s.startKnotRadius * 2))
            ctx.fillEllipse(in: CGRect(x: seg.to.x - s.endKnotRadius, y: seg.to.y - s.endKnotRadius, width: s.endKnotRadius * 2, height: s.endKnotRadius * 2))
        }
    }
}

/// A folded thread, tied to the card it was opened from: a small hole punched near the card's edge, a
/// strand of the thread's colour through it, knotted just outside with two short tails.
struct ClipBadge: View {
    static let size = CGSize(width: 36, height: 36)
    /// How far into the card the hole sits (the badge's left part overlaps the card).
    static let inset: CGFloat = 13
    let clip: ReaderModel.Clip
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            TiedKnot(color: Color.yarn(clip.color))
                .scaleEffect(x: clip.right ? 1 : -1, y: 1)
                .frame(width: Self.size.width, height: Self.size.height)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .help(clip.title)
        .accessibilityLabel(clip.title)
    }
}

/// Drawn for a card edge on the left of the badge at x = ClipBadge.inset.
struct TiedKnot: View {
    let color: Color

    var body: some View {
        Canvas { ctx, size in
            let hole = CGPoint(x: 7, y: 15)
            let knot = CGPoint(x: 21, y: 16)
            // The punched hole: the background showing through, with a pressed rim.
            let holeRect = CGRect(x: hole.x - 3.4, y: hole.y - 3.4, width: 6.8, height: 6.8)
            ctx.fill(Path(ellipseIn: holeRect), with: .color(Color.paperSunken))
            ctx.fill(Path(ellipseIn: holeRect.insetBy(dx: 0.6, dy: 0.6).offsetBy(dx: 0, dy: 0.5)), with: .color(.black.opacity(0.22)))
            ctx.stroke(Path(ellipseIn: holeRect), with: .color(Color.inkFaint.opacity(0.7)), lineWidth: 0.8)
            // The strand: in through the hole, over and under the card's edge, to the knot.
            var over = Path()
            over.move(to: hole)
            over.addCurve(to: knot, control1: CGPoint(x: 10, y: 6), control2: CGPoint(x: 17, y: 7))
            var under = Path()
            under.move(to: CGPoint(x: hole.x + 1, y: hole.y + 1))
            under.addCurve(to: knot, control1: CGPoint(x: 11, y: 24), control2: CGPoint(x: 17, y: 24))
            ctx.stroke(under, with: .color(color.opacity(0.75)), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            ctx.stroke(over, with: .color(color), style: StrokeStyle(lineWidth: 2.2, lineCap: .round))
            // The knot: two turns pulled tight.
            for (dx, dy, r) in [(-1.2, -0.8, 3.6), (1.3, 1.0, 3.3)] {
                let c = CGRect(x: knot.x + dx - r, y: knot.y + dy - r, width: r * 2, height: r * 2)
                ctx.fill(Path(ellipseIn: c), with: .color(color))
                ctx.stroke(Path(ellipseIn: c), with: .color(.black.opacity(0.18)), lineWidth: 0.6)
            }
            // Two loose tails.
            var tail1 = Path()
            tail1.move(to: CGPoint(x: knot.x + 2, y: knot.y + 3))
            tail1.addQuadCurve(to: CGPoint(x: 31, y: 30), control: CGPoint(x: 29, y: 21))
            var tail2 = Path()
            tail2.move(to: CGPoint(x: knot.x, y: knot.y + 3.5))
            tail2.addQuadCurve(to: CGPoint(x: 24, y: 33), control: CGPoint(x: 20, y: 28))
            for t in [tail1, tail2] { ctx.stroke(t, with: .color(color), style: StrokeStyle(lineWidth: 1.6, lineCap: .round)) }
        }
        .allowsHitTesting(false)
    }
}

struct KnotBadge: View {
    let knot: ReaderModel.Knot
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Circle().fill(Color.yarn(knot.color)).frame(width: 6, height: 6)
                Text(knot.label).font(.system(size: 10, weight: .semibold))
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Capsule().fill(Color(nsColor: .white)))
            .overlay(Capsule().stroke(Color.yarn(knot.color).opacity(0.4)))
            .foregroundStyle(Color.yarn(knot.color))
        }
        .buttonStyle(.borderless)
    }
}

extension Geometry {
    static var g: Tokens.GeometryTokens { SharedContract.tokens.geometry }
}
