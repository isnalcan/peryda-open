import Foundation

/// Whole-page translation runs as a Gemini batch job (half the price of a direct request; Google's
/// target turnaround is 24 hours, most jobs finish much sooner). Requests go from the Mac straight
/// to Google with the reader's own key.
public protocol PageBatching: Sendable {
    func create(apiKey: String, model: String, items: [GeminiBatch.Item]) async throws -> String
    func status(apiKey: String, name: String) async throws -> GeminiBatch.Status
    func cancel(apiKey: String, name: String) async
    /// Removes a job and what Google keeps of it (the pages sent and their translations).
    func delete(apiKey: String, name: String) async
}

extension PageBatching {
    /// Stops a job nobody waits for any more and removes it.
    public func abandon(apiKey: String, name: String) async {
        guard GeminiBatch.isValidName(name) else { return }
        await cancel(apiKey: apiKey, name: name)
        await delete(apiKey: apiKey, name: name)
    }

    /// The key a job was made with is going away (the reader changed or removed it): asks Google once
    /// with that key. A finished job's results come back to be kept (the caller saves them, then
    /// calls `delete`); an unfinished one is cancelled and removed now (audit KR-2, 15 Nov).
    public func settle(apiKey: String, name: String) async -> BatchOutcome {
        guard GeminiBatch.isValidName(name) else { return .unfinished }
        if case .done(let texts, let errors)? = try? await status(apiKey: apiKey, name: name) {
            return .done(texts: texts, errors: errors)
        }
        await abandon(apiKey: apiKey, name: name)
        return .unfinished
    }
}

/// What became of a batch job when the key that made it went away.
public enum BatchOutcome: Sendable, Equatable {
    /// Finished: results by key, and error codes for keys that failed.
    case done(texts: [String: String], errors: [String: String])
    /// Not finished (or unknown): cancelled and removed; its pages are to be sent again.
    case unfinished
}

public struct GeminiBatch: PageBatching {
    /// The recommended model for page translation (the reader may choose another Gemini model).
    public static let model = "gemini-3.8-flash"
    public static let maxOutputTokens = 16_384

    public struct Item: Sendable {
        public var key: String
        public var system: String
        public var turns: [AITurn]

        public init(key: String, system: String, turns: [AITurn]) {
            self.key = key
            self.system = system
            self.turns = turns
        }
    }

    public enum Status: Sendable, Equatable {
        case waiting
        /// Finished: translated text by key, and an error code for keys that failed.
        case done(texts: [String: String], errors: [String: String])
        /// The job failed, expired or was cancelled as a whole.
        case failed(String)
    }

    /// Google no longer knows the job (deleted, or older than its 48-hour limit).
    public struct JobGone: Error {}

    /// Creating a job failed for a reason other than the key (the model or the endpoint is not
    /// available for batches). The pages are not sent again on their own: each says so and offers a
    /// direct translation.
    public struct Unavailable: Error {}

    let session: URLSession

    public init(session: URLSession = AIClient.providerSession) {
        self.session = session
    }

    /// A job name as Google gives it. Names come back from Google and from backups; only this shape
    /// is ever put into a request URL.
    public static func isValidName(_ name: String) -> Bool {
        let prefix = "batches/"
        guard name.hasPrefix(prefix) else { return false }
        let rest = name.utf8.dropFirst(prefix.utf8.count)
        return (1...128).contains(rest.count) && rest.allSatisfy { b in
            (48...57).contains(b) || (65...90).contains(b) || (97...122).contains(b) || b == 95 || b == 45
        }
    }

    static var base: String { AIClient.geminiBase }

    /// Each request carries the model's thinking (level for Gemini 3, budget for 2.5) and the
    /// translation temperature where the model takes one.
    public static func createBody(_ items: [Item], model: String = model) -> [String: Any] {
        let temperature = ModelAdvice.acceptsTemperature(.gemini, model) ? ModelAdvice.temperature(.translation) : nil
        return [
            "batch": [
                "display_name": "peryda-page-translation",
                "input_config": [
                    "requests": [
                        "requests": items.map { item in
                            [
                                "request": AIClient.geminiBody(system: item.system, turns: item.turns, maxOutputTokens: maxOutputTokens, thinking: .forModel(model), temperature: temperature),
                                "metadata": ["key": item.key],
                            ] as [String: Any]
                        },
                    ],
                ],
            ],
        ]
    }

