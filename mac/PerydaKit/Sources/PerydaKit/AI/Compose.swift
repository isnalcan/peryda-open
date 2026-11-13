import Foundation

/// Builds provider conversations from cards. Matches web/src/ai/compose.ts.
public enum Compose {
    /// Fills `{name}` placeholders in one pass: a value that itself contains `{context}` (a book title,
    /// a selection) is never expanded again.
    static func fill(_ template: String, _ values: [String: String]) -> String {
        var out = ""
        var rest = template[...]
        while let open = rest.firstIndex(of: "{") {
            out += rest[..<open]
            let after = rest[rest.index(after: open)...]
            if let close = after.firstIndex(of: "}"), let value = values[String(after[..<close])] {
                out += value
                rest = after[after.index(after: close)...]
            } else {
                out += "{"
                rest = after
            }
        }
        return out + rest
    }

    /// A book title as it goes into an instruction: it is the file's own metadata, so it is kept to one
    /// short line (no line breaks or control characters to pose as a new instruction).
    public static func promptTitle(_ title: String) -> String {
        let bidi: ClosedRange<UInt32> = 0x202A...0x202E
        let isolates: ClosedRange<UInt32> = 0x2066...0x2069
        var out = ""
        var space = false
        for scalar in title.unicodeScalars {
            if CharacterSet.whitespacesAndNewlines.contains(scalar) {
                space = !out.isEmpty
                continue
            }
            if scalar.properties.generalCategory == .control || bidi.contains(scalar.value) || isolates.contains(scalar.value) { continue }
            if space { out.unicodeScalars.append(" ") }
            space = false
            out.unicodeScalars.append(scalar)
        }
        return String(out.prefix(200)).trimmingCharacters(in: .whitespaces)
    }

    public static func pageLabel(_ lang: Lang, _ page: Int) -> String {
        fill(SharedContract.prompts.pageLabel.text(lang), ["page": String(page)])
    }

    public static func chapterLabel(_ lang: Lang, _ chapter: Int) -> String {
        fill(SharedContract.prompts.chapterLabel.text(lang), ["chapter": String(chapter)])
    }

    public static func location(_ lang: Lang, _ anchor: YarnAnchor) -> String {
        switch anchor.sourceType {
        case .card: "—"
        case .epubText: chapterLabel(lang, anchor.pageNumber)
        default: pageLabel(lang, anchor.pageNumber)
        }
    }

    public static func systemPrompt(_ lang: Lang, bookTitle: String, pages: [Int]) -> String {
        let label = Array(Set(pages)).sorted().map { pageLabel(lang, $0) }.joined(separator: ", ")
        return fill(SharedContract.prompts.system.text(lang), ["bookTitle": promptTitle(bookTitle), "pageLabel": label, "language": lang.languageName])
    }

    /// The instruction for Pery's summary of a Book Journal.
    public static func journalSummarySystem(_ lang: Lang, bookTitle: String) -> String {
        fill(SharedContract.prompts.journalSummary.text(lang), ["bookTitle": promptTitle(bookTitle)])
    }

    public static func kindPrompt(_ lang: Lang, _ kind: YarnKind) -> String {
        let k = SharedContract.kinds
        switch kind {
        case .bridge: return k.bridge.prompt.text(lang)
        case .translate: return fill(k.translate.prompt.text(lang), ["language": lang.languageName])
        case .question: return ""
        case .quick(let color): return k.kind(color).prompt.text(lang)
        }
    }

    /// Whole-page translation into `target`: the editor's rules, then the page (its text, or its
    /// picture with an OCR-and-translate instruction when it has no text layer). With `explainTerms`
    /// (the reader's choice, on by default) hard terms get a short explanation in brackets; without it
    /// the same rules leave that out.
    public static func pageTranslationSystem(target: Lang, explainTerms: Bool = true) -> String {
        let p = SharedContract.prompts
        return (explainTerms ? p.pageTranslateSystem : p.pageTranslateSystemNoTerms).text(target)
    }

