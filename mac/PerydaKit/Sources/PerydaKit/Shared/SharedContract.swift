import Foundation

/// The shared design and prompt contract (shared/*.json), bundled as resources.
public enum SharedContract {
    static func load<T: Decodable>(_ name: String, as type: T.Type) -> T {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "shared"),
              let data = try? Data(contentsOf: url),
              let value = try? JSONDecoder().decode(T.self, from: data)
        else { fatalError("Missing or invalid shared resource \(name).json") }
        return value
    }

    public static let tokens: Tokens = load("tokens", as: Tokens.self)
    public static let kinds: YarnKinds = load("yarn-kinds", as: YarnKinds.self)
    public static let prompts: Prompts = load("prompts", as: Prompts.self)
    public static let ui: [String: Localized] = load("ui-strings", as: [String: Localized].self)
    public static let privacy: [String: PrivacyText] = load("privacy", as: [String: PrivacyText].self)
}

/// The privacy text for Mac, Windows and the web (shared/privacy.json): the same words as the web
/// settings and the repository's PRIVACY.md files.
public struct PrivacyText: Decodable, Sendable {
    public struct Block: Decodable, Sendable {
        /// A paragraph, or (when nil) a list.
        public let p: String?
        public let ul: [String]?
    }

    public struct Section: Decodable, Sendable {
        public let heading: String
        public let blocks: [Block]
    }

    public let title: String
    public let updated: String
    public let sections: [Section]

    public static func of(_ lang: Lang) -> PrivacyText {
        SharedContract.privacy[lang.rawValue] ?? SharedContract.privacy["en"]!
    }
}

/// Interface text shared with the web engine (shared/ui-strings.json).
public struct UIText: Sendable {
    public var lang: Lang

    public init(_ lang: Lang) {
        self.lang = lang
    }

    public subscript(_ key: String) -> String {
        SharedContract.ui[key]?.text(lang) ?? key
    }

    /// Fills {n}, {p} … placeholders.
    public func callAsFunction(_ key: String, _ values: [String: CustomStringConvertible] = [:]) -> String {
        var text = self[key]
        for (k, v) in values { text = text.replacingOccurrences(of: "{\(k)}", with: v.description) }
        return text
    }
}

public typealias Localized = [String: String]

public struct Tokens: Decodable, Sendable {
    public struct Palette: Decodable, Sendable {
        public let paper, paperRaised, paperSunken, ink, inkSoft, inkFaint, accent, accentStrong: String
        public let accentTint, line, lineStrong, errorText: String
    }

    public struct YarnTone: Decodable, Sendable {
        public let light: String
        public let dark: String
        public let highlightAlpha: Double
    }

    public struct GeometryTokens: Decodable, Sendable {
        public let pageWorldWidth, pageGap, laneOffset, laneTop, laneGap, anchorLift, cardWidth, cardAttachY: Double
        public let subLaneGap, bezierMinSpan, bezierSpanRatio: Double
        /// The smallest and largest page size, as a multiple of pageWorldWidth (resizing the pages).
        public let pageScaleMin, pageScaleMax: Double
        public let areaMinWidth, areaMinHeight, areaCropScale, textlessPageCharacterThreshold: Double
        public let cardRadius, previewImageMaxHeight, recallBlur: Double
    }

    public struct YarnStroke: Decodable, Sendable {
        public let haloWidth, haloOpacity, mainWidth, mainOpacity, startKnotRadius, endKnotRadius: Double
    }

    /// The reader's own highlights ("Vurgula"): a yellow highlighter, multiplied into the page.
    public struct Highlighter: Decodable, Sendable {
        public let color: String
        public let alpha: Double
    }

    public let palette: [String: Palette]
    public let yarn: [String: YarnTone]
    public let geometry: GeometryTokens
    public let yarnStroke: YarnStroke
    public let highlighter: Highlighter

    public func tone(_ color: YarnColor) -> YarnTone { yarn[color.rawValue]! }
}

public struct YarnKinds: Decodable, Sendable {
    public struct Kind: Decodable, Sendable {
        public let runsAI: Bool
        public let label: Localized
        public let cardTitle: Localized
        public let prompt: Localized
    }

    public struct Custom: Decodable, Sendable {
        public let color: String
        public let cardTitle: Localized
    }

    public struct Bridge: Decodable, Sendable {
        public let cardTitle: Localized
        public let prompt: Localized
    }

    public struct Translate: Decodable, Sendable {
        public let color: String
        public let cardTitle: Localized
        public let label: Localized
        public let prompt: Localized
    }

    public let order: [String]
    public let kinds: [String: Kind]
    public let custom: Custom
    public let bridge: Bridge
    public let translate: Translate

    public func kind(_ color: YarnColor) -> Kind { kinds[color.rawValue]! }

    /// The colour translations are drawn in.
    public var translateColor: YarnColor { YarnColor(rawValue: translate.color) ?? .sky }
}

public struct Prompts: Decodable, Sendable {
    public let system: Localized
    public let passageHeader: Localized
    public let areaHeader: Localized
    public let pageLabel: Localized
    public let chapterLabel: Localized
    public let journalSummary: Localized
    public let pageTranslateSystem: Localized
    public let pageTranslate: Localized
    public let pageTranslateScanned: Localized
    /// The same three without the rule that explains hard terms in brackets.
    public let pageTranslateSystemNoTerms: Localized
    public let pageTranslateNoTerms: Localized
    public let pageTranslateScannedNoTerms: Localized
    public let contextTemplate: Localized
    public let areaSelection: Localized
    /// Reading a page's picture into text ("Read with Pery" in "Extract page text").
    public let pageTranscribeSystem: Localized
    public let pageTranscribe: Localized
}

public enum Lang: String, CaseIterable, Sendable {
    case tr, en, de, es

    public static func preferred(_ languages: [String] = Locale.preferredLanguages) -> Lang {
        for tag in languages {
            if let lang = Lang(rawValue: String(tag.prefix(2)).lowercased()) { return lang }
        }
        return .en
    }

    public var languageName: String {
        switch self {
        case .tr: "Türkçe"
        case .en: "English"
        case .de: "Deutsch"
        case .es: "español"
        }
    }
}

extension Localized {
    public func text(_ lang: Lang) -> String { self[lang.rawValue] ?? self["en"] ?? "" }
}
