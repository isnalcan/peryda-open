import AppKit
import Observation
import PDFKit
import PerydaKit

enum ReaderTool: String {
    case select, brush, area
}

/// A selection waiting for the reader to choose what to do with it.
struct PendingSelection {
    var anchors: [YarnAnchor]
    /// In the reader view's coordinates (top-left origin), for placing the menu.
    var rect: CGRect
    var parentCardId: String?
}

struct YarnSegment: Identifiable {
    var id: String
    var color: YarnColor
    var from: CGPoint
    var to: CGPoint
    var dashed = false
    /// The card the yarn ends at, and the card it starts from (for threads opened inside a card).
    var cardId = ""
    var sourceCardId: String?
}

/// Camera requests sent from buttons to the reading surface; the surface never moves on its own.
enum CameraCommand: Equatable {
    case focus, map, actualSize, zoomIn, zoomOut
    /// The page in the middle with room for threads on both sides (the opening view).
    case overview
    case previousPage, nextPage
    /// The top of a page.
    case goToPage(Int)
    /// A page and its translation side by side (after the reader asks for a translation).
    case showTranslation(page: Int)
    case show(cardId: String)
}

@MainActor
@Observable
final class ReaderModel {
    let book: BookRecord
    /// The PDF being read; nil for EPUB books.
    let document: PDFDocument?
    /// The EPUB being read; nil for PDF books.
    let epub: EPUBBook?
    let pages: [PageBox]
    let cards: CardsModel
    private let store: LibraryStore

    var tool: ReaderTool = .select
    var brushColor: YarnColor = .mint
    var pending: PendingSelection?
    var bridgeHeld: [YarnAnchor]?
    var hideThreads = false {
        didSet { if !hideThreads { revealed = [] } }
    }
    /// Cards the reader opened from their highlight while threads are hidden.
    var revealed: Set<String> = []
    var heights: [String: Double] = [:]
    var focusedCard: String?
    var cameraCommand: CameraCommand?
    var magnification: Double = 1
    var currentPage = 1
    /// One page at a time instead of one long scroll; a reader preference.
    var pagedReading = UserDefaults.standard.bool(forKey: "pagedReading") {
        didSet { UserDefaults.standard.set(pagedReading, forKey: "pagedReading") }
    }
    /// Cards whose quote is shortened to its first lines.
    var shortQuotes: Set<String> = []
    var toast: String?
    var showJournal = false
    var liveBrush: (from: CGPoint, to: CGPoint)?
    var offscreenCard: String?
    var journal: [JournalRecord] = []
    /// 1-based chapter at the top of the EPUB view.
    var epubChapter: Int?
    var summary: (text: String, createdAt: Date)?
    var summarizing = false
    var summaryError: String?
    private var summaryTask: Task<Void, Never>?
    private let streamer: AnswerStreaming

    // MARK: Page translation state

    /// The language pages are translated into (this book).
    var translationTarget: Lang = .tr {
        didSet { if let key = SafeID.defaultsKey("translateLang", book.id) { UserDefaults.standard.set(translationTarget.rawValue, forKey: key) } }
    }
    /// The size of the text in this book's cards (×1 is as designed), kept per book: in some PDFs the
    /// cards end up small beside large pages (owner test 14 Nov).
    var cardTextScale: Double = 1 {
        didSet { if let key = SafeID.defaultsKey("cardTextScale", book.id) { UserDefaults.standard.set(cardTextScale, forKey: key) } }
    }
    static let cardTextScales: [Double] = [0.85, 1, 1.15, 1.3, 1.5, 1.75]

    /// One step smaller (−1) or larger (+1) text in every card of this book.
    func stepCardText(_ delta: Int) {
        let steps = Self.cardTextScales
        let here = steps.indices.min { abs(steps[$0] - cardTextScale) < abs(steps[$1] - cardTextScale) } ?? 1
        cardTextScale = steps[min(max(here + delta, 0), steps.count - 1)]
    }

    var canShrinkCardText: Bool { cardTextScale > Self.cardTextScales.first! + 0.001 }
    var canGrowCardText: Bool { cardTextScale < Self.cardTextScales.last! - 0.001 }

    private static func savedCardTextScale(_ bookId: String) -> Double {
        savedScale("cardTextScale", bookId)
    }

    /// A per-book text size kept under `prefix`, or ×1 when none (or an unknown value) is saved.
    private static func savedScale(_ prefix: String, _ bookId: String) -> Double {
        let saved = SafeID.defaultsKey(prefix, bookId).map { UserDefaults.standard.double(forKey: $0) } ?? 0
        return cardTextScales.contains(saved) ? saved : 1
    }

    /// The size of the text on this book's translated pages, on top of the size that fits the page
    /// (owner test 15 Nov). Larger than fits, the translation scrolls inside its page. Kept per book.
    var translationTextScale: Double = 1 {
        didSet { if let key = SafeID.defaultsKey("translationTextScale", book.id) { UserDefaults.standard.set(translationTextScale, forKey: key) } }
    }

