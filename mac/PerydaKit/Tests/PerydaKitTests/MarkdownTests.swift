import Foundation
import Testing
@testable import PerydaKit

/// The Mac reads Markdown exactly as the web engine does: both run shared/vectors/markdown.json.
@Suite("Markdown")
struct MarkdownTests {
    static func block(_ json: [String: Any]) -> Markdown.Block? {
        switch json["type"] as? String {
        case "p": .paragraph(json["text"] as? String ?? "")
        case "h": .heading(json["text"] as? String ?? "")
        case "quote": .quote(json["text"] as? String ?? "")
        case "ul": .bullets(json["items"] as? [String] ?? [])
        case "ol": .numbered(json["items"] as? [String] ?? [])
        case "hr": .rule
        default: nil
        }
    }

    @Test func blocksMatchTheSharedVectors() throws {
        let cases = try #require(Vectors.json("markdown.json")["blocks"] as? [[String: Any]])
        #expect(cases.count >= 9)
        for c in cases {
            let text = try #require(c["text"] as? String)
            let expected = try #require(c["blocks"] as? [[String: Any]]).map { Self.block($0) }
            #expect(Markdown.blocks(text).map { Optional($0) } == expected, "\(c["name"] ?? "")")
        }
    }

    @Test func spansMatchTheSharedVectors() throws {
        let cases = try #require(Vectors.json("markdown.json")["inline"] as? [[String: Any]])
        #expect(cases.count >= 6)
        for c in cases {
            let text = try #require(c["text"] as? String)
            let expected = try #require(c["spans"] as? [[String: Any]]).map {
                Markdown.Span(text: $0["text"] as? String ?? "", bold: $0["bold"] as? Bool ?? false, italic: $0["italic"] as? Bool ?? false, code: $0["code"] as? Bool ?? false)
            }
            #expect(Markdown.spans(text) == expected, "\(c["name"] ?? "")")
        }
    }
}
