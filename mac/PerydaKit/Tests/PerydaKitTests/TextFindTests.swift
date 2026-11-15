import Foundation
import Testing
@testable import PerydaKit

/// Find in the document (owner, 16 Nov): Turkish-aware, accent-blind, line breaks as spaces.
@Suite("Find in the document")
struct TextFindTests {
    func found(_ query: String, _ text: String) -> [String] {
        TextFind.ranges(of: query, in: text).map { (text as NSString).substring(with: $0) }
    }

    @Test func caseAndTurkishLettersAreOne() {
        #expect(found("ilk", "İlk adım, ILK, ılk ve ilke") == ["İlk", "ILK", "ılk", "ilk"])
        #expect(found("ISIK", "ışık") == ["ışık"])
        #expect(found("gelisim", "Gelişim psikolojisi") == ["Gelişim"])
        #expect(found("özet", "OZET ve Özet") == ["OZET", "Özet"])
        #expect(found("café", "Cafe, CAFÉ") == ["Cafe", "CAFÉ"])
    }

    @Test func aPhraseBrokenOverLinesIsFound() {
        #expect(found("bilişsel  gelişim", "bilişsel\ngelişim ve bilişsel \n gelişim") == ["bilişsel\ngelişim", "bilişsel \n gelişim"])
    }

    @Test func matchesDoNotOverlapAndEmptyFindsNothing() {
        #expect(found("aa", "aaaa").count == 2)
        #expect(found("  ", "a b").isEmpty)
        #expect(found("", "metin").isEmpty)
        #expect(found("yok", "metin").isEmpty)
    }

    @Test func rangesCountAsPDFKitDoes() {
        // An emoji takes two UTF-16 units: the range after it must still point at the word.
        let text = "😀 kavram"
        let r = TextFind.ranges(of: "kavram", in: text)
        #expect(r == [NSRange(location: 3, length: 6)])
    }
}
