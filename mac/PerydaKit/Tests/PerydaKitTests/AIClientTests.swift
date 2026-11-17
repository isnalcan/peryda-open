import Foundation
import Testing
@testable import PerydaKit

/// Serves canned responses to URLSession and remembers the request.
final class MockProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var response: (status: Int, body: String) = (200, "")
    /// Answers in this order first, one per request, then `response`.
    nonisolated(unsafe) static var queue: [(status: Int, body: String)] = []
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBody: Data?
    nonisolated(unsafe) static var sent: [(url: String, body: [String: Any])] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastRequest = request
        if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            stream.close()
            Self.lastBody = data
        } else {
            Self.lastBody = request.httpBody
        }
        Self.sent.append((request.url?.absoluteString ?? "", (Self.lastBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) ?? [:]))
        let answer = Self.queue.isEmpty ? Self.response : Self.queue.removeFirst()
        let http = HTTPURLResponse(url: request.url!, statusCode: answer.status, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(answer.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

func mockClient() -> AIClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MockProtocol.self]
    return AIClient(session: URLSession(configuration: config))
}

func collect(_ stream: AsyncThrowingStream<String, Error>) async throws -> String {
    var out = ""
    for try await piece in stream { out += piece }
    return out
}

let placeholderKey = "test-key-not-real-000"

@Suite("BYOK clients", .serialized)
struct AIClientTests {
    let turns = [AITurn(role: .user, parts: [.text("Hello"), .image(mimeType: "image/png", base64: "AAAA")])]

    @Test func sseParserKeepsRecordsAndMultilineData() {
        var p = SSEParser()
        var records = p.feed("event: a\nda")
        records += p.feed("ta: 1\n\ndata: x\ndata: y\n\n")
        records += p.feed("data: tail")
        records += p.finish()
        #expect(records.map(\.event) == ["a", "message", "message"])
        #expect(records.map(\.data) == ["1", "x\ny", "tail"])
    }

    @Test func geminiStreamsTextAndKeepsTheKeyOutOfTheURL() async throws {
        MockProtocol.response = (200, """
        data: {"candidates":[{"content":{"parts":[{"text":"Mer"}]}}]}

        data: {"candidates":[{"content":{"parts":[{"text":"haba"},{"text":"hidden","thought":true}]},"finishReason":"STOP"}]}


        """)
        let text = try await collect(mockClient().stream(AIRequest(provider: .gemini, apiKey: placeholderKey, model: "gemini-x", system: "Be brief.", turns: turns)))
        #expect(text == "Merhaba")
        let request = try #require(MockProtocol.lastRequest)
        #expect(request.url!.absoluteString.contains("/models/gemini-x:streamGenerateContent?alt=sse"))
        #expect(!request.url!.absoluteString.contains(placeholderKey))
        #expect(request.value(forHTTPHeaderField: "x-goog-api-key") == placeholderKey)
        let sent = try #require(MockProtocol.lastBody)
        let body = try #require(try JSONSerialization.jsonObject(with: sent) as? [String: Any])
        let parts = ((body["contents"] as! [[String: Any]])[0]["parts"] as! [[String: Any]])
        #expect((parts[1]["inlineData"] as! [String: String])["data"] == "AAAA")
    }

    func reset() {
        MockProtocol.queue = []
        MockProtocol.sent = []
    }

    @Test func openAIUsesChatCompletionsWithTheThreadTemperature() async throws {
        reset()
        MockProtocol.response = (200, """
        data: {"choices":[{"delta":{"role":"assistant","content":""}}]}

        data: {"choices":[{"delta":{"content":"Hel"}}]}

        data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}

        data: [DONE]


        """)
        let text = try await collect(mockClient().stream(AIRequest(provider: .openai, apiKey: placeholderKey, model: "gpt-6.1-sol", system: "Be brief.", turns: turns, temperature: 0.55)))
        #expect(text == "Hello")
        let request = try #require(MockProtocol.lastRequest)
        #expect(request.url?.absoluteString == "https://api.openai.com/v1/chat/completions")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(placeholderKey)")
        let body = try #require(MockProtocol.sent.last?.body)
        #expect(body["store"] as? Bool == false)
        // GPT-6 accepts only the default temperature (400 otherwise, measured 17 Nov 2026): none is sent.
        #expect(body["temperature"] == nil)
        let messages = try #require(body["messages"] as? [[String: Any]])
        #expect(messages.first?["role"] as? String == "system")
        let parts = try #require(messages[1]["content"] as? [[String: Any]])
        #expect((parts[1]["image_url"] as? [String: Any])?["url"] as? String == "data:image/png;base64,AAAA")
    }

