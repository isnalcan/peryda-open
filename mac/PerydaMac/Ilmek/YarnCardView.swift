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
    /// About three lines of the card's quote; longer passages get the shorten toggle.
    static let longQuote = 160

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

    /// The quote, the conversation and archive suggestions: what scrolls when the card is resized.
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
            let quote = card.anchors.map(\.selectedText).filter { !$0.isEmpty }.joined(separator: " · ")
            if !quote.isEmpty {
                let short = reader.shortQuotes.contains(cardId)
                VStack(alignment: .leading, spacing: 2) {
                    Text(quote)
                        .font(.reading(13))
                        .foregroundStyle(Color.inkSoft)
                        .lineLimit(short ? 3 : nil)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 10)
                        .overlay(alignment: .leading) { Rectangle().fill(Color.yarn(card.color)).frame(width: 2) }
                    // Long passages can be shortened to their first lines, and opened again.
                    if quote.count > Self.longQuote {
                        Button {
                            if short { reader.shortQuotes.remove(cardId) } else { reader.shortQuotes.insert(cardId) }
                        } label: {
                            Label(short ? t["quoteShowAll"] : t["quoteShorten"], systemImage: short ? "chevron.down" : "chevron.up")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(Color.inkFaint)
                        }
                        .buttonStyle(.borderless)
                        .padding(.leading, 10)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.top, 10)
            }
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
            if card.isPinned {
                iconButton("pin.slash", t["backToLane"]) { reader.cards.unpin(cardId) }
            }
            iconButton("bookmark", t["saveToJournal"]) { reader.saveToJournal(cardId, lang: lang) }
                .disabled(streaming || card.messages.isEmpty)
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

    private func iconButton(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 11, weight: .medium)).frame(width: 24, height: 24)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(Color.inkSoft)
        .help(label)
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func messageView(_ card: YarnCard, index: Int, message: YarnMessage, isNote: Bool) -> some View {
        switch (message.role, message.state) {
        case (.user, _):
            if isNote {
                SelectableAnswer(text: message.content) { text, rect in onSelectText(cardId, text, rect) }
            } else if index > 0 || card.kind == .question {
                SelectableAnswer(text: message.content, font: .systemFont(ofSize: 13, weight: .semibold)) { text, rect in onSelectText(cardId, text, rect) }
                    .padding(.top, 4)
            }
        case (.assistant, .error):
            VStack(alignment: .leading, spacing: 4) {
                Text(message.content == "no-key" ? t["noKeyBody"] : errorText(message.content)).font(.callout)
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
                Text("⁂").font(.system(size: 12)).foregroundStyle(Color.peryda)
                if message.content.isEmpty {
                    Text(t["thinking"]).font(.reading(14).italic()).foregroundStyle(Color.inkFaint)
                } else {
                    SelectableAnswer(text: message.content) { text, rect in onSelectText(cardId, text, rect) }
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

    /// Bold and italics from AI answers, journal entries and backups, never links: a link's text can
    /// hide where it goes (another app's URL scheme, a file share, a phishing page).
    static func markdown(_ text: String) -> AttributedString {
        var out = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
        for run in out.runs where run.link != nil || run.imageURL != nil {
            out[run.range].link = nil
            out[run.range].imageURL = nil
        }
        return out
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
