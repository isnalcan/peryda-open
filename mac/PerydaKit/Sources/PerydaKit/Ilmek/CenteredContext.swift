import Foundation

/// The text around a selection that travels with it (owner, 17 Nov 2026): about `length` characters
/// centred on the selection, reaching into the previous or next page when the selection is near an
/// edge. A blind test that day scored this clearly above sending the page's opening, at the same size
/// and cost. When the selection cannot be found, the page's opening is sent as before. The web engine
/// follows the same rules (web/src/ai/centeredContext.ts).
public enum CenteredContext {
    static func norm(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    public static func make(page: String, selected: String, before: String = "", after: String = "", length: Int = YarnAnchor.contextLength) -> String? {
        let text = norm(page)
        guard !text.isEmpty else { return nil }
        let sel = norm(selected)
        var range = sel.isEmpty ? nil : text.range(of: sel)
        if range == nil, sel.count > 40 { range = text.range(of: String(sel.prefix(40))) }
        guard let found = range else { return String(text.prefix(length)) }
        let prev = norm(before), next = norm(after)
        let full = Array([prev, text, next].filter { !$0.isEmpty }.joined(separator: " "))
        let at = (prev.isEmpty ? 0 : prev.count + 1) + text.distance(from: text.startIndex, to: found.lowerBound)
        let selLength = min(sel.count, full.count - at)
        let side = max(0, (length - selLength) / 2)
        var start = max(0, at - side)
        var end = min(full.count, at + selLength + side)
        // Room left on one side goes to the other.
        if start == 0 { end = min(full.count, max(end, length)) }
        if end == full.count { start = max(0, min(start, full.count - length)) }
        let out = String(full[start..<end]).trimmingCharacters(in: .whitespaces)
        return String(out.prefix(max(length, selLength)))
    }
}
