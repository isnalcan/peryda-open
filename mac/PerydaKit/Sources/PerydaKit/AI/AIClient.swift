import Foundation

/// Bring-your-own-key streaming clients. Requests go straight from this Mac to Google or OpenAI; the key
/// is sent only to the provider it belongs to and is never logged or stored here.
public enum AIPart: Sendable, Equatable {
    case text(String)
    case image(mimeType: String, base64: String)
}

public struct AITurn: Sendable, Equatable {
    public enum Role: Sendable { case user, assistant }
    public var role: Role
    public var parts: [AIPart]

    public init(role: Role, parts: [AIPart]) {
        self.role = role
        self.parts = parts
    }
}

public struct AIRequest: Sendable {
    public var provider: ProviderID
    public var apiKey: String
    public var system: String
    public var turns: [AITurn]
    public var maxOutputTokens: Int?
    /// The wanted temperature; left out for models that refuse or are better without one.
    public var temperature: Double?
    /// How hard the model thinks (the job's level). Gemini carries it in its candidates; OpenAI and
    /// DeepSeek get `reasoning_effort`, Claude `output_config.effort`. Nil: the provider's default.
    public var effort: Effort?
    /// The model to use first, then fallbacks (Gemini) if a model is not available.
    public var candidates: [ModelCandidate]

    public var model: String { candidates.first?.model ?? "" }

    public init(provider: ProviderID, apiKey: String, model: String, system: String, turns: [AITurn], maxOutputTokens: Int? = nil, temperature: Double? = nil, effort: Effort? = nil, candidates: [ModelCandidate]? = nil) {
        self.provider = provider
        self.effort = effort
        self.apiKey = apiKey
        self.system = system
        self.turns = turns
        self.maxOutputTokens = maxOutputTokens
        self.temperature = temperature
        self.candidates = candidates ?? [ModelCandidate(model, thinking: provider == .gemini ? .forModel(model, effort: effort ?? .high) : .none)]
    }
}

public struct AIError: Error, Equatable, Sendable {
    public enum Kind: String, Sendable { case network, key, quota, blocked, aborted, unknown }
    public var kind: Kind
    public var status: Int?

    public init(_ kind: Kind, status: Int? = nil) {
        self.kind = kind
        self.status = status
    }
}

/// Splits a server-sent-events text stream into (event, data) records.
public struct SSEParser {
    private var buffer = ""

    public init() {}

    public mutating func feed(_ text: String) -> [(event: String, data: String)] {
        buffer += text
        var records: [(String, String)] = []
        while let range = buffer.range(of: "\n\n") ?? buffer.range(of: "\r\n\r\n") {
            let chunk = String(buffer[buffer.startIndex..<range.lowerBound])
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            if let r = Self.parse(chunk) { records.append(r) }
        }
        return records
    }

    public mutating func finish() -> [(event: String, data: String)] {
        defer { buffer = "" }
        return Self.parse(buffer).map { [$0] } ?? []
    }

    static func parse(_ chunk: String) -> (String, String)? {
        var event = "message"
        var data: [String] = []
        for line in chunk.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" }) {
            if line.hasPrefix("event:") {
                event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                var value = String(line.dropFirst(5))
                if value.hasPrefix(" ") { value.removeFirst() }
                data.append(value)
            }
        }
        return data.isEmpty ? nil : (event, data.joined(separator: "\n"))
    }
}

public final class AIClient: Sendable {
    let session: URLSession

    public init(session: URLSession = AIClient.providerSession) {
        self.session = session
    }