    func request(_ url: String, method: String, apiKey: String, body: [String: Any]? = nil) throws -> URLRequest {
        guard let target = URL(string: url) else { throw AIError(.unknown) }
        var r = URLRequest(url: target)
        r.httpMethod = method
        r.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        r.timeoutInterval = 60
        return r
    }

    func send(_ r: URLRequest) async throws -> [String: Any] {
        let (data, response) = try await session.data(for: r)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let body = String(decoding: data, as: UTF8.self).lowercased()
            switch code {
            case 401, 403: throw AIError(.key)
            case 400 where body.contains("api key") || body.contains("api_key"): throw AIError(.key)
            case 400: throw Unavailable()
            case 404: throw JobGone()
            case 429: throw AIError(.quota)
            default: throw AIError(.network)
            }
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    public func create(apiKey: String, model: String, items: [Item]) async throws -> String {
        guard let path = AIClient.modelPath(model) else { throw Unavailable() }
        let r = try request("\(Self.base)/models/\(path):batchGenerateContent", method: "POST", apiKey: apiKey, body: Self.createBody(items, model: model))
        let json: [String: Any]
        do { json = try await send(r) } catch is JobGone { throw Unavailable() }
        guard let name = json["name"] as? String, Self.isValidName(name) else { throw AIError(.unknown) }
        return name
    }

    public func status(apiKey: String, name: String) async throws -> Status {
        guard Self.isValidName(name) else { throw JobGone() }
        return try Self.parseStatus(await send(request("\(Self.base)/\(name)", method: "GET", apiKey: apiKey)))
    }

    public func cancel(apiKey: String, name: String) async {
        guard Self.isValidName(name), let r = try? request("\(Self.base)/\(name):cancel", method: "POST", apiKey: apiKey, body: [:]) else { return }
        _ = try? await send(r)
    }

    public func delete(apiKey: String, name: String) async {
        guard Self.isValidName(name), let r = try? request("\(Self.base)/\(name)", method: "DELETE", apiKey: apiKey) else { return }
        _ = try? await send(r)
    }

    /// Reads a batch job. The documented examples differ on nesting (`metadata.state` or `state`;
    /// `response.inlinedResponses` or `dest.inlinedResponses`), so both are accepted.
    public static func parseStatus(_ json: [String: Any]) -> Status {
        let meta = json["metadata"] as? [String: Any]
        let state = (meta?["state"] as? String) ?? (json["state"] as? String) ?? ""
        if state.hasSuffix("FAILED") || state.hasSuffix("CANCELLED") || state.hasSuffix("EXPIRED") {
            return .failed(state.hasSuffix("EXPIRED") ? "expired" : "unknown")
        }
        let finished = state.hasSuffix("SUCCEEDED") || (json["done"] as? Bool) == true
        guard finished else { return .waiting }
        if let error = json["error"] as? [String: Any], error["message"] != nil { return .failed("unknown") }
        var texts: [String: String] = [:]
        var errors: [String: String] = [:]
        for item in inlined(json) {
            let key = ((item["metadata"] as? [String: Any])?["key"] as? String) ?? (item["key"] as? String) ?? ""
            guard !key.isEmpty else { continue }
            if item["error"] != nil {
                errors[key] = "unknown"
                continue
            }
            let response = item["response"] as? [String: Any]
            let candidate = (response?["candidates"] as? [[String: Any]])?.first
            let parts = ((candidate?["content"] as? [String: Any])?["parts"] as? [[String: Any]]) ?? []
            let text = parts.filter { ($0["thought"] as? Bool) != true }.compactMap { $0["text"] as? String }.joined()
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                errors[key] = (candidate?["finishReason"] as? String) == "SAFETY" ? "blocked" : "unknown"
            } else {
                texts[key] = text
            }
        }
        return .done(texts: texts, errors: errors)
    }

    static func inlined(_ json: [String: Any]) -> [[String: Any]] {
        for container in [json["response"], json["dest"], json["output"]].compactMap({ $0 as? [String: Any] }) {
            if let list = container["inlinedResponses"] as? [[String: Any]] { return list }
            if let nested = container["inlinedResponses"] as? [String: Any], let list = nested["inlinedResponses"] as? [[String: Any]] { return list }
        }
        return []
    }
}
