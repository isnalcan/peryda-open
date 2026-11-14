import Foundation
import Testing
@testable import PerydaKit

/// A stand-in for Google's batch service: records what was sent and answers as told.
actor FakeBatcher: PageBatching {
    var created: [(model: String, items: [GeminiBatch.Item])] = []
    var status: GeminiBatch.Status = .waiting
    var createError: Error?
    var statusError: Error?
    var statusAsked: [String] = []
    var cancelled: [String] = []
    var deleted: [String] = []

    func setStatus(_ s: GeminiBatch.Status) { status = s }
    func setCreateError(_ e: Error?) { createError = e }
    func setStatusError(_ e: Error?) { statusError = e }

    func create(apiKey: String, model: String, items: [GeminiBatch.Item]) async throws -> String {
        if let createError { throw createError }
        created.append((model, items))
        return "batches/job-\(created.count)"
    }

    func status(apiKey: String, name: String) async throws -> GeminiBatch.Status {
        statusAsked.append(name)
        if let statusError { throw statusError }
        return status
    }

    func cancel(apiKey: String, name: String) async { cancelled.append(name) }
    func delete(apiKey: String, name: String) async { deleted.append(name) }
}

/// Records the requests it is asked to stream and answers each with a short text.
final class RecordingStreamer: AnswerStreaming, @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [AIRequest] = []
    var requests: [AIRequest] { lock.withLock { _requests } }

    func stream(_ request: AIRequest) -> AsyncThrowingStream<String, Error> {
        lock.withLock { _requests.append(request) }
        return AsyncThrowingStream { c in
            c.yield("Kavramlar, sınırlarında netleşir.")
            c.finish()
        }
    }
}

@Suite("Page translation")
@MainActor
struct PageTranslationTests {
    func page(_ n: Int, image: String? = nil) -> CardsModel.PageSource {
        CardsModel.PageSource(page: n, text: image == nil ? "Page \(n): concepts become clear at their borders." : "", imageDataURL: image, width: 760, height: 983)
    }

    func model(_ settings: ByokSettings = keyed, streamer: AnswerStreaming = RecordingStreamer(), batcher: FakeBatcher = FakeBatcher(), store: LibraryStore? = nil) -> CardsModel {
        let m = CardsModel(bookId: "book", bookTitle: "Freud", lang: .tr, settings: settings, store: store, streamer: streamer, batcher: batcher)
        m.pageCount = 20
        return m
    }

    @Test func batchRequestsCarryTheModelsThinkingAndTheTranslationTemperature() throws {
        let item = GeminiBatch.Item(key: "card-1", system: "SYS", turns: [AITurn(role: .user, parts: [.text("PAGE")])])
        func request(_ model: String) throws -> [String: Any] {
            let batch = try #require(GeminiBatch.createBody([item], model: model)["batch"] as? [String: Any])
            let requests = try #require(((batch["input_config"] as? [String: Any])?["requests"] as? [String: Any])?["requests"] as? [[String: Any]])
            #expect((requests[0]["metadata"] as? [String: Any])?["key"] as? String == "card-1")
            return try #require(requests[0]["request"] as? [String: Any])
        }
        let three = try #require(try request("gemini-3.8-flash")["generationConfig"] as? [String: Any])
        #expect((three["thinkingConfig"] as? [String: Any])?["thinkingLevel"] as? String == "high")
        #expect(three["temperature"] == nil)
        let two = try #require(try request("gemini-2.5-flash")["generationConfig"] as? [String: Any])
        #expect((two["thinkingConfig"] as? [String: Any])?["thinkingBudget"] as? Int == 8192)
        #expect(two["temperature"] as? Double == 0.35)
    }

