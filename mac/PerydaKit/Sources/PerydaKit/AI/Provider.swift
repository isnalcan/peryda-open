import Foundation

/// The four providers a reader can bring a key for. Gemini first: prompts, thinking settings and page
/// translation batches are tuned for it.
public enum ProviderID: String, Codable, CaseIterable, Sendable {
    case gemini, openai, deepseek, claude

    /// The model used when the reader has not picked one (the first recommended for threads).
    public var defaultModel: String { ModelAdvice.recommended(self, .thread)[0] }
}

/// What a request is for. Threads and page translations have their own recommended models and settings.
public enum AITask: String, Codable, Sendable {
    case thread, translation
}

/// How a Gemini model is asked to think.
public enum GeminiThinking: Equatable, Sendable {
    case level(String)
    case budget(Int)
    case none

    /// Gemini 3 models take a thinking level, Gemini 2.5 a token budget; others nothing.
    public static func forModel(_ model: String) -> GeminiThinking {
        if model.hasPrefix("gemini-3") { return .level("high") }
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

/// The models the prompts and settings were tuned for, per provider and task. The reader may choose
/// any model; these are marked "Recommended" and listed first.
public enum ModelAdvice {
    public static func recommended(_ provider: ProviderID, _ task: AITask) -> [String] {
        switch (provider, task) {
        case (.gemini, _): ["gemini-3.8-flash", "gemini-3-flash-preview", "gemini-2.5-flash"]
        case (.openai, .thread): ["gpt-6.1-sol", "gpt-6.1-terra"]
        case (.openai, .translation): ["gpt-6.1-terra", "gpt-6-luna"]
        case (.deepseek, .thread): ["deepseek-v4-pro", "deepseek-flash"]
        case (.deepseek, .translation): ["deepseek-flash"]
        case (.claude, .thread): ["claude-sonnet-5-5", "claude-haiku-5-5"]
        case (.claude, .translation): ["claude-haiku-5-5", "claude-sonnet-5-5"]
        }
    }

    public static func isRecommended(_ model: String, _ provider: ProviderID, _ task: AITask) -> Bool {
        recommended(provider, task).contains(model)
    }

    /// The reader's Gemini model first; if it answers 404 (or 400 naming the model), the next one.
    public static func geminiChain(selected: String) -> [ModelCandidate] {
        var chain = [ModelCandidate(selected, thinking: .forModel(selected))]
        for c in [
            ModelCandidate("gemini-3.8-flash", thinking: .level("high")),
            ModelCandidate("gemini-3-flash-preview", thinking: .level("high")),
            ModelCandidate("gemini-2.5-flash", thinking: .budget(8192)),
            ModelCandidate("gemini-2.5-flash", thinking: .none),
        ] where !chain.contains(c) {
            chain.append(c)
        }
        return chain
    }

    /// Sampling temperature by task: threads may range for vivid examples; translation stays close
    /// to the text.
    public static func temperature(_ task: AITask) -> Double { task == .thread ? 0.55 : 0.35 }

    /// Google strongly recommends leaving Gemini 3 at its default temperature (1.0): lower values may
    /// cause looping or weaker answers. Off until the owner decides otherwise.
    public static let sendTemperatureToGemini3 = false

    /// Whether this model takes a temperature at all. Current Claude models (5.x, Opus 4.7/4.8) reject
    /// one other than the default with a 400; older ones accept it.
    public static func acceptsTemperature(_ provider: ProviderID, _ model: String) -> Bool {
        switch provider {
        case .gemini: return sendTemperatureToGemini3 || !model.hasPrefix("gemini-3")
        case .claude: return model.range(of: #"^claude-(3|(opus|sonnet|haiku)-4-[0-6]\b|(opus|sonnet|haiku)-4-[0-6]-)"#, options: .regularExpression) != nil
        case .openai, .deepseek: return true
        }
    }

    /// Room for the answer. Claude's thinking counts against `max_tokens` and cannot be turned off on
    /// its current models, so its caps are wider than the answer itself. Every provider has a cap, so a
    /// book that asks for "at least 20,000 words" cannot run an answer to the model's maximum.
    public static func maxOutputTokens(_ provider: ProviderID, _ task: AITask) -> Int {
        switch (provider, task) {
        case (.claude, .thread): 8000
        case (.claude, .translation): 16000
        case (_, .thread): 16384
        case (_, .translation): 16384
        }
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

    public init(
        activeProvider: ProviderID = .gemini,
        geminiApiKey: String = "", geminiModel: String = "",
        openaiApiKey: String = "", openaiModel: String = "",
        deepseekApiKey: String = "", deepseekModel: String = "",
        claudeApiKey: String = "", claudeModel: String = "",
        geminiTranslationModel: String = "", openaiTranslationModel: String = "",
        deepseekTranslationModel: String = "", claudeTranslationModel: String = ""
    ) {
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
        }
    }

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
        }
    }

    public mutating func setKey(_ key: String, for provider: ProviderID) {
        switch provider {
        case .gemini: geminiApiKey = key
        case .openai: openaiApiKey = key
        case .deepseek: deepseekApiKey = key
        case .claude: claudeApiKey = key
        }
    }

    /// The model for a task: the reader's choice, or the first recommended.
    public func model(for provider: ProviderID, task: AITask = .thread) -> String {
        let chosen = chosenModel(for: provider, task: task)
        return chosen.isEmpty ? ModelAdvice.recommended(provider, task)[0] : chosen
    }
}
