import CoreGraphics
import Foundation

/// İlmek geometry. Every rule matches web/src/ilmek/geometry.ts and is checked against shared/vectors.
public enum Geometry {
    static var g: Tokens.GeometryTokens { SharedContract.tokens.geometry }

    public static var pageWorldWidth: Double { g.pageWorldWidth }
    public static var cardWidth: Double { g.cardWidth }
    public static var laneX: Double { g.pageWorldWidth + g.laneOffset }

    /// The first threads' lane beside pages of a given width (the reader can resize the pages).
    public static func laneX(pageWidth: Double) -> Double { pageWidth + g.laneOffset }

    /// The page size the reader chose, as a multiple of pageWorldWidth, within the allowed range.
    public static func clampPageScale(_ s: Double) -> Double {
        guard s.isFinite else { return 1 }
        return min(max(s, g.pageScaleMin), g.pageScaleMax)
    }

    public static func subLaneX(parentX: Double, parentWidth: Double) -> Double {
        parentX + parentWidth + g.subLaneGap
    }

    /// Control points of a yarn from the anchor (x1, y1) to the card (x2, y2).
    public static func bezierControls(x1: Double, y1: Double, x2: Double, y2: Double) -> (c1: CGPoint, c2: CGPoint) {
        let span = max(g.bezierMinSpan, abs(x2 - x1) * g.bezierSpanRatio)
        return (CGPoint(x: x1 + span, y: y1), CGPoint(x: x2 - span, y: y2))
    }

    /// A page size layout can use: a page with no size (or not a number) is drawn as a letter page,
    /// and a strip is kept to at most 200 times as long as wide, or as wide as long (real long pages,
    /// such as an article saved as one page, reach about 30:1). A PDF page with an empty MediaBox
    /// otherwise divided zero by zero and crashed the window (audit 16 Nov, M16-1; recheck R16-1).
    /// Matches make-vectors.py.
    public static func usablePageSize(_ s: CGSize) -> CGSize {
        let w = Double(s.width), h = Double(s.height)
        guard w.isFinite, h.isFinite, w >= 1, h >= 1 else { return CGSize(width: 612, height: 792) }
        return CGSize(width: w, height: w * min(max(h / w, 0.005), 200))
    }

    /// Pages stack vertically at one world width (pageWorldWidth times the book's page scale); sizes
    /// are page boxes in points.
    public static func pageLayout(_ sizes: [CGSize], width: Double? = nil) -> [PageBox] {
        let width = width ?? g.pageWorldWidth
        var y = 0.0
        return sizes.map { raw in
            let size = usablePageSize(raw)
            let height = width * (size.height / size.width)
            let box = PageBox(x: 0, y: y, width: width, height: height)
            y += height + g.pageGap
            return box
        }
    }

    /// Where a card the reader placed goes when the pages are resized, so it stays by its passage.
    /// x: right of the pages it moves with their right edge, left of them it stays, over them it
    /// scales. y: on a page it keeps its place within that page; in the gap below a page it moves with
    /// that page's bottom; above the first page it stays. Matches shared/tools/make-vectors.py.
    public static func remapPinned(_ point: CGPoint, from old: [PageBox], to new: [PageBox]) -> CGPoint {
        guard let o0 = old.first, let n0 = new.first, old.count == new.count else { return point }
        let x = Double(point.x), y = Double(point.y)
        let oldW = o0.width, newW = n0.width
        let nx: Double = x >= oldW ? x + (newW - oldW) : (x <= 0 ? x : x * newW / oldW)
        var index: Int?
        for (i, page) in old.enumerated() {
            if page.y <= y { index = i } else { break }
        }
        var ny = y
        if let i = index {
            let o = old[i], n = new[i]
            ny = y <= o.y + o.height ? n.y + (y - o.y) * n.height / o.height : y + (n.y + n.height) - (o.y + o.height)
        }
        return CGPoint(x: nx, y: ny)
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
