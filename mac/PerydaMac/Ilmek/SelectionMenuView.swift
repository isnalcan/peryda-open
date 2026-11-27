import PerydaKit
import SwiftUI

/// Two rows under a selection: quick threads and tools, then an always-open question field.
struct SelectionMenuView: View {
    let reader: ReaderModel
    let lang: Lang
    @State private var text = ""
    @State private var noteMode = false
    @FocusState private var focused: Bool

    private var t: UIText { UIText(lang) }
    /// The quick threads offered under a selection, in this order.
    static let quick: [YarnColor] = [.lavender, .mint, .coral]

    var body: some View {
        let isCard = reader.pending?.parentCardId != nil
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 2) {
                if reader.bridgeHeld != nil && !isCard {
                    Button { reader.compareBridge() } label: {
                        Label(t["bridgeCompare"], systemImage: "link").font(.system(size: 12.5, weight: .semibold))
                    }
                    .buttonStyle(MenuChipStyle(color: .yarn(.sky)))
                } else {
                    ForEach(Self.quick, id: \.self) { color in
                        Button { reader.create(color: color, kind: .quick(color)) } label: {
                            HStack(spacing: 6) {
                                Circle().fill(Color.yarn(color)).frame(width: 7, height: 7)
                                Text(Compose.kindLabel(lang, color))
                            }
                            .font(.system(size: 12.5, weight: .semibold))
                        }
                        .buttonStyle(MenuChipStyle(color: .yarn(color)))
                    }
                }
                Divider().frame(height: 18).padding(.horizontal, 4)
                tool("translate", SharedContract.kinds.translate.label.text(lang)) { reader.create(color: .sky, kind: .translate) }
                if reader.bridgeHeld == nil && !isCard {
                    tool("link", t["bridge"]) { reader.holdBridge() }
                }
                if !isCard {
                    tool("bookmark", t["clip"]) { reader.clip(lang: lang) }
                }
                if reader.canHighlight {
                    HighlightButton(reader: reader, lang: lang)
                }
                if !reader.removableHighlights.isEmpty {
                    Button { reader.removeHighlights(lang: lang) } label: {
                        Text(t["removeHighlight"]).font(.system(size: 12.5, weight: .semibold))
                    }
                    .buttonStyle(MenuChipStyle(color: .inkSoft))
                    .help(t["removeHighlight"])
                }
                tool(noteMode ? "note.text.badge.plus" : "note.text", t["myNote"], active: noteMode) {
                    noteMode.toggle()
                    focused = true
                }
            }
            .padding(6)
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                // As wide as the menu's buttons, whatever is typed: a long question wraps, grows to four
                // lines, then scrolls inside the field (owner, 16 Nov: the field grew past the window).
                TextField(noteMode ? t["notePlaceholder"] : t["askPlaceholder"], text: $text, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(noteMode ? .reading(14) : .body)
                    .lineLimit(1...4)
                    .frame(minWidth: 120, idealWidth: 120, maxWidth: .infinity, alignment: .leading)
                    .focused($focused)
                    .onSubmit(submit)
                Button(action: submit) { Image(systemName: "arrow.up") }
                    .buttonStyle(SendButtonStyle())
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
        .background(Color.paperRaised, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.1)))
        .shadow(color: .black.opacity(0.14), radius: 20, y: 10)
        .fixedSize()
        .onExitCommand { reader.pending = nil }
    }

    private func submit() {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        if noteMode {
            reader.create(color: .cream, kind: .quick(.cream), text: body)
        } else {
            reader.create(color: .mint, kind: .question, text: body)
        }
        text = ""
    }

    private func tool(_ symbol: String, _ label: String, active: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 13)).frame(width: 30, height: 28)
        }
        .buttonStyle(MenuChipStyle(color: active ? .yarn(.cream) : .inkSoft, active: active))
        .help(label)
        .accessibilityLabel(label)
    }
}

struct MenuChipStyle: ButtonStyle {
    var color: Color
    var active = false
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 8)
            .frame(height: 30)
            .foregroundStyle(Color.ink)
            .background(RoundedRectangle(cornerRadius: 8).fill(color.opacity(active || hovering || configuration.isPressed ? 0.14 : 0)))
            .onHover { hovering = $0 }
    }
}

