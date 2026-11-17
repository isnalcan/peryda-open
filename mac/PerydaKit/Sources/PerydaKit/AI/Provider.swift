import Foundation

/// The four providers a reader can bring a key for. Gemini first: its free tier, and page translation
/// batches at half the price.
public enum ProviderID: String, Codable, CaseIterable, Sendable {
    case gemini, openai, deepseek, claude

    /// The model used when the reader has not picked one (the first recommended for threads).
    public var defaultModel: String { ModelAdvice.recommended(self, .thread)[0] }
}

/// What a request is for. Each job has its own model and thinking level (owner, 17 Nov 2026): threads,
/// an area of a page (a picture), page translation, pictures of pages (scanned translation and text
/// extraction) and the Book Journal summary. Same rules as web/src/ai/provider.ts.
public enum AITask: String, Codable, CaseIterable, Sendable {
    case thread, area, translation, scan, summary

    /// Jobs whose request carries a picture.
    public var takesPicture: Bool { self == .area || self == .scan }
    /// Jobs that write a translation or a transcription (kept close to the text).
    public var isTranslationLike: Bool { self == .translation || self == .scan }
}

/// How hard a model is asked to think. Every tested model takes these three.
public enum Effort: String, Codable, CaseIterable, Sendable {
    case low, medium, high
}

/// How a Gemini model is asked to think.
public enum GeminiThinking: Equatable, Sendable {
    case level(String)
    case budget(Int)
    case none

    /// Gemini 3 and later take a thinking level, Gemini 2.5 a token budget; others nothing.
    public static func forModel(_ model: String, effort: Effort = .high) -> GeminiThinking {
        if model.range(of: #"^gemini-([3-9]|\d{2,})"#, options: .regularExpression) != nil { return .level(effort.rawValue) }
        if model.hasPrefix("gemini-2.5") { return .budget(8192) }
        return .none
    }
}

/// One model to try, with how it should think (Gemini only; others use their defaults).
public struct ModelCandidate: Equatable, Sendable {
    public var model: String
    public var thinking: GeminiThinking

    public init(_ model: String, thinking: GeminiThinking = .none) {
        self.model = model
        self.thinking = thinking
    }
}

/// The recommended model and thinking level for each job, from the blind test of 17 Nov 2026 (Kant,
/// 14 tasks, 8 models at three levels, two blind judges; notes/model-testi-2026-11-17): the best
/// quality, and among nearly equal answers the fastest and cheapest. The first model is the default.
/// DeepSeek was not in the test: its models keep the provider's own thinking.
public enum ModelAdvice {
    struct Recommendation {
        let models: [String]
        let effort: Effort?
    }

    static func recommendation(_ provider: ProviderID, _ task: AITask) -> Recommendation {
        let sol = ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"]
        switch (provider, task) {
        case (.gemini, .thread): return Recommendation(models: ["gemini-4-hydrogen", "gemini-3.8-flash"], effort: .medium)
        case (.gemini, .area): return Recommendation(models: ["gemini-3.8-flash", "gemini-4-hydrogen"], effort: .low)
        case (.gemini, .translation), (.gemini, .scan): return Recommendation(models: ["gemini-4-hydrogen", "gemini-3.8-flash"], effort: .low)
        case (.gemini, .summary): return Recommendation(models: ["gemini-3.8-flash", "gemini-4-hydrogen"], effort: .low)
        case (.openai, .area): return Recommendation(models: sol, effort: .medium)
        case (.openai, _): return Recommendation(models: sol, effort: .low)
        case (.deepseek, .thread), (.deepseek, .summary): return Recommendation(models: ["deepseek-v4-pro", "deepseek-flash"], effort: nil)
        // DeepSeek's reasoning model takes no pictures.
        case (.deepseek, _): return Recommendation(models: ["deepseek-flash"], effort: nil)
        case (.claude, .thread): return Recommendation(models: ["claude-sonnet-5-5", "claude-haiku-5-5"], effort: .medium)
        case (.claude, .area), (.claude, .summary): return Recommendation(models: ["claude-sonnet-5-5", "claude-haiku-5-5"], effort: .low)
        case (.claude, .translation), (.claude, .scan): return Recommendation(models: ["claude-haiku-5-5", "claude-sonnet-5-5"], effort: .medium)
        }
    }

