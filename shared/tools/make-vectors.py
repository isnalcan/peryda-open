#!/usr/bin/env python3
"""Reference implementation of the İlmek geometry, used only to write the shared test vectors.

The web engine (TypeScript) and the Mac app (Swift) each implement the same rules and must reproduce
these numbers. Run from the repository root: python3 -I shared/tools/make-vectors.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKENS = json.load(open(os.path.join(ROOT, "tokens.json")))
G = TOKENS["geometry"]
OUT = os.path.join(ROOT, "vectors")


def bezier(x1, y1, x2, y2):
    span = max(G["bezierMinSpan"], abs(x2 - x1) * G["bezierSpanRatio"])
    return {"c1": [x1 + span, y1], "c2": [x2 - span, y2]}


def usable_page_size(w, h):
    """A page size layout can use: no size (or not a number) is a letter page, and a long strip is kept
    to 20 times as long as wide, 20 times as wide as long at most (audit 16 Nov, M16-1)."""
    import math
    if not (math.isfinite(w) and math.isfinite(h) and w >= 1 and h >= 1):
        return 612.0, 792.0
    return float(w), float(w) * min(max(h / w, 0.05), 20.0)


def page_layout(sizes, width=None):
    """sizes: list of [widthPt, heightPt]; pages stack vertically at one world width (the reader's page
    size: pageWorldWidth times the book's page scale)."""
    width = float(G["pageWorldWidth"] if width is None else width)
    y = 0.0
    pages = []
    for raw_w, raw_h in sizes:
        w, h = usable_page_size(raw_w, raw_h)
        height = width * (h / w)
        pages.append({"x": 0.0, "y": y, "width": width, "height": height})
        y += height + G["pageGap"]
    return pages


def clamp_page_scale(s):
    return min(max(s, G["pageScaleMin"]), G["pageScaleMax"])


def lane_x(page_width):
    return page_width + G["laneOffset"]


def remap_pinned(point, old_pages, new_pages):
    """Where a card the reader placed goes when the pages are resized, so it stays by its passage.
    x: right of the pages it moves with their right edge, left of them it stays, over them it scales.
    y: on a page it keeps its place within that page; in the gap below a page it moves with that
    page's bottom; above the first page it stays."""
    x, y = point
    if not old_pages or not new_pages or len(old_pages) != len(new_pages):
        return [x, y]
    old_w, new_w = old_pages[0]["width"], new_pages[0]["width"]
    if x >= old_w:
        nx = x + (new_w - old_w)
    elif x <= 0:
        nx = x
    else:
        nx = x * new_w / old_w
    index = None
    for i, page in enumerate(old_pages):
        if page["y"] <= y:
            index = i
        else:
            break
    if index is None:
        ny = y
    else:
        o, n = old_pages[index], new_pages[index]
        if y <= o["y"] + o["height"]:
            ny = n["y"] + (y - o["y"]) * n["height"] / o["height"]
        else:
            ny = y + (n["y"] + n["height"]) - (o["y"] + o["height"])
    return [nx, ny]


def anchor_world_point(rect, page):
    return [
        page["x"] + (rect["x"] + rect["width"]) * page["width"],
        page["y"] + (rect["y"] + rect["height"] / 2) * page["height"],
    ]


def card_attach_point(card):
    return [card["x"], card["y"] + G["cardAttachY"]]


def pdf_to_normalized(bounds, rect):
    """bounds/rect in PDF points with a bottom-left origin (PDFKit). Result: top-left, 0..1."""
    bx, by, bw, bh = bounds
    rx, ry, rw, rh = rect
    return {
        "x": (rx - bx) / bw,
        "y": ((by + bh) - (ry + rh)) / bh,
        "width": rw / bw,
        "height": rh / bh,
    }


def normalized_to_pdf(bounds, n):
    bx, by, bw, bh = bounds
    return [
        bx + n["x"] * bw,
        by + (1.0 - (n["y"] + n["height"])) * bh,
        n["width"] * bw,
        n["height"] * bh,
    ]


def lane_solve(cards):
    """cards: [{id, desiredY, height}] for one lane. Ties keep input order."""
    order = sorted(range(len(cards)), key=lambda i: (cards[i]["desiredY"], i))
    cursor = G["laneTop"]
    placed = {}
    for i in order:
        c = cards[i]
        y = max(c["desiredY"], cursor)
        placed[c["id"]] = y
        cursor = y + c["height"] + G["laneGap"]
    return placed


def crop_pixels(canvas_w, canvas_h, n):
    return {
        "sx": round_half_away(n["x"] * canvas_w),
        "sy": round_half_away(n["y"] * canvas_h),
        "sw": max(1, round_half_away(n["width"] * canvas_w)),
        "sh": max(1, round_half_away(n["height"] * canvas_h)),
    }


def round_half_away(v):
    # JavaScript Math.round rounds .5 up (towards +inf); every input here is positive.
    import math
    return int(math.floor(v + 0.5))


def area_accepted(n):
    return not (n["width"] < G["areaMinWidth"] or n["height"] < G["areaMinHeight"])


def zoom_at(pan, scale, cursor, next_scale):
    world = [(cursor[0] - pan[0]) / scale, (cursor[1] - pan[1]) / scale]
    return {"world": world, "nextPan": [cursor[0] - world[0] * next_scale, cursor[1] - world[1] * next_scale]}


def resolve_provider(s):
    has_g = len(s["geminiApiKey"].strip()) > 10
    has_o = len(s["openaiApiKey"].strip()) > 10
    if has_g and has_o:
        return s["activeProvider"]
    if has_g:
        return "gemini"
    if has_o:
        return "openai"
    return None


def write(name, data):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, name), "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main():
    bez_cases = [[760, 120, 835, 106], [500, 400, 835, 900], [700, 50, 1293, 40], [835, 300, 835, 300], [100, 10, 1400, 2000]]
    write("bezier.json", {"description": "Cubic Bezier control points for a yarn from (x1,y1) to (x2,y2).",
                          "cases": [{"from": c[:2], "to": c[2:], **bezier(*c)} for c in bez_cases]})

    sizes = [[612, 792], [595.28, 841.89], [842, 595], [612, 792]]
    layout = page_layout(sizes)
    rects = [
        {"page": 0, "rect": {"x": 0.1, "y": 0.2, "width": 0.5, "height": 0.02}},
        {"page": 1, "rect": {"x": 0.12, "y": 0.5, "width": 0.7, "height": 0.05}},
        {"page": 2, "rect": {"x": 0.6, "y": 0.9, "width": 0.3, "height": 0.08}},
    ]
    anchors = [{**r, "world": anchor_world_point(r["rect"], layout[r["page"]])} for r in rects]
    cards = [{"x": 835, "y": 120}, {"x": 1293, "y": 0.5}]
    write("world.json", {
        "description": "Page stacking in world space and the points where yarns start and end.",
        "pageSizes": sizes, "pages": layout, "anchors": anchors,
        "cardAttach": [{"card": c, "point": card_attach_point(c)} for c in cards],
        "laneX": G["pageWorldWidth"] + G["laneOffset"],
        "subLane": {"parent": {"x": 835, "width": 390}, "x": 835 + 390 + G["subLaneGap"]},
    })

    pdf_cases = [
        {"bounds": [0, 0, 612, 792], "rect": [72, 600, 300, 14]},
        {"bounds": [0, 0, 595.28, 841.89], "rect": [56.7, 56.7, 481.88, 120]},
        {"bounds": [18, 36, 576, 720], "rect": [90, 680, 200, 20]},
        {"bounds": [0, 0, 842, 595], "rect": [0, 0, 842, 595]},
    ]
    write("pdf-coordinates.json", {
        "description": "PDFKit (bottom-left origin, points) to normalized top-left 0..1 and back.",
        "cases": [{**c, "normalized": pdf_to_normalized(c["bounds"], c["rect"])} for c in pdf_cases],
    })

    lanes = [
        {"name": "no overlap", "cards": [{"id": "a", "desiredY": 100, "height": 80}, {"id": "b", "desiredY": 400, "height": 120}]},
        {"name": "same paragraph", "cards": [{"id": "a", "desiredY": 300, "height": 140}, {"id": "b", "desiredY": 310, "height": 90}, {"id": "c", "desiredY": 305, "height": 60}]},
        {"name": "above lane top", "cards": [{"id": "a", "desiredY": -40, "height": 50}, {"id": "b", "desiredY": 0, "height": 50}]},
        {"name": "ties keep order", "cards": [{"id": "x", "desiredY": 200, "height": 40}, {"id": "y", "desiredY": 200, "height": 40}]},
        {"name": "unsorted input", "cards": [{"id": "late", "desiredY": 900, "height": 100}, {"id": "early", "desiredY": 850, "height": 100}, {"id": "mid", "desiredY": 860, "height": 10}]},
    ]
    write("lane.json", {"description": "Magnetic right-lane placement (unpinned cards of one lane).",
                        "laneTop": G["laneTop"], "laneGap": G["laneGap"],
                        "cases": [{**l, "placedY": lane_solve(l["cards"])} for l in lanes]})

    crops = [
        {"canvas": [1224, 1584], "norm": {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.25}},
        {"canvas": [1000, 1000], "norm": {"x": 0.0005, "y": 0.9995, "width": 0.0001, "height": 0.0004}},
        {"canvas": [1191, 1684], "norm": {"x": 0.333, "y": 0.125, "width": 0.5, "height": 0.0625}},
    ]
    areas = [
        {"norm": {"x": 0.1, "y": 0.1, "width": 0.019, "height": 0.2}},
        {"norm": {"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.0149}},
        {"norm": {"x": 0.1, "y": 0.1, "width": 0.02, "height": 0.015}},
    ]
    write("area.json", {"description": "Area stitch: pixel crop of a rendered page and the minimum-size rule.",
                        "crops": [{**c, "pixels": crop_pixels(*c["canvas"], c["norm"])} for c in crops],
                        "minimum": [{**a, "accepted": area_accepted(a["norm"])} for a in areas]})

    zooms = [
        {"pan": [0, 0], "scale": 1, "cursor": [400, 300], "nextScale": 2},
        {"pan": [-120, 40], "scale": 0.8, "cursor": [512, 384], "nextScale": 1.25},
        {"pan": [10, -500], "scale": 1.5, "cursor": [0, 0], "nextScale": 0.5},
    ]
    write("zoom.json", {"description": "Zoom keeps the world point under the cursor fixed.",
                        "cases": [{**z, **zoom_at(z["pan"], z["scale"], z["cursor"], z["nextScale"])} for z in zooms]})

    providers = [
        {"geminiApiKey": "", "openaiApiKey": "", "activeProvider": "openai"},
        {"geminiApiKey": "AIzaSyExampleKey1234", "openaiApiKey": "", "activeProvider": "openai"},
        {"geminiApiKey": "", "openaiApiKey": "sk-example-key-1234", "activeProvider": "gemini"},
        {"geminiApiKey": "AIzaSyExampleKey1234", "openaiApiKey": "sk-example-key-1234", "activeProvider": "openai"},
        {"geminiApiKey": "AIzaSyExampleKey1234", "openaiApiKey": "sk-example-key-1234", "activeProvider": "gemini"},
        {"geminiApiKey": "  short    ", "openaiApiKey": "           ", "activeProvider": "gemini"},
    ]
    write("provider.json", {"description": "Which provider answers. Keys here are placeholders, not real keys.",
                            "cases": [{"settings": p, "provider": resolve_provider(p)} for p in providers]})

    scale_sizes = [[612, 792], [842, 595], [595.28, 841.89]]
    base = page_layout(scale_sizes)
    scaled = []
    for s in [0.5, 1.37, 2.5]:
        width = G["pageWorldWidth"] * s
        new_pages = page_layout(scale_sizes, width)
        points = [[835, 120], [1300, 1500], [-420, 700], [300, 1200], [0, 50], [760, 990], [500, 2400], [900, 5000], [200, -40]]
        scaled.append({
            "scale": s,
            "pages": new_pages,
            "laneX": lane_x(width),
            "pinned": [{"from": p, "to": remap_pinned(p, base, new_pages)} for p in points],
        })
    write("page-scale.json", {
        "description": "Resizing the pages (the book's page scale): page stacking at the new width, the lane, "
                       "where cards the reader placed move to (from the pages at scale 1), and the scale limits.",
        "sizes": scale_sizes,
        "basePages": base,
        "scaled": scaled,
        "clamp": [{"scale": s, "clamped": clamp_page_scale(s)} for s in [0.1, 0.5, 1, 1.8, 2.5, 4]],
        # Pages with no size, a negative size or the shape of a long strip (audit 16 Nov, M16-1).
        "degenerate": {"sizes": [[0, 0], [612, -5], [0.5, 800], [10, 100000], [100000, 10], [595.28, 841.89]],
                       "pages": page_layout([[0, 0], [612, -5], [0.5, 800], [10, 100000], [100000, 10], [595.28, 841.89]])},
    })


if __name__ == "__main__":
    main()
