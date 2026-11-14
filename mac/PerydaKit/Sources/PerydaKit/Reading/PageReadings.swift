import Foundation
import Observation

/// One page read with Pery: its text as the reader's AI wrote it out from the page's picture.
public struct PageReading: Codable, Hashable, Sendable, Identifiable {
    public enum State: String, Codable, Sendable {
        /// Waiting its turn, or waiting on a Gemini batch job (`job`).
        case waiting
        /// Streaming in.
        case reading
        case done
        /// Not read: `error` says why ("no-key", "key", "quota", "network", "blocked", "batch",
        /// "expired", "interrupted", "unknown").
        case failed
    }

    public var page: Int
    public var text: String
    public var state: State
    public var error: String?
    /// The Gemini batch job the page waits on.
    public var job: String?
    public var createdAt: Double

    public var id: Int { page }

    public init(page: Int, text: String = "", state: State, error: String? = nil, job: String? = nil, createdAt: Double = Date().timeIntervalSince1970 * 1000) {
        self.page = page
        self.text = text
        self.state = state
        self.error = error
        self.job = job
        self.createdAt = createdAt
    }
}

/// "Read with Pery" in "Extract page text": a page, or a range of pages, read from their pictures by
/// the reader's AI when the page's own text (or this computer's reading of a scan) is poor (owner
/// test 14 Nov). One or two pages are read directly; more go to Gemini as batch jobs (half the price)
/// or, with other providers, four at a time. Readings are kept with the book, so a batch job that
/// finishes later still lands. Mirrors web/src/reading/pageReadings.ts.
@MainActor
@Observable
public final class PageReadings {
    public private(set) var readings: [Int: PageReading] = [:]
    public let bookId: String
    public var bookTitle: String
    public let pageCount: Int
    public var settings: ByokSettings
    /// The first wait before asking Google about a job; later waits grow to 30 s.
    public var pollStart: Duration = .seconds(5)

    private let store: LibraryStore?
    private let streamer: AnswerStreaming
    private let batcher: PageBatching
    /// The page's picture as a `data:` URL (JPEG), drawn by the app.
    private let picture: @MainActor (Int) async -> String?
    private var tasks: [Int: Task<Void, Never>] = [:]
    /// Bumped by Stop: planned waves and late job names are dropped.
    private var generation = 0
    private var pollTask: Task<Void, Never>?

    public init(bookId: String, bookTitle: String, pageCount: Int, settings: ByokSettings, store: LibraryStore?, streamer: AnswerStreaming, batcher: PageBatching = GeminiBatch(), picture: @escaping @MainActor (Int) async -> String?) {
        self.bookId = bookId
        self.bookTitle = bookTitle
        self.pageCount = pageCount
        self.settings = settings
        self.store = store
        self.streamer = streamer
        self.batcher = batcher
        self.picture = picture
        for var r in store?.readings(for: bookId) ?? [] where r.page >= 1 && r.page <= pageCount {
            // A page that was streaming when the app closed did not finish.
            if r.state == .reading || (r.state == .waiting && r.job == nil) {
                r.state = .failed
                r.error = "interrupted"
            }
            readings[r.page] = r
        }
        // Jobs still waiting from an earlier session are asked about once the book is open.
        Task { [weak self] in self?.ensurePolling() }
    }

    /// Pages waiting or streaming.
    public var pending: Int { readings.values.filter { $0.state == .waiting || $0.state == .reading }.count }
    /// Pages waiting on a batch job.
    public var inBatch: Int { readings.values.filter { $0.state == .waiting && $0.job != nil }.count }
    /// Pages read, in page order.
    public var done: [PageReading] { readings.values.filter { $0.state == .done && !$0.text.isEmpty }.sorted { $0.page < $1.page } }

    /// Reads these pages again from their pictures (a page read before is replaced). At most
    /// `CardsModel.maxPages` at once.
    public func read(_ range: ClosedRange<Int>, lang: Lang) {
        let lower = max(1, range.lowerBound)
        let upper = min(pageCount, range.upperBound, lower + CardsModel.maxPages - 1)
        guard lower <= upper else { return }
        let pages = Array(lower...upper)
        for p in pages {
            tasks[p]?.cancel()
            tasks[p] = nil
        }
        // Pages still in an older job are taken out of it; a job nobody waits for is removed.
        let oldJobs = Set(pages.compactMap { readings[$0]?.job })
        for p in pages { readings[p] = PageReading(page: p, state: .waiting) }
        abandonUnwaited(oldJobs)
        guard let provider = settings.resolvedProvider else {
            for p in pages { fail(p, "no-key") }
            save()
            return
        }
        save()
        if provider == .gemini, pages.count > CardsModel.directLimit {
            submitBatch(pages, lang: lang)
        } else {
            runWaves(pages, provider: provider, lang: lang)
        }
    }