    /// The models recommended for a job; the first is the default.
    public static func recommended(_ provider: ProviderID, _ task: AITask) -> [String] {
        recommendation(provider, task).models
    }

    public static func isRecommended(_ model: String, _ provider: ProviderID, _ task: AITask) -> Bool {
        recommended(provider, task).contains(model)
    }

    /// The recommended thinking level for a job; nil leaves the provider's own default.
    public static func recommendedEffort(_ provider: ProviderID, _ task: AITask) -> Effort? {
        recommendation(provider, task).effort
    }

    /// Whether a thinking level can be sent to this model: Gemini 3 and later, OpenAI's reasoning
    /// models, DeepSeek's models and Claude models that take `effort`.
    public static func acceptsEffort(_ provider: ProviderID, _ model: String) -> Bool {
        let pattern: String = switch provider {
        case .gemini: #"^gemini-([3-9]|\d{2,})"#
        case .openai: #"^(o\d|gpt-[5-9]|gpt-\d{2,})"#
        case .deepseek: #"^deepseek"#
        case .claude: #"^claude-((opus|sonnet|haiku|fable|mythos)-([5-9]|\d{2,})|opus-4-[5-8]|sonnet-4-6)"#
        }
        return model.range(of: pattern, options: .regularExpression) != nil
    }

    /// The reader's Gemini model first; if it answers 404 (or 400 naming the model), the next one.
    public static func geminiChain(selected: String, effort: Effort = .high) -> [ModelCandidate] {
        var chain = [ModelCandidate(selected, thinking: .forModel(selected, effort: effort))]
        for c in [
            ModelCandidate("gemini-3.8-flash", thinking: .level(effort.rawValue)),
            ModelCandidate("gemini-4-hydrogen", thinking: .level(effort.rawValue)),
            ModelCandidate("gemini-2.5-flash", thinking: .budget(8192)),
            ModelCandidate("gemini-2.5-flash", thinking: .none),
        ] where !chain.contains(c) {
            chain.append(c)
        }
        return chain
    }

    /// Sampling temperature by job: threads may range for vivid examples; translation stays close
    /// to the text.
    public static func temperature(_ task: AITask) -> Double { task.isTranslationLike ? 0.35 : 0.55 }

    /// Google strongly recommends leaving Gemini 3 at its default temperature (1.0): lower values may
    /// cause looping or weaker answers. Off until the owner decides otherwise.
    public static let sendTemperatureToGemini3 = false

