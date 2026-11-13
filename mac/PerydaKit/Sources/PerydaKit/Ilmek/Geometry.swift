import CoreGraphics
import Foundation

/// İlmek geometry. Every rule matches web/src/ilmek/geometry.ts and is checked against shared/vectors.
public enum Geometry {
    static var g: Tokens.GeometryTokens { SharedContract.tokens.geometry }

    public static var pageWorldWidth: Double { g.pageWorldWidth }
    public static var cardWidth: Double { g.cardWidth }
    public static var laneX: Double { g.pageWorldWidth + g.laneOffset }

    public static func subLaneX(parentX: Double, parentWidth: Double) -> Double {
        parentX + parentWidth + g.subLaneGap
    }

    /// Control points of a yarn from the anchor (x1, y1) to the card (x2, y2).
    public static func bezierControls(x1: Double, y1: Double, x2: Double, y2: Double) -> (c1: CGPoint, c2: CGPoint) {
        let span = max(g.bezierMinSpan, abs(x2 - x1) * g.bezierSpanRatio)
        return (CGPoint(x: x1 + span, y: y1), CGPoint(x: x2 - span, y: y2))
    }

    /// Pages stack vertically at a fixed world width; sizes are page boxes in points.
    public static func pageLayout(_ sizes: [CGSize]) -> [PageBox] {
        var y = 0.0
        return sizes.map { size in
            let height = g.pageWorldWidth * (size.height / size.width)
            let box = PageBox(x: 0, y: y, width: g.pageWorldWidth, height: height)
            y += height + g.pageGap
            return box
        }
    }

    /// Where a yarn starts: the middle of the right edge of the anchor's bounding rectangle.
    public static func anchorWorldPoint(_ rect: NormalizedRect, page: PageBox) -> CGPoint {
        CGPoint(x: page.x + (rect.x + rect.width) * page.width, y: page.y + (rect.y + rect.height / 2) * page.height)
    }

    /// Where a yarn ends: the card's left edge, a fixed distance below its top.
    public static func cardAttachPoint(x: Double, y: Double) -> CGPoint {
        CGPoint(x: x, y: y + g.cardAttachY)
    }

    /// PDFKit page space (bottom-left origin, points) to normalized top-left 0...1.
    public static func normalized(_ rect: CGRect, in bounds: CGRect) -> NormalizedRect {
        NormalizedRect(
            x: (rect.minX - bounds.minX) / bounds.width,
            y: (bounds.maxY - rect.maxY) / bounds.height,
            width: rect.width / bounds.width,
            height: rect.height / bounds.height
        )
    }

    public static func pageRect(_ n: NormalizedRect, in bounds: CGRect) -> CGRect {
        CGRect(
            x: bounds.minX + n.x * bounds.width,
            y: bounds.minY + (1 - (n.y + n.height)) * bounds.height,
            width: n.width * bounds.width,
            height: n.height * bounds.height
        )
    }

    public static func union(_ rects: [NormalizedRect]) -> NormalizedRect {
        guard let first = rects.first else { return .zero }
        var minX = first.x, minY = first.y, maxX = first.x + first.width, maxY = first.y + first.height
        for r in rects.dropFirst() {
            minX = min(minX, r.x)
            minY = min(minY, r.y)
            maxX = max(maxX, r.x + r.width)
            maxY = max(maxY, r.y + r.height)
        }
        return NormalizedRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    /// Tiny boxes are stray clicks, not area selections.
    public static func areaAccepted(_ n: NormalizedRect) -> Bool {
        !(n.width < g.areaMinWidth || n.height < g.areaMinHeight)
    }

    /// Pixel crop of a rendered page for an area selection (JavaScript Math.round semantics).
    public static func cropPixels(canvasWidth: Double, canvasHeight: Double, _ n: NormalizedRect) -> (sx: Int, sy: Int, sw: Int, sh: Int) {
        func round(_ v: Double) -> Int { Int((v + 0.5).rounded(.down)) }
        return (round(n.x * canvasWidth), round(n.y * canvasHeight), max(1, round(n.width * canvasWidth)), max(1, round(n.height * canvasHeight)))
    }

    /// Zooms around the cursor: the world point under the cursor stays put.
    public static func zoomAt(pan: CGPoint, scale: Double, cursor: CGPoint, nextScale: Double) -> (world: CGPoint, pan: CGPoint) {
        let world = CGPoint(x: (cursor.x - pan.x) / scale, y: (cursor.y - pan.y) / scale)
        return (world, CGPoint(x: cursor.x - world.x * nextScale, y: cursor.y - world.y * nextScale))
    }
}