/// "Vurgula": a click highlights in the colour in use; holding it for two seconds (a ring fills while
/// it is held) offers the four colours, as does a right-click (owner, 16 Nov). The colour chosen stays
/// in use.
struct HighlightButton: View {
    let reader: ReaderModel
    let lang: Lang
    /// How long the button is held before the colours open (the owner's number).
    static let hold: Duration = .seconds(2)
    @State private var pressed = false
    @State private var progress: CGFloat = 0
    @State private var opened = false
    @State private var choosing = false
    @State private var holding: Task<Void, Never>?
    @State private var hovering = false

    private var t: UIText { UIText(lang) }

    static func name(_ id: String, _ t: UIText) -> String {
        switch id {
        case "green": t["highlightGreen"]
        case "pink": t["highlightPink"]
        case "blue": t["highlightBlue"]
        default: t["highlightYellow"]
        }
    }

    var body: some View {
        VStack(spacing: 2) {
            Image(systemName: "highlighter").font(.system(size: 13))
            Capsule().fill(Color(nsColor: Theme.hex(HighlightColor.hex(reader.highlightColor)))).frame(width: 14, height: 3)
        }
        .frame(width: 30, height: 28)
        .overlay {
            Circle()
                .trim(from: 0, to: progress)
                .stroke(Color.peryda, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .frame(width: 26, height: 26)
                .opacity(progress > 0 ? 1 : 0)
        }
        .padding(.horizontal, 8)
        .frame(height: 30)
        .foregroundStyle(Color.ink)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.inkSoft.opacity(pressed || hovering ? 0.14 : 0)))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        // The press is followed by AppKit itself: a hold with the pointer still is seen at once, and a
        // right-click opens the colours too.
        .overlay(PressCatcher(down: begin, up: end, right: { choosing = true }))
        .popover(isPresented: $choosing, arrowEdge: .bottom) { swatches }
        .help(t["highlightHold"])
        .accessibilityElement()
        .accessibilityLabel(t["highlight"])
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { reader.highlight(lang: lang) }
    }

    /// The four colours, the one in use ringed.
    private var swatches: some View {
        HStack(spacing: 10) {
            ForEach(HighlightColor.ids, id: \.self) { id in
                Button {
                    choosing = false
                    reader.highlight(lang: lang, color: id)
                } label: {
                    Circle()
                        .fill(Color(nsColor: Theme.hex(HighlightColor.hex(id))))
                        .frame(width: 26, height: 26)
                        .overlay(Circle().stroke(Color.ink.opacity(id == reader.highlightColor ? 0.8 : 0.15), lineWidth: id == reader.highlightColor ? 2 : 1))
                        .padding(2)
                }
                .buttonStyle(.plain)
                .help(Self.name(id, t))
                .accessibilityLabel(Self.name(id, t))
            }
        }
        .padding(12)
    }

    private func begin() {
        guard !pressed else { return }
        pressed = true
        opened = false
        withAnimation(.linear(duration: 2)) { progress = 1 }
        holding = Task { @MainActor in
            try? await Task.sleep(for: Self.hold)
            guard !Task.isCancelled, pressed else { return }
            opened = true
            choosing = true
            withAnimation(.easeOut(duration: 0.15)) { progress = 0 }
        }
    }

    private func end() {
        guard pressed else { return }
        holding?.cancel()
        holding = nil
        pressed = false
        withAnimation(.easeOut(duration: 0.15)) { progress = 0 }
        // Let go before the colours opened: an ordinary click.
        if !opened { reader.highlight(lang: lang) }
        opened = false
    }
}

/// A transparent AppKit view over a SwiftUI control that reports the left button going down and up,
/// and a right-click: SwiftUI gestures did not see a press that was held without moving.
struct PressCatcher: NSViewRepresentable {
    var down: () -> Void
    var up: () -> Void
    var right: () -> Void

    final class View: NSView {
        var down: () -> Void = {}
        var up: () -> Void = {}
        var right: () -> Void = {}
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func mouseDown(with event: NSEvent) { down() }
        override func mouseUp(with event: NSEvent) { up() }
        override func rightMouseDown(with event: NSEvent) { right() }
    }

    func makeNSView(context: Context) -> View { View() }

    func updateNSView(_ view: View, context: Context) {
        view.down = down
        view.up = up
        view.right = right
    }
}
