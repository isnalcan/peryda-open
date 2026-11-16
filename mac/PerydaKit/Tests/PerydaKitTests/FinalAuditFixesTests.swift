import CoreGraphics
import Foundation
import Testing
@testable import PerydaKit

/// The final audit of 16 Nov: limits and the page with no size.
@Suite("Final audit 16 Nov")
struct FinalAuditFixesTests {
    @Test func aPageWithNoSizeStillLaysOut() {
        // M16-1: an empty MediaBox divided zero by zero and crashed the reading window.
        #expect(Geometry.usablePageSize(.zero) == CGSize(width: 612, height: 792))
        #expect(Geometry.usablePageSize(CGSize(width: Double.nan, height: 100)) == CGSize(width: 612, height: 792))
        #expect(Geometry.usablePageSize(CGSize(width: 100, height: 1_000_000)).height == 2000, "a strip at most 20 times as long as wide")
        for page in Geometry.pageLayout([.zero, CGSize(width: 612, height: -1), CGSize(width: 1, height: Double.infinity)]) {
            #expect(page.height.isFinite && page.height > 0)
        }
    }

    @Test func findKeepsAtMostItsLimitAndIsQuick() {
        // M16-2: a one-letter query found everything; a long query on a long page took 47 seconds.
        let page = String(repeating: "a ", count: 200_000)
        #expect(TextFind.ranges(of: "a", in: page).count == TextFind.maxHits)
        #expect(TextFind.ranges(of: "a", in: page, limit: 3).count == 3)
        let long = String(repeating: "a", count: 1_000_000)
        let started = Date()
        _ = TextFind.ranges(of: String(repeating: "a", count: 2001) + "b", in: long)
        #expect(Date().timeIntervalSince(started) < 5, "no longer a nested loop")
    }

    @Test func aBackupKeepsAtMostItsHighlightsPerBook() {
        // M16-3: 50,000 highlights froze the restored book's window.
        let marks = [JournalMark(pageNumber: 1, lineRects: [NormalizedRect(x: 0.1, y: 0.1, width: 0.2, height: 0.02)])]
        let many = (0..<(Backup.maxHighlights + 50)).map { JournalRecord(id: "h\($0)", bookId: "b", source: .highlight, quote: "q", text: "", pageNumber: 1, marks: marks) }
        let note = JournalRecord(id: "n", bookId: "b", source: .note, quote: "", text: "kept", pageNumber: 1)
        let m = Backup.Manifest(format: Backup.format, version: Backup.version, createdAt: 0, books: [], cards: [], journal: many + [note], positions: [], prefs: [])
        let kept = Backup.sane(m).journal
        #expect(kept.filter { $0.source == .highlight }.count == Backup.maxHighlights)
        #expect(kept.contains { $0.id == "n" }, "other entries are not counted against highlights")
    }
}
