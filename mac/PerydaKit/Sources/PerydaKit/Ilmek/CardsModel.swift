import Foundation
import Observation

/// Something that streams an answer (the real client, or a fake in tests and previews).
public protocol AnswerStreaming: Sendable {
    func stream(_ request: AIRequest) -> AsyncThrowingStream<String, Error>
}

extension AIClient: AnswerStreaming {}

/// Threads of one book: create, stream answers, continue, stop, retry, fold, pin and remove.
/// Mirrors web/src/ilmek/useCards.ts.
@MainActor
@Observable
public final class CardsModel {
    public private(set) var cards: [YarnCard] = []
    public let bookId: String
    public var bookTitle: String
    public var lang: Lang
    public var settings: ByokSettings

    private let store: LibraryStore?
    private let streamer: AnswerStreaming
    private let batcher: PageBatching
    private var tasks: [String: Task<Void, Never>] = [:]
    /// The batch submission each page translation is waiting for; a later choice (translate now,
    /// translate again) replaces it, so a late reply from an older submission is ignored.
    private var submissions: [String: UUID] = [:]
    /// Bumped when the reader stops translating, so waves already planned do not go on.
    private var waveGeneration = 0
    /// Bumped when pages stop going to batch jobs (stop, or the Gemini key changed), so a range still
    /// being drawn sends nothing more; direct translations are not affected (audit KR-1, MR-2, MR-8).
    private var batchGeneration = 0
    /// Page translations on their way to a batch job (being drawn, or the job not made yet).
    private var batchBound = Set<String>()
    /// Jobs being settled with an old key: polling with the new key leaves them alone.
    private var settling = Set<String>()
    private var saveTask: Task<Void, Never>?

