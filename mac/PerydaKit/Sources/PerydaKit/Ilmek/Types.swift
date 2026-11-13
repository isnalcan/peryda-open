import Foundation

/// The six İlmek kinds. The raw values match the web engine and shared/yarn-kinds.json.
public enum YarnColor: String, Codable, CaseIterable, Sendable {
    case coral, mint, sky, amber, lavender, cream
}

/// The action that opened a card: a quick kind, a free question, a bridge, or a translation.
public enum YarnKind: Codable, Hashable, Sendable {
    case quick(YarnColor)
    case question
    case bridge
    case translate

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        switch raw {
        case "question": self = .question
        case "bridge": self = .bridge
        case "translate": self = .translate
        default:
            guard let color = YarnColor(rawValue: raw) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "unknown kind \(raw)"))
            }
            self = .quick(color)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    public var rawValue: String {
        switch self {
        case .quick(let color): color.rawValue
        case .question: "question"
        case .bridge: "bridge"
        case .translate: "translate"
        }
    }

    public var runsAI: Bool {
        if case .quick(.cream) = self { return false }
        return true
    }
}

/// A rectangle on a page, 0...1, with the origin at the page's top-left corner.
public struct NormalizedRect: Codable, Hashable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public static let zero = NormalizedRect(x: 0, y: 0, width: 0, height: 0)
}

public enum AnchorSource: String, Codable, Sendable {
    case pdfText = "pdf_text"
    case pdfArea = "pdf_area"
    case card
    case epubText = "epub_text"
}

/// Where a thread starts. The field names match the web engine so backups move between the two.
public struct YarnAnchor: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var sourceType: AnchorSource
    public var bookId: String
    /// 1-based page (or chapter for EPUB).
    public var pageNumber: Int
    public var selectedText: String
    public var lineRects: [NormalizedRect]
    public var boundingRect: NormalizedRect
    /// PNG data URL of an area selection, rendered at 2x.
    public var croppedImage: String?
    public var sourceCardId: String?
    public var cfi: String?
    /// What surrounds the selection, sent with it: the start of the page's (or chapter's) text, or the
    /// parent card's answer for a thread opened inside a card.
    public var context: String?

    public init(
        id: String = UUID().uuidString.lowercased(),
        sourceType: AnchorSource,
        bookId: String,
        pageNumber: Int,
        selectedText: String,
        lineRects: [NormalizedRect],
        boundingRect: NormalizedRect,
        croppedImage: String? = nil,
        sourceCardId: String? = nil,
        cfi: String? = nil,
        context: String? = nil
    ) {
        self.id = id
        self.sourceType = sourceType
        self.bookId = bookId
        self.pageNumber = pageNumber
        self.selectedText = selectedText
        self.lineRects = lineRects
        self.boundingRect = boundingRect
        self.croppedImage = croppedImage
        self.sourceCardId = sourceCardId
        self.cfi = cfi
        self.context = context
    }

    /// How much surrounding text goes with a selection.
    public static let contextLength = 1200
}

public struct YarnMessage: Codable, Hashable, Identifiable, Sendable {
    public enum Role: String, Codable, Sendable { case user, assistant }
    public enum State: String, Codable, Sendable { case streaming, error }

    public var id: String
    public var role: Role
    public var content: String
    /// Milliseconds since 1970, like the web engine.
    public var createdAt: Double
    public var state: State?
    public var provider: ProviderID?
    public var model: String?

    public init(id: String = UUID().uuidString.lowercased(), role: Role, content: String, createdAt: Double = Date().timeIntervalSince1970 * 1000, state: State? = nil, provider: ProviderID? = nil, model: String? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.createdAt = createdAt
        self.state = state
        self.provider = provider
        self.model = model
    }
}

public struct ArchiveLink: Codable, Hashable, Sendable {
    public var bookId: String
    public var bookTitle: String
    public var sourceId: String
    public var snippet: String

    public init(bookId: String, bookTitle: String, sourceId: String, snippet: String) {
        self.bookId = bookId
        self.bookTitle = bookTitle
        self.sourceId = sourceId
        self.snippet = snippet
    }
}

public struct YarnCard: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var bookId: String
    public var color: YarnColor
    public var kind: YarnKind
    public var anchors: [YarnAnchor]
    public var parentCardId: String?
    public var x: Double
    public var y: Double
    public var width: Double
    /// A height the reader set by resizing the card; nil means the card is as tall as its content.
    public var height: Double?
    /// A whole-page translation: the page it translates, shown beside that page instead of in a lane.
    public var translatedPage: Int?
    /// The language of a page translation (a `Lang` code).
    public var translationLanguage: String?
    /// The Gemini batch job a page translation is waiting on.
    public var batchJob: String?
    public var isPinned: Bool
    public var collapsed: Bool
    public var messages: [YarnMessage]
    /// From the retired archive-link feature: still read so older backups (and the web's) load.
    public var archiveLinks: [ArchiveLink]?
    public var archiveDismissed: Bool?
    public var createdAt: Double
    public var updatedAt: Double

    public init(
        id: String = UUID().uuidString.lowercased(),
        bookId: String,
        color: YarnColor,
        kind: YarnKind,
        anchors: [YarnAnchor],
        parentCardId: String? = nil,
        width: Double = Geometry.cardWidth,
        messages: [YarnMessage] = [],
        now: Double = Date().timeIntervalSince1970 * 1000
    ) {
        self.id = id
        self.bookId = bookId
        self.color = color
        self.kind = kind
        self.anchors = anchors
        self.parentCardId = parentCardId
        self.x = 0
        self.y = 0
        self.width = width
        self.height = nil
        self.translatedPage = nil
        self.translationLanguage = nil
        self.batchJob = nil
        self.isPinned = false
        self.collapsed = false
        self.messages = messages
        self.archiveLinks = nil
        self.archiveDismissed = nil
        self.createdAt = now
        self.updatedAt = now
    }
}

/// A page's place in the stacked world (points in world units).
public struct PageBox: Hashable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
}
