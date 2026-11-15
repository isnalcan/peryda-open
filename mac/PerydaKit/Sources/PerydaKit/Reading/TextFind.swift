import Foundation

/// Find in the document (owner, 16 Nov): where a query appears in a page's text, ignoring case and
/// accents the way a Turkish reader expects (İ, I, ı and i are one letter; ö o, ş s, ç c, ğ g, ü u),
/// and treating any run of spaces or line breaks as one space, so a phrase broken over two lines is
/// still found. The web engine folds text by the same rules (web/src/reader/find.ts).
public enum TextFind {
    /// A string folded for matching: lower case, no accents, dotless i as i, white space as one space.
    public static func fold(_ s: String) -> String {
        var out = ""
        var lastWasSpace = false
        for ch in s {
            let piece = foldCharacter(ch)
            for c in piece {
                if c.isWhitespace {
                    if !lastWasSpace { out.append(" ") }
                    lastWasSpace = true
                } else {
                    out.append(c)
                    lastWasSpace = false
                }
            }
        }
        return out
    }

    static func foldCharacter(_ ch: Character) -> String {
        if ch.isWhitespace { return " " }
        let s = String(ch).folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: Locale(identifier: "en_US_POSIX"))
        return s.replacingOccurrences(of: "ı", with: "i")
    }

    /// The ranges (in the text's UTF-16 units, as NSString and PDFKit count) where the query appears.
    public static func ranges(of query: String, in text: String) -> [NSRange] {
        let q = Array(fold(query).trimmingCharacters(in: .whitespaces).utf16)
        guard !q.isEmpty else { return [] }
        // The folded text, one UTF-16 unit at a time, each with the range of the text it came from.
        let ns = text as NSString
        var units: [unichar] = []
        var origin: [NSRange] = []
        var lastWasSpace = true
        ns.enumerateSubstrings(in: NSRange(location: 0, length: ns.length), options: .byComposedCharacterSequences) { sub, range, _, _ in
            guard let sub, let ch = sub.first else { return }
            for c in foldCharacter(ch) {
                if c.isWhitespace {
                    if lastWasSpace { continue }
                    lastWasSpace = true
                    units.append(32)
                    origin.append(range)
                } else {
                    lastWasSpace = false
                    for u in String(c).utf16 {
                        units.append(u)
                        origin.append(range)
                    }
                }
            }
        }
        guard units.count >= q.count else { return [] }
        var out: [NSRange] = []
        var i = 0
        while i <= units.count - q.count {
            var j = 0
            while j < q.count, units[i + j] == q[j] { j += 1 }
            if j == q.count {
                let start = origin[i].location
                let end = NSMaxRange(origin[i + q.count - 1])
                out.append(NSRange(location: start, length: end - start))
                i += q.count
            } else {
                i += 1
            }
        }
        return out
    }
}
