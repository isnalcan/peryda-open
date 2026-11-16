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

    /// The most matches a search keeps, and the longest query: a one-letter query in a long book would
    /// otherwise find hundreds of thousands (audit 16 Nov, M16-2). The web keeps the same limits.
    public static let maxHits = 5000
    public static let maxQuery = 500

    /// The ranges (in the text's UTF-16 units, as NSString and PDFKit count) where the query appears, at
    /// most `limit` of them.
    public static func ranges(of query: String, in text: String, limit: Int = maxHits) -> [NSRange] {
        let q = fold(String(query.prefix(maxQuery))).trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty, limit > 0 else { return [] }
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
        let qLength = (q as NSString).length
        guard units.count >= qLength else { return [] }
        // Foundation's own search over the folded text (a nested loop took 47 s on a crafted page).
        let folded = NSString(characters: units, length: units.count)
        var out: [NSRange] = []
        var from = 0
        while out.count < limit, from <= units.count - qLength {
            let found = folded.range(of: q, options: .literal, range: NSRange(location: from, length: units.count - from))
            guard found.location != NSNotFound else { break }
            let start = origin[found.location].location
            let end = NSMaxRange(origin[NSMaxRange(found) - 1])
            out.append(NSRange(location: start, length: end - start))
            from = NSMaxRange(found)
        }
        return out
    }
}
