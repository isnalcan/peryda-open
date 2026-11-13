import CoreGraphics
import Foundation
import PerydaKit

/// Rope-like motion for yarns. While a card is dragged, the middle of each yarn attached to it trails
/// the movement and sags a little under gravity; after release it swings back to the drawn curve and
/// settles. Each yarn's midpoint is a small mass on a spring toward the curve's resting midpoint.
struct YarnRopes {
    struct Rope {
        var mid: CGPoint
        var velocity: CGVector
    }

    /// Spring in Apple's terms: response (seconds) and damping ratio (below 1 swings a little).
    static let response = 0.42
    static let damping = 0.6
    static let stiffness = pow(2 * Double.pi / response, 2)
    static let friction = 4 * Double.pi * damping / response

    private(set) var ropes: [String: Rope] = [:]
    /// How far each yarn's midpoint sits from the resting curve, by segment id.
    private(set) var bends: [String: CGPoint] = [:]

    var isSettled: Bool { ropes.isEmpty }

    /// The resting curve's control points. A yarn running leftwards (to a card left of the page) is the
    /// mirror image of the usual left-to-right curve.
    static func baseControls(_ seg: YarnSegment) -> (CGPoint, CGPoint) {
        if seg.to.x >= seg.from.x { return Geometry.bezierControls(x1: seg.from.x, y1: seg.from.y, x2: seg.to.x, y2: seg.to.y) }
        let (c1, c2) = Geometry.bezierControls(x1: -seg.from.x, y1: seg.from.y, x2: -seg.to.x, y2: seg.to.y)
        return (CGPoint(x: -c1.x, y: c1.y), CGPoint(x: -c2.x, y: c2.y))
    }

    /// Midpoint of the drawn cubic curve.
    static func restMid(_ seg: YarnSegment) -> CGPoint {
        let (c1, c2) = baseControls(seg)
        return CGPoint(x: (seg.from.x + 3 * c1.x + 3 * c2.x + seg.to.x) / 8, y: (seg.from.y + 3 * c1.y + 3 * c2.y + seg.to.y) / 8)
    }

    /// Steady sag while held: slight, and smaller on short yarns.
    static func sag(_ seg: YarnSegment) -> Double {
        min(26, hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y) * 0.08)
    }

    /// Advances the ropes by `dt` seconds. `held` are the yarns attached to the card being dragged.
    mutating func step(_ segments: [YarnSegment], held: Set<String>, dt: Double) {
        let byId = Dictionary(segments.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for id in held where ropes[id] == nil {
            if let seg = byId[id] { ropes[id] = Rope(mid: Self.restMid(seg), velocity: .zero) }
        }
        var next: [String: CGPoint] = [:]
        for (id, start) in ropes {
            guard let seg = byId[id] else {
                ropes[id] = nil
                continue
            }
            var rope = start
            let rest = Self.restMid(seg)
            let isHeld = held.contains(id)
            let target = CGPoint(x: rest.x, y: rest.y + (isHeld ? Self.sag(seg) : 0))
            if dt > 0 {
                let n = max(1, Int((dt * 240).rounded(.up)))
                let h = dt / Double(n)
                for _ in 0..<n {
                    let ax = Self.stiffness * (target.x - rope.mid.x) - Self.friction * rope.velocity.dx
                    let ay = Self.stiffness * (target.y - rope.mid.y) - Self.friction * rope.velocity.dy
                    rope.velocity.dx += ax * h
                    rope.velocity.dy += ay * h
                    rope.mid.x += rope.velocity.dx * h
                    rope.mid.y += rope.velocity.dy * h
                }
            }
            // Keep the bend modest even after a fast fling.
            let chord = hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y)
            let limit = max(10, chord * 0.3)
            var d = CGPoint(x: rope.mid.x - rest.x, y: rope.mid.y - rest.y)
            let length = hypot(d.x, d.y)
            if length > limit {
                d = CGPoint(x: d.x * limit / length, y: d.y * limit / length)
                rope.mid = CGPoint(x: rest.x + d.x, y: rest.y + d.y)
                rope.velocity = CGVector(dx: rope.velocity.dx * 0.5, dy: rope.velocity.dy * 0.5)
            }
            if !isHeld, hypot(d.x, d.y) < 0.2, hypot(rope.velocity.dx, rope.velocity.dy) < 3 {
                ropes[id] = nil
                continue
            }
            ropes[id] = rope
            next[id] = d
        }
        bends = next
    }

    /// Control points for a yarn, bent so the curve's midpoint moves by `bend`.
    /// Moving both control points by b moves a cubic's midpoint by 3b/4.
    static func controls(_ seg: YarnSegment, bend: CGPoint?) -> (CGPoint, CGPoint) {
        let (c1, c2) = baseControls(seg)
        guard let bend else { return (c1, c2) }
        let b = CGPoint(x: bend.x * 4 / 3, y: bend.y * 4 / 3)
        return (CGPoint(x: c1.x + b.x, y: c1.y + b.y), CGPoint(x: c2.x + b.x, y: c2.y + b.y))
    }
}