    /// Whether this model takes a temperature at all. Current Claude models (5.x, Opus 4.7/4.8) reject
    /// one other than the default with a 400; older ones accept it. OpenAI's reasoning models (o-series,
    /// GPT-5 and later, GPT-6) accept only the default (1) and answer any other value with a 400.
    public static func acceptsTemperature(_ provider: ProviderID, _ model: String) -> Bool {
        switch provider {
        case .gemini: return sendTemperatureToGemini3 || !model.hasPrefix("gemini-3")
        case .claude: return model.range(of: #"^claude-(3|(opus|sonnet|haiku)-4-[0-6]\b|(opus|sonnet|haiku)-4-[0-6]-)"#, options: .regularExpression) != nil
        case .openai: return model.range(of: #"^(o\d|gpt-[5-9]|gpt-\d{2,})"#, options: .regularExpression) == nil
        case .deepseek: return true
        }
    }

    /// Room for the answer. Claude's thinking counts against `max_tokens` and cannot be turned off on
    /// its current models, so its caps are wider than the answer itself. Every provider has a cap, so a
    /// book that asks for "at least 20,000 words" cannot run an answer to the model's maximum.
    public static func maxOutputTokens(_ provider: ProviderID, _ task: AITask) -> Int {
        if provider == .claude { return task.isTranslationLike ? 16000 : 8000 }
        return 16384
    }
}

public struct ByokSettings: Codable, Equatable, Sendable {
    public var activeProvider: ProviderID
    public var geminiApiKey: String
    public var geminiModel: String
    public var openaiApiKey: String
    public var openaiModel: String
    public var deepseekApiKey: String
    public var deepseekModel: String
    public var claudeApiKey: String
    public var claudeModel: String
    /// Models for page translation (empty: the first recommended).
    public var geminiTranslationModel: String
    public var openaiTranslationModel: String
    public var deepseekTranslationModel: String
    public var claudeTranslationModel: String
    /// The reader's other choices, by "provider.job.model" or "provider.job.effort" (for example
    /// "gemini.area.model", "openai.thread.effort"); a missing or empty value means the recommended one.
    public var choices: [String: String]

    public init(
        activeProvider: ProviderID = .gemini,
        geminiApiKey: String = "", geminiModel: String = "",
        openaiApiKey: String = "", openaiModel: String = "",
        deepseekApiKey: String = "", deepseekModel: String = "",
        claudeApiKey: String = "", claudeModel: String = "",
        geminiTranslationModel: String = "", openaiTranslationModel: String = "",
        deepseekTranslationModel: String = "", claudeTranslationModel: String = "",
        choices: [String: String] = [:]
    ) {
        self.choices = choices
        self.activeProvider = activeProvider
        self.geminiApiKey = geminiApiKey
        self.geminiModel = geminiModel
        self.openaiApiKey = openaiApiKey
        self.openaiModel = openaiModel
        self.deepseekApiKey = deepseekApiKey
        self.deepseekModel = deepseekModel
        self.claudeApiKey = claudeApiKey
        self.claudeModel = claudeModel
        self.geminiTranslationModel = geminiTranslationModel
        self.openaiTranslationModel = openaiTranslationModel
        self.deepseekTranslationModel = deepseekTranslationModel
        self.claudeTranslationModel = claudeTranslationModel
    }

    /// Settings saved before DeepSeek and Claude existed still load.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func s(_ k: CodingKeys) -> String { (try? c.decodeIfPresent(String.self, forKey: k)) ?? "" }
        activeProvider = (try? c.decodeIfPresent(ProviderID.self, forKey: .activeProvider)) ?? .gemini
        geminiApiKey = s(.geminiApiKey)
        geminiModel = s(.geminiModel)
        openaiApiKey = s(.openaiApiKey)
        openaiModel = s(.openaiModel)
        deepseekApiKey = s(.deepseekApiKey)
        deepseekModel = s(.deepseekModel)
        claudeApiKey = s(.claudeApiKey)
        claudeModel = s(.claudeModel)
        geminiTranslationModel = s(.geminiTranslationModel)
        openaiTranslationModel = s(.openaiTranslationModel)
        deepseekTranslationModel = s(.deepseekTranslationModel)
        claudeTranslationModel = s(.claudeTranslationModel)
        let raw = (try? c.decodeIfPresent([String: String].self, forKey: .choices)) ?? [:]
        choices = raw.filter { Self.isChoiceKey($0.key) && $0.value.count <= 200 }
    }

    /// "provider.job.model" or "provider.job.effort".
    static func isChoiceKey(_ key: String) -> Bool {
        key.range(of: #"^(gemini|openai|deepseek|claude)\.(thread|area|translation|scan|summary)\.(model|effort)$"#, options: .regularExpression) != nil
    }

    public static func hasUsableKey(_ key: String) -> Bool {
        key.trimmingCharacters(in: .whitespacesAndNewlines).count > 10
    }

    /// The reader's chosen provider when it has a key; otherwise the first with a key (Gemini, OpenAI,
    /// DeepSeek, Claude); none without keys.
    public var resolvedProvider: ProviderID? {
        if Self.hasUsableKey(key(for: activeProvider)) { return activeProvider }
        return ProviderID.allCases.first { Self.hasUsableKey(key(for: $0)) }
    }

    public var providersWithKeys: [ProviderID] {
        ProviderID.allCases.filter { Self.hasUsableKey(key(for: $0)) }
    }

    /// The key as typed (for the settings field).
    public func chosenKey(_ provider: ProviderID) -> String {
        switch provider {
        case .gemini: geminiApiKey
        case .openai: openaiApiKey
        case .deepseek: deepseekApiKey
        case .claude: claudeApiKey
        }
    }

    public func key(for provider: ProviderID) -> String {
        let raw: String = switch provider {
        case .gemini: geminiApiKey
        case .openai: openaiApiKey
        case .deepseek: deepseekApiKey
        case .claude: claudeApiKey
        }
        return raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func chosenModel(for provider: ProviderID, task: AITask) -> String {
        switch (provider, task) {
        case (.gemini, .thread): geminiModel
        case (.openai, .thread): openaiModel
        case (.deepseek, .thread): deepseekModel
        case (.claude, .thread): claudeModel
        case (.gemini, .translation): geminiTranslationModel
        case (.openai, .translation): openaiTranslationModel
        case (.deepseek, .translation): deepseekTranslationModel
        case (.claude, .translation): claudeTranslationModel
        default: choices["\(provider.rawValue).\(task.rawValue).model"] ?? ""
        }
    }

    /// The reader's model for a job; an empty string goes back to the recommended one.
    public mutating func setModel(_ model: String, for provider: ProviderID, task: AITask) {
        switch (provider, task) {
        case (.gemini, .thread): geminiModel = model
        case (.openai, .thread): openaiModel = model
        case (.deepseek, .thread): deepseekModel = model
        case (.claude, .thread): claudeModel = model
        case (.gemini, .translation): geminiTranslationModel = model
        case (.openai, .translation): openaiTranslationModel = model
        case (.deepseek, .translation): deepseekTranslationModel = model
        case (.claude, .translation): claudeTranslationModel = model
        default:
            let key = "\(provider.rawValue).\(task.rawValue).model"
            if model.isEmpty { choices[key] = nil } else { choices[key] = model }
        }
    }

    /// The reader's thinking level for a job, or nil for the recommended one.
    public func chosenEffort(for provider: ProviderID, task: AITask) -> Effort? {
        choices["\(provider.rawValue).\(task.rawValue).effort"].flatMap(Effort.init(rawValue:))
    }

    public mutating func setEffort(_ effort: Effort?, for provider: ProviderID, task: AITask) {
        choices["\(provider.rawValue).\(task.rawValue).effort"] = effort?.rawValue
    }

    /// Every job of a provider back to its recommended model and thinking level.
    public mutating func useRecommended(for provider: ProviderID) {
        for task in AITask.allCases {
            setModel("", for: provider, task: task)
            setEffort(nil, for: provider, task: task)
        }
    }

    /// Whether a provider's jobs all use the recommended models and levels.
    public func usesRecommended(_ provider: ProviderID) -> Bool {
        AITask.allCases.allSatisfy { task in
            let chosen = chosenModel(for: provider, task: task)
            return chosenEffort(for: provider, task: task) == nil && (chosen.isEmpty || chosen == ModelAdvice.recommended(provider, task)[0])
        }
    }

    /// The thinking level a job is sent with: the reader's, else the recommended one; nil (nothing
    /// sent) when neither applies or the model does not take one.
    public func effort(for provider: ProviderID, task: AITask, model: String? = nil) -> Effort? {
        let m = model ?? self.model(for: provider, task: task)
        guard ModelAdvice.acceptsEffort(provider, m) else { return nil }
        return chosenEffort(for: provider, task: task) ?? ModelAdvice.recommendedEffort(provider, task)
    }

    public mutating func setKey(_ key: String, for provider: ProviderID) {
        switch provider {
        case .gemini: geminiApiKey = key
        case .openai: openaiApiKey = key
        case .deepseek: deepseekApiKey = key
        case .claude: claudeApiKey = key
        }
    }

    /// The model for a job: the reader's choice, or the first recommended. DeepSeek's reasoning model
    /// takes no pictures: pictures always go to deepseek-flash.
    public func model(for provider: ProviderID, task: AITask = .thread) -> String {
        let chosen = chosenModel(for: provider, task: task)
        let model = chosen.isEmpty ? ModelAdvice.recommended(provider, task)[0] : chosen
        if provider == .deepseek, task.takesPicture, model == "deepseek-v4-pro" { return "deepseek-flash" }
        return model
    }
}
