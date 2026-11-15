import AppKit
import PerydaKit
import SwiftUI

/// A whole-page translation, drawn as a page of its own beside the PDF page: same size, level with
/// it, paper and ink like a printed page. Its text can be selected to open threads, as on the PDF.
struct TranslatedPageView: View {
    let cardId: String
    let reader: ReaderModel
    let lang: Lang
    let openSettings: () -> Void
    /// Called with the selected text and its rectangle in window coordinates.
    var onSelectText: (String, String, CGRect) -> Void = { _, _, _ in }

    /// Printed-page colours: the translation reads like the PDF beside it, in either theme.
    static let paper = Color.white
    static let ink = NSColor(srgbRed: 0x21 / 255, green: 0x1F / 255, blue: 0x1A / 255, alpha: 1)
    static let faint = Color(nsColor: NSColor(srgbRed: 0x6F / 255, green: 0x64 / 255, blue: 0x57 / 255, alpha: 1))

    private var t: UIText { UIText(lang) }

    var body: some View {
        if let card = reader.cards.cards.first(where: { $0.id == cardId }) {
            let answer = card.messages.last { $0.role == .assistant }
            VStack(alignment: .leading, spacing: 0) {
                header(card, answer: answer)
                    .padding(.bottom, 14)
                content(card, answer: answer)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .padding(EdgeInsets(top: 20, leading: 52, bottom: 40, trailing: 44))
            .frame(width: card.width, height: card.height.map { CGFloat($0) } ?? 980, alignment: .topLeading)
            .background(Self.paper)
            .overlay(Rectangle().stroke(Color.black.opacity(0.06)))
            .shadow(color: .black.opacity(0.10), radius: 10, y: 3)
            .background(GeometryReader { g in
                Color.clear
                    .onAppear { report(g.size.height) }
                    .onChange(of: g.size.height) { _, h in report(h) }
            })
        }
    }

    private func report(_ height: Double) {
        if abs((reader.heights[cardId] ?? 0) - height) > 0.5 { reader.heights[cardId] = height }
    }

    private func header(_ card: YarnCard, answer: YarnMessage?) -> some View {
        let language = Lang(rawValue: card.translationLanguage ?? "")?.languageName ?? ""
        return HStack(spacing: 8) {
            Image(systemName: "translate").font(.system(size: 10, weight: .semibold))
            Text(t("translationOf", ["language": language, "page": card.translatedPage ?? 0]).uppercased(with: Locale(identifier: lang.rawValue)))
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.9)
            if answer?.state == .streaming, card.batchJob == nil, !(answer?.content.isEmpty ?? true) {
                Text("· " + t["translating"]).font(.system(size: 10))
            }
            Spacer(minLength: 8)
            // The translation's text size, for every translated page of this book (owner test 15 Nov).
            Button { reader.stepTranslationText(-1) } label: { Image(systemName: "textformat.size.smaller").frame(width: 22, height: 22) }
                .buttonStyle(.borderless)
                .help(t["textSmaller"])
                .accessibilityLabel(t["textSmaller"])
                .disabled(!reader.canShrinkTranslationText)
            Button { reader.stepTranslationText(1) } label: { Image(systemName: "textformat.size.larger").frame(width: 22, height: 22) }
                .buttonStyle(.borderless)
                .help(t["textLarger"])
                .accessibilityLabel(t["textLarger"])
                .disabled(!reader.canGrowTranslationText)
            if answer?.state != .streaming {
                Button { reader.cards.retranslate(cardId) } label: { Image(systemName: "arrow.clockwise").frame(width: 22, height: 22) }
                    .buttonStyle(.borderless)
                    .help(t["retranslate"])
            }
            Button { reader.cards.remove(cardId) } label: { Image(systemName: "xmark").frame(width: 22, height: 22) }
                .buttonStyle(.borderless)
                .help(t["close"])
        }
        .foregroundStyle(Self.faint)
    }

    @ViewBuilder
    private func content(_ card: YarnCard, answer: YarnMessage?) -> some View {
        // No answer yet: waiting for its batch or its wave.
        if answer == nil {
            waiting(card)
        } else {
            answerView(card, answer: answer)
        }
    }

    @ViewBuilder
    private func answerView(_ card: YarnCard, answer: YarnMessage?) -> some View {
        switch (answer?.state, answer?.content.isEmpty ?? true) {
        case (.error, _):
            VStack(alignment: .leading, spacing: 8) {
                Text(Self.errorText(answer?.content ?? "", t)).font(.system(size: 13)).foregroundStyle(Color(nsColor: Self.ink))
                if answer?.content == "no-key" || answer?.content == "key" {
                    LinkButton(title: t["openSettings"], action: openSettings)
                } else {
                    LinkButton(title: t["retry"]) { reader.cards.retranslate(cardId) }
                }
            }
        case (.streaming, true):
            waiting(card)
        default:
            TranslationText(
                text: answer?.content ?? "",
                scale: reader.translationTextScale,
                marks: reader.marks(inCard: cardId).map { AnswerTextView.Mark(text: $0.text, color: Theme.highlight($0.color), near: $0.rect, multiply: true) },
                onPress: { reader.pending = nil }
            ) { text, rect in onSelectText(cardId, text, rect) }
        }
    }

