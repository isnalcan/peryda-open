import SwiftUI

/// A quiet drawing in the library's bottom-right corner: a thread comes in from the edge, ties one
/// loop (an İlmek) with a knot, and trails off with a loose end. It draws itself once when the
/// library opens (at once with Reduce Motion). Decoration only: no hit testing, hidden from
/// VoiceOver. Same shape as the web library (web/src/library/LibraryArt.tsx), in its 520 × 420 frame.
struct LibraryArt: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @State private var drawn: CGFloat = 0
    @State private var knotted = false

    static let size = CGSize(width: 520, height: 420)

    var body: some View {
        GeometryReader { geo in
            let scale = geo.size.width / Self.size.width
            ZStack(alignment: .topLeading) {
                Thread()
                    .trim(from: 0, to: drawn)
                    .stroke(style: StrokeStyle(lineWidth: 2.8, lineCap: .round, lineJoin: .round))
                Knot()
                    .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .opacity(knotted ? 1 : 0)
                KnotTurns()
                    .fill()
                    .opacity(knotted ? 1 : 0)
            }
            .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
            .scaleEffect(scale, anchor: .topLeading)
        }
        .aspectRatio(Self.size.width / Self.size.height, contentMode: .fit)
        .foregroundStyle(Color.peryda.opacity(colorScheme == .dark ? 0.4 : 0.34))
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear {
            if reduceMotion {
                drawn = 1
                knotted = true
            } else {
                // The same timing as the web: the thread draws, and the knot is tied as it passes.
                withAnimation(.timingCurve(0.33, 0, 0.2, 1, duration: 2.4).delay(0.2)) { drawn = 1 }
                withAnimation(.easeOut(duration: 0.9).delay(1.3)) { knotted = true }
            }
        }
    }

    /// The thread: in from beyond the right edge, one loose loop, then a loose end.
    struct Thread: Shape {
        func path(in rect: CGRect) -> Path {
            var p = Path()
            p.move(to: CGPoint(x: 560, y: 392))
            p.addCurve(to: CGPoint(x: 372, y: 324), control1: CGPoint(x: 470, y: 392), control2: CGPoint(x: 412, y: 362))
            p.addCurve(to: CGPoint(x: 338, y: 206), control1: CGPoint(x: 330, y: 284), control2: CGPoint(x: 304, y: 236))
            p.addCurve(to: CGPoint(x: 398, y: 246), control1: CGPoint(x: 372, y: 176), control2: CGPoint(x: 424, y: 206))
            p.addCurve(to: CGPoint(x: 268, y: 250), control1: CGPoint(x: 372, y: 286), control2: CGPoint(x: 304, y: 286))
            p.addCurve(to: CGPoint(x: 220, y: 164), control1: CGPoint(x: 240, y: 222), control2: CGPoint(x: 226, y: 190))
            return p
        }
    }

    /// The two loose tails of the knot where the loop crosses itself.
    struct Knot: Shape {
        func path(in rect: CGRect) -> Path {
            var p = Path()
            p.move(to: CGPoint(x: 336, y: 278))
            p.addCurve(to: CGPoint(x: 335, y: 309), control1: CGPoint(x: 344, y: 290), control2: CGPoint(x: 343, y: 300))
            p.move(to: CGPoint(x: 331, y: 279))
            p.addCurve(to: CGPoint(x: 313, y: 300), control1: CGPoint(x: 328, y: 291), control2: CGPoint(x: 321, y: 297))
            return p
        }
    }

    /// The knot itself: two turns pulled tight.
    struct KnotTurns: Shape {
        func path(in rect: CGRect) -> Path {
            var p = Path()
            p.addEllipse(in: CGRect(x: 331 - 4.6, y: 271 - 4.6, width: 9.2, height: 9.2))
            p.addEllipse(in: CGRect(x: 335.5 - 3.9, y: 275 - 3.9, width: 7.8, height: 7.8))
            return p
        }
    }
}