    /// Stops every page still on its way (a batch job is cancelled and removed at Google); pages
    /// already read stay. Returns how many were stopped.
    @discardableResult
    public func stop() -> Int {
        generation += 1
        let stopped = readings.values.filter { $0.state == .waiting || $0.state == .reading }
        for r in stopped {
            tasks[r.page]?.cancel()
            tasks[r.page] = nil
            readings[r.page] = nil
        }
        abandonUnwaited(Set(stopped.compactMap(\.job)))
        save()
        return stopped.count
    }

    // MARK: Direct reading

    private func request(_ page: Int, image: String, provider: ProviderID, lang: Lang) -> AIRequest {
        var model = settings.model(for: provider, task: .translation)
        // DeepSeek's reasoning model takes no pictures.
        if provider == .deepseek { model = "deepseek-flash" }
        return AIRequest(
            provider: provider,
            apiKey: settings.key(for: provider),
            model: model,
            system: Compose.pageTranscriptionSystem(lang),
            turns: Compose.pageTranscriptionTurns(lang, file: bookTitle, page: page, pages: pageCount, imageDataURL: image),
            maxOutputTokens: ModelAdvice.maxOutputTokens(provider, .translation),
            temperature: ModelAdvice.temperature(.translation),
            candidates: provider == .gemini ? ModelAdvice.geminiChain(selected: model) : nil
        )
    }

    private func runWaves(_ pages: [Int], provider: ProviderID, lang: Lang) {
        let waves = stride(from: 0, to: pages.count, by: CardsModel.waveSize).map { Array(pages[$0..<min($0 + CardsModel.waveSize, pages.count)]) }
        let generation = generation
        Task { [weak self] in
            for wave in waves {
                guard let self, generation == self.generation else { return }
                for p in wave { self.run(p, provider: provider, lang: lang) }
                for p in wave { await self.tasks[p]?.value }
            }
        }
    }

    private func run(_ page: Int, provider: ProviderID, lang: Lang) {
        guard readings[page]?.state == .waiting, readings[page]?.job == nil else { return }
        readings[page]?.state = .reading
        tasks[page] = Task { [weak self] in
            guard let self else { return }
            guard let image = await self.picture(page) else {
                self.fail(page, "unknown")
                self.save()
                return
            }
            var out = ""
            do {
                for try await piece in self.streamer.stream(self.request(page, image: image, provider: provider, lang: lang)) {
                    if Task.isCancelled { return }
                    out += piece
                    self.readings[page]?.text = out
                }
                guard !Task.isCancelled else { return }
                let text = out.trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty {
                    self.fail(page, "unknown")
                } else {
                    self.readings[page]?.text = text
                    self.readings[page]?.state = .done
                }
            } catch let e as AIError {
                if e.kind == .aborted || Task.isCancelled { return }
                self.fail(page, e.kind.rawValue)
            } catch {
                if Task.isCancelled { return }
                self.fail(page, "network")
            }
            self.tasks[page] = nil
            self.save()
        }
    }

    private func fail(_ page: Int, _ code: String) {
        guard readings[page] != nil else { return }
        readings[page]?.state = .failed
        readings[page]?.error = code
        readings[page]?.job = nil
    }

    // MARK: Batch jobs

    private func submitBatch(_ pages: [Int], lang: Lang) {
        let key = settings.key(for: .gemini)
        let model = settings.model(for: .gemini, task: .translation)
        let generation = generation
        Task { [weak self] in
            // Pictures are drawn and sent one job at a time, each job kept under Google's size
            // limit, so a long scanned range is never held in memory all at once (audit WW-5).
            var group: [GeminiBatch.Item] = []
            var bytes = 0
            for p in pages {
                guard let self, generation == self.generation else { return }
                guard let image = await self.picture(p) else {
                    self.fail(p, "unknown")
                    continue
                }
                let r = self.request(p, image: image, provider: .gemini, lang: lang)
                let item = GeminiBatch.Item(key: String(p), system: r.system, turns: r.turns)
                let size = CardsModel.batchItemBytes(item)
                if !group.isEmpty, bytes + size > CardsModel.batchMaxBytes {
                    self.submitGroup(group, key: key, model: model, generation: generation)
                    group = []
                    bytes = 0
                }
                group.append(item)
                bytes += size
                await Task.yield()
            }
            guard let self, generation == self.generation else { return }
            self.save()
            if !group.isEmpty { self.submitGroup(group, key: key, model: model, generation: generation) }
        }
    }

    private func submitGroup(_ items: [GeminiBatch.Item], key: String, model: String, generation: Int) {
        let pages = items.compactMap { Int($0.key) }
        let batcher = batcher
        Task { [weak self] in
            do {
                let name = try await batcher.create(apiKey: key, model: model, items: items)
                guard let self else { return }
                let still = pages.filter { self.readings[$0]?.state == .waiting && self.readings[$0]?.job == nil }
                // Stopped (or read again) while the job was being made: nobody waits for it.
                guard generation == self.generation, !still.isEmpty else {
                    await batcher.abandon(apiKey: key, name: name)
                    return
                }
                for p in still { self.readings[p]?.job = name }
                self.save()
                self.ensurePolling()
            } catch let error as AIError where error.kind == .key {
                guard let self, generation == self.generation else { return }
                for p in pages { self.fail(p, "key") }
                self.save()
            } catch {
                // No silent fallback to full-price requests (as with page translation): each page
                // says the job could not be made and can be read again.
                guard let self, generation == self.generation else { return }
                for p in pages { self.fail(p, "batch") }
                self.save()
            }
        }
    }