    /// A long scanned range is split into several jobs that each stay under Google's size limit.
    @Test func aLongScannedRangeGoesAsSeveralJobs() async throws {
        let batcher = FakeBatcher()
        let m = model(batcher: batcher)
        // Each scanned page is a ~4 MB picture here, so three fit in one 15 MB job.
        let picture = "data:image/jpeg;base64," + String(repeating: "A", count: 4_000_000)
        let ids = m.translatePages((1...7).map { page($0, image: picture) }, target: .tr)
        for _ in 0..<200 where m.waitingTranslations.count < 7 { try await Task.sleep(for: .milliseconds(10)) }
        let jobs = await batcher.created
        #expect(jobs.map(\.items.count) == [3, 3, 1])
        #expect(jobs.flatMap { $0.items.map(\.key) } == ids)
        for job in jobs { #expect(job.items.map(CardsModel.batchItemBytes).reduce(0, +) < CardsModel.batchMaxBytes) }
        #expect(Set(m.waitingTranslations.compactMap(\.batchJob)).count == 3)
        await m.waitForIdle()
    }

    /// With `pagePicture`, a scanned page's picture is drawn when its request is made and is never
    /// stored in the card (audit MA-2: pictures made a library's own backup too large to restore).
    @Test func scannedPagesAreDrawnWhenAskedAndNotStored() async throws {
        let streamer = RecordingStreamer()
        let batcher = FakeBatcher()
        let m = model(streamer: streamer, batcher: batcher)
        var drawn: [Int] = []
        m.pagePicture = { page in
            drawn.append(page)
            return "data:image/jpeg;base64," + String(repeating: "B", count: 4_000_000)
        }
        let scanned = (1...7).map { CardsModel.PageSource(page: $0, text: "", scanned: true, width: 760, height: 983) }
        // One page directly: drawn for the request, not kept.
        m.translatePages([scanned[0]], target: .tr)
        for _ in 0..<300 where m.pageTranslation(page: 1, target: .tr)?.messages.last?.state != nil || streamer.requests.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        let first = try #require(m.pageTranslation(page: 1, target: .tr))
        #expect(first.anchors.first?.sourceType == .pdfArea)
        #expect(first.anchors.first?.croppedImage == nil)
        guard case .image = try #require(streamer.requests.last).turns[0].parts[0] else { Issue.record("the picture goes with the request"); return }
        // A range: drawn job by job, three 4 MB pictures per 15 MB job.
        m.translatePages(Array(scanned[1...6]), target: .tr)
        for _ in 0..<300 where m.waitingTranslations.count < 6 { try await Task.sleep(for: .milliseconds(10)) }
        #expect(await batcher.created.map(\.items.count) == [3, 3])
        #expect(drawn == Array(1...7))
        #expect(m.cards.allSatisfy { $0.anchors.allSatisfy { $0.croppedImage == nil } })
        await m.waitForIdle()
    }

    /// A page whose picture cannot be drawn fails instead of going as an empty page.
    @Test func aScannedPageWithoutAPictureFails() async throws {
        let streamer = RecordingStreamer()
        let m = model(streamer: streamer)
        m.pagePicture = { _ in nil }
        m.translatePages([CardsModel.PageSource(page: 3, text: "", scanned: true, width: 760, height: 983)], target: .tr)
        for _ in 0..<300 where m.pageTranslation(page: 3, target: .tr)?.messages.last?.role != .assistant || m.pageTranslation(page: 3, target: .tr)?.messages.last?.state == .streaming { try await Task.sleep(for: .milliseconds(10)) }
        #expect(m.pageTranslation(page: 3, target: .tr)?.messages.last?.state == .error)
        #expect(streamer.requests.isEmpty)
    }

    /// The Gemini key changed: pages stop waiting on jobs made with the old key and say so; the jobs
    /// are handed back to be removed with that key (audit K-3).
    @Test func forgettingJobsWhenTheKeyChanges() async throws {
        let batcher = FakeBatcher()
        let m = model(batcher: batcher)
        m.translatePages((1...4).map { page($0) }, target: .tr)
        for _ in 0..<200 where m.waitingTranslations.count < 4 { try await Task.sleep(for: .milliseconds(10)) }
        #expect(m.forgetBatchJobs(code: "key-changed") == ["batches/job-1"])
        #expect(m.waitingTranslations.isEmpty)
        #expect(m.pageTranslation(page: 2, target: .tr)?.messages.last?.content == "key-changed")
        // The same for a book that is not open.
        var stored = m.cards
        stored[0].batchJob = "batches/job-9"
        stored[0].messages[stored[0].messages.count - 1].state = .streaming
        let (cards, jobs) = CardsModel.forgettingBatchJobs(stored, code: "key-changed")
        #expect(jobs == ["batches/job-9"])
        #expect(cards[0].batchJob == nil && cards[0].messages.last?.state == .error)
    }

    /// "Stop translating": batch jobs are cancelled and removed at Google, waiting pages go, finished ones stay.
    @Test func stoppingCancelsJobsAndKeepsFinishedPages() async throws {
        let batcher = FakeBatcher()
        let m = model(batcher: batcher)
        m.translatePages([page(1), page(2)], target: .tr)
        await m.waitForIdle()
        let ids = m.translatePages((3...6).map { page($0) }, target: .tr)
        for _ in 0..<200 where m.waitingTranslations.count < 4 { try await Task.sleep(for: .milliseconds(10)) }
        #expect(m.unfinishedTranslations.count == 4)
        #expect(m.stopTranslations() == 4)
        for _ in 0..<200 where await batcher.deleted.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        #expect(m.unfinishedTranslations.isEmpty)
        #expect(m.pageTranslation(page: 1, target: .tr)?.messages.last?.content == "Kavramlar, sınırlarında netleşir.")
        #expect(ids.allSatisfy { id in !m.cards.contains { $0.id == id } })
        #expect(await batcher.cancelled == ["batches/job-1"])
        #expect(await batcher.deleted == ["batches/job-1"])
        await m.waitForIdle()
    }

    @Test func splittingKeepsTheOrderAndPutsAnOversizedPageAlone() {
        #expect(CardsModel.splitBatch([1, 2, 3, 20, 4], size: { $0 }, maxBytes: 10) == [[1, 2, 3], [20], [4]])
        #expect(CardsModel.splitBatch([Int](), size: { $0 }, maxBytes: 10).isEmpty)
    }

    @Test func readsBothDocumentedResultShapes() {
        #expect(GeminiBatch.parseStatus(["name": "batches/1", "metadata": ["state": "JOB_STATE_RUNNING"]]) == .waiting)
        let nested: [String: Any] = [
            "metadata": ["state": "JOB_STATE_SUCCEEDED"], "done": true,
            "response": ["inlinedResponses": ["inlinedResponses": [
                ["metadata": ["key": "a"], "response": ["candidates": [["content": ["parts": [["text": "thinking…", "thought": true], ["text": "Çeviri A"]]]]]]],
                ["metadata": ["key": "b"], "error": ["code": 400, "message": "bad"]],
            ]]],
        ]
        #expect(GeminiBatch.parseStatus(nested) == .done(texts: ["a": "Çeviri A"], errors: ["b": "unknown"]))
        let flat: [String: Any] = [
            "state": "BATCH_STATE_SUCCEEDED",
            "dest": ["inlinedResponses": [["metadata": ["key": "c"], "response": ["candidates": [["content": ["parts": [["text": "Çeviri C"]]]]]]]]],
        ]
        #expect(GeminiBatch.parseStatus(flat) == .done(texts: ["c": "Çeviri C"], errors: [:]))
        #expect(GeminiBatch.parseStatus(["metadata": ["state": "JOB_STATE_EXPIRED"]]) == .failed("expired"))
    }

    /// "Translate this page": this page and the next, directly and at once, streaming in.
    @Test func twoPagesAreTranslatedDirectlyAtOnce() async throws {
        let streamer = RecordingStreamer()
        let batcher = FakeBatcher()
        let m = model(streamer: streamer, batcher: batcher)
        let ids = m.translatePages([page(4), page(5)], target: .tr)
        #expect(ids.count == 2)
        for _ in 0..<100 where streamer.requests.count < 2 { try await Task.sleep(for: .milliseconds(10)) }
        await m.waitForIdle()
        #expect(await batcher.created.isEmpty, "no batch for two pages")
        #expect(streamer.requests.count == 2)
        let req = try #require(streamer.requests.first)
        #expect(req.provider == .gemini)
        #expect(req.candidates.first == ModelCandidate("gemini-3.8-flash", thinking: .level("high")))
        #expect(req.temperature == 0.35)
        #expect(req.system.hasPrefix("Sen okuma ve çalışma atölyesinin baş çevirmeni"))
        guard case .text(let prompt) = req.turns[0].parts[0] else { Issue.record("text"); return }
        #expect(prompt.hasPrefix("[Freud · Sayfa 4/20]"))
        #expect(prompt.hasSuffix("Page 4: concepts become clear at their borders."))
        #expect(m.pageTranslation(page: 5, target: .tr)?.messages.last?.content == "Kavramlar, sınırlarında netleşir.")
        #expect(m.translatePages([page(4)], target: .tr).isEmpty, "a page is translated once")
    }

    /// More than two pages with Gemini: one batch job, filled in when it finishes.
    @Test func threeOrMorePagesGoToGeminiAsOneBatch() async throws {
        let store = try tempStore()
        let streamer = RecordingStreamer()
        let batcher = FakeBatcher()
        let m = model(streamer: streamer, batcher: batcher, store: store)
        let ids = m.translatePages([page(1), page(2), page(3)], target: .tr)
        for _ in 0..<100 where m.waitingTranslations.count < 3 { try await Task.sleep(for: .milliseconds(10)) }
        let jobs = await batcher.created
        #expect(jobs.count == 1)
        #expect(jobs[0].model == "gemini-3.8-flash")
        #expect(jobs[0].items.map(\.key) == ids)
        #expect(streamer.requests.isEmpty)

        // The job keeps running at Google across a restart.
        await m.waitForIdle()
        let reopened = model(streamer: streamer, batcher: batcher, store: store)
        #expect(reopened.waitingTranslations.count == 3)

        await batcher.setStatus(.done(texts: [ids[0]: "Bir.", ids[1]: "İki."], errors: [ids[2]: "blocked"]))
        await m.pollBatches()
        #expect(m.pageTranslation(page: 1, target: .tr)?.messages.last?.content == "Bir.")
        #expect(m.pageTranslation(page: 3, target: .tr)?.messages.last?.state == .error)
    }

    /// With another provider, pages go in waves of four.
    @Test func otherProvidersTranslateInWavesOfFour() async throws {
        let streamer = RecordingStreamer()
        let claude = ByokSettings(activeProvider: .claude, claudeApiKey: "sk-ant-placeholder-0000")
        let m = model(claude, streamer: streamer)
        m.translatePages((1...6).map { page($0) }, target: .tr)
        for _ in 0..<200 where streamer.requests.count < 6 { try await Task.sleep(for: .milliseconds(10)) }
        await m.waitForIdle()
        #expect(streamer.requests.count == 6)
        #expect(streamer.requests.allSatisfy { $0.provider == .claude && $0.model == "claude-haiku-5-5" })
        #expect(streamer.requests[0].maxOutputTokens == 16000)
        #expect(m.cards.filter { $0.messages.last?.state == nil && $0.messages.last?.role == .assistant }.count == 6)
    }

    /// When the batch cannot be made (no batch for the model, a timeout, a busy service), nothing is
    /// sent again at full price on its own: each page says so, and its Retry translates it directly.
    @Test(arguments: [GeminiBatch.Unavailable() as Error, AIError(.network), AIError(.quota), AIError(.unknown, status: 503)])
    func whenTheBatchCannotBeMadeEachPageSaysSoAndOffersADirectTranslation(_ failure: Error) async throws {
        let streamer = RecordingStreamer()
        let batcher = FakeBatcher()
        await batcher.setCreateError(failure)
        let m = model(streamer: streamer, batcher: batcher)
        m.translatePages([page(1), page(2), page(3)], target: .tr)
        for _ in 0..<200 where m.pageTranslation(page: 3, target: .tr)?.messages.last?.state != .error { try await Task.sleep(for: .milliseconds(10)) }
        await m.waitForIdle()
        #expect(streamer.requests.isEmpty, "no silent full-price fallback")
        #expect(m.waitingTranslations.isEmpty)
        for n in 1...3 {
            #expect(m.pageTranslation(page: n, target: .tr)?.messages.last?.content == "batch")
            #expect(m.pageTranslation(page: n, target: .tr)?.messages.last?.state == .error)
        }
        // Retry on one page translates that page, directly.
        m.retranslate(try #require(m.pageTranslation(page: 2, target: .tr)).id)
        await m.waitForIdle()
        #expect(streamer.requests.count == 1)
        #expect(m.pageTranslation(page: 2, target: .tr)?.messages.last?.content == "Kavramlar, sınırlarında netleşir.")
    }

    @Test func aScannedPageGoesAsAPictureAndToDeepSeekFlash() async throws {
        let streamer = RecordingStreamer()
        let deepseek = ByokSettings(activeProvider: .deepseek, deepseekApiKey: "sk-placeholder-0000000")
        let m = model(deepseek, streamer: streamer)
        m.translatePages([page(7, image: "data:image/jpeg;base64,/9j/")], target: .tr)
        for _ in 0..<100 where streamer.requests.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        let req = try #require(streamer.requests.first)
        #expect(req.model == "deepseek-flash", "deepseek-v4-pro takes no pictures")
        #expect(req.turns[0].parts.first == .image(mimeType: "image/jpeg", base64: "/9j/"))
    }

    @Test func withoutAnyKeyItSaysSo() async throws {
        let m = model(ByokSettings())
        m.translatePages([page(1)], target: .tr)
        for _ in 0..<100 where m.pageTranslation(page: 1, target: .tr)?.messages.last?.state != .error { try await Task.sleep(for: .milliseconds(10)) }
        #expect(m.pageTranslation(page: 1, target: .tr)?.messages.last?.content == "no-key")
    }

    @Test func translateNowTakesAPageOutOfTheBatch() async throws {
        let streamer = RecordingStreamer()
        let batcher = FakeBatcher()
        let m = model(streamer: streamer, batcher: batcher)
        let ids = m.translatePages([page(1), page(2), page(3)], target: .tr)
        for _ in 0..<100 where m.waitingTranslations.count < 3 { try await Task.sleep(for: .milliseconds(10)) }
        m.translateNow(ids[1])
        await m.waitForIdle()
        let card = try #require(m.pageTranslation(page: 2, target: .tr))
        #expect(card.batchJob == nil)
        #expect(card.messages.last?.content == "Kavramlar, sınırlarında netleşir.")
        #expect(card.messages.filter { $0.role == .assistant }.count == 1)
        #expect(m.waitingTranslations.count == 2)
    }

    /// A page never waits for ever: a rejected key or a job Google no longer has is shown as an error
    /// (with a retry); a passing network problem just waits for the next ask.
    @Test func aWaitingPageSaysWhenTheJobCannotBeAnswered() async throws {
        let batcher = FakeBatcher()
        let m = model(batcher: batcher)
        m.translatePages([page(1), page(2), page(3)], target: .tr)
        for _ in 0..<100 where m.waitingTranslations.count < 3 { try await Task.sleep(for: .milliseconds(10)) }
        await batcher.setStatusError(AIError(.network))
        await m.pollBatches()
        #expect(m.waitingTranslations.count == 3, "a network hiccup keeps waiting")
        await batcher.setStatusError(GeminiBatch.JobGone())
        await m.pollBatches()
        #expect(m.waitingTranslations.isEmpty)
        #expect(m.pageTranslation(page: 1, target: .tr)?.messages.last?.content == "expired")
    }
}
