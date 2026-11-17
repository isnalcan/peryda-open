import CoreGraphics
import Foundation
import Testing
@testable import PerydaKit

/// The same shared/vectors files the web engine is tested against.
enum Vectors {
    static let sharedDir: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // PerydaKitTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // PerydaKit
        .deletingLastPathComponent() // mac
        .deletingLastPathComponent() // repo
        .appendingPathComponent("shared")

    static func json(_ name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: sharedDir.appendingPathComponent("vectors/\(name)"))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

func d(_ v: Any?) -> Double { (v as? NSNumber)?.doubleValue ?? .nan }
func arr(_ v: Any?) -> [Double] { ((v as? [Any]) ?? []).map { d($0) } }
func rect(_ v: Any?) -> NormalizedRect {
    let r = v as? [String: Any] ?? [:]
    return NormalizedRect(x: d(r["x"]), y: d(r["y"]), width: d(r["width"]), height: d(r["height"]))
}
func close(_ a: Double, _ b: Double, _ tol: Double = 1e-9) -> Bool { abs(a - b) <= tol }

@Suite("Shared vectors")
struct SharedVectorsTests {
    @Test func bezier() throws {
        for c in try Vectors.json("bezier.json")["cases"] as! [[String: Any]] {
            let from = arr(c["from"]), to = arr(c["to"])
            let r = Geometry.bezierControls(x1: from[0], y1: from[1], x2: to[0], y2: to[1])
            let c1 = arr(c["c1"]), c2 = arr(c["c2"])
            #expect(close(r.c1.x, c1[0]) && close(r.c1.y, c1[1]) && close(r.c2.x, c2[0]) && close(r.c2.y, c2[1]))
        }
    }

    @Test func worldSpace() throws {
        let v = try Vectors.json("world.json")
        let sizes = (v["pageSizes"] as! [[Any]]).map { CGSize(width: d($0[0]), height: d($0[1])) }
        let pages = Geometry.pageLayout(sizes)
        for (i, e) in (v["pages"] as! [[String: Any]]).enumerated() {
            #expect(close(pages[i].y, d(e["y"])) && close(pages[i].height, d(e["height"])) && close(pages[i].width, d(e["width"])))
        }
        for a in v["anchors"] as! [[String: Any]] {
            let p = Geometry.anchorWorldPoint(rect(a["rect"]), page: pages[(a["page"] as! NSNumber).intValue])
            let w = arr(a["world"])
            #expect(close(p.x, w[0]) && close(p.y, w[1]))
        }
        for c in v["cardAttach"] as! [[String: Any]] {
            let card = c["card"] as! [String: Any]
            let p = Geometry.cardAttachPoint(x: d(card["x"]), y: d(card["y"]))
            let w = arr(c["point"])
            #expect(close(p.x, w[0]) && close(p.y, w[1]))
        }
        #expect(Geometry.laneX == d(v["laneX"]))
        let sub = v["subLane"] as! [String: Any]
        let parent = sub["parent"] as! [String: Any]
        #expect(Geometry.subLaneX(parentX: d(parent["x"]), parentWidth: d(parent["width"])) == d(sub["x"]))
    }