    /// One step smaller (−1) or larger (+1) text on every translated page of this book.
    func stepTranslationText(_ delta: Int) {
        let steps = Self.cardTextScales
        let here = steps.indices.min { abs(steps[$0] - translationTextScale) < abs(steps[$1] - translationTextScale) } ?? 1
        translationTextScale = steps[min(max(here + delta, 0), steps.count - 1)]
    }

    var canShrinkTranslationText: Bool { translationTextScale > Self.cardTextScales.first! + 0.001 }
    var canGrowTranslationText: Bool { translationTextScale < Self.cardTextScales.last! - 0.001 }

    /// Pages read with Pery in "Extract page text" (PDFs only).
    private(set) var readings: PageReadings?

    /// A page's picture for Pery to read (JPEG at 2×), or for translating a scanned page (1.6×).
    func pagePicture(_ number: Int, scale: CGFloat = 2, quality: CGFloat = 0.88) -> String? {
        guard number >= 1, number <= pages.count, let page = document?.page(at: number - 1) else { return nil }
        return PageGeometry(page: page).jpegDataURL(scale: scale, quality: quality)
    }

    /// Asking which pages to translate.
    var askingRange = false
    /// The page whose extracted text is shown.
    var extractingPage: ExtractRequest?
    struct ExtractRequest: Identifiable { var page: Int; var id: Int { page } }
    /// The first wait before asking Google about a batch job; later waits grow to 30 s.
    var pollStart: Duration = .seconds(5)
    private var pollTask: Task<Void, Never>?
    private var preparing: Set<Int> = []
    /// Bumped by "Stop translating": pages being prepared are dropped.
    private var translateGeneration = 0

    /// Pages still on their way: being prepared, waiting their turn, streaming in or in a batch job.
    var pendingTranslations: Int { preparing.count + cards.unfinishedTranslations.count }

    /// Stops every page translation still on its way; pages already translated stay.
    func stopTranslating(lang: Lang) {
        translateGeneration += 1
        let preparingNow = preparing.count
        preparing.removeAll()
        let stopped = cards.stopTranslations() + preparingNow
        if stopped > 0 { flash(UIText(lang)("translationsStopped", ["n": stopped])) }
    }

    convenience init?(book: BookRecord, app: AppModel) {
        self.init(book: book, store: app.store, lang: app.lang, settings: app.settings, streamer: app.streamer, batcher: app.batcher)
        cards.explainTerms = app.explainTerms
        app.register(self)
    }

    init?(book: BookRecord, store: LibraryStore, lang: Lang, settings: ByokSettings, streamer: AnswerStreaming, batcher: PageBatching = GeminiBatch()) {
        guard let file = try? store.fileURL(for: book), let doc = PDFDocument(url: file) else { return nil }
        self.book = book
        self.document = doc
        self.epub = nil
        self.store = store
        let sizes: [CGSize] = (0..<doc.pageCount).map { i in
            guard let page = doc.page(at: i) else { return CGSize(width: 612, height: 792) }
            return PageGeometry(page: page).displaySize
        }
        self.pages = Geometry.pageLayout(sizes)
        self.cards = CardsModel(bookId: book.id, bookTitle: book.title, lang: lang, settings: settings, store: store, streamer: streamer, batcher: batcher)
        self.streamer = streamer
        let saved = SafeID.defaultsKey("translateLang", book.id).flatMap { UserDefaults.standard.string(forKey: $0) }
        self.translationTarget = Lang(rawValue: saved ?? "") ?? lang
        self.cards.pageCount = doc.pageCount
        self.cardTextScale = Self.savedCardTextScale(book.id)
        self.translationTextScale = Self.savedScale("translationTextScale", book.id)
        self.readings = PageReadings(bookId: book.id, bookTitle: book.title, pageCount: doc.pageCount, settings: settings, store: store, streamer: streamer, batcher: batcher) { [weak self] page in
            self?.pagePicture(page)
        }
        cards.pagePicture = { [weak self] page in self?.pagePicture(page, scale: 1.6, quality: 0.86) }
        cards.dropStoredPagePictures()
        store.markOpened(book.id)
        ensurePolling()
        reloadJournal()
        loadSummary()
    }

    /// Opens an EPUB, unpacked into the app's cache.
    init?(epubBook book: BookRecord, store: LibraryStore, lang: Lang, settings: ByokSettings, streamer: AnswerStreaming) {
        guard let caches = AppModel.epubCache, let file = try? store.fileURL(for: book),
              let opened = try? EPUBBook.open(file, cacheParent: caches, id: book.id)
        else { return nil }
        Self.openEpubs[book.id, default: 0] += 1
        self.book = book
        self.document = nil
        self.epub = opened
        self.pages = []
        self.store = store
        self.cards = CardsModel(bookId: book.id, bookTitle: book.title, lang: lang, settings: settings, store: store, streamer: streamer)
        self.streamer = streamer
        self.translationTarget = lang
        self.cardTextScale = Self.savedCardTextScale(book.id)
        self.translationTextScale = Self.savedScale("translationTextScale", book.id)
        store.markOpened(book.id)
        reloadJournal()
        loadSummary()
    }

