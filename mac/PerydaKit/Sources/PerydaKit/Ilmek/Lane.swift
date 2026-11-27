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
        /// Home page number (1-based), used to balance the right and left margin lanes.
        public var page: Int?
        /// When the thread was created (ms). Threads from before the left lane existed stay right.
        public var createdAt: Double?

        public init(id: String, parentCardId: String? = nil, isPinned: Bool = false, collapsed: Bool = false, x: Double = 0, y: Double = 0, width: Double = Geometry.cardWidth, anchorY: Double, height: Double, page: Int? = nil, createdAt: Double? = nil) {
            self.id = id
            self.parentCardId = parentCardId
            self.isPinned = isPinned
            self.collapsed = collapsed
            self.x = x
            self.y = y
            self.width = width
            self.anchorY = anchorY
            self.height = height
            self.page = page
            self.createdAt = createdAt
        }
    }

    /// The left margin lane arrived on 27 Nov 2026. Threads created before it keep their place on the
    /// right, so opening an older book after updating never rearranges what the reader left.
    public static let leftLaneSince: Double = 1_795_737_600_000 // Date.UTC(2026, 10, 27)
    /// Above this many free first-generation threads in one layout, all of them stay in the right lane.
    public static let maxBalancedRoots = 400
    static let probeCardHeight: Double = 260

    /// One side's probes, kept in the order `solve` places them (by desiredY, then arrival), with how far
    /// the lane pushes them down in all. Adding a probe is one pass, not a fresh solve (the Mac lays out
    /// on every frame of a zoom; a fresh solve per thread made 50 threads on a page twelve times slower).
    struct ProbeLane {
        private(set) var items: [(desiredY: Double, height: Double, page: Int?)] = []
        private(set) var displacement = 0.0

        /// Where a new probe goes: after every probe with the same or a smaller desiredY.
        private func slot(_ desiredY: Double) -> Int {
            var lo = 0, hi = items.count
            while lo < hi {
                let mid = (lo + hi) / 2
                if items[mid].desiredY <= desiredY { lo = mid + 1 } else { hi = mid }
            }
            return lo
        }

        /// The lane's displacement with the probe added.
        func displacement(adding desiredY: Double, height: Double) -> Double {
            let gap = SharedContract.tokens.geometry.laneGap
            let at = slot(desiredY)
            var cursor = SharedContract.tokens.geometry.laneTop
            var sum = 0.0
            for i in 0...items.count {
                let item = i == at ? (desiredY: desiredY, height: height, page: Int?.none) : items[i < at ? i : i - 1]
                let y = max(item.desiredY, cursor)
                sum += y - item.desiredY
                cursor = y + item.height + gap
            }
            return sum
        }

        mutating func add(_ desiredY: Double, height: Double, page: Int?) {
            displacement = displacement(adding: desiredY, height: height)
            items.insert((desiredY, height, page), at: slot(desiredY))
        }

        func count(onPage page: Int?) -> Int {
            guard let page else { return items.count }
            return items.reduce(0) { $0 + ($1.page == page ? 1 : 0) }
        }
    }

    static func displacement(_ items: [LaneItem]) -> Double {
        guard !items.isEmpty else { return 0 }
        let placed = solve(items)
        return items.reduce(0) { $0 + max(0, (placed[$1.id] ?? $1.desiredY) - $1.desiredY) }
    }

    static func pinnedOverlap(_ boxes: [(top: Double, bottom: Double, page: Int?)], desiredY: Double, height: Double) -> Double {
        let gap = SharedContract.tokens.geometry.laneGap
        var overlap = 0.0
        for b in boxes {
            let ov = min(desiredY + height, b.bottom + gap) - max(desiredY, b.top - gap)
            if ov > 0 { overlap += ov }
        }
        return overlap
    }

    /// Pinned cards stay put. Unpinned first-generation cards use the lane right of the pages first and
    /// overflow to the symmetric lane left of the pages when the right margin beside that page is
    /// crowded (needs `pageWidth`); a card opened from another card flows outward (right of a right-side
    /// parent, left of a left-side parent). Folded cards are not placed. Matches web/src/ilmek/lane.ts.
    public static func layout(_ cards: [Input], laneX: Double = Geometry.laneX, pageWidth: Double? = nil) -> [String: CGPoint] {
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
        var depthOf: [String: Int] = [:]
        for c in cards where depthOf[c.id] == nil { depthOf[c.id] = depth(c) }
        func depth(of c: Input) -> Int { depthOf[c.id] ?? 0 }
        var result: [String: CGPoint] = [:]
        let visible = cards.filter { !$0.collapsed }
        for c in visible where c.isPinned { result[c.id] = CGPoint(x: c.x, y: c.y) }

        // Every card (folded ones too) counts with the same probe height, so a card never changes
        // sides because its answer grows or because an earlier thread was folded or unfolded.
        var rootSide: [String: Bool] = [:] // true = left
        if let pageWidth {
            let pageMid = pageWidth / 2
            var rightPinned: [(top: Double, bottom: Double, page: Int?)] = []
            var leftPinned: [(top: Double, bottom: Double, page: Int?)] = []
            for c in cards where c.isPinned && depth(of: c) == 0 {
                // Whole-page translations sit far right with the page's own width.
                if abs(c.width - pageWidth) < 1 && c.x >= pageWidth { continue }
                let center = c.x + c.width / 2
                if center >= pageMid && c.x < laneX + g.cardWidth * 0.85 {
                    rightPinned.append((c.y, c.y + c.height, c.page))
                } else if center < pageMid && c.x + c.width > -g.laneOffset - g.cardWidth * 0.85 {
                    leftPinned.append((c.y, c.y + c.height, c.page))
                }
            }
            var right = ProbeLane()
            var left = ProbeLane()
            let balance = cards.filter { !$0.isPinned && depth(of: $0) == 0 }.count <= maxBalancedRoots
            for c in cards where !c.isPinned && depth(of: c) == 0 {
                let desiredY = c.anchorY - g.anchorLift
                if !balance || (c.createdAt.map { $0 < leftLaneSince } ?? false) {
                    rootSide[c.id] = false
                    right.add(desiredY, height: probeCardHeight, page: c.page)
                    continue
                }
                let samePageOnRight = right.count(onPage: c.page) + (c.page != nil ? rightPinned.filter { $0.page == c.page }.count : rightPinned.count)
                if samePageOnRight >= 1 {
                    let rightAdded = right.displacement(adding: desiredY, height: probeCardHeight) - right.displacement + pinnedOverlap(rightPinned, desiredY: desiredY, height: probeCardHeight)
                    let leftAdded = left.displacement(adding: desiredY, height: probeCardHeight) - left.displacement + pinnedOverlap(leftPinned, desiredY: desiredY, height: probeCardHeight)
                    if rightAdded >= 120 && leftAdded + 60 < rightAdded {
                        rootSide[c.id] = true
                        left.add(desiredY, height: probeCardHeight, page: c.page)
                        continue
                    }
                }
                rootSide[c.id] = false
                right.add(desiredY, height: probeCardHeight, page: c.page)
            }
        }

        let pageMid = pageWidth.map { $0 / 2 }
        let maxDepth = visible.map { depth(of: $0) }.max() ?? 0
        for d in 0...maxDepth {
            var keys: [String] = []
            var lanes: [String: (xFor: (Input) -> Double, list: [Input])] = [:]
            for c in visible where !c.isPinned && depth(of: c) == d {
                var key = "x:\(laneX)"
                var xFor: (Input) -> Double = { _ in laneX }
                if d == 0, rootSide[c.id] == true {
                    key = "left-root"
                    xFor = { card in -g.laneOffset - card.width }
                } else if d > 0, let parentId = c.parentCardId, let parent = byId[parentId], let p = result[parentId] {
                    let parentOnLeft = pageMid.map { Double(p.x) + parent.width / 2 < $0 } ?? false
                    if parentOnLeft {
                        key = "left-sub:\(parentId)"
                        xFor = { card in Double(p.x) - card.width - g.subLaneGap }
                    } else {
                        let sx = Geometry.subLaneX(parentX: p.x, parentWidth: parent.width)
                        key = "x:\(sx)"
                        xFor = { _ in sx }
                    }
                }
                if lanes[key] == nil { keys.append(key); lanes[key] = (xFor, []) }
                lanes[key]!.list.append(c)
            }
            for key in keys {
                guard let lane = lanes[key] else { continue }
                let solved = solve(lane.list.map { LaneItem(id: $0.id, desiredY: $0.anchorY - g.anchorLift, height: $0.height) })
                for c in lane.list { result[c.id] = CGPoint(x: lane.xFor(c), y: solved[c.id] ?? c.anchorY) }
            }
        }
        return result
    }
}