    /// The session every provider request goes through. Nothing is written to disk: no response
    /// cache (it would keep each request with its key header, and translated pages), no cookies, no
    /// stored credentials.
    public static let providerSession: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.urlCredentialStorage = nil
        return URLSession(configuration: c, delegate: RefuseRedirects(), delegateQueue: nil)
    }()

    /// Provider requests never follow a redirect: URLSession would resend the request, with Gemini's
    /// and Claude's key headers and the page text, to whatever host the redirect names (audit K-1 /
    /// MA-7, 15 Nov). A 3xx answer is then an error like any other.
    public final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
        public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    /// A model name as it may appear in a request path: letters, digits, ".", "_" and "-" only, so a
    /// name (from settings or a provider's list) can never change the path or the host.
    public static func modelPath(_ model: String) -> String? {
        guard !model.isEmpty, model.count <= 128, model != ".", model != "..",
              model.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-").contains($0) })
        else { return nil }
        return model
    }

    static let geminiBase = "https://generativelanguage.googleapis.com/v1beta"
    static let openAIBase = "https://api.openai.com/v1"
    static let deepseekBase = "https://api.deepseek.com"
    static let claudeBase = "https://api.anthropic.com/v1"
    static let claudeVersion = "2023-06-01"

    /// A Gemini generateContent request body (also used inside batch jobs).
    static func geminiBody(system: String, turns: [AITurn], maxOutputTokens: Int?, thinking: GeminiThinking, temperature: Double?) -> [String: Any] {
        var body: [String: Any] = [
            "systemInstruction": ["parts": [["text": system]]],
            "contents": turns.map { turn in
                [
                    "role": turn.role == .assistant ? "model" : "user",
                    "parts": turn.parts.map { part -> [String: Any] in
                        switch part {
                        case .text(let t): return ["text": t]
                        case .image(let mime, let b64): return ["inlineData": ["mimeType": mime, "data": b64]]
                        }
                    },
                ] as [String: Any]
            },
        ]
        var config: [String: Any] = [:]
        if let max = maxOutputTokens { config["maxOutputTokens"] = max }
        switch thinking {
        case .level(let level): config["thinkingConfig"] = ["thinkingLevel": level]
        case .budget(let budget): config["thinkingConfig"] = ["thinkingBudget": budget]
        case .none: break
        }
        if let temperature { config["temperature"] = temperature }
        if !config.isEmpty { body["generationConfig"] = config }
        return body
    }

    /// OpenAI and DeepSeek share the Chat Completions shape.
    static func chatBody(model: String, system: String, turns: [AITurn], maxOutputTokens: Int?, temperature: Double?) -> [String: Any] {
        var messages: [[String: Any]] = [["role": "system", "content": system]]
        for turn in turns {
            if turn.role == .assistant {
                let text = turn.parts.compactMap { part -> String? in if case .text(let t) = part { t } else { nil } }.joined()
                messages.append(["role": "assistant", "content": text])
            } else {
                messages.append(["role": "user", "content": turn.parts.map { part -> [String: Any] in
                    switch part {
                    case .text(let t): return ["type": "text", "text": t]
                    case .image(let mime, let b64): return ["type": "image_url", "image_url": ["url": "data:\(mime);base64,\(b64)"]]
                    }
                }])
            }
        }
        var body: [String: Any] = ["model": model, "messages": messages, "stream": true]
        if let max = maxOutputTokens { body["max_completion_tokens"] = max }
        if let temperature { body["temperature"] = temperature }
        return body
    }

    static func claudeBody(model: String, system: String, turns: [AITurn], maxOutputTokens: Int?, temperature: Double?) -> [String: Any] {
        var body: [String: Any] = [
            "model": model,
            "system": system,
            "max_tokens": maxOutputTokens ?? 8000,
            "stream": true,
            "messages": turns.map { turn -> [String: Any] in
                if turn.role == .assistant {
                    let text = turn.parts.compactMap { part -> String? in if case .text(let t) = part { t } else { nil } }.joined()
                    return ["role": "assistant", "content": text]
                }
                return ["role": "user", "content": turn.parts.map { part -> [String: Any] in
                    switch part {
                    case .text(let t): return ["type": "text", "text": t]
                    case .image(let mime, let b64): return ["type": "image", "source": ["type": "base64", "media_type": mime, "data": b64]]
                    }
                }]
            },
        ]
        if let temperature { body["temperature"] = temperature }
        return body
    }

    public func urlRequest(for req: AIRequest) throws -> URLRequest {
        try urlRequest(for: req, candidate: req.candidates.first ?? ModelCandidate(req.model), temperature: req.temperature)
    }

    func urlRequest(for req: AIRequest, candidate: ModelCandidate, temperature: Double?) throws -> URLRequest {
        let model = candidate.model
        let temp = temperature.flatMap { ModelAdvice.acceptsTemperature(req.provider, model) ? $0 : nil }
        let effort = req.effort.flatMap { ModelAdvice.acceptsEffort(req.provider, model) ? $0 : nil }
        var r: URLRequest
        let body: [String: Any]
        switch req.provider {
        case .gemini:
            guard let path = Self.modelPath(model), let url = URL(string: "\(Self.geminiBase)/models/\(path):streamGenerateContent?alt=sse") else { throw AIError(.unknown) }
            r = URLRequest(url: url)
            r.setValue(req.apiKey, forHTTPHeaderField: "x-goog-api-key")
            body = Self.geminiBody(system: req.system, turns: req.turns, maxOutputTokens: req.maxOutputTokens, thinking: candidate.thinking, temperature: temp)
        case .openai, .deepseek:
            r = URLRequest(url: URL(string: req.provider == .openai ? "\(Self.openAIBase)/chat/completions" : "\(Self.deepseekBase)/chat/completions")!)
            r.setValue("Bearer \(req.apiKey)", forHTTPHeaderField: "Authorization")
            var b = Self.chatBody(model: model, system: req.system, turns: req.turns, maxOutputTokens: req.maxOutputTokens, temperature: temp)
            // OpenAI is asked not to keep the conversation; it stays on the Mac.
            if req.provider == .openai { b["store"] = false }
            if let effort { b["reasoning_effort"] = effort.rawValue }
            body = b
        case .claude:
            r = URLRequest(url: URL(string: "\(Self.claudeBase)/messages")!)
            r.setValue(req.apiKey, forHTTPHeaderField: "x-api-key")
            r.setValue(Self.claudeVersion, forHTTPHeaderField: "anthropic-version")
            var b = Self.claudeBody(model: model, system: req.system, turns: req.turns, maxOutputTokens: req.maxOutputTokens, temperature: temp)
            if let effort { b["output_config"] = ["effort": effort.rawValue] }
            body = b
        }
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: body)
        return r
    }

    static func error(status: Int, body: String) -> AIError {
        let lower = body.lowercased()
        if status == 401 || status == 403 || lower.contains("api_key_invalid") || lower.contains("invalid api key") || lower.contains("incorrect api key") {
            return AIError(.key, status: status)
        }
        if status == 429 || lower.contains("quota") {
            return AIError(.quota, status: status)
        }
        // A redirect that was not followed (see RefuseRedirects).
        if (300..<400).contains(status) { return AIError(.network, status: status) }
        return AIError(.unknown, status: status)
    }

    /// An HTTP error before any text arrived, with what is needed to decide on a fallback.
    struct HTTPFailure: Error {
        var status: Int
        var body: String
    }

    /// Streams the answer as text pieces; throws AIError. A Gemini model that is not available (404,
    /// or a 400 naming the model) hands over to the next candidate; a model that refuses the
    /// temperature is asked once more without it.
    public func stream(_ req: AIRequest) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var lastFailure: HTTPFailure?
                    for candidate in req.candidates {
                        var temperature = req.temperature
                        while true {
                            do {
                                try await self.run(req, candidate: candidate, temperature: temperature, continuation: continuation)
                                continuation.finish()
                                return
                            } catch let failure as HTTPFailure {
                                lastFailure = failure
                                let lower = failure.body.lowercased()
                                if failure.status == 400, temperature != nil, lower.contains("temperature") {
                                    temperature = nil
                                    continue
                                }
                                let modelMissing = failure.status == 404 || (failure.status == 400 && lower.contains("model"))
                                if req.provider == .gemini, modelMissing { break }
                                throw Self.error(status: failure.status, body: failure.body)
                            }
                        }
                    }
                    if let lastFailure { throw Self.error(status: lastFailure.status, body: lastFailure.body) }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(throwing: AIError(.aborted))
                } catch let error as AIError {
                    continuation.finish(throwing: error)
                } catch let error as URLError where error.code == .cancelled {
                    continuation.finish(throwing: AIError(.aborted))
                } catch {
                    continuation.finish(throwing: AIError(.network))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func run(_ req: AIRequest, candidate: ModelCandidate, temperature: Double?, continuation: AsyncThrowingStream<String, Error>.Continuation) async throws {
        let request = try urlRequest(for: req, candidate: candidate, temperature: temperature)
        let (bytes, response) = try await session.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if !(200..<300).contains(status) {
            var body = ""
            for try await line in bytes.lines {
                body += line
                if body.count > 4000 { break }
            }
            throw HTTPFailure(status: status, body: body)
        }
        var parser = SSEParser()
        var produced = false
        // Read byte by byte so empty lines, which end each event, are kept.
        var line = Data()
        func flush() throws {
            var text = String(decoding: line, as: UTF8.self)
            if text.hasSuffix("\r") { text.removeLast() }
            line.removeAll(keepingCapacity: true)
            for record in parser.feed(text + "\n") {
                for piece in try Self.pieces(provider: req.provider, event: record.event, data: record.data, produced: &produced) {
                    continuation.yield(piece)
                }
            }
        }
        for try await byte in bytes {
            if byte == 0x0A { try flush() } else { line.append(byte) }
        }
        if !line.isEmpty { try flush() }
        for record in parser.finish() {
            for piece in try Self.pieces(provider: req.provider, event: record.event, data: record.data, produced: &produced) {
                continuation.yield(piece)
            }
        }
    }

    /// Text pieces carried by one SSE record.
    static func pieces(provider: ProviderID, event: String, data: String, produced: inout Bool) throws -> [String] {
        if data == "[DONE]" { return [] }
        guard let json = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any] else { return [] }
        switch provider {
        case .gemini:
            if json["error"] != nil { throw AIError(.unknown) }
            if let feedback = json["promptFeedback"] as? [String: Any], feedback["blockReason"] != nil { throw AIError(.blocked) }
            let candidate = (json["candidates"] as? [[String: Any]])?.first
            let parts = ((candidate?["content"] as? [String: Any])?["parts"] as? [[String: Any]]) ?? []
            var out: [String] = []
            for part in parts where (part["thought"] as? Bool) != true {
                if let text = part["text"] as? String {
                    out.append(text)
                    produced = true
                }
            }
            let finish = candidate?["finishReason"] as? String
            if !produced, let finish, ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].contains(finish) { throw AIError(.blocked) }
            return out
        case .openai, .deepseek:
            // Chat Completions: only `delta.content` is the answer; DeepSeek's thinking arrives in
            // `delta.reasoning_content` and is left out.
            if let error = json["error"] as? [String: Any] {
                let code = String(describing: error["code"] ?? error["type"] ?? "")
                throw AIError(code.contains("quota") || code.contains("rate") ? .quota : .unknown)
            }
            let choice = (json["choices"] as? [[String: Any]])?.first
            let delta = choice?["delta"] as? [String: Any]
            if let refusal = delta?["refusal"] as? String, !refusal.isEmpty { throw AIError(.blocked) }
            if (choice?["finish_reason"] as? String) == "content_filter", !produced { throw AIError(.blocked) }
            if let text = delta?["content"] as? String, !text.isEmpty {
                produced = true
                return [text]
            }
            return []
        case .claude:
            let type = (json["type"] as? String) ?? event
            switch type {
            case "content_block_delta":
                // Only text; thinking deltas are left out.
                let delta = json["delta"] as? [String: Any]
                if (delta?["type"] as? String) == "text_delta", let text = delta?["text"] as? String {
                    produced = true
                    return [text]
                }
                return []
            case "message_delta":
                let reason = (json["delta"] as? [String: Any])?["stop_reason"] as? String
                if reason == "refusal", !produced { throw AIError(.blocked) }
                return []
            case "error":
                let kind = ((json["error"] as? [String: Any])?["type"] as? String) ?? ""
                throw AIError(kind.contains("rate_limit") || kind.contains("overloaded") ? .quota : kind.contains("authentication") ? .key : .unknown)
            default:
                return []
            }
        }
    }

    /// Models that can answer text questions, for "Load models".
    public func listModels(provider: ProviderID, apiKey: String) async throws -> [String] {
        var request: URLRequest
        switch provider {
        case .gemini:
            request = URLRequest(url: URL(string: "\(Self.geminiBase)/models?pageSize=1000")!)
            request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        case .openai:
            request = URLRequest(url: URL(string: "\(Self.openAIBase)/models")!)
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        case .deepseek:
            request = URLRequest(url: URL(string: "\(Self.deepseekBase)/models")!)
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        case .claude:
            request = URLRequest(url: URL(string: "\(Self.claudeBase)/models?limit=1000")!)
            request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
            request.setValue(Self.claudeVersion, forHTTPHeaderField: "anthropic-version")
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Self.error(status: status, body: String(decoding: data, as: UTF8.self)) }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let ids = ((json["data"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String }
        switch provider {
        case .gemini:
            return ((json["models"] as? [[String: Any]]) ?? [])
                .filter { (($0["supportedGenerationMethods"] as? [String]) ?? []).contains("generateContent") }
                .compactMap { ($0["name"] as? String)?.replacingOccurrences(of: "models/", with: "") }
                .filter { $0.hasPrefix("gemini-") && $0.range(of: "embedding|aqa|imagen|tts|image-generation|live", options: .regularExpression) == nil }
        case .openai:
            return ids
                .filter { $0.range(of: "^(gpt-|o\\d|chatgpt-)", options: .regularExpression) != nil }
                .filter { $0.range(of: "embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|search|moderation|instruct", options: .regularExpression) == nil }
                .sorted()
        case .deepseek:
            return ids.filter { $0.hasPrefix("deepseek") }.sorted()
        case .claude:
            return ids.filter { $0.hasPrefix("claude-") }
        }
    }
}