    private func loadSummary() {
        if let key = SafeID.defaultsKey("journalSummary", book.id), let saved = UserDefaults.standard.dictionary(forKey: key),
           let text = saved["text"] as? String, let at = saved["createdAt"] as? Double {
            summary = (text, Date(timeIntervalSince1970: at))
        }
    }

    /// EPUB readers open per book: the unpacked copy is deleted when the last one closes.
    private static var openEpubs: [String: Int] = [:]
    private(set) var isClosed = false

    /// The reader's window closed: stop asking about batch jobs and, for an EPUB nobody else is
    /// reading, delete its unpacked copy (the book itself stays in the library).
    func close() {
        guard !isClosed else { return }
        isClosed = true
        pollTask?.cancel()
        summaryTask?.cancel()
        guard epub != nil else { return }
        let left = (Self.openEpubs[book.id] ?? 1) - 1
        Self.openEpubs[book.id] = left > 0 ? left : nil
        if left <= 0, let caches = AppModel.epubCache { try? EPUBBook.removeCache(parent: caches, id: book.id) }
    }

    /// The book's page could not be shown safely (WebKit's network block was unavailable).
    var epubBlocked = false

    // MARK: Page translation

    /// A page has a text layer when it holds at least 25 characters besides spaces.
    static func hasTextLayer(_ raw: String) -> Bool {
        raw.filter { !$0.isWhitespace }.count >= 25
    }

    /// The page as sent for translation: its raw text, or for a page without a text layer, a picture
    /// at 1.6× (JPEG, quality 0.86) for the model to read and translate.
    func pageSource(_ number: Int) -> CardsModel.PageSource? {
        guard number >= 1, number <= pages.count, let page = document?.page(at: number - 1) else { return nil }
        let box = pages[number - 1]
        let raw = page.readingText
        if Self.hasTextLayer(raw) {
            return CardsModel.PageSource(page: number, text: raw, width: box.width, height: box.height)
        }
        // A scanned page: its picture is drawn when the translation is asked for (cards.pagePicture),
        // not now and not into the threads file.
        return CardsModel.PageSource(page: number, text: "", scanned: true, width: box.width, height: box.height)
    }

    /// "Translate this page": only this page. Nothing is translated without the reader asking: more
    /// pages only through "Translate pages…" (owner's decision, 14 Nov).
    func startTranslating(at page: Int? = nil) {
        let p = page ?? currentPage
        translate([p])
        cameraCommand = .showTranslation(page: p)
    }

    /// A range of pages, at most 200; more than two go to Gemini as batch jobs.
    func translateRange(_ range: ClosedRange<Int>) {
        let lower = max(1, range.lowerBound), upper = min(pages.count, range.upperBound, lower + CardsModel.maxPages - 1)
        guard lower <= upper else { return }
        translate(Array(lower...upper))
        cameraCommand = .showTranslation(page: lower)
    }

    func translation(of page: Int) -> YarnCard? { cards.pageTranslation(page: page, target: translationTarget) }

    /// Sends the pages that have no translation in the current language yet.
    func translate(_ numbers: [Int]) {
        let wanted = numbers.filter { $0 >= 1 && $0 <= pages.count && translation(of: $0) == nil && !preparing.contains($0) }
        guard !wanted.isEmpty else { return }
        preparing.formUnion(wanted)
        let target = translationTarget
        let generation = translateGeneration
        Task { [weak self] in
            guard let self else { return }
            var sources: [CardsModel.PageSource] = []
            for n in wanted {
                // The reader pressed "Stop translating" while the pages were being read: send nothing.
                guard generation == self.translateGeneration else { return }
                if let s = self.pageSource(n) { sources.append(s) }
                await Task.yield()
            }
            self.preparing.subtract(wanted)
            guard generation == self.translateGeneration else { return }
            self.cards.translatePages(sources, target: target)
            self.ensurePolling()
        }
    }

    /// Page translations and readings stop waiting on Gemini batch jobs (they say `code`); returns
    /// the jobs, for the caller to cancel and remove with the key that made them.
    func forgetBatchJobs(code: String) -> Set<String> {
        var jobs = cards.forgetBatchJobs(code: code)
        if let readings { jobs.formUnion(readings.forgetBatchJobs(code: code)) }
        return jobs
    }

    /// The Gemini key changed: pages on their way to a batch job stop; returns the jobs to settle
    /// with the old key (`apply` then fills in what had finished). Direct work carries on.
    func detachBatchJobs(code: String) -> Set<String> {
        var jobs = cards.detachBatchJobs(code: code)
        if let readings { jobs.formUnion(readings.detachBatchJobs(code: code)) }
        return jobs
    }

