import PerydaKit
import SwiftUI

/// A thread card on the reading surface. Lives inside the magnified world, so it scales with the page.
struct YarnCardView: View {
    let cardId: String
    let reader: ReaderModel
    let lang: Lang
    let openSettings: () -> Void
    /// Called with the selected text and its rectangle in window coordinates.
    var onSelectText: (String, String, CGRect) -> Void = { _, _, _ in }
    /// Shows the resize grip in the bottom-right corner (cards on the reading surface).
    var resizable = false

    @State private var draft = ""
    @State private var replying = false
    @FocusState private var fieldFocused: Bool
    @State private var confirmRemove = false

    private var t: UIText { UIText(lang) }
    /// The book's card text size (the − and + in the header).
    private var s: CGFloat { reader.cardTextScale }

    var body: some View {
        if let card = reader.cards.cards.first(where: { $0.id == cardId }) {
            // A card the reader resized keeps that height; otherwise it is as tall as its content.
            content(card)
                .frame(width: card.width, height: card.height.map { CGFloat($0) }, alignment: .topLeading)
                .fixedSize(horizontal: false, vertical: card.height == nil)
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

    @ViewBuilder
    private func content(_ card: YarnCard) -> some View {
        let streaming = card.messages.contains { $0.state == .streaming }
        let isNote = card.kind == .quick(.cream)
        VStack(alignment: .leading, spacing: 0) {
            header(card, streaming: streaming)
            Divider()
            if card.height != nil {
                ScrollView { middle(card, isNote: isNote).frame(maxWidth: .infinity, alignment: .leading) }
                    .frame(maxHeight: .infinity)
            } else {
                middle(card, isNote: isNote)
            }
            Divider()
            footer(card, streaming: streaming, isNote: isNote)
        }
        .background(Color.paperRaised)
        .overlay(alignment: .bottomTrailing) { if resizable { ResizeGrip().padding(3) } }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(card.isPinned ? Color.yarn(card.color).opacity(0.4) : Color.primary.opacity(0.1)))
        .shadow(color: .black.opacity(0.08), radius: 14, y: 6)
        .simultaneousGesture(TapGesture().onEnded { reader.focusedCard = cardId })
        .alert(t["removeCard"], isPresented: $confirmRemove) {
            Button(t["cancel"], role: .cancel) {}
            Button(t["delete"], role: .destructive) { reader.cards.remove(cardId) }
        } message: {
            Text(t["removeCardConfirm"])
        }
    }

    /// A region's picture, the conversation and archive suggestions: what scrolls when the card is resized.
    @ViewBuilder
    private func middle(_ card: YarnCard, isNote: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let image = card.anchors.compactMap(\.croppedImage).first, let nsImage = Self.image(fromDataURL: image) {
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxHeight: 120, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.primary.opacity(0.1)))
                    .padding(.horizontal, 14)
                    .padding(.top, 12)
            }
            // The passage itself is not repeated: it is marked where it was chosen (on the page, a card or
            // a translation), so the card is the answer alone (owner, 16 Nov). A region of the page keeps
            // its picture.
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(card.messages.enumerated()), id: \.element.id) { index, message in
                    messageView(card, index: index, message: message, isNote: isNote)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
    }

    private func header(_ card: YarnCard, streaming: Bool) -> some View {
        HStack(spacing: 8) {
            Circle().fill(Color.yarn(card.color)).frame(width: 8, height: 8)
            Text(Compose.kindTitle(lang, card.kind))
                .font(.system(size: 10.5, weight: .bold))
                .tracking(0.9)
                .foregroundStyle(Color.yarn(card.color))
            Spacer(minLength: 4)
            // Text size for every card of this book (owner test 14 Nov: some PDFs leave cards small).
            iconButton("textformat.size.smaller", t["textSmaller"]) { reader.stepCardText(-1) }
                .disabled(!reader.canShrinkCardText)
            iconButton("textformat.size.larger", t["textLarger"]) { reader.stepCardText(1) }
                .disabled(!reader.canGrowCardText)
            if card.isPinned {
                iconButton("pin.slash", t["backToLane"]) { reader.cards.unpin(cardId) }
            }
            journalButton(card, streaming: streaming)
            iconButton("arrow.down.right.and.arrow.up.left", t["collapse"]) { reader.cards.setCollapsed(cardId, true) }
            iconButton("xmark", t["removeCard"]) {
                if card.messages.count <= 1 { reader.cards.remove(cardId) } else { confirmRemove = true }
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .frame(height: 36)
        .contentShape(Rectangle())
    }

    /// Saves the card to the journal once; then it stays lit. If the conversation went on since, it
    /// goes back to plain and a click brings the one entry up to date.
    private func journalButton(_ card: YarnCard, streaming: Bool) -> some View {
        let state = reader.journalState(cardId)
        let label = state == .saved ? t["inJournal"] : state == .outdated ? t["updateInJournal"] : t["saveToJournal"]
        return Button {
            if state != .saved { reader.saveToJournal(cardId, lang: lang) }
        } label: {
            Image(systemName: state == .saved ? "bookmark.fill" : "bookmark")
                .font(.system(size: 11, weight: .medium))
                .frame(width: 24, height: 24)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(state == .saved ? Color.yarn(card.color) : Color.inkSoft)
        .help(label)
        .accessibilityLabel(label)
        .accessibilityAddTraits(state == .saved ? .isSelected : [])
        .disabled(streaming || card.messages.isEmpty)
    }

    private func iconButton(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 11, weight: .medium)).frame(width: 24, height: 24)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(Color.inkSoft)
        .help(label)
        .accessibilityLabel(label)
    }

    /// Passages of this card that threads were opened from, in their colours.
    private var marks: [AnswerTextView.Mark] {
        reader.marks(inCard: cardId).map { AnswerTextView.Mark(text: $0.text, color: Theme.yarn($0.color).withAlphaComponent(0.26), near: $0.rect) }
    }

    /// A press in the card's text closes the selection menu (a new selection opens it again).
    private func pressed() { reader.pending = nil }

    @ViewBuilder
    private func messageView(_ card: YarnCard, index: Int, message: YarnMessage, isNote: Bool) -> some View {
        switch (message.role, message.state) {
        case (.user, _):
            if isNote {
                SelectableAnswer(text: message.content, font: SelectableAnswer.readingFont(14 * s), markdown: false, marks: marks, onPress: pressed) { text, rect in onSelectText(cardId, text, rect) }
            } else if index > 0 || card.kind == .question {
                // The reader's own message as a chat bubble on the right, so it stands out from the
                // answers while scrolling (owner, 20 Nov; same as the web).
                SelectableAnswer(text: message.content, font: .systemFont(ofSize: 13 * s, weight: .medium), markdown: false, marks: marks, onPress: pressed) { text, rect in onSelectText(cardId, text, rect) }
                    .padding(.horizontal, 10 * s)
                    .padding(.vertical, 6 * s)
                    .background(UnevenRoundedRectangle(topLeadingRadius: 12 * s, bottomLeadingRadius: 12 * s, bottomTrailingRadius: 4 * s, topTrailingRadius: 12 * s).fill(Color.peryda.opacity(0.09)))
                    .overlay(UnevenRoundedRectangle(topLeadingRadius: 12 * s, bottomLeadingRadius: 12 * s, bottomTrailingRadius: 4 * s, topTrailingRadius: 12 * s).strokeBorder(Color.peryda.opacity(0.22), lineWidth: 1))
                    .padding(.leading, 36 * s)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
            }
        case (.assistant, .error):
            VStack(alignment: .leading, spacing: 4) {
                Text(message.content == "no-key" ? t["noKeyBody"] : errorText(message.content)).font(.system(size: 13 * s))
                if message.content == "no-key" {
                    LinkButton(title: t["openSettings"], action: openSettings)
                } else {
                    LinkButton(title: t["retry"]) { reader.cards.retry(cardId) }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
        case (.assistant, _):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("⁂").font(.system(size: 12 * s)).foregroundStyle(Color.peryda)
                if message.content.isEmpty {
                    Text(t["thinking"]).font(.reading(14 * s).italic()).foregroundStyle(Color.inkFaint)
                } else {
                    SelectableAnswer(text: message.content, font: SelectableAnswer.readingFont(14 * s), marks: marks, onPress: pressed) { text, rect in onSelectText(cardId, text, rect) }
                }
            }
        }
    }

    private func footer(_ card: YarnCard, streaming: Bool, isNote: Bool) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            // A real text field per card is costly when many cards are zoomed; until the reader clicks
            // in, this is a label that turns into the field.
            if replying || !draft.isEmpty {
                TextField(isNote ? t["notePlaceholder"] : t["continuePlaceholder"], text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13 * s))
                    .lineLimit(1...6)
                    .focused($fieldFocused)
                    .onSubmit(send)
                    .onChange(of: fieldFocused) { _, focused in if !focused, draft.isEmpty { replying = false } }
            } else {
                Button {
                    replying = true
                    fieldFocused = true
                } label: {
                    Text(isNote ? t["notePlaceholder"] : t["continuePlaceholder"])
                        .font(.system(size: 13 * s))
                        .foregroundStyle(Color.inkFaint)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
            }
            if streaming {
                Button { reader.cards.stop(cardId) } label: { SendLabel(symbol: "stop.fill", enabled: true) }
                    .buttonStyle(.borderless)
                    .help(t["stop"])
            } else {
                let empty = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                Button(action: send) { SendLabel(symbol: "arrow.up", enabled: !empty) }
                    .buttonStyle(.borderless)
                    .disabled(empty)
                    .help(t["send"])
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private func send() {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        reader.cards.ask(cardId, body)
        draft = ""
    }

    private func errorText(_ code: String) -> String {
        switch code {
        case "network": t["errorNetwork"]
        case "key": t["errorKey"]
        case "quota": t["errorQuota"]
        case "blocked": t["errorBlocked"]
        default: t["errorUnknown"]
        }
    }

    static func image(fromDataURL url: String) -> NSImage? {
        guard let comma = url.firstIndex(of: ","), let data = Data(base64Encoded: String(url[url.index(after: comma)...])) else { return nil }
        return NSImage(data: data)
    }
}

/// Three short diagonal strokes in the bottom-right corner, where a card can be resized.
struct ResizeGrip: View {
    var body: some View {
        Canvas { ctx, size in
            for i in 1...3 {
                let d = Double(i) * size.width / 3
                var p = Path()
                p.move(to: CGPoint(x: size.width - d, y: size.height))
                p.addLine(to: CGPoint(x: size.width, y: size.height - d))
                ctx.stroke(p, with: .color(Color.inkFaint), lineWidth: 1)
            }
        }
        .frame(width: 10, height: 10)
        .allowsHitTesting(false)
    }
}

/// Buttons inside cards are AppKit-backed (borderless), so they work at any zoom of the world.
struct LinkButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) { Text(title).foregroundStyle(Color.peryda) }
            .buttonStyle(.borderless)
    }
}

struct SendLabel: View {
    let symbol: String
    let enabled: Bool

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(enabled ? Color.paper : Color.inkFaint)
            .frame(width: 26, height: 26)
            .background(Circle().fill(enabled ? Color.peryda : Color.primary.opacity(0.12)))
    }
}

struct SendButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(enabled ? Color.paper : Color.inkFaint)
            .frame(width: 26, height: 26)
            .background(Circle().fill(enabled ? Color.peryda : Color.primary.opacity(0.12)))
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
    }
}