    public static func pageTranslationTurns(target: Lang, file: String, page: Int, pages: Int, text: String, imageDataURL: String?, explainTerms: Bool = true) -> [AITurn] {
        let p = SharedContract.prompts
        let values = ["file": promptTitle(file), "page": String(page), "pages": String(max(pages, page))]
        if let image = imageDataURL, let part = imagePart(image) {
            let scanned = explainTerms ? p.pageTranslateScanned : p.pageTranslateScannedNoTerms
            return [AITurn(role: .user, parts: [part, .text(fill(scanned.text(target), values))])]
        }
        let instruction = explainTerms ? p.pageTranslate : p.pageTranslateNoTerms
        return [AITurn(role: .user, parts: [.text(fill(instruction.text(target), values.merging(["text": text]) { a, _ in a }))])]
    }

    /// A `data:` URL as an image part.
    static func imagePart(_ dataURL: String) -> AIPart? {
        guard dataURL.hasPrefix("data:"), let comma = dataURL.firstIndex(of: ","), let semi = dataURL.firstIndex(of: ";"), semi < comma else { return nil }
        let mime = String(dataURL[dataURL.index(dataURL.startIndex, offsetBy: 5)..<semi])
        return .image(mimeType: mime, base64: String(dataURL[dataURL.index(after: comma)...]))
    }

    /// The first message of a thread: the selection, what surrounds it and the request, in one
    /// message; for a region of a page, its picture first and a placeholder in place of the text.
    public static func contextParts(_ lang: Lang, anchors: [YarnAnchor], request: String) -> [AIPart] {
        var parts: [AIPart] = []
        let area = anchors.first { $0.sourceType == .pdfArea }
        if let area, let image = area.croppedImage, let part = imagePart(image) { parts.append(part) }
        let selected = area.map { fill(SharedContract.prompts.areaSelection.text(lang), ["page": String($0.pageNumber)]) }
            ?? anchors.map { $0.selectedText.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: " ")
        let context = anchors.compactMap(\.context).first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .map { String($0.prefix(YarnAnchor.contextLength)) } ?? "—"
        parts.append(.text(fill(SharedContract.prompts.contextTemplate.text(lang), ["selected": selected, "context": context, "request": request])))
        return parts
    }

    public static func kindTitle(_ lang: Lang, _ kind: YarnKind) -> String {
        let k = SharedContract.kinds
        switch kind {
        case .bridge: return k.bridge.cardTitle.text(lang)
        case .translate: return k.translate.cardTitle.text(lang)
        case .question: return k.custom.cardTitle.text(lang)
        case .quick(let color): return k.kind(color).cardTitle.text(lang)
        }
    }

    public static func kindLabel(_ lang: Lang, _ color: YarnColor) -> String {
        SharedContract.kinds.kind(color).label.text(lang)
    }

    static func anchorParts(_ lang: Lang, _ anchors: [YarnAnchor]) -> [AIPart] {
        var parts: [AIPart] = []
        for (i, a) in anchors.enumerated() {
            let template = a.sourceType == .pdfArea ? SharedContract.prompts.areaHeader : SharedContract.prompts.passageHeader
            let header = fill(template.text(lang), ["index": String(i + 1), "pageLabel": location(lang, a)])
            let text = a.selectedText.trimmingCharacters(in: .whitespacesAndNewlines)
            parts.append(.text("\(header)\n\(text.isEmpty ? "—" : text)"))
            let prefix = "data:image/png;base64,"
            if let image = a.croppedImage, image.hasPrefix(prefix) {
                parts.append(.image(mimeType: "image/png", base64: String(image.dropFirst(prefix.count))))
            }
        }
        return parts
    }

    /// The first user turn carries the passages, images and first instruction; later messages alternate.
    public static func turns(_ lang: Lang, card: YarnCard) -> [AITurn] {
        var turns: [AITurn] = []
        let usable = card.messages.filter { $0.state != .error && ($0.role == .user || !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
        for (i, m) in usable.enumerated() {
            if i == 0 && m.role == .user {
                // A bridge compares two passages and keeps its headed form; every other thread sends
                // the selection, its context and the request together.
                let parts = card.kind == .bridge ? anchorParts(lang, card.anchors) + [.text(m.content)] : contextParts(lang, anchors: card.anchors, request: m.content)
                turns.append(AITurn(role: .user, parts: parts))
            } else {
                turns.append(AITurn(role: m.role == .user ? .user : .assistant, parts: [.text(m.content)]))
            }
        }
        while turns.last?.role == .assistant { turns.removeLast() }
        return turns
    }
}