    /// Jobs being settled with an old key while this book opened (audit F-2).
    func holdSettling(_ jobs: Set<String>) {
        cards.holdSettling(jobs)
        readings?.holdSettling(jobs)
    }

    /// What became of a job settled with the old key.
    func apply(_ outcome: BatchOutcome, of job: String, code: String) {
        cards.apply(outcome, of: job, code: code)
        readings?.apply(outcome, of: job, code: code)
    }

    /// Text that surrounds a selection on a page: the start of the page's text.
    func pageContext(_ number: Int) -> String? {
        guard let text = document?.page(at: number - 1)?.readingText.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return String(text.prefix(YarnAnchor.contextLength))
    }

    /// What a thread opened inside a card is read with: the card's answer (or note, or translation).
    func cardContext(_ cardId: String) -> String? {
        guard let card = cards.cards.first(where: { $0.id == cardId }) else { return nil }
        let text = card.messages.last { $0.role == .assistant && $0.state != .error }?.content
            ?? card.messages.first { $0.role == .user }?.content
        return text.map { String($0.prefix(YarnAnchor.contextLength)) }
    }

    /// A page translation being prepared, sent, or waiting for its answer. (The batch job's name
    /// arrives a moment after sending, so a translation without one yet still counts.)
    private var hasPendingTranslation: Bool {
        !preparing.isEmpty || cards.cards.contains { $0.translatedPage != nil && $0.messages.last?.state == .streaming }
    }

    /// Asks Google about waiting batch jobs: often at first, then less often.
    func ensurePolling() {
        guard pollTask == nil, hasPendingTranslation else { return }
        let start = pollStart
        pollTask = Task { [weak self] in
            var wait = start
            while !Task.isCancelled {
                try? await Task.sleep(for: wait)
                guard let self else { return }
                if !self.hasPendingTranslation { break }
                await self.cards.pollBatches()
                wait = min(.seconds(30), wait * 1.25)
            }
            self?.pollTask = nil
        }
    }

    /// Whole-page translations are drawn beside their page, not in a lane.
    func isTranslation(_ card: YarnCard) -> Bool { card.translatedPage != nil }

    func reloadJournal() {
        journal = store.journal(for: book.id).sorted { $0.createdAt > $1.createdAt }
    }

    func deleteJournal(_ id: String) {
        try? store.deleteJournal(id, bookId: book.id)
        reloadJournal()
    }

    /// Looks for related notes in the reader's other books (on this Mac only).
    /// Pery summarises the Book Journal with the reader's own key.
    func summarize(lang: Lang) {
        let t = UIText(lang)
        summaryError = nil
        guard !journal.isEmpty else {
            summaryError = t["summaryEmpty"]
            return
        }
        guard let provider = cards.settings.resolvedProvider else {
            summaryError = t["noKeyBody"]
            return
        }
        let body = journal.reversed().map { j in
            [j.quote.isEmpty ? nil : "> \(j.quote)", j.text.isEmpty ? nil : j.text].compactMap { $0 }.joined(separator: "\n")
        }.joined(separator: "\n\n---\n\n")
        let model = cards.settings.model(for: provider, task: .thread)
        let request = AIRequest(
            provider: provider,
            apiKey: cards.settings.key(for: provider),
            model: model,
            system: Compose.journalSummarySystem(lang, bookTitle: book.title),
            turns: [AITurn(role: .user, parts: [.text(body)])],
            maxOutputTokens: ModelAdvice.maxOutputTokens(provider, .thread),
            temperature: ModelAdvice.temperature(.thread),
            candidates: provider == .gemini ? ModelAdvice.geminiChain(selected: model) : nil
        )
        summarizing = true
        summaryTask?.cancel()
        summaryTask = Task { [weak self] in
            var text = ""
            do {
                for try await piece in (self?.streamer.stream(request) ?? AsyncThrowingStream { $0.finish() }) {
                    text += piece
                    self?.summary = (text, Date())
                }
                if let self, let key = SafeID.defaultsKey("journalSummary", self.book.id) {
                    UserDefaults.standard.set(["text": text, "createdAt": Date().timeIntervalSince1970], forKey: key)
                }
            } catch {
                let kind = (error as? AIError)?.kind ?? .unknown
                if kind != .aborted {
                    self?.summaryError = kind == .key ? t["errorKey"] : kind == .quota ? t["errorQuota"] : t["errorNetwork"]
                }
            }
            self?.summarizing = false
        }
    }

    func stopSummary() { summaryTask?.cancel() }

    var worldSize: CGSize { worldRect.size }

    /// Free room beyond the outermost page, thread or translation, on every side: somewhere to
    /// move threads to, and space to see when zoomed out.
    static let roomAround: Double = 1100
    static let roomBelow: Double = 600

