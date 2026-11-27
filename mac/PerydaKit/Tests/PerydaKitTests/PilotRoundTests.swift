import XCTest
@testable import PerydaKit

/// The 0.1.3 reader round (web pilot), brought to the Mac: right and left margin lanes.
final class PilotRoundTests: XCTestCase {
    let page = 760.0
    var lane: Double { page + 75 }
    var newer: Double { Lane.leftLaneSince + 1000 }

    func card(_ id: String, _ anchorY: Double, _ createdAt: Double?, collapsed: Bool = false, height: Double = 300) -> Lane.Input {
        Lane.Input(id: id, collapsed: collapsed, width: 390, anchorY: anchorY, height: height, page: 1, createdAt: createdAt)
    }

    func sides(_ cards: [Lane.Input]) -> [String: String] {
        Lane.layout(cards, laneX: lane, pageWidth: page).mapValues { $0.x < 0 ? "left" : "right" }
    }

    func testLeftLaneDateMatchesWeb() {
        // Date.UTC(2026, 10, 27) in web/src/ilmek/lane.ts
        XCTAssertEqual(Lane.leftLaneSince, Date(timeIntervalSince1970: 1_795_737_600).timeIntervalSince1970 * 1000)
        var c = DateComponents()
        c.year = 2026; c.month = 11; c.day = 27; c.timeZone = TimeZone(identifier: "UTC")
        XCTAssertEqual(Calendar(identifier: .gregorian).date(from: c)!.timeIntervalSince1970 * 1000, Lane.leftLaneSince)
    }

    func testCrowdedRightOpensLeft() {
        XCTAssertEqual(sides([card("a", 250, newer), card("b", 280, newer + 1)]), ["a": "right", "b": "left"])
    }

    func testThreadsFromBeforeTheUpdateStayRight() {
        let old = Lane.leftLaneSince - 10_000
        XCTAssertEqual(sides([card("a", 250, old), card("b", 280, old + 1), card("c", 300, old + 2)]), ["a": "right", "b": "right", "c": "right"])
    }

    func testWithoutPageWidthEverythingStaysRight() {
        let placed = Lane.layout([card("a", 250, newer), card("b", 280, newer + 1)], laneX: lane)
        XCTAssertTrue(placed.values.allSatisfy { $0.x == lane })
    }

    func testHugeCountStaysFastAndRight() {
        let many = (0..<5000).map { card("m\($0)", 100 + Double($0 % 50), newer + Double($0)) }
        let started = Date()
        let placed = Lane.layout(many, laneX: lane, pageWidth: page)
        XCTAssertLessThan(Date().timeIntervalSince(started), 4)
        XCTAssertTrue(placed.values.allSatisfy { $0.x == lane })
        XCTAssertLessThan(Lane.maxBalancedRoots, 5000)
    }

    func testFoldOrGrowthNeverFlipsSides() {
        let cards = [card("a", 250, newer), card("b", 280, newer + 1), card("c", 310, newer + 2), card("d", 340, newer + 3)]
        var before = sides(cards)
        let folded = sides(cards.map { $0.id == "a" ? card("a", 250, newer, collapsed: true) : $0 })
        before["a"] = nil
        XCTAssertEqual(folded, before)
        let grown = sides(cards.map { $0.id == "b" ? card("b", 280, newer + 1, height: 1400) : $0 })
        var expected = before
        expected["a"] = "right"
        XCTAssertEqual(grown, expected)
    }

    func testIncrementalLaneMatchesAFreshSolve() {
        var rng = SystemRandomNumberGenerator()
        for _ in 0..<200 {
            var lane = Lane.ProbeLane()
            var items: [LaneItem] = []
            for i in 0..<Int.random(in: 1...40, using: &rng) {
                let y = Double(Int.random(in: 0...20, using: &rng) * 50)
                let h = Double(Int.random(in: 1...6, using: &rng) * 60)
                XCTAssertEqual(lane.displacement(adding: y, height: h), Lane.displacement(items + [LaneItem(id: "p\(i)", desiredY: y, height: h)]), accuracy: 1e-9)
                lane.add(y, height: h, page: nil)
                items.append(LaneItem(id: "p\(i)", desiredY: y, height: h))
                XCTAssertEqual(lane.displacement, Lane.displacement(items), accuracy: 1e-9)
            }
        }
    }

    func testLeftChildFlowsFurtherLeft() {
        let parent = card("p", 250, newer)
        let crowd = card("q", 280, newer + 1)
        let child = Lane.Input(id: "c", parentCardId: "q", width: 390, anchorY: 300, height: 200, page: 1, createdAt: 4)
        let placed = Lane.layout([parent, crowd, child], laneX: lane, pageWidth: page)
        XCTAssertEqual(placed["p"].map { Double($0.x) }, lane)
        XCTAssertEqual(placed["q"]?.x, -75 - 390)
        XCTAssertEqual(placed["c"]?.x, -75 - 390 - 390 - 68)
    }
}