    /// Resizing the pages: stacking at the new width, the lane beside them, where placed cards go, and
    /// the scale limits (owner, 16 Nov).
    @Test func pageScale() throws {
        let v = try Vectors.json("page-scale.json")
        let sizes = (v["sizes"] as! [[Any]]).map { CGSize(width: d($0[0]), height: d($0[1])) }
        let base = Geometry.pageLayout(sizes)
        for (i, e) in (v["basePages"] as! [[String: Any]]).enumerated() {
            #expect(close(base[i].y, d(e["y"])) && close(base[i].height, d(e["height"])) && close(base[i].width, d(e["width"])))
        }
        for c in v["scaled"] as! [[String: Any]] {
            let width = Geometry.pageWorldWidth * d(c["scale"])
            let pages = Geometry.pageLayout(sizes, width: width)
            for (i, e) in (c["pages"] as! [[String: Any]]).enumerated() {
                #expect(close(pages[i].y, d(e["y"])) && close(pages[i].height, d(e["height"])) && close(pages[i].width, d(e["width"])))
            }
            #expect(close(Geometry.laneX(pageWidth: width), d(c["laneX"])))
            for p in c["pinned"] as! [[String: Any]] {
                let from = arr(p["from"]), to = arr(p["to"])
                let r = Geometry.remapPinned(CGPoint(x: from[0], y: from[1]), from: base, to: pages)
                #expect(close(r.x, to[0], 1e-6) && close(r.y, to[1], 1e-6), "\(from) -> \(r), expected \(to)")
            }
        }
        for c in v["clamp"] as! [[String: Any]] {
            #expect(Geometry.clampPageScale(d(c["scale"])) == d(c["clamped"]))
        }
        // Pages with no size or a strip's shape still lay out (audit 16 Nov, M16-1).
        let bad = v["degenerate"] as! [String: Any]
        let badSizes = (bad["sizes"] as! [[Any]]).map { CGSize(width: d($0[0]), height: d($0[1])) }
        let badPages = Geometry.pageLayout(badSizes + [CGSize(width: Double.nan, height: 792), CGSize(width: 612, height: Double.infinity)])
        for (i, e) in (bad["pages"] as! [[String: Any]]).enumerated() {
            #expect(close(badPages[i].y, d(e["y"])) && close(badPages[i].height, d(e["height"])), "page \(i + 1)")
        }
        for page in badPages { #expect(page.height.isFinite && page.height > 0 && page.y.isFinite) }
    }

    @Test func pdfCoordinates() throws {
        for c in try Vectors.json("pdf-coordinates.json")["cases"] as! [[String: Any]] {
            let b = arr(c["bounds"]), r = arr(c["rect"])
            let bounds = CGRect(x: b[0], y: b[1], width: b[2], height: b[3])
            let pdfRect = CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
            let n = Geometry.normalized(pdfRect, in: bounds)
            let e = rect(c["normalized"])
            #expect(close(n.x, e.x) && close(n.y, e.y) && close(n.width, e.width) && close(n.height, e.height))
            let back = Geometry.pageRect(n, in: bounds)
            #expect(close(back.minX, pdfRect.minX, 1e-6) && close(back.minY, pdfRect.minY, 1e-6))
        }
    }

    @Test func magneticLane() throws {
        for c in try Vectors.json("lane.json")["cases"] as! [[String: Any]] {
            let items = (c["cards"] as! [[String: Any]]).map { LaneItem(id: $0["id"] as! String, desiredY: d($0["desiredY"]), height: d($0["height"])) }
            let placed = Lane.solve(items)
            for (id, y) in c["placedY"] as! [String: Any] {
                #expect(close(placed[id] ?? .nan, d(y)), "\(c["name"] ?? "") \(id)")
            }
        }
    }

    @Test func areaStitch() throws {
        let v = try Vectors.json("area.json")
        for c in v["crops"] as! [[String: Any]] {
            let canvas = arr(c["canvas"])
            let p = Geometry.cropPixels(canvasWidth: canvas[0], canvasHeight: canvas[1], rect(c["norm"]))
            let e = c["pixels"] as! [String: Any]
            #expect(p.sx == (e["sx"] as! NSNumber).intValue && p.sy == (e["sy"] as! NSNumber).intValue)
            #expect(p.sw == (e["sw"] as! NSNumber).intValue && p.sh == (e["sh"] as! NSNumber).intValue)
        }
        for c in v["minimum"] as! [[String: Any]] {
            #expect(Geometry.areaAccepted(rect(c["norm"])) == (c["accepted"] as! Bool))
        }
    }

    @Test func zoomAroundCursor() throws {
        for c in try Vectors.json("zoom.json")["cases"] as! [[String: Any]] {
            let pan = arr(c["pan"]), cursor = arr(c["cursor"])
            let r = Geometry.zoomAt(pan: CGPoint(x: pan[0], y: pan[1]), scale: d(c["scale"]), cursor: CGPoint(x: cursor[0], y: cursor[1]), nextScale: d(c["nextScale"]))
            let w = arr(c["world"]), p = arr(c["nextPan"])
            #expect(close(r.world.x, w[0]) && close(r.world.y, w[1]) && close(r.pan.x, p[0]) && close(r.pan.y, p[1]))
        }
    }

    @Test func providerChoice() throws {
        for c in try Vectors.json("provider.json")["cases"] as! [[String: Any]] {
            let s = c["settings"] as! [String: Any]
            let settings = ByokSettings(
                activeProvider: ProviderID(rawValue: s["activeProvider"] as! String)!,
                geminiApiKey: s["geminiApiKey"] as! String,
                openaiApiKey: s["openaiApiKey"] as! String
            )
            #expect(settings.resolvedProvider?.rawValue == (c["provider"] as? String))
        }
    }

    @Test func bundledResourcesMatchShared() throws {
        for name in ["tokens.json", "yarn-kinds.json", "prompts.json", "ui-strings.json", "privacy.json", "cost-estimates.json"] {
            let shared = try Data(contentsOf: Vectors.sharedDir.appendingPathComponent(name))
            let bundled = try Data(contentsOf: #require(Bundle.module.url(forResource: name.replacingOccurrences(of: ".json", with: ""), withExtension: "json", subdirectory: "shared")))
            #expect(shared == bundled, "\(name) drifted; run mac/scripts/sync-shared.sh")
        }
    }
}