    /// Where things are: the pages, the default lane, and every placed thread and translation.
    var contentRect: CGRect {
        var left = 0.0
        var right = Geometry.laneX + Geometry.cardWidth
        var bottom = pages.last.map { $0.y + $0.height } ?? 0
        for (id, p) in placements {
            let w = cards.cards.first { $0.id == id }?.width ?? Geometry.cardWidth
            left = min(left, p.x)
            right = max(right, p.x + w)
            bottom = max(bottom, p.y + (heights[id] ?? 150))
        }
        return CGRect(x: left, y: 0, width: right - left, height: bottom)
    }

    /// The content's width when kept centred on the page (what the camera fits).
    var centredContentWidth: Double {
        let c = contentRect, mid = Geometry.pageWorldWidth / 2
        return 2 * max(c.maxX - mid, mid - c.minX) + 80
    }

    /// The world's extent: the content plus generous room on both sides, symmetric around the
    /// page's centre so the page sits in the middle.
    var worldRect: CGRect {
        let c = contentRect, mid = Geometry.pageWorldWidth / 2
        let half = max(c.maxX - mid, mid - c.minX) + Self.roomAround
        return CGRect(x: mid - half, y: 0, width: half * 2, height: c.maxY + Self.roomBelow)
    }

    /// The page a card belongs to: its first page anchor, or for a thread opened inside a card, that
    /// card's page.
    func homePage(of card: YarnCard) -> Int {
        var seen: Set<String> = []
        var current: YarnCard? = card
        while let c = current, !seen.contains(c.id) {
            seen.insert(c.id)
            if let page = c.anchors.filter({ $0.sourceType != .card && $0.pageNumber >= 1 }).map(\.pageNumber).min() { return page }
            current = c.anchors.compactMap(\.sourceCardId).first.flatMap { sid in cards.cards.first { $0.id == sid } }
        }
        return 1
    }

    /// Cards shown now: all of them, or in page-by-page reading only the current page's.
    func isShown(_ card: YarnCard) -> Bool {
        // Hidden threads stay hidden unless the reader opened one from its highlight; a page
        // translation is not a thread and stays.
        if hideThreads, !revealed.contains(card.id), card.translatedPage == nil { return false }
        return !pagedReading || epub != nil || homePage(of: card) == currentPage
    }

    // MARK: Layout (same rules as the web engine)

    var placements: [String: CGPoint] {
        let list = cards.cards
        let byId = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        func anchorY(_ card: YarnCard, _ placed: [String: CGPoint]) -> Double {
            var ys: [Double] = []
            for a in card.anchors {
                if a.sourceType == .card {
                    if let sid = a.sourceCardId, let p = placed[sid] { ys.append(p.y + a.boundingRect.y + a.boundingRect.height / 2) }
                } else if a.pageNumber >= 1, a.pageNumber <= pages.count {
                    ys.append(Geometry.anchorWorldPoint(a.boundingRect, page: pages[a.pageNumber - 1]).y)
                }
            }
            return ys.min() ?? 0
        }
        /// Folded itself, or under a folded thread at any depth.
        func folded(_ card: YarnCard) -> Bool {
            var seen: Set<String> = []
            var current: YarnCard? = card
            while let c = current, !seen.contains(c.id) {
                if c.collapsed { return true }
                seen.insert(c.id)
                current = c.parentCardId.flatMap { byId[$0] }
            }
            return false
        }
        // A thread opened inside a card sits level with its parent, which must be placed first; each
        // round places one more generation, so repeat until nothing moves (deep chains included).
        /// A page translation, or a thread opened inside one.
        func fromTranslation(_ card: YarnCard) -> Bool {
            var seen: Set<String> = []
            var current: YarnCard? = card
            while let c = current, !seen.contains(c.id) {
                if c.translatedPage != nil { return true }
                seen.insert(c.id)
                current = c.parentCardId.flatMap { byId[$0] } ?? c.anchors.compactMap(\.sourceCardId).first.flatMap { byId[$0] }
            }
            return false
        }
        /// Level with its page, a little right of the threads beside that page (or of the page).
        func translationOrigin(_ t: YarnCard, _ placed: [String: CGPoint]) -> CGPoint {
            guard let n = t.translatedPage, n >= 1, n <= pages.count else { return CGPoint(x: t.x, y: t.y) }
            let page = pages[n - 1]
            var right = page.x + page.width
            for c in list where !fromTranslation(c) {
                guard let p = placed[c.id] else { continue }
                let h = heights[c.id] ?? 150
                if p.y < page.y + page.height, p.y + h > page.y { right = max(right, p.x + c.width) }
            }
            return CGPoint(x: right + 60, y: page.y)
        }
        var placed: [String: CGPoint] = [:]
        for _ in 0..<32 {
            let previous = placed
            let input = list.map { c in
                let origin = c.translatedPage != nil ? translationOrigin(c, placed) : nil
                return Lane.Input(
                    id: c.id,
                    parentCardId: c.parentCardId.flatMap { byId[$0] != nil ? $0 : nil },
                    isPinned: origin != nil || c.isPinned,
                    collapsed: folded(c),
                    x: origin.map { Double($0.x) } ?? c.x,
                    y: origin.map { Double($0.y) } ?? c.y,
                    width: c.width,
                    anchorY: anchorY(c, placed),
                    height: heights[c.id] ?? 150
                )
            }
            if pagedReading {
                // Each page lays out its own threads, so another page's stack never pushes them down.
                let pageOf = Dictionary(list.map { ($0.id, homePage(of: $0)) }, uniquingKeysWith: { a, _ in a })
                var merged: [String: CGPoint] = [:]
                for group in Dictionary(grouping: input, by: { pageOf[$0.id] ?? 1 }).values {
                    merged.merge(Lane.layout(group)) { a, _ in a }
                }
                placed = merged
            } else {
                placed = Lane.layout(input)
            }
            if placed == previous { break }
        }
        return placed
    }

