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

/// Hostile text (from a backup or an answer) must not make reading slow (audit WW-1, 15 Nov).
@Suite("Markdown takes linear time")
struct MarkdownTimingTests {
    func seconds(_ work: () -> Void) -> Double {
        let start = Date()
        work()
        return Date().timeIntervalSince(start)
    }

    @Test func pathologicalInputsStayFast() {
        let n = 190_000
        let inputs = [
            String(repeating: "![a](", count: n / 5),
            String(repeating: "[a", count: n / 2),
            "# a" + String(repeating: " ", count: n) + "b",
            String(repeating: "a" + String(repeating: " ", count: 1000) + "b\n", count: n / 1003),
        ]
        for text in inputs {
            let t = seconds { _ = Markdown.blocks(text); _ = Markdown.spans(text) }
            #expect(t < 2, "\(t) s for \(text.prefix(12))…")
        }
        // Past the limit: plain text, no marks looked for.
        let huge = String(repeating: "**a** ", count: 50_000)
        #expect(Markdown.spans(huge) == [Markdown.Span(text: huge)])
        #expect(Markdown.blocks("## Başlık ##") == [.heading("Başlık")])
        #expect(Markdown.blocks("# C#") == [.heading("C#")])
    }
}
