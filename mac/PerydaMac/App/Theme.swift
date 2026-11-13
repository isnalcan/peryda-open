import AppKit
import PerydaKit
import SwiftUI

/// Peryda's "Kenar Notu" colours from shared/tokens.json, adapting to light and dark appearance.
enum Theme {
    /// "#RRGGBB", or "rgba(r, g, b, a)" as the line tokens are written.
    static func hex(_ s: String) -> NSColor {
        if s.hasPrefix("rgb") {
            let parts = s.drop { $0 != "(" }.dropFirst().prefix { $0 != ")" }.split(separator: ",").map { Double($0.trimmingCharacters(in: .whitespaces)) ?? 0 }
            guard parts.count >= 3 else { return .black }
            return NSColor(srgbRed: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, alpha: parts.count > 3 ? parts[3] : 1)
        }
        var v: UInt64 = 0
        Scanner(string: s.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&v)
        return NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }

    static func adaptive(_ light: String, _ dark: String) -> NSColor {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .vibrantDark]) != nil ? hex(dark) : hex(light)
        }
    }

    static func palette(_ key: KeyPath<Tokens.Palette, String>) -> NSColor {
        let p = SharedContract.tokens.palette
        return adaptive(p["light"]![keyPath: key], p["dark"]![keyPath: key])
    }

    static let paper = palette(\.paper)
    static let paperRaised = palette(\.paperRaised)
    static let paperSunken = palette(\.paperSunken)
    static let ink = palette(\.ink)
    static let inkSoft = palette(\.inkSoft)
    static let inkFaint = palette(\.inkFaint)
    static let accent = palette(\.accent)
    static let line = palette(\.line)
    static let lineStrong = palette(\.lineStrong)

    static func yarn(_ color: YarnColor) -> NSColor {
        let tone = SharedContract.tokens.tone(color)
        return adaptive(tone.light, tone.dark)
    }

    /// Highlights sit on paper-coloured pages in both themes, so they use the light tone.
    static func highlight(_ color: YarnColor) -> NSColor {
        let tone = SharedContract.tokens.tone(color)
        return hex(tone.light).withAlphaComponent(tone.highlightAlpha)
    }
}

extension Color {
    static let paper = Color(nsColor: Theme.paper)
    static let paperRaised = Color(nsColor: Theme.paperRaised)
    static let paperSunken = Color(nsColor: Theme.paperSunken)
    static let ink = Color(nsColor: Theme.ink)
    static let inkSoft = Color(nsColor: Theme.inkSoft)
    static let inkFaint = Color(nsColor: Theme.inkFaint)
    static let peryda = Color(nsColor: Theme.accent)
    static func yarn(_ c: YarnColor) -> Color { Color(nsColor: Theme.yarn(c)) }
}

extension Font {
    /// Reading text: Apple's serif (New York), as in the iPhone app.
    static func reading(_ size: CGFloat) -> Font { .system(size: size, design: .serif) }
}