    /// A folded thread that was opened inside a card: shown as a knot tied through that card's edge,
    /// on the side the thread was on.
    struct Clip: Hashable {
        var cardId: String
        var color: YarnColor
        var title: String
        var right: Bool
        var point: CGPoint
    }

    func clips(placements place: [String: CGPoint], lang: Lang) -> [Clip] {
        var out: [Clip] = []
        let byId = Dictionary(cards.cards.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for card in cards.cards where card.collapsed {
            guard let anchor = card.anchors.first(where: { $0.sourceType == .card }), let pid = anchor.sourceCardId,
                  let parent = byId[pid], let pp = place[pid], isShown(parent) else { continue }
            let right = !card.isPinned || card.x + card.width / 2 >= pp.x + parent.width / 2
            let y = pp.y + anchor.boundingRect.y + anchor.boundingRect.height / 2
            out.append(Clip(cardId: card.id, color: card.color, title: Compose.kindTitle(lang, card.kind), right: right, point: CGPoint(x: right ? pp.x + parent.width : pp.x, y: y)))
        }
        // Knots on the same edge never overlap.
        out.sort { $0.point.y < $1.point.y }
        var lastY: [String: Double] = [:]
        for i in out.indices {
            let key = "\(out[i].point.x)"
            if let last = lastY[key], out[i].point.y < last + 30 { out[i].point.y = last + 30 }
            lastY[key] = out[i].point.y
        }
        return out
    }

    var segments: [YarnSegment] { segments(placements: placements) }

    /// Yarns for given card positions (the surface passes a dragged card's live position).
    func segments(placements place: [String: CGPoint]) -> [YarnSegment] {
        var out: [YarnSegment] = []
        let byId = Dictionary(cards.cards.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for card in cards.cards where isShown(card) && card.translatedPage == nil {
            guard let p = place[card.id] else { continue }
            // A card moved to the left of the page takes its yarn on its right edge, from the
            // passage's left end; otherwise left edge, right end.
            let onLeft = p.x + card.width / 2 < Geometry.pageWorldWidth / 2
            let to = onLeft ? CGPoint(x: p.x + card.width, y: p.y + Geometry.g.cardAttachY) : Geometry.cardAttachPoint(x: p.x, y: p.y)
            for a in card.anchors {
                var from: CGPoint?
                if a.sourceType == .card {
                    if let sid = a.sourceCardId, let parent = byId[sid], let pp = place[sid] {
                        from = CGPoint(x: onLeft ? pp.x : pp.x + parent.width, y: pp.y + a.boundingRect.y + a.boundingRect.height / 2)
                    }
                } else if a.pageNumber >= 1, a.pageNumber <= pages.count {
                    let page = pages[a.pageNumber - 1]
                    from = onLeft
                        ? CGPoint(x: page.x + a.boundingRect.x * page.width, y: page.y + (a.boundingRect.y + a.boundingRect.height / 2) * page.height)
                        : Geometry.anchorWorldPoint(a.boundingRect, page: page)
                }
                if let from { out.append(YarnSegment(id: "\(card.id)-\(a.id)", color: card.color, from: from, to: to, cardId: card.id, sourceCardId: a.sourceCardId)) }
            }
        }
        if let live = liveBrush { out.append(YarnSegment(id: "brush-live", color: brushColor, from: live.from, to: live.to, dashed: true)) }
        return out
    }

    struct Highlight: Hashable {
        var cardId: String
        var color: YarnColor
        var area: Bool
        var rects: [NormalizedRect]
        var pending = false
    }

    func highlights(onPage page: Int) -> [Highlight] {
        var out: [Highlight] = []
        for card in cards.cards where card.translatedPage == nil {
            for a in card.anchors where a.sourceType != .card && a.pageNumber == page {
                out.append(Highlight(cardId: card.id, color: card.color, area: a.sourceType == .pdfArea, rects: a.lineRects))
            }
        }
        for a in (pending?.anchors ?? []) + (bridgeHeld ?? []) where a.sourceType != .card && a.pageNumber == page {
            out.append(Highlight(cardId: "", color: .mint, area: a.sourceType == .pdfArea, rects: a.lineRects, pending: true))
        }
        return out
    }

    /// Passages in a card's text (or a translated page's) that threads were opened from, each in its
    /// thread's colour, with where it was selected (card units). A removed thread takes its mark along.
    func marks(inCard id: String) -> [(text: String, color: YarnColor, rect: CGRect)] {
        cards.cards.flatMap { card in
            card.anchors.filter { $0.sourceType == .card && $0.sourceCardId == id }.map { a in
                (a.selectedText, card.color, CGRect(x: a.boundingRect.x, y: a.boundingRect.y, width: a.boundingRect.width, height: a.boundingRect.height))
            }
        }
    }

    struct Knot: Hashable {
        var cardId: String
        var color: YarnColor
        var label: String
        var rect: NormalizedRect
    }

    func knots(onPage page: Int, lang: Lang) -> [Knot] {
        cards.cards.compactMap { card in
            guard card.collapsed, let a = card.anchors.first(where: { $0.sourceType != .card && $0.pageNumber == page }) else { return nil }
            let label: String
            if case .quick(let color) = card.kind { label = Compose.kindLabel(lang, color) } else { label = "⁂" }
            return Knot(cardId: card.id, color: card.color, label: label, rect: a.boundingRect)
        }
    }

    // MARK: Actions

    func create(color: YarnColor, kind: YarnKind, text: String? = nil) {
        guard let pending else { return }
        let card = cards.create(color: color, kind: kind, anchors: pending.anchors, parentCardId: pending.parentCardId, text: text)
        focusedCard = card.id
        offscreenCard = card.id
        self.pending = nil
    }

    func holdBridge() {
        bridgeHeld = pending?.anchors
        pending = nil
    }

    func compareBridge() {
        guard let held = bridgeHeld, let pending else { return }
        let card = cards.create(color: .sky, kind: .bridge, anchors: held + pending.anchors)
        focusedCard = card.id
        offscreenCard = card.id
        bridgeHeld = nil
        self.pending = nil
    }

    /// A note written straight into the Book Journal, on the page being read.
    func addNote(_ text: String) {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        try? store.addJournal(JournalRecord(bookId: book.id, source: .note, quote: "", text: body, pageNumber: epub == nil ? currentPage : (epubChapter ?? 0)))
        reloadJournal()
    }

    func clip(lang: Lang) {
        guard let pending else { return }
        try? store.addJournal(JournalRecord(bookId: book.id, source: .clip, quote: journalQuote(pending.anchors, lang: lang), text: "", pageNumber: pending.anchors.first?.pageNumber ?? 0))
        self.pending = nil
        reloadJournal()
        flash(UIText(lang)["clipped"])
    }

    /// A passage as the journal shows it. A region of the page is named, not quoted: the text read from
    /// its picture is often garbled ("Hfe", "4oward"), and the card already shows the picture itself
    /// (owner test 15 Nov).
    func journalQuote(_ anchors: [YarnAnchor], lang: Lang) -> String {
        if anchors.contains(where: { $0.sourceType == .pdfArea }) { return UIText(lang)["areaQuote"] }
        return anchors.map(\.selectedText).filter { !$0.isEmpty }.joined(separator: " … ")
    }

    /// "Highlight" (Vurgula) is offered for text selected on a PDF page, not for a region, text inside a
    /// card or translation, or an EPUB.
    var canHighlight: Bool {
        guard epub == nil, let pending, pending.parentCardId == nil, !pending.anchors.isEmpty else { return false }
        return pending.anchors.allSatisfy { $0.sourceType == .pdfText }
    }

    /// "Highlight" (Vurgula): the selected passage is marked in yellow on its page and goes into the Book
    /// Journal as a highlight; deleting that entry takes the mark away (owner test 15 Nov).
    func highlight(lang: Lang) {
        guard canHighlight, let pending else { return }
        let anchors = wholeWords(pending.anchors)
        let marks = anchors.map { JournalMark(pageNumber: $0.pageNumber, lineRects: $0.lineRects) }
        let quote = anchors.map(\.selectedText).filter { !$0.isEmpty }.joined(separator: " … ")
        try? store.addJournal(JournalRecord(bookId: book.id, source: .highlight, quote: quote, text: "", pageNumber: pending.anchors.first?.pageNumber ?? 0, marks: marks))
        self.pending = nil
        reloadJournal()
        flash(UIText(lang)["highlighted"])
    }

    /// A highlight covers whole words: a selection that starts or ends inside a word is widened to the
    /// word's edges, as the brush does (owner test 15 Nov: "r. Bu çaba … bırakm"). Each page's passage is
    /// rebuilt from the PDF: its first and last character are joined with their whole words.
    func wholeWords(_ anchors: [YarnAnchor]) -> [YarnAnchor] {
        guard let document else { return anchors }
        return anchors.map { anchor in
            guard anchor.sourceType == .pdfText, let first = anchor.lineRects.first, let last = anchor.lineRects.last,
                  anchor.pageNumber >= 1, let page = document.page(at: anchor.pageNumber - 1) else { return anchor }
            let geometry = PageGeometry(page: page)
            let a = geometry.pageRect(fromNormalized: first), b = geometry.pageRect(fromNormalized: last)
            // The line rectangles are a point wider than the text on each side: step inside them.
            let start = CGPoint(x: a.minX + min(2, a.width / 2), y: a.midY)
            let end = CGPoint(x: b.maxX - min(2, b.width / 2), y: b.midY)
            guard let selection = page.selection(from: start, to: end) else { return anchor }
            if let word = page.selectionForWord(at: start) { selection.add(word) }
            if let word = page.selectionForWord(at: end) { selection.add(word) }
            let lines = selection.selectionsByLine()
            let rects = lines.map { geometry.normalized(fromPage: $0.bounds(for: page).insetBy(dx: -1, dy: -1)) }
                .filter { $0.width > 0 && $0.height > 0 && $0.height < 0.25 }
            let pieces = lines.map { SelectionText.Piece(text: $0.string ?? "", bounds: $0.bounds(for: page)) }
            let text = SelectionText.join(pieces, inLine: .space, lineBreak: " ")
                .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !rects.isEmpty, !text.isEmpty else { return anchor }
            var widened = anchor
            widened.lineRects = rects
            widened.selectedText = text
            widened.boundingRect = Geometry.union(rects)
            return widened
        }
    }

    /// The reader's own highlights on a page: one list of line rectangles per highlight.
    func highlighterMarks(onPage page: Int) -> [[NormalizedRect]] {
        journal.filter { $0.source == .highlight }.flatMap { entry in
            (entry.marks ?? []).filter { $0.pageNumber == page }.map(\.lineRects)
        }
    }

    /// What a card puts in the journal: its passage and its conversation (or note).
    private func journalContent(_ card: YarnCard) -> (quote: String, text: String) {
        let quote = journalQuote(card.anchors, lang: cards.lang)
        let usable = card.messages.filter { $0.state != .error && !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let text = card.kind == .quick(.cream)
            ? usable.map(\.content).joined(separator: "\n\n")
            : usable.enumerated().filter { $0.element.role == .assistant || ($0.offset > 0 && $0.element.role == .user) }
                .map { $0.element.role == .user ? "**\($0.element.content)**" : $0.element.content }
                .joined(separator: "\n\n")
        return (quote, text)
    }

    enum JournalState { case notSaved, saved, outdated }

    /// Whether a card is in the journal, and if so whether the conversation went on since.
    func journalState(_ cardId: String) -> JournalState {
        guard let card = cards.cards.first(where: { $0.id == cardId }), let entry = journal.first(where: { $0.cardId == cardId }) else { return .notSaved }
        let now = journalContent(card)
        // A region's quote is a name in the app's language: only its conversation decides.
        let area = card.anchors.contains { $0.sourceType == .pdfArea }
        return entry.text == now.text && (area || entry.quote == now.quote) ? .saved : .outdated
    }

    /// A card goes into the journal once (owner test 14 Nov: it could be saved again and again). Saved
    /// again after the conversation went on, its one entry is brought up to date instead.
    func saveToJournal(_ cardId: String, lang: Lang) {
        guard let card = cards.cards.first(where: { $0.id == cardId }) else { return }
        let content = journalContent(card)
        if let entry = journal.first(where: { $0.cardId == card.id }) {
            guard entry.text != content.text || entry.quote != content.quote else { return }
            var updated = entry
            updated.quote = content.quote
            updated.text = content.text
            try? store.replaceJournal(updated)
            reloadJournal()
            flash(UIText(lang)["journalUpdated"])
            return
        }
        let isNote = card.kind == .quick(.cream)
        try? store.addJournal(JournalRecord(bookId: book.id, source: isNote ? .note : .thread, quote: content.quote, text: content.text, pageNumber: card.anchors.first { $0.sourceType != .card }?.pageNumber ?? 0, cardId: card.id))
        reloadJournal()
        flash(UIText(lang)["savedToJournal"])
    }

    func flash(_ message: String) {
        toast = message
        Task {
            try? await Task.sleep(for: .seconds(2.2))
            if toast == message { toast = nil }
        }
    }

    func savePosition(origin: CGPoint, magnification: Double) {
        store.savePosition(ReadingPosition(bookId: book.id, cfi: nil, panX: origin.x, panY: origin.y, scale: magnification, page: currentPage, updatedAt: Date().timeIntervalSince1970 * 1000))
    }

    var savedPosition: ReadingPosition? { store.position(for: book.id) }

    func saveEpubPosition(_ locator: String) {
        store.savePosition(ReadingPosition(bookId: book.id, cfi: locator, panX: 0, panY: 0, scale: 1, page: epubChapter ?? 1, updatedAt: Date().timeIntervalSince1970 * 1000))
    }
}