    /// Asks Google about waiting jobs: often at first, then less often, while pages wait.
    public func ensurePolling() {
        guard pollTask == nil, inBatch > 0 else { return }
        let start = pollStart
        pollTask = Task { [weak self] in
            var wait = start
            while !Task.isCancelled {
                try? await Task.sleep(for: wait)
                guard let self else { return }
                if self.inBatch == 0 { break }
                await self.poll()
                wait = min(.seconds(30), wait * 1.25)
            }
            self?.pollTask = nil
        }
    }

    public func poll() async {
        let key = settings.key(for: .gemini)
        guard ByokSettings.hasUsableKey(key) else { return }
        let now = Date().timeIntervalSince1970 * 1000
        for job in Set(readings.values.compactMap(\.job)) {
            let waiting = readings.values.filter { $0.job == job && $0.state == .waiting }.map(\.page)
            // Only pages still waiting on this job are changed by its answer: a page read again (or
            // stopped) while the request was out keeps its new state (audit WW-4).
            func stillWaiting() -> [Int] { waiting.filter { readings[$0]?.job == job && readings[$0]?.state == .waiting } }
            guard GeminiBatch.isValidName(job) else {
                for p in stillWaiting() { fail(p, "expired") }
                continue
            }
            let status: GeminiBatch.Status
            do {
                status = try await batcher.status(apiKey: key, name: job)
            } catch let error as AIError where error.kind == .key {
                for p in stillWaiting() { fail(p, "key") }
                continue
            } catch is GeminiBatch.JobGone {
                for p in stillWaiting() { fail(p, "expired") }
                continue
            } catch {
                // A network hiccup: ask again next time, unless Google's 48-hour limit has passed.
                if let oldest = waiting.compactMap({ readings[$0]?.createdAt }).min(), now - oldest > 48 * 3600 * 1000 {
                    for p in stillWaiting() { fail(p, "expired") }
                }
                continue
            }
            switch status {
            case .waiting:
                continue
            case .failed(let code):
                for p in stillWaiting() { fail(p, code) }
                await batcher.delete(apiKey: key, name: job)
            case .done(let texts, let errors):
                for p in stillWaiting() {
                    let text = texts[String(p)]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    if text.isEmpty {
                        fail(p, errors[String(p)] ?? "unknown")
                    } else {
                        readings[p]?.text = text
                        readings[p]?.state = .done
                        readings[p]?.job = nil
                    }
                }
                // The text is kept here: Google need not keep the pages or what it read.
                await batcher.delete(apiKey: key, name: job)
            }
        }
        save()
    }

    /// Pages stop waiting on their batch jobs and say `code`; returns the jobs, for the caller to
    /// cancel and remove with the key that made them (the Gemini key changed, or the book is being
    /// deleted). Pages still being read directly stop too.
    @discardableResult
    public func forgetBatchJobs(code: String) -> Set<String> {
        generation += 1
        let jobs = Self.jobs(in: Array(readings.values))
        for r in readings.values where r.state == .waiting || r.state == .reading {
            tasks[r.page]?.cancel()
            tasks[r.page] = nil
            fail(r.page, code)
        }
        save()
        return jobs
    }

    /// The same for a book that is not open (its readings as stored).
    public nonisolated static func forgettingBatchJobs(_ readings: [PageReading], code: String) -> (readings: [PageReading], jobs: Set<String>) {
        var jobs = Set<String>()
        let out = readings.map { r -> PageReading in
            guard let job = r.job, r.state == .waiting else { return r }
            jobs.insert(job)
            var copy = r
            copy.state = .failed
            copy.error = code
            copy.job = nil
            return copy
        }
        return (out, jobs)
    }

    /// Removes jobs no page waits for any more.
    private func abandonUnwaited(_ jobs: Set<String>) {
        let waited = Set(readings.values.compactMap(\.job))
        let orphaned = jobs.subtracting(waited)
        guard !orphaned.isEmpty else { return }
        let key = settings.key(for: .gemini)
        let batcher = batcher
        Task { for job in orphaned { await batcher.abandon(apiKey: key, name: job) } }
    }

    /// Jobs a book's readings still wait on (for removing a deleted book's jobs at Google).
    public nonisolated static func jobs(in readings: [PageReading]) -> Set<String> {
        Set(readings.compactMap(\.job))
    }

    private func save() {
        try? store?.saveReadings(readings.values.sorted { $0.page < $1.page }, for: bookId)
    }
}
