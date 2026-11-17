import XCTest
@testable import PerydaKit

/// Owner, 17 Nov 2026: the context sent with a selection is centred on it (same cases as the web's
/// centeredContext.test.ts).
final class CenteredContextTests: XCTestCase {
    func words(_ prefix: String, _ n: Int) -> String { (0..<n).map { "\(prefix)\($0)" }.joined(separator: " ") }

    func testMiddleOfAPage() throws {
        let page = "\(words("a", 300)) SEÇİLEN CÜMLE BURADA. \(words("b", 300))"
        let c = try XCTUnwrap(CenteredContext.make(page: page, selected: "SEÇİLEN CÜMLE BURADA."))
        XCTAssertTrue(c.contains("SEÇİLEN CÜMLE BURADA."))
        XCTAssertLessThanOrEqual(c.count, 1200)
        XCTAssertGreaterThan(c.count, 1100)
        XCTAssertFalse(c.hasPrefix("a0 "))
    }

    func testNeighbourPages() throws {
        let end = try XCTUnwrap(CenteredContext.make(page: "\(words("a", 400)) SON CÜMLE.", selected: "SON CÜMLE.", after: words("n", 200)))
        XCTAssertTrue(end.contains("SON CÜMLE.") && end.contains("n0 n1"))
        let start = try XCTUnwrap(CenteredContext.make(page: "İLK CÜMLE. \(words("a", 400))", selected: "İLK CÜMLE.", before: words("p", 200)))
        XCTAssertTrue(start.contains("p199") && start.contains("İLK CÜMLE."))
    }

    func testWhitespaceFallbackAndLongSelection() {
        XCTAssertEqual(CenteredContext.make(page: "Bir\n  iki   üç dört", selected: "iki\nüç"), "Bir iki üç dört")
        XCTAssertEqual(CenteredContext.make(page: words("a", 400), selected: "yok böyle bir şey"), String(words("a", 400).prefix(1200)))
        XCTAssertNil(CenteredContext.make(page: "   ", selected: "x"))
        let long = words("s", 400)
        XCTAssertEqual(CenteredContext.make(page: "önce \(long) sonra", selected: long), long)
    }
}