    public init(bookId: String, bookTitle: String, lang: Lang, settings: ByokSettings, store: LibraryStore?, streamer: AnswerStreaming, batcher: PageBatching = GeminiBatch()) {
        self.bookId = bookId
        self.bookTitle = bookTitle
        self.lang = lang
        self.settings = settings
        self.store = store
        self.streamer = streamer
        self.batcher = batcher
        let loaded = store?.cards(for: bookId) ?? []
        // An answer still streaming when the app quit: keep what arrived, or offer a retry. A page
        // translation waiting on a batch job keeps waiting; the job carries on at Google.
        cards = loaded.map { card in
            var c = card
            c.messages = c.messages.map { m in
                guard m.state == .streaming, c.batchJob == nil else { return m }
                var fixed = m
                if m.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    fixed.state = .error
                    fixed.content = "network"
                } else {
                    fixed.state = nil
                    fixed.content = m.content.trimmingCharacters(in: .whitespacesAndNewlines) + " …"
                }
                return fixed
            }
            return c
        }
    }

    // MARK: Persistence

    /// Writes the threads now: before a batch job's results are deleted at Google, they must be on
    /// disk (audit WR-2).
    private func saveNow() {
        saveTask?.cancel()
        try? store?.saveCards(cards, for: bookId)
    }

    private func scheduleSave(immediately: Bool = false) {
        saveTask?.cancel()
        let snapshot = cards
        let bookId = bookId
        let store = store
        saveTask = Task {
            if !immediately { try? await Task.sleep(for: .milliseconds(800)) }
            guard !Task.isCancelled else { return }
            try? store?.saveCards(snapshot, for: bookId)
        }
    }

    private func mutate(_ id: String, save: Bool = true, _ change: (inout YarnCard) -> Void) {
        guard let i = cards.firstIndex(where: { $0.id == id }) else { return }
        change(&cards[i])
        cards[i].updatedAt = Date().timeIntervalSince1970 * 1000
        if save { scheduleSave() }
    }

    // MARK: Actions

    @discardableResult
    public func create(color: YarnColor, kind: YarnKind, anchors: [YarnAnchor], parentCardId: String? = nil, text: String? = nil) -> YarnCard {
        let first = text?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? Compose.kindPrompt(lang, kind)
        let card = YarnCard(
            bookId: bookId,
            color: color,
            kind: kind,
            anchors: anchors,
            parentCardId: parentCardId,
            messages: first.isEmpty ? [] : [YarnMessage(role: .user, content: first)]
        )
        cards.append(card)
        scheduleSave(immediately: true)
        if kind.runsAI { run(card.id) }
        return card
    }

    public func ask(_ cardId: String, _ text: String) {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, let card = cards.first(where: { $0.id == cardId }) else { return }
        mutate(cardId) { $0.messages.append(YarnMessage(role: .user, content: body)) }
        if card.kind.runsAI { run(cardId) }
    }

    public func retry(_ cardId: String) {
        mutate(cardId) { $0.messages.removeAll { $0.state == .error } }
        run(cardId)
    }

    public func stop(_ cardId: String) {
        tasks[cardId]?.cancel()
    }

    public func setCollapsed(_ cardId: String, _ collapsed: Bool) { mutate(cardId) { $0.collapsed = collapsed } }

    public func pin(_ cardId: String, x: Double, y: Double) {
        mutate(cardId) {
            $0.isPinned = true
            $0.x = x
            $0.y = y
        }
    }

    public func unpin(_ cardId: String) { mutate(cardId) { $0.isPinned = false } }

    /// Limits for resizing a card by its corner, in world units.
    nonisolated public static let widthRange: ClosedRange<Double> = 300...640
    nonisolated public static let heightRange: ClosedRange<Double> = 150...1000

    /// Resizes a card within the limits; nil height lets it follow its content again.
    public func resize(_ cardId: String, width: Double, height: Double?) {
        mutate(cardId) {
            $0.width = min(max(width, Self.widthRange.lowerBound), Self.widthRange.upperBound)
            $0.height = height.map { min(max($0, Self.heightRange.lowerBound), Self.heightRange.upperBound) }
        }
    }


    /// Removes a card and every thread opened from it.
    public func remove(_ cardId: String) {
        removeAll([cardId])
    }

    /// Removes cards and every thread opened from them, in one step.
    private func removeAll(_ cardIds: [String]) {
        var doomed = Set(cardIds)
        var grew = true
        while grew {
            grew = false
            for c in cards where c.parentCardId.map(doomed.contains) == true && !doomed.contains(c.id) {
                doomed.insert(c.id)
                grew = true
            }
        }
        let jobs = Set(cards.filter { doomed.contains($0.id) }.compactMap(\.batchJob))
        for id in doomed {
            tasks[id]?.cancel()
            submissions[id] = nil
        }
        cards.removeAll { doomed.contains($0.id) }
        scheduleSave(immediately: true)
        abandonUnwaited(jobs)
    }

    // MARK: Whole-page translation

    /// The book's page count, for the "page n of m" line sent with a page.
    public var pageCount = 0
    /// Page translations explain hard terms in brackets (the reader's choice; pages already translated keep theirs).
    public var explainTerms = true

    /// A page to translate: its text layer, or (for a scanned page) its picture.
    public struct PageSource: Sendable {
        public var page: Int
        public var text: String
        public var imageDataURL: String?
        /// A page without a text layer: it goes as a picture. With `pagePicture` set, the picture is
        /// drawn when the request is made and never stored in the card (audit MA-2, WW-5).
        public var scanned: Bool
        public var width: Double
        public var height: Double

        public init(page: Int, text: String, imageDataURL: String? = nil, scanned: Bool? = nil, width: Double, height: Double) {
            self.page = page
            self.text = text
            self.imageDataURL = imageDataURL
            self.scanned = scanned ?? (imageDataURL != nil)
            self.width = width
            self.height = height
        }
    }

    /// Draws a scanned page's picture (a JPEG `data:` URL) when its translation is asked for. Pictures
    /// then stay out of the threads file and the backup: they made a library's own backup too large
    /// to restore, and held a long range in memory at once (audit MA-2, WW-5, 15 Nov).
    public var pagePicture: (@MainActor (Int) async -> String?)?

    /// The picture a translation request carries: the one stored with the card (older cards), or one
    /// drawn now for a scanned page.
    private func picture(for card: YarnCard) async -> String? {
        guard let anchor = card.anchors.first, anchor.sourceType == .pdfArea else { return nil }
        if let stored = anchor.croppedImage { return stored }
        return await pagePicture?(card.translatedPage ?? anchor.pageNumber)
    }

    /// Takes stored page pictures out of whole-page translations (made by earlier builds), when they
    /// can be drawn again; the threads file shrinks at the next save.
    public func dropStoredPagePictures() {
        guard pagePicture != nil else { return }
        var changed = false
        for i in cards.indices where cards[i].translatedPage != nil && cards[i].anchors.first?.sourceType == .pdfArea && cards[i].anchors.first?.croppedImage != nil {
            cards[i].anchors[0].croppedImage = nil
            changed = true
        }
        if changed { scheduleSave(immediately: true) }
    }

    public func pageTranslation(page: Int, target: Lang) -> YarnCard? {
        cards.first { $0.translatedPage == page && $0.translationLanguage == target.rawValue }
    }

    /// Up to two pages (this page and the next) are translated directly, in parallel; more pages go
    /// to Gemini as one batch job (half the price), or in waves of four with other providers.
    public static let directLimit = 2
    public static let waveSize = 4
    /// The most pages one request translates (the reader's range is clamped to it).
    nonisolated public static let maxPages = 200

    /// Google takes at most 20 MB in one batch request sent inline. Text pages are a few kB, but a
    /// scanned page travels as a picture (a few hundred kB), so a long scanned range is split into
    /// several jobs, each kept well under the limit.
    nonisolated public static let batchMaxBytes = 15_000_000

    /// Roughly how many bytes one page adds to a batch request.
    nonisolated public static func batchItemBytes(_ item: GeminiBatch.Item) -> Int {
        var bytes = item.system.utf8.count + 512
        for turn in item.turns {
            for part in turn.parts {
                switch part {
                case .text(let text): bytes += text.utf8.count
                case .image(_, let base64): bytes += base64.utf8.count
                }
            }
        }
        return bytes
    }

    /// Splits pages into consecutive groups that each stay under `maxBytes` (a page larger than that
    /// goes alone).
    nonisolated public static func splitBatch<T>(_ items: [T], size: (T) -> Int, maxBytes: Int = batchMaxBytes) -> [[T]] {
        var groups: [[T]] = []
        var current: [T] = []
        var total = 0
        for item in items {
            let bytes = size(item)
            if !current.isEmpty, total + bytes > maxBytes {
                groups.append(current)
                current = []
                total = 0
            }
            current.append(item)
            total += bytes
        }
        if !current.isEmpty { groups.append(current) }
        return groups
    }

    @discardableResult
    public func translatePages(_ sources: [PageSource], target: Lang) -> [String] {
        var created: [YarnCard] = []
        for source in sources.prefix(Self.maxPages) where pageTranslation(page: source.page, target: target) == nil {
            let anchor = YarnAnchor(
                sourceType: source.scanned ? .pdfArea : .pdfText,
                bookId: bookId,
                pageNumber: source.page,
                selectedText: source.text,
                lineRects: [],
                boundingRect: .zero,
                croppedImage: pagePicture == nil ? source.imageDataURL : nil
            )
            var card = YarnCard(
                bookId: bookId,
                color: SharedContract.kinds.translateColor,
                kind: .translate,
                anchors: [anchor],
                width: source.width,
                messages: [YarnMessage(role: .user, content: SharedContract.kinds.translate.cardTitle.text(target))]
            )
            card.height = source.height
            card.translatedPage = source.page
            card.translationLanguage = target.rawValue
            created.append(card)
        }
        guard !created.isEmpty else { return [] }
        cards.append(contentsOf: created)
        scheduleSave(immediately: true)
        let ids = created.map(\.id)
        if ids.count > Self.directLimit, settings.resolvedProvider == .gemini {
            submitBatch(ids)
        } else {
            runWaves(ids)
        }
        return ids
    }

    /// Pages in waves of four at once; each page streams in as it is translated.
    private func runWaves(_ ids: [String]) {
        let waves = stride(from: 0, to: ids.count, by: Self.waveSize).map { Array(ids[$0..<min($0 + Self.waveSize, ids.count)]) }
        let generation = waveGeneration
        Task { [weak self] in
            for wave in waves {
                // Stopped by the reader: pages still waiting their turn never start.
                guard let self, generation == self.waveGeneration else { return }
                for id in wave { self.run(id) }
                for id in wave { await self.tasks[id]?.value }
            }
        }
    }

    /// A page translation with no answer yet (a failed one has its error as an answer).
    public nonisolated static func isUnfinishedTranslation(_ card: YarnCard) -> Bool {
        guard card.translatedPage != nil else { return false }
        guard let last = card.messages.last else { return true }
        return last.role == .user || last.state == .streaming
    }

    /// Page translations that have not got their answer yet: waiting their turn, streaming in, or in a batch job.
    public var unfinishedTranslations: [YarnCard] {
        cards.filter(Self.isUnfinishedTranslation)
    }

    /// Stops every page translation still on its way in this book: pages waiting their turn, answers
    /// streaming in and batch jobs at Google (cancelled and removed there). Pages already translated
    /// stay. Returns how many pages were stopped.
    @discardableResult
    public func stopTranslations() -> Int {
        waveGeneration += 1
        batchGeneration += 1
        batchBound.removeAll()
        let ids = unfinishedTranslations.map(\.id)
        if !ids.isEmpty { removeAll(ids) }
        return ids.count
    }

    /// The request for a page translation with the reader's provider and translation model.
    private func translationRequest(_ card: YarnCard, provider: ProviderID, image: String?) -> AIRequest {
        let anchor = card.anchors.first
        let target = Lang(rawValue: card.translationLanguage ?? "") ?? lang
        var model = settings.model(for: provider, task: .translation)
        // DeepSeek's reasoning model takes no pictures; scanned pages always go to deepseek-flash.
        if provider == .deepseek, image != nil { model = "deepseek-flash" }
        return AIRequest(
            provider: provider,
            apiKey: settings.key(for: provider),
            model: model,
            system: Compose.pageTranslationSystem(target: target, explainTerms: explainTerms),
            turns: Compose.pageTranslationTurns(target: target, file: bookTitle, page: card.translatedPage ?? anchor?.pageNumber ?? 1, pages: pageCount, text: anchor?.selectedText ?? "", imageDataURL: image, explainTerms: explainTerms),
            maxOutputTokens: ModelAdvice.maxOutputTokens(provider, .translation),
            temperature: ModelAdvice.temperature(.translation),
            candidates: provider == .gemini ? ModelAdvice.geminiChain(selected: model) : nil
        )
    }

    private func submitBatch(_ ids: [String]) {
        let key = settings.key(for: .gemini)
        let model = settings.model(for: .gemini, task: .translation)
        for id in ids {
            mutate(id) { c in
                c.messages = Array(c.messages.prefix(1)) + [YarnMessage(role: .assistant, content: "", state: .streaming, provider: .gemini, model: model)]
            }
        }
        // One job per group that fits Google's size limit; each group goes on (or fails) on its own.
        // Scanned pages' pictures are drawn as the group fills and dropped once it is sent, so a
        // long range is never held in memory at once (audit WW-5).
        batchBound.formUnion(ids)
        let generation = batchGeneration
        Task { [weak self] in
            var group: [GeminiBatch.Item] = []
            var bytes = 0
            for id in ids {
                guard let self, generation == self.batchGeneration else { return }
                // A page translated now (or stopped) while the range was being drawn is not sent
                // again in the job (audit MR-2).
                guard self.batchBound.contains(id), let card = self.cards.first(where: { $0.id == id }), card.messages.last?.state == .streaming, card.batchJob == nil else { continue }
                let image = await self.picture(for: card)
                if card.anchors.first?.sourceType == .pdfArea, image == nil {
                    self.failTranslation(id, "unknown")
                    continue
                }
                let r = self.translationRequest(card, provider: .gemini, image: image)
                let item = GeminiBatch.Item(key: id, system: r.system, turns: r.turns)
                let size = Self.batchItemBytes(item)
                if !group.isEmpty, bytes + size > Self.batchMaxBytes {
                    self.submitGroup(group, key: key, model: model)
                    group = []
                    bytes = 0
                }
                group.append(item)
                bytes += size
                await Task.yield()
            }
            guard let self, generation == self.batchGeneration, !group.isEmpty else { return }
            self.submitGroup(group, key: key, model: model)
        }
    }

    private func submitGroup(_ items: [GeminiBatch.Item], key: String, model: String) {
        let ids = items.map(\.key)
        let batcher = batcher
        let token = UUID()
        for id in ids { submissions[id] = token }
        Task { [weak self] in
            do {
                let name = try await batcher.create(apiKey: key, model: model, items: items)
                guard let self else {
                    // The book was closed (or deleted) while the job was being made.
                    await batcher.abandon(apiKey: key, name: name)
                    return
                }
                let still = ids.filter { self.submissions[$0] == token }
                self.batchBound.subtract(ids)
                for id in still { self.mutate(id) { $0.batchJob = name } }
                // Every page was taken out (translated now, or closed) while the job was being made.
                // Nobody waits for it: removed with the key it was made with (the key in settings may
                // have changed meanwhile, audit K-3).
                if still.isEmpty { await batcher.abandon(apiKey: key, name: name) }
            } catch let error as AIError where error.kind == .key {
                guard let self else { return }
                for id in ids where self.submissions[id] == token { self.failTranslation(id, "key") }
            } catch {
                // No silent fallback to full-price requests: Google may have made the job even though
                // its answer was lost, and a busy service would only get more requests. Each page says
                // so and offers to translate it directly.
                guard let self else { return }
                for id in ids where self.submissions[id] == token { self.failTranslation(id, "batch") }
            }
        }
    }

    /// The Gemini key changed: pages on their way to a batch job stop and say `code` (a job made
    /// anyway is removed with the key that made it); pages already in a job keep waiting until that
    /// job is settled with the old key (`apply`). Direct translations, with any provider, carry on
    /// (audit KR-1, MR-2, MR-8). Returns the jobs to settle.
    @discardableResult
    public func detachBatchJobs(code: String) -> Set<String> {
        batchGeneration += 1
        var jobs = Set<String>()
        for card in cards where card.translatedPage != nil && card.messages.last?.state == .streaming {
            if let job = card.batchJob {
                jobs.insert(job)
                continue
            }
            guard batchBound.contains(card.id) || submissions[card.id] != nil else { continue }
            submissions[card.id] = nil
            failTranslation(card.id, code)
        }
        batchBound.removeAll()
        settling.formUnion(jobs)
        if !jobs.isEmpty { saveNow() }
        return jobs
    }

    /// What became of a job settled with the old key: finished pages are filled in, the others say
    /// `code`; saved before the caller deletes the job at Google (audit KR-2, WR-2).
    public func apply(_ outcome: BatchOutcome, of job: String, code: String) {
        settling.remove(job)
        let next = Self.applying(outcome, of: job, code: code, to: cards)
        guard next != cards else { return }
        cards = next
        saveNow()
    }

    /// The same for stored threads (a book that is not open).
    nonisolated public static func applying(_ outcome: BatchOutcome, of job: String, code: String, to cards: [YarnCard]) -> [YarnCard] {
        let now = Date().timeIntervalSince1970 * 1000
        return cards.map { card in
            guard card.batchJob == job, card.messages.last?.state == .streaming else { return card }
            var c = card
            c.batchJob = nil
            c.updatedAt = now
            guard let i = c.messages.lastIndex(where: { $0.role == .assistant }) else { return c }
            if case .done(let texts, let errors) = outcome {
                let text = texts[card.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if text.isEmpty {
                    c.messages[i].state = .error
                    c.messages[i].content = errors[card.id] ?? "unknown"
                } else {
                    c.messages[i].content = text
                    c.messages[i].state = nil
                }
            } else {
                c.messages[i].state = .error
                c.messages[i].content = code
            }
            return c
        }
    }

    /// Page translations stop waiting on their batch jobs and say `code`; returns the jobs, for the
    /// caller to cancel and remove with the key that made them (the book is being deleted).
    @discardableResult
    public func forgetBatchJobs(code: String) -> Set<String> {
        let jobs = detachBatchJobs(code: code)
        settling.subtract(jobs)
        for card in cards where card.batchJob.map(jobs.contains) == true && card.messages.last?.state == .streaming {
            failTranslation(card.id, code)
        }
        return jobs
    }

    /// The same for a book that is not open (its cards as stored).
    nonisolated public static func forgettingBatchJobs(_ cards: [YarnCard], code: String) -> (cards: [YarnCard], jobs: Set<String>) {
        var jobs = Set<String>()
        let out = cards.map { card -> YarnCard in
            guard let job = card.batchJob, card.messages.last?.state == .streaming else { return card }
            jobs.insert(job)
            var c = card
            c.batchJob = nil
            if let i = c.messages.lastIndex(where: { $0.role == .assistant }) {
                c.messages[i].state = .error
                c.messages[i].content = code
            }
            return c
        }
        return (out, jobs)
    }

    private func failTranslation(_ cardId: String, _ code: String) {
        batchBound.remove(cardId)
        mutate(cardId) { c in
            c.batchJob = nil
            if let i = c.messages.lastIndex(where: { $0.role == .assistant }) {
                c.messages[i].state = .error
                c.messages[i].content = code
            } else {
                c.messages.append(YarnMessage(role: .assistant, content: code, state: .error))
            }
        }
    }

    /// Page translations still waiting on a batch job.
    public var waitingTranslations: [YarnCard] {
        cards.filter { $0.batchJob != nil && $0.messages.last?.state == .streaming }
    }

    /// Asks Google about every batch job this book is waiting on and fills in what has finished.
    public func pollBatches() async {
        let key = settings.key(for: .gemini)
        guard ByokSettings.hasUsableKey(key) else { return }
        let now = Date().timeIntervalSince1970 * 1000
        for job in Set(waitingTranslations.compactMap(\.batchJob)).subtracting(settling) {
            let waiting = waitingTranslations.filter { $0.batchJob == job }
            // Only a name Google could have given goes into a request (a backup may carry anything).
            guard GeminiBatch.isValidName(job) else {
                for card in waiting { failTranslation(card.id, "expired") }
                continue
            }
            let status: GeminiBatch.Status
            do {
                status = try await batcher.status(apiKey: key, name: job)
            } catch let error as AIError where error.kind == .key {
                for card in waiting { failTranslation(card.id, "key") }
                continue
            } catch is GeminiBatch.JobGone {
                for card in waiting { failTranslation(card.id, "expired") }
                continue
            } catch {
                // A network hiccup: ask again next time, unless Google's 48-hour limit has passed.
                if let oldest = waiting.map(\.createdAt).min(), now - oldest > 48 * 3600 * 1000 {
                    for card in waiting { failTranslation(card.id, "expired") }
                }
                continue
            }
            switch status {
            case .waiting:
                continue
            case .failed(let code):
                for card in waiting { failTranslation(card.id, code) }
                saveNow()
                await batcher.delete(apiKey: key, name: job)
            case .done(let texts, let errors):
                for card in waiting {
                    if let text = texts[card.id] {
                        mutate(card.id) { c in
                            c.batchJob = nil
                            if let i = c.messages.lastIndex(where: { $0.role == .assistant }) {
                                c.messages[i].content = text.trimmingCharacters(in: .whitespacesAndNewlines)
                                c.messages[i].state = nil
                            }
                        }
                    } else {
                        failTranslation(card.id, errors[card.id] ?? "unknown")
                    }
                }
                // The results are on disk (saved first, audit WR-2): Google need not keep the pages
                // or their translations.
                saveNow()
                await batcher.delete(apiKey: key, name: job)
            }
        }
    }

    /// Stops waiting for the batch and translates this page straight away.
    public func translateNow(_ cardId: String) {
        let job = cards.first { $0.id == cardId }?.batchJob
        submissions[cardId] = nil
        batchBound.remove(cardId)
        mutate(cardId) { c in
            c.batchJob = nil
            c.messages.removeAll { $0.role == .assistant }
        }
        if let job { abandonUnwaited([job]) }
        run(cardId)
    }

    /// Cancels and removes batch jobs no page waits for any more (after translate now, translate again
    /// or closing a page), so Google stops working, and billing, for nothing.
    private func abandonUnwaited(_ jobs: Set<String>) {
        let orphaned = jobs.subtracting(cards.compactMap(\.batchJob))
        guard !orphaned.isEmpty else { return }
        let key = settings.key(for: .gemini)
        let batcher = batcher
        let id = UUID()
        abandoning[id] = Task { [weak self] in
            for job in orphaned { await batcher.abandon(apiKey: key, name: job) }
            self?.abandoning[id] = nil
        }
    }

    /// Cancellations still on their way to Google (tests wait for them).
    private var abandoning: [UUID: Task<Void, Never>] = [:]

    /// Cancels and removes the batch jobs a book's pages were waiting on (the book is being deleted).
    public static func abandonBatches(of cards: [YarnCard], apiKey: String, batcher: PageBatching) async {
        for job in Set(cards.compactMap(\.batchJob)) {
            await batcher.abandon(apiKey: apiKey, name: job)
        }
    }

    /// Translates a page again, directly.
    public func retranslate(_ cardId: String) {
        translateNow(cardId)
    }

    // MARK: Streaming

    private func run(_ cardId: String) {
        guard let card = cards.first(where: { $0.id == cardId }) else { return }
        let answer = YarnMessage(role: .assistant, content: "", state: .streaming)
        mutate(cardId, save: false) { $0.messages.append(answer) }

        guard let provider = settings.resolvedProvider else {
            mutate(cardId) { c in
                if let i = c.messages.firstIndex(where: { $0.id == answer.id }) {
                    c.messages[i].state = .error
                    c.messages[i].content = "no-key"
                }
            }
            return
        }
        if card.translatedPage != nil {
            stream(cardId, answer) { [weak self] in
                guard let self else { return nil }
                let image = await self.picture(for: card)
                // A scanned page whose picture cannot be drawn is not sent as an empty page.
                if card.anchors.first?.sourceType == .pdfArea, image == nil { return nil }
                return self.translationRequest(card, provider: provider, image: image)
            }
            return
        }
        let pages = card.anchors.filter { $0.sourceType != .card }.map(\.pageNumber)
        let model = settings.model(for: provider, task: .thread)
        let request = AIRequest(
            provider: provider,
            apiKey: settings.key(for: provider),
            model: model,
            system: Compose.systemPrompt(lang, bookTitle: bookTitle, pages: pages),
            turns: Compose.turns(lang, card: card),
            maxOutputTokens: ModelAdvice.maxOutputTokens(provider, .thread),
            temperature: ModelAdvice.temperature(.thread),
            candidates: provider == .gemini ? ModelAdvice.geminiChain(selected: model) : nil
        )
        stream(cardId, answer, request)
    }

    private func stream(_ cardId: String, _ answer: YarnMessage, _ request: AIRequest) {
        stream(cardId, answer) { request }
    }

    /// Streams the answer to a request made when the task starts (a scanned page's picture is drawn
    /// then); a request that cannot be made ends as an error.
    private func stream(_ cardId: String, _ answer: YarnMessage, _ makeRequest: @escaping @MainActor () async -> AIRequest?) {
        tasks[cardId]?.cancel()
        tasks[cardId] = Task { [weak self] in
            var text = ""
            var lastSave = Date()
            guard let request = await makeRequest() else {
                self?.setAnswer(cardId, answer.id, content: "unknown", state: .error)
                self?.tasks[cardId] = nil
                return
            }
            let provider = request.provider
            do {
                for try await piece in self?.streamer.stream(request) ?? AsyncThrowingStream { $0.finish() } {
                    if Task.isCancelled { throw AIError(.aborted) }
                    text += piece
                    let save = Date().timeIntervalSince(lastSave) > 1.5
                    if save { lastSave = Date() }
                    self?.setAnswer(cardId, answer.id, content: text, state: .streaming, save: save)
                }
                if Task.isCancelled { throw AIError(.aborted) }
                self?.setAnswer(cardId, answer.id, content: text, state: nil, provider: provider, model: request.model)
            } catch {
                let kind = (error as? AIError)?.kind ?? .unknown
                if kind == .aborted && !text.isEmpty {
                    self?.setAnswer(cardId, answer.id, content: text, state: nil)
                } else {
                    self?.setAnswer(cardId, answer.id, content: kind.rawValue, state: .error)
                }
            }
            self?.tasks[cardId] = nil
        }
    }

    private func setAnswer(_ cardId: String, _ messageId: String, content: String, state: YarnMessage.State?, provider: ProviderID? = nil, model: String? = nil, save: Bool = true) {
        mutate(cardId, save: save || state != .streaming) { c in
            guard let i = c.messages.firstIndex(where: { $0.id == messageId }) else { return }
            c.messages[i].content = content
            c.messages[i].state = state
            if let provider { c.messages[i].provider = provider }
            if let model { c.messages[i].model = model }
        }
    }

    public func isStreaming(_ cardId: String) -> Bool { tasks[cardId] != nil }

    /// Waits until every running answer has finished (tests).
    public func waitForIdle() async {
        while !tasks.isEmpty {
            for task in tasks.values { await task.value }
        }
        await saveTask?.value
        for task in abandoning.values { await task.value }
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
