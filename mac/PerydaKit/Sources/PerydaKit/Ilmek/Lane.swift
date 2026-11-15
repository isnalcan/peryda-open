import CoreGraphics
import Foundation

public struct LaneItem: Sendable {
    public var id: String
    public var desiredY: Double
    public var height: Double

    public init(id: String, desiredY: Double, height: Double) {
        self.id = id
        self.desiredY = desiredY
        self.height = height
    }
}

/// The magnetic lane and card layout. Matches web/src/ilmek/lane.ts.
public enum Lane {
    /// Cards sit level with their sentence but never overlap; equal desiredY keeps input order.
    public static func solve(_ items: [LaneItem]) -> [String: Double] {
        let g = SharedContract.tokens.geometry
        let order = items.enumerated().sorted { a, b in
            a.element.desiredY != b.element.desiredY ? a.element.desiredY < b.element.desiredY : a.offset < b.offset
        }
        var placed: [String: Double] = [:]
        var cursorBottom = g.laneTop
        for (_, item) in order {
            let y = max(item.desiredY, cursorBottom)
            placed[item.id] = y
            cursorBottom = y + item.height + g.laneGap
        }
        return placed
    }

    public struct Input: Sendable {
        public var id: String
        public var parentCardId: String?
        public var isPinned: Bool
        public var collapsed: Bool
        public var x: Double
        public var y: Double
        public var width: Double
        public var anchorY: Double
        public var height: Double

        public init(id: String, parentCardId: String? = nil, isPinned: Bool = false, collapsed: Bool = false, x: Double = 0, y: Double = 0, width: Double = Geometry.cardWidth, anchorY: Double, height: Double) {
            self.id = id
            self.parentCardId = parentCardId
            self.isPinned = isPinned
            self.collapsed = collapsed
            self.x = x
            self.y = y
            self.width = width
            self.anchorY = anchorY
            self.height = height
        }
    }

    /// Pinned cards stay put; first-generation cards share the lane right of the pages; a card opened
    /// from another card goes to a lane right of its parent. Folded cards are not placed.
    public static func layout(_ cards: [Input], laneX: Double = Geometry.laneX) -> [String: CGPoint] {
        let g = SharedContract.tokens.geometry
        let byId = Dictionary(cards.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        func depth(_ card: Input) -> Int {
            var d = 0
            var current = card
            var seen: Set<String> = []
            while let parent = current.parentCardId, let next = byId[parent], !seen.contains(current.id) {
                seen.insert(current.id)
                current = next
                d += 1
            }
            return d
        }
        var result: [String: CGPoint] = [:]
        let visible = cards.filter { !$0.collapsed }
        for c in visible where c.isPinned { result[c.id] = CGPoint(x: c.x, y: c.y) }
        let maxDepth = visible.map(depth).max() ?? 0
        guard maxDepth >= 0 else { return result }
        for d in 0...maxDepth {
            var lanes: [Double: [Input]] = [:]
            for c in visible where !c.isPinned && depth(c) == d {
                var x = laneX
                if d > 0, let parentId = c.parentCardId, let parent = byId[parentId], let p = result[parentId] {
                    x = Geometry.subLaneX(parentX: p.x, parentWidth: parent.width)
                }
                lanes[x, default: []].append(c)
            }
            for (x, list) in lanes {
                let solved = solve(list.map { LaneItem(id: $0.id, desiredY: $0.anchorY - g.anchorLift, height: $0.height) })
                for c in list { result[c.id] = CGPoint(x: x, y: solved[c.id] ?? c.anchorY) }
            }
        }
        return result
    }
}
