import Foundation
import Testing
@testable import PerydaKit

/// Owner test 15 Nov: highlights ("Vurgula") in the journal, in the web's shape, checked on restore.
@Suite("Highlights in the journal")
struct OwnerFeedbackTests {
    let rect = NormalizedRect(x: 0.1, y: 0.2, width: 0.5, height: 0.02)

    @Test func aHighlightKeepsItsMarksInTheWebsShape() throws {
        let record = JournalRecord(id: "h1", bookId: "b1", source: .highlight, quote: "Kavramlar", text: "", pageNumber: 3, createdAt: 1, marks: [JournalMark(pageNumber: 3, lineRects: [rect])])
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any])
        #expect(json["source"] as? String == "highlight")
        let marks = try #require(json["marks"] as? [[String: Any]])
        #expect(marks.first?["pageNumber"] as? Int == 3)
        let rects = try #require(marks.first?["lineRects"] as? [[String: Any]])
        #expect(rects.first?["width"] as? Double == 0.5)
        // A record written by the web, and one from before highlights, both decode.
        let web = #"{"id":"h2","bookId":"b1","source":"highlight","quote":"q","text":"","pageNumber":1,"createdAt":2,"marks":[{"pageNumber":1,"lineRects":[{"x":0.1,"y":0.1,"width":0.3,"height":0.02}]}]}"#
        let decoded = try JSONDecoder().decode(JournalRecord.self, from: Data(web.utf8))
        #expect(decoded.marks?.first?.lineRects.count == 1)
        let old = #"{"id":"c1","bookId":"b1","source":"clip","quote":"q","text":"","pageNumber":1,"createdAt":2}"#
        #expect(try JSONDecoder().decode(JournalRecord.self, from: Data(old.utf8)).marks == nil)
    }

    @Test func restoreKeepsOnlySensibleMarks() {
        let bad = [
            JournalMark(pageNumber: 0, lineRects: [rect]),
            JournalMark(pageNumber: 99, lineRects: [rect]),
            JournalMark(pageNumber: 2, lineRects: [NormalizedRect(x: .nan, y: 0, width: 0.1, height: 0.1), NormalizedRect(x: 0.9, y: 0.5, width: 0.5, height: 0.1), NormalizedRect(x: 0.1, y: 0.1, width: 0, height: 0.1)]),
        ]
        let good = JournalMark(pageNumber: 2, lineRects: Array(repeating: rect, count: 300))
        let record = JournalRecord(bookId: "b1", source: .highlight, quote: "q", text: "", pageNumber: 2, marks: bad + [good] + Array(repeating: good, count: 60))
        let restored = Backup.clamped(record, pageCount: 10)
        #expect(restored.marks?.count == 47, "the first 50 marks are looked at; the 3 bad ones go")
        #expect(restored.marks?.allSatisfy { $0.pageNumber == 2 && $0.lineRects.count == 200 } == true)
        // Marks travel only with highlights.
        let clip = JournalRecord(bookId: "b1", source: .clip, quote: "q", text: "", pageNumber: 2, marks: [good])
        #expect(Backup.clamped(clip, pageCount: 10).marks == nil)
    }
}