    /// Waiting on its batch job (or its direct answer). A page in a batch can be translated now at
    /// once, at the normal price, while the others stay in the queue (owner, 15 Nov: batches can take
    /// long; the button used to appear only after a minute).
    private func waiting(_ card: YarnCard) -> some View {
        let inBatch = reader.cards.isWaitingForBatch(card.id)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(inBatch ? t["batchWaiting"] : t["translating"])
                    .font(.system(size: 13))
                    .foregroundStyle(Self.faint)
            }
            if inBatch {
                LinkButton(title: t["translateNow"]) { reader.cards.translateNow(cardId) }
                Text(t["batchNowNote"])
                    .font(.system(size: 12))
                    .foregroundStyle(Self.faint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// What a failed page says; every error but a missing or rejected key offers Retry, which
    /// translates the page directly.
    static func errorText(_ code: String, _ t: UIText) -> String {
        switch code {
        case "no-key": t["noKeyBody"]
        case "expired": t["batchExpired"]
        case "batch": t["batchFailed"]
        case "key-changed": t["batchKeyChanged"]
        case "network": t["errorNetwork"]
        case "key": t["errorKey"]
        case "quota": t["errorQuota"]
        case "blocked": t["errorBlocked"]
        default: t["errorUnknown"]
        }
    }
}

/// The translated text: paragraphs, headings and list items laid out like a page, sized to fill the
/// page without running over; selectable (selecting opens the same menu as on the PDF).
struct TranslationText: NSViewRepresentable {
    let text: String
    /// The reader's size on top of the size that fits the page (×1 = just fits).
    var scale: Double = 1
    var marks: [AnswerTextView.Mark] = []
    var onPress: (() -> Void)?
    let onSelect: (String, CGRect) -> Void

    func makeNSView(context: Context) -> FittingTextView {
        FittingTextView()
    }

    func updateNSView(_ view: FittingTextView, context: Context) {
        view.textView.onSelect = onSelect
        view.textView.onPress = onPress
        view.textView.marks = marks
        if view.source != text || view.scale != scale {
            view.source = text
            view.scale = scale
            view.needsLayout = true
        }
    }
}

/// Picks the largest reading size (10–16 pt) at which the text fits; scrolls only if even the
/// smallest does not. The reader's scale then makes that size smaller or larger (8–30 pt); text larger
/// than the page scrolls inside it.
final class FittingTextView: NSView {
    let scroll = NSScrollView()
    let textView = AnswerTextView(usingTextLayoutManager: false)
    var source = ""
    /// The reader's size on top of the size that fits (×1 = just fits).
    var scale: Double = 1
    /// The size that fits the page, and the size shown (after the reader's scale), in points.
    private(set) var fittedSize: Double = 16
    private(set) var shownSize: Double = 16
    private var laidOut: (String, CGSize, Double)?

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.textContainerInset = .zero
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.selectedTextAttributes = [.backgroundColor: NSColor.selectedTextBackgroundColor.withAlphaComponent(0.5)]
        scroll.documentView = textView
        addSubview(scroll)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        scroll.frame = bounds
        guard bounds.width > 0, bounds.height > 0, laidOut.map({ $0.0 != source || $0.1 != bounds.size || $0.2 != scale }) ?? true else { return }
        laidOut = (source, bounds.size, scale)
        var size = 16.0
        var attributed = Self.attributed(source, size: size)
        while size > 10, Self.height(of: attributed, width: bounds.width) > bounds.height {
            size -= 0.5
            attributed = Self.attributed(source, size: size)
        }
        if abs(scale - 1) > 0.001 {
            fittedSize = size
            size = min(max((size * scale * 2).rounded() / 2, 8), 30)
            attributed = Self.attributed(source, size: size)
        } else {
            fittedSize = size
        }
        shownSize = size
        let fits = Self.height(of: attributed, width: bounds.width) <= bounds.height
        scroll.hasVerticalScroller = !fits
        textView.textStorage?.setAttributedString(attributed)
        textView.frame = CGRect(x: 0, y: 0, width: bounds.width, height: max(bounds.height, Self.height(of: attributed, width: bounds.width)))
    }

    static func height(of text: NSAttributedString, width: CGFloat) -> CGFloat {
        let storage = NSTextStorage(attributedString: text)
        let container = NSTextContainer(size: CGSize(width: width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        let layout = NSLayoutManager()
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        layout.ensureLayout(for: container)
        return ceil(layout.usedRect(for: container).height)
    }

    /// The translation's Markdown (headings, lists, quotes, lines, emphasis) in the reading face, on the
    /// page's own light paper whatever the app's appearance.
    static func attributed(_ source: String, size: Double) -> NSAttributedString {
        let base = NSFont(descriptor: NSFont.systemFont(ofSize: size).fontDescriptor.withDesign(.serif) ?? NSFont.systemFont(ofSize: size).fontDescriptor, size: size) ?? .systemFont(ofSize: size)
        let soft = NSColor(srgbRed: 0x6F / 255, green: 0x64 / 255, blue: 0x57 / 255, alpha: 1)
        let style = MarkdownText.Style(
            font: base, color: TranslatedPageView.ink, soft: soft, line: NSColor(white: 0, alpha: 0.16),
            lineSpacing: size * 0.28, blockSpacing: size * 0.55, itemSpacing: size * 0.25, headingSpacing: size * 0.9, headingScale: 1.12
        )
        return MarkdownText.attributed(source, style: style)
    }
}