    @Test func aModelThatRefusesTheTemperatureIsAskedOnceMoreWithoutIt() async throws {
        reset()
        MockProtocol.queue = [(400, #"{"error":{"message":"Unsupported value: 'temperature' does not support 0.55 with this model.","code":"unsupported_value"}}"#)]
        MockProtocol.response = (200, "data: {\"choices\":[{\"delta\":{\"content\":\"Tamam\"}}]}\n\ndata: [DONE]\n\n")
        let text = try await collect(mockClient().stream(AIRequest(provider: .openai, apiKey: placeholderKey, model: "gpt-4o-mini", system: "", turns: turns, temperature: 0.35)))
        #expect(text == "Tamam")
        #expect(MockProtocol.sent.count == 2)
        #expect(MockProtocol.sent[0].body["temperature"] as? Double == 0.35)
        #expect(MockProtocol.sent[1].body["temperature"] == nil)
    }

    @Test func deepSeekLeavesItsThinkingOut() async throws {
        reset()
        MockProtocol.response = (200, """
        data: {"choices":[{"delta":{"reasoning_content":"Önce düşüneyim…"}}]}

        data: {"choices":[{"delta":{"content":"Kısa yanıt."}}]}

        data: [DONE]


        """)
        let text = try await collect(mockClient().stream(AIRequest(provider: .deepseek, apiKey: placeholderKey, model: "deepseek-v4-pro", system: "", turns: turns, temperature: 0.55)))
        #expect(text == "Kısa yanıt.")
        #expect(MockProtocol.lastRequest?.url?.absoluteString == "https://api.deepseek.com/chat/completions")
    }

    @Test func claudeSendsItsHeadersAndOnlyTheAnswerText() async throws {
        reset()
        MockProtocol.response = (200, """
        event: message_start
        data: {"type":"message_start","message":{"id":"m"}}

        event: content_block_delta
        data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"…"}}

        event: content_block_delta
        data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Merhaba"}}

        event: message_delta
        data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}


        """)
        let text = try await collect(mockClient().stream(AIRequest(provider: .claude, apiKey: placeholderKey, model: "claude-sonnet-5-5", system: "Kural", turns: turns, maxOutputTokens: ModelAdvice.maxOutputTokens(.claude, .thread), temperature: 0.55)))
        #expect(text == "Merhaba")
        let request = try #require(MockProtocol.lastRequest)
        #expect(request.url?.absoluteString == "https://api.anthropic.com/v1/messages")
        #expect(request.value(forHTTPHeaderField: "x-api-key") == placeholderKey)
        #expect(request.value(forHTTPHeaderField: "anthropic-version") == "2023-06-01")
        let body = try #require(MockProtocol.sent.last?.body)
        #expect(body["system"] as? String == "Kural")
        #expect(body["max_tokens"] as? Int == 8000)
        #expect(body["temperature"] == nil, "current Claude models reject a non-default temperature")
        let content = try #require(((body["messages"] as? [[String: Any]])?.first?["content"]) as? [[String: Any]])
        #expect(((content[1]["source"] as? [String: Any])?["media_type"]) as? String == "image/png")
    }

    @Test func aClaudeRefusalBeforeAnyTextIsBlocked() async {
        reset()
        MockProtocol.response = (200, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"}}\n\n")
        do {
            _ = try await collect(mockClient().stream(AIRequest(provider: .claude, apiKey: placeholderKey, model: "claude-haiku-5-5", system: "", turns: turns)))
            Issue.record("expected blocked")
        } catch let error as AIError {
            #expect(error.kind == .blocked)
        } catch {
            Issue.record("unexpected \(error)")
        }
    }

    @Test func geminiThinksByModelAndLeavesGemini3AtItsDefaultTemperature() throws {
        let client = AIClient()
        let three = try client.urlRequest(for: AIRequest(provider: .gemini, apiKey: placeholderKey, model: "gemini-3.8-flash", system: "", turns: turns, temperature: 0.55))
        let b3 = try #require(try JSONSerialization.jsonObject(with: three.httpBody!) as? [String: Any])
        let c3 = try #require(b3["generationConfig"] as? [String: Any])
        #expect((c3["thinkingConfig"] as? [String: Any])?["thinkingLevel"] as? String == "high")
        #expect(c3["temperature"] == nil, "Google: keep Gemini 3 at its default temperature")
        let two = try client.urlRequest(for: AIRequest(provider: .gemini, apiKey: placeholderKey, model: "gemini-2.5-flash", system: "", turns: turns, temperature: 0.55))
        let c2 = try #require((try JSONSerialization.jsonObject(with: two.httpBody!) as? [String: Any])?["generationConfig"] as? [String: Any])
        #expect((c2["thinkingConfig"] as? [String: Any])?["thinkingBudget"] as? Int == 8192)
        #expect(c2["temperature"] as? Double == 0.55)
    }

    @Test func aMissingGeminiModelHandsOverToTheNextInTheChain() async throws {
        reset()
        MockProtocol.queue = [(404, #"{"error":{"code":404,"message":"models/gemini-x is not found"}}"#)]
        MockProtocol.response = (200, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"düşünce\",\"thought\":true},{\"text\":\"Yanıt\"}]}}]}\n\n")
        let req = AIRequest(provider: .gemini, apiKey: placeholderKey, model: "gemini-x", system: "", turns: turns, candidates: ModelAdvice.geminiChain(selected: "gemini-x"))
        let text = try await collect(mockClient().stream(req))
        #expect(text == "Yanıt", "thought parts are left out")
        #expect(MockProtocol.sent.count == 2)
        #expect(MockProtocol.sent[0].url.contains("models/gemini-x:"))
        #expect(MockProtocol.sent[1].url.contains("models/gemini-3.8-flash:"))
    }

    @Test(arguments: [(401, "Incorrect API key", AIError.Kind.key), (429, "insufficient_quota", .quota), (500, "oops", .unknown)])
    func errorsMap(status: Int, body: String, kind: AIError.Kind) async {
        MockProtocol.response = (status, body)
        do {
            _ = try await collect(mockClient().stream(AIRequest(provider: .openai, apiKey: placeholderKey, model: "m", system: "", turns: turns)))
            Issue.record("expected an error")
        } catch let error as AIError {
            #expect(error.kind == kind)
        } catch {
            Issue.record("unexpected \(error)")
        }
    }
}

@Suite("Compose")
struct ComposeTests {
    @Test func aRegionGoesAsItsPictureWithThePlaceholderContextAndRequest() {
        let anchor = YarnAnchor(sourceType: .pdfArea, bookId: "b", pageNumber: 4, selectedText: "Şema", lineRects: [], boundingRect: .zero, croppedImage: "data:image/png;base64,QUJD", context: "Sayfanın metni")
        var card = YarnCard(bookId: "b", color: .lavender, kind: .quick(.lavender), anchors: [anchor])
        card.messages = [YarnMessage(role: .user, content: Compose.kindPrompt(.tr, .quick(.lavender))), YarnMessage(role: .assistant, content: "", state: .streaming)]
        let turns = Compose.turns(.tr, card: card)
        #expect(turns.count == 1, "the unfinished answer is not sent")
        #expect(turns[0].parts.first == .image(mimeType: "image/png", base64: "QUJD"))
        guard case .text(let text) = turns[0].parts.last else { Issue.record("no text"); return }
        #expect(text.hasPrefix("Seçilen Metin: \"[PDF Sayfa 4 üzerinden seçilen görsel kesit]\""))
        #expect(text.contains("Bölüm Bağlamı:\nSayfanın metni"))
        #expect(text.hasSuffix("İstek: Bu konunun arkasındaki klasik deneyleri, kuramcıları ve akademik arka planı derinlemesine anlatır mısın?"))
    }

    @Test func aPassageGoesWithTheFirst1200CharactersOfItsContext() {
        let long = String(repeating: "a", count: 1500)
        let anchor = YarnAnchor(sourceType: .pdfText, bookId: "b", pageNumber: 2, selectedText: "Kavramlar sınırlarda netleşir.", lineRects: [], boundingRect: .zero, context: long)
        let parts = Compose.contextParts(.tr, anchors: [anchor], request: "Özel soru?")
        guard case .text(let text) = parts[0] else { Issue.record("no text"); return }
        #expect(text.contains("Seçilen Metin: \"Kavramlar sınırlarda netleşir.\""))
        #expect(text.contains(String(repeating: "a", count: 1200) + "\n\nİstek: Özel soru?"))
        #expect(!text.contains(String(repeating: "a", count: 1201)))
    }

    @Test func theThreeButtonsAskInTheOwnersWords() {
        #expect(Compose.kindPrompt(.tr, .quick(.coral)) == "Bu kısmı çok daha iyi anlamam için günlük hayattan ve alandan somut örneklerle açıklar mısın?")
        #expect(Compose.kindPrompt(.tr, .quick(.mint)) == "Bu kavramı hiç bilmeyen birine anlatır gibi sadeleştirip akılda kalıcı bir metaforla açıklar mısın?")
        #expect(Compose.kindPrompt(.tr, .quick(.lavender)) == "Bu konunun arkasındaki klasik deneyleri, kuramcıları ve akademik arka planı derinlemesine anlatır mısın?")
        let system = Compose.systemPrompt(.tr, bookTitle: "Mazoşizmin Ekonomik Sorunu", pages: [4])
        #expect(system.hasPrefix("Sen \"Mazoşizmin Ekonomik Sorunu\" metninin akademik çalışma ve okuma eşlikçisisin."))
        #expect(system.contains("ASLA emoji kullanma"))
    }

    @Test func pageTranslationPromptsFollowTheTextLayer() {
        let text = Compose.pageTranslationTurns(target: .tr, file: "Freud", page: 4, pages: 20, text: "The existence of this primary masochism…", imageDataURL: nil)
        guard case .text(let t) = text[0].parts[0] else { Issue.record("no text"); return }
        #expect(t.hasPrefix("[Freud · Sayfa 4/20]\nAşağıdaki sayfa metnini kontrol et:"))
        #expect(t.hasSuffix("hiçbir paragrafı atlama:\n\nThe existence of this primary masochism…"))
        let scanned = Compose.pageTranslationTurns(target: .tr, file: "Freud", page: 5, pages: 20, text: "", imageDataURL: "data:image/jpeg;base64,/9j/")
        #expect(scanned[0].parts.first == .image(mimeType: "image/jpeg", base64: "/9j/"))
        guard case .text(let s) = scanned[0].parts.last else { Issue.record("no text"); return }
        #expect(s.hasPrefix("[Freud · Sayfa 5/20 — Metin katmanı yok (Görsel OCR + Çeviri)]"))
        #expect(Compose.pageTranslationSystem(target: .tr).hasPrefix("Sen okuma ve çalışma atölyesinin baş çevirmeni ve akademik editörüsün."))
    }

    /// Hard terms are explained in brackets unless the reader turns it off; then the same rules go
    /// without that one, in every language.
    @Test func pageTranslationsExplainTermsOnlyWhenAsked() {
        let brackets: [Lang: String] = [.tr: "parantez", .en: "bracket", .de: "klammer", .es: "paréntesis"]
        func words(_ target: Lang, _ explain: Bool, image: String? = nil) -> String {
            let turns = Compose.pageTranslationTurns(target: target, file: "Freud", page: 4, pages: 20, text: "Page text.", imageDataURL: image, explainTerms: explain)
            guard case .text(let t) = turns[0].parts.last else { return "" }
            return (Compose.pageTranslationSystem(target: target, explainTerms: explain) + "\n" + t).lowercased()
        }
        let scan = "data:image/jpeg;base64,/9j/"
        for l in Lang.allCases {
            let word = brackets[l]!
            #expect(words(l, true).contains(word), "\(l)")
            #expect(words(l, true, image: scan).contains(word), "\(l)")
            #expect(!words(l, false).contains(word), "\(l)")
            #expect(!words(l, false, image: scan).contains(word), "\(l)")
            #expect(words(l, false).hasSuffix("page text."), "\(l)")
        }
        // The default is on.
        #expect(Compose.pageTranslationSystem(target: .tr) == Compose.pageTranslationSystem(target: .tr, explainTerms: true))
    }

    @Test func settingsSavedBeforeFourProvidersStillLoadAndResolve() throws {
        let old = #"{"activeProvider":"openai","geminiApiKey":"AIzaSyExampleKey1234","geminiModel":"","openaiApiKey":"","openaiModel":""}"#
        let s = try JSONDecoder().decode(ByokSettings.self, from: Data(old.utf8))
        #expect(s.resolvedProvider == .gemini, "the chosen provider has no key: the first with one")
        #expect(s.model(for: .gemini, task: .thread) == "gemini-4-hydrogen")
        #expect(s.model(for: .openai, task: .translation) == "gpt-6.1-sol")
        #expect(s.choices.isEmpty)
        var four = ByokSettings(activeProvider: .claude, claudeApiKey: "sk-ant-placeholder-0000")
        #expect(four.resolvedProvider == .claude)
        four.setModel("claude-haiku-5-5", for: .claude, task: .thread)
        #expect(four.model(for: .claude) == "claude-haiku-5-5")
        #expect(ModelAdvice.recommended(.deepseek, .translation) == ["deepseek-flash"])
        #expect(ModelAdvice.geminiChain(selected: "gemini-3.8-flash").map(\.model) == ["gemini-3.8-flash", "gemini-4-hydrogen", "gemini-2.5-flash", "gemini-2.5-flash"])
    }

    @Test func translatePromptNamesTheLanguage() {
        #expect(Compose.kindPrompt(.tr, .translate).contains("Türkçe"))
        #expect(Compose.kindPrompt(.en, .translate).contains("English"))
    }

    /// A thread answer has a ceiling with every provider (16,384 tokens; Claude's 8,000 includes its
    /// thinking), so a book asking for an endless answer cannot run up the reader's bill.
    @Test func threadAnswersAreCappedForEveryProvider() throws {
        func body(_ provider: ProviderID, _ model: String) throws -> [String: Any] {
            let req = AIRequest(provider: provider, apiKey: placeholderKey, model: model, system: "s", turns: [AITurn(role: .user, parts: [.text("Hello")])], maxOutputTokens: ModelAdvice.maxOutputTokens(provider, .thread))
            let data = try #require(try mockClient().urlRequest(for: req).httpBody)
            return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        #expect((try body(.gemini, "gemini-3.8-flash")["generationConfig"] as? [String: Any])?["maxOutputTokens"] as? Int == 16_384)
        #expect(try body(.openai, "gpt-6.1-sol")["max_completion_tokens"] as? Int == 16_384)
        #expect(try body(.deepseek, "deepseek-v4-pro")["max_completion_tokens"] as? Int == 16_384)
        #expect(try body(.claude, "claude-sonnet-5-5")["max_tokens"] as? Int == 8_000)
    }

    @Test func kindsRoundTripThroughJSON() throws {
        for kind in [YarnKind.quick(.coral), .question, .bridge, .translate] {
            let data = try JSONEncoder().encode(kind)
            #expect(try JSONDecoder().decode(YarnKind.self, from: data) == kind)
        }
    }
}
