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
                    tool("highlighter", t["highlight"]) { reader.highlight(lang: lang) }
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
