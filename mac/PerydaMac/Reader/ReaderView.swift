import PerydaKit
import SwiftUI

struct ReaderView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openSettings) private var openSettings
    let book: BookRecord
    @State private var reader: ReaderModel?
    @State private var failed = false

    var body: some View {
        Group {
            if let reader, reader.epub != nil {
                EpubReaderSurface(reader: reader)
            } else if let reader {
                ReaderSurface(reader: reader)
            } else if failed {
                Text(app.t["importFailed"]).foregroundStyle(Color.inkSoft).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(book.title)
        .task {
            // Shown again after its window closed: start over (an EPUB is unpacked again).
            if reader?.isClosed == true { reader = nil }
            guard reader == nil else { return }
            if book.format == .pdf, let model = ReaderModel(book: book, app: app) {
                reader = model
            } else if book.format == .epub, let model = ReaderModel(epubBook: book, store: app.store, lang: app.lang, settings: app.settings, streamer: app.streamer) {
                reader = model
            } else {
                failed = true
            }
        }
        .onDisappear { reader?.close() }
        .onChange(of: app.settings) { _, s in
            reader?.cards.settings = s
            reader?.readings?.settings = s
        }
        .onChange(of: app.lang) { _, l in reader?.cards.lang = l }
        .onChange(of: app.explainTerms) { _, on in reader?.cards.explainTerms = on }
    }
}

struct ReaderSurface: View {
    @Environment(AppModel.self) private var app
    /// The translation options panel is open.
    @State private var translateOptions = false
    @Environment(\.openSettings) private var openSettings
    @Bindable var reader: ReaderModel

    var body: some View {
        let t = app.t
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                WorldRepresentable(reader: reader, lang: app.lang, openSettings: { openSettings() })
                if let pending = reader.pending {
                    SelectionMenuView(reader: reader, lang: app.lang)
                        .id(pending.anchors.first?.id)
                        .modifier(MenuPlacement(anchor: pending.rect, bounds: geo.size))
                        .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
                }
                if reader.bridgeHeld != nil {
                    Banner(text: t["bridgeHeld"], action: t["cancel"]) { reader.bridgeHeld = nil }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 12)
                }
                if let id = reader.offscreenCard {
                    HStack {
                        Text(t["offscreenThread"])
                        Button(t["show"]) { reader.cameraCommand = .show(cardId: id) }.buttonStyle(.link)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Color.paperRaised, in: RoundedRectangle(cornerRadius: 10))
                    .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(16)
                    .task(id: id) {
                        try? await Task.sleep(for: .seconds(8))
                        if reader.offscreenCard == id { reader.offscreenCard = nil }
                    }
                }
                CameraBar(reader: reader, t: t)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(16)
                if let toast = reader.toast {
                    Text(toast)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(Color.paper)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Color.ink, in: RoundedRectangle(cornerRadius: 10))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                        .padding(.bottom, 24)
                }
            }
            .animation(.spring(duration: 0.18, bounce: 0), value: reader.pending?.anchors.first?.id)
        }
        .inspector(isPresented: $reader.showJournal) {
            JournalPanel(reader: reader, lang: app.lang, openSettings: { openSettings() })
                .inspectorColumnWidth(min: 300, ideal: 380, max: 520)
        }
        .sheet(item: $reader.extractingPage) { request in
            ExtractedTextSheet(reader: reader, page: request.page, lang: app.lang)
        }
        .sheet(isPresented: $reader.askingRange) {
            TranslateRangeSheet(reader: reader, t: t)
        }
        .focusedSceneValue(\.reader, reader)
        .toolbar {
            ToolbarItemGroup(placement: .navigation) {
                ToolSwitcher(tool: $reader.tool, t: t)
            }
            ToolbarItemGroup(placement: .primaryAction) {
                ControlGroup {
                    Button { reader.cameraCommand = .previousPage } label: { Image(systemName: "chevron.left") }
                        .help(t["previousPage"])
                        .disabled(reader.currentPage <= 1)
                    GoToPageButton(reader: reader, t: t)
                    Button { reader.cameraCommand = .nextPage } label: { Image(systemName: "chevron.right") }
                        .help(t["nextPage"])
                        .disabled(reader.currentPage >= reader.pages.count)
                }
                Picker(t["readByPage"], selection: $reader.pagedReading) {
                    Label(t["readScrolling"], systemImage: "scroll").tag(false)
                    Label(t["readByPage"], systemImage: "book.pages").tag(true)
                }
                .pickerStyle(.segmented)
                .help(reader.pagedReading ? t["readByPage"] : t["readScrolling"])
                if reader.pendingTranslations > 0 {
                    // While pages are on their way the reader can always see how many, and stop them in one click.
                    // The spinner gets a frame of its own and the row an inset, so neither runs past the
                    // toolbar's rounded background (owner test 14 Nov: the spinner overflowed it).
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small).frame(width: 16, height: 16)
                        Text(t("translationsPending", ["n": reader.pendingTranslations])).monospacedDigit().foregroundStyle(.secondary)
                        Button { reader.stopTranslating(lang: app.lang) } label: { Image(systemName: "stop.fill") }
                            .help(t["stopTranslating"])
                            .accessibilityLabel(t["stopTranslating"])
                    }
                    .padding(.horizontal, 8)
                }
                // "Translate" translates the page in view; the chevron opens the options in a panel that
                // stays open while "Explain terms in parentheses" is switched (owner, 16 Nov: the menu
                // closed on it, and the switch did not take).
                ControlGroup {
                    Button { reader.startTranslating() } label: {
                        Label(t["translatePages"], systemImage: "translate")
                    }
                    .help(t["translateThisPage"])
                    Button { translateOptions.toggle() } label: {
                        Image(systemName: "chevron.down")
                    }
                    .help(t["translationOptions"])
                    .accessibilityLabel(t["translationOptions"])
                    .popover(isPresented: $translateOptions, arrowEdge: .bottom) {
                        TranslateOptions(reader: reader, app: app, t: t) { translateOptions = false }
                    }
                }
                Toggle(isOn: $reader.showJournal) {
                    Label(t["journal"], systemImage: "book.closed")
                }
                .help(t["journal"])
                Toggle(isOn: $reader.hideThreads) {
                    Label(reader.hideThreads ? t["showThreads"] : t["hideThreads"], systemImage: reader.hideThreads ? "eye" : "eye.slash")
                }
                .help(reader.hideThreads ? t["showThreads"] : t["hideThreads"])
            }
        }
    }
}

/// Translation options: the language (choosing one translates the page in view), whether terms are
/// explained in parentheses (switching it leaves the panel open), a range of pages, the page's text,
/// and stopping translations on their way.
struct TranslateOptions: View {
    let reader: ReaderModel
    @Bindable var app: AppModel
    let t: UIText
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(t["translateInto"]).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Lang.allCases, id: \.self) { l in
                    Button {
                        reader.translationTarget = l
                        reader.startTranslating()
                        close()
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark").opacity(l == reader.translationTarget ? 1 : 0).frame(width: 14)
                            Text(l.languageName.capitalized)
                            Spacer()
                        }
                        .contentShape(Rectangle())
                        .padding(.vertical, 3)
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(Color.ink)
                }
            }
            Divider()
            Toggle(t["explainTerms"], isOn: $app.explainTerms)
                .toggleStyle(.checkbox)
            Divider()
            VStack(alignment: .leading, spacing: 6) {
                Button(t["translateRange"]) {
                    close()
                    reader.askingRange = true
                }
                Button(t["extractText"]) {
                    close()
                    reader.extractingPage = .init(page: reader.currentPage)
                }
                if reader.pendingTranslations > 0 {
                    Button(t["stopTranslating"]) { reader.stopTranslating(lang: app.lang) }
                }
            }
            .buttonStyle(.borderless)
            .foregroundStyle(Color.ink)
        }
        .padding(14)
        .frame(width: 280, alignment: .leading)
    }
}

/// Select and area: the tool in use is always marked (select when a book opens). The thread brush was
/// taken out (owner, 16 Nov): selecting and choosing from the menu does the same.
struct ToolSwitcher: View {
    @Binding var tool: ReaderTool
    let t: UIText

    var body: some View {
        HStack(spacing: 2) {
            item(.select, "cursorarrow", t["toolSelect"])
            item(.area, "viewfinder", t["toolArea"])
        }
        // Inset from the toolbar's rounded background, with a rounded mark of the same shape inside it
        // (owner test 14 Nov: the square mark ran past the background's rounded end).
        .padding(.horizontal, 4)
    }

    private func item(_ value: ReaderTool, _ symbol: String, _ label: String) -> some View {
        Button { tool = value } label: {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .medium))
                .frame(width: 32, height: 24)
                .background(Capsule().fill(tool == value ? Color.primary.opacity(0.13) : .clear))
                .contentShape(Capsule())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(tool == value ? Color.ink : Color.inkSoft)
        .help(label)
        .accessibilityLabel(label)
        .accessibilityAddTraits(tool == value ? .isSelected : [])
    }
}

/// A page number that can be typed as well as stepped. What is typed is checked against the book only
/// when the field is left or Return is pressed (owner test 15 Nov: reaching page 150 took 144 clicks of
/// the stepper, and a field that checks every keystroke snaps back while a number is being typed).
struct PageNumberField: View {
    let title: String
    @Binding var value: Int
    let range: ClosedRange<Int>

    var body: some View {
        LabeledContent(title) {
            HStack(spacing: 6) {
                TextField(title, value: Binding(get: { value }, set: { value = min(max($0, range.lowerBound), range.upperBound) }), format: .number.grouping(.never))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .multilineTextAlignment(.trailing)
                    .monospacedDigit()
                    .frame(width: 72)
                Stepper(title, value: $value, in: range)
                    .labelsHidden()
            }
        }
    }
}

/// Which pages to translate; more than two go to Gemini as one batch job.
struct TranslateRangeSheet: View {
    @Bindable var reader: ReaderModel
    let t: UIText
    @Environment(\.dismiss) private var dismiss
    @State private var from = 1
    @State private var to = 1

    /// The last page that may be asked for from `from`: at most 50 pages at once.
    static func upperLimit(from: Int, pageCount: Int) -> Int {
        max(1, min(pageCount, from + CardsModel.maxPages - 1))
    }

    var body: some View {
        let count = max(0, to - from + 1)
        let limit = Self.upperLimit(from: from, pageCount: reader.pages.count)
        Form {
            PageNumberField(title: t["fromPage"], value: $from, range: 1...max(1, reader.pages.count))
            PageNumberField(title: t["toPage"], value: $to, range: from...max(from, limit))
            Text(t("pagesToTranslate", ["n": count])).font(.headline)
            if reader.pages.count > CardsModel.maxPages {
                Text(t("rangeLimit", ["n": CardsModel.maxPages])).font(.callout).foregroundStyle(count >= CardsModel.maxPages ? Color.ink : .secondary)
            }
            Text(t["rangeBatchNote"]).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button(t["cancel"]) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(t["translate"]) {
                    reader.translateRange(from...max(from, to))
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(count == 0)
            }
        }
        .formStyle(.grouped)
        .frame(width: 440)
        .onAppear {
            from = reader.currentPage
            to = min(reader.pages.count, reader.currentPage + 9)
        }
        .onChange(of: from) { _, v in to = min(max(to, v), Self.upperLimit(from: v, pageCount: reader.pages.count)) }
    }
}

/// The page number; a click asks which page to go to.
struct GoToPageButton: View {
    @Bindable var reader: ReaderModel
    let t: UIText
    @State private var asking = false
    @State private var text = ""

    var body: some View {
        Button {
            text = "\(reader.currentPage)"
            asking = true
        } label: {
            Text(t("pageOf", ["p": reader.currentPage, "n": reader.pages.count])).monospacedDigit()
        }
        .help(t["goToPage"])
        .popover(isPresented: $asking, arrowEdge: .bottom) {
            HStack(spacing: 8) {
                TextField(t["pageNumber"], text: $text)
                    .frame(width: 90)
                    .onSubmit(go)
                Text("/ \(reader.pages.count)").foregroundStyle(.secondary).monospacedDigit()
                Button(t["goToPage"], action: go).keyboardShortcut(.defaultAction)
            }
            .padding(12)
        }
    }

    private func go() {
        if let n = Int(text.trimmingCharacters(in: .whitespaces)), n >= 1, n <= reader.pages.count {
            reader.cameraCommand = .goToPage(n)
        }
        asking = false
    }
}

struct ReaderFocusKey: FocusedValueKey {
    typealias Value = ReaderModel
}

extension FocusedValues {
    /// The reader in the front window, for the menus.
    var reader: ReaderModel? {
        get { self[ReaderFocusKey.self] }
        set { self[ReaderFocusKey.self] = newValue }
    }
}

/// View and Go menu items for the front reader window, with their shortcuts.
struct ReaderCommands: Commands {
    let model: AppModel
    @FocusedValue(\.reader) private var reader

    var body: some Commands {
        let t = model.t
        CommandGroup(after: .toolbar) {
            Button(t["cameraFocus"]) { reader?.cameraCommand = .focus }
                .keyboardShortcut("1")
                .disabled(reader?.document == nil)
            Button(t["cameraMap"]) { reader?.cameraCommand = .map }
                .keyboardShortcut("2")
                .disabled(reader?.document == nil)
            Divider()
            Toggle(t["readByPage"], isOn: Binding(get: { reader?.pagedReading ?? false }, set: { reader?.pagedReading = $0 }))
                .keyboardShortcut("p", modifiers: [.command, .shift])
                .disabled(reader?.document == nil)
            Toggle(t["hideThreads"], isOn: Binding(get: { reader?.hideThreads ?? false }, set: { reader?.hideThreads = $0 }))
                .keyboardShortcut("h", modifiers: [.command, .shift])
                .disabled(reader == nil)
            Toggle(t["journal"], isOn: Binding(get: { reader?.showJournal ?? false }, set: { reader?.showJournal = $0 }))
                .keyboardShortcut("j", modifiers: [.command, .shift])
                .disabled(reader == nil)
            Divider()
            Button(t["translateThisPage"]) { reader?.startTranslating() }
                .keyboardShortcut("t", modifiers: [.command, .shift])
                .disabled(reader?.document == nil)
            Button(t["translateRange"]) { reader?.askingRange = true }
                .disabled(reader?.document == nil)
            Toggle(t["explainTerms"], isOn: Binding(get: { model.explainTerms }, set: { model.explainTerms = $0 }))
            Button(t["extractText"]) { if let reader { reader.extractingPage = .init(page: reader.currentPage) } }
            Button(t["stopTranslating"]) { reader?.stopTranslating(lang: model.lang) }
                .keyboardShortcut(".", modifiers: [.command])
                .disabled((reader?.pendingTranslations ?? 0) == 0)
                .keyboardShortcut("e", modifiers: [.command, .shift])
                .disabled(reader?.document == nil)
        }
        CommandMenu(t["menuGo"]) {
            Button(t["previousPage"]) { reader?.cameraCommand = .previousPage }
                .keyboardShortcut(.upArrow, modifiers: [.command, .option])
                .disabled(reader?.document == nil)
            Button(t["nextPage"]) { reader?.cameraCommand = .nextPage }
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])
                .disabled(reader?.document == nil)
        }
    }
}

/// The camera controls, floating at the bottom right: faint until the pointer comes near, so they do
/// not sit on the page while reading.
struct CameraBar: View {
    @Bindable var reader: ReaderModel
    let t: UIText
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 2) {
            barButton(t["cameraFocus"]) { reader.cameraCommand = .focus }
            barButton(t["cameraMap"]) { reader.cameraCommand = .map }
            Divider().frame(height: 16).padding(.horizontal, 4)
            iconButton("minus", t["zoomOut"]) { reader.cameraCommand = .zoomOut }
                .keyboardShortcut("-")
            Button { reader.cameraCommand = .actualSize } label: {
                Text("\(Int((reader.magnification * 100).rounded()))%")
                    .monospacedDigit()
                    .frame(minWidth: 44)
            }
            .buttonStyle(.borderless)
            .keyboardShortcut("0")
            .help("100%")
            iconButton("plus", t["zoomIn"]) { reader.cameraCommand = .zoomIn }
                .keyboardShortcut("+")
        }
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(Color.ink)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(Color.primary.opacity(0.08)))
        .shadow(color: .black.opacity(hovering ? 0.12 : 0), radius: 10, y: 4)
        .opacity(hovering ? 1 : 0.4)
        .animation(.easeOut(duration: 0.15), value: hovering)
        .onHover { hovering = $0 }
    }

    private func barButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(title).padding(.horizontal, 8).padding(.vertical, 4) }
            .buttonStyle(.borderless)
    }

    private func iconButton(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).frame(width: 24, height: 22) }
            .buttonStyle(.borderless)
            .help(label)
    }
}

/// Places the selection menu under the selection, or above it near the bottom edge.
struct MenuPlacement: ViewModifier {
    let anchor: CGRect
    let bounds: CGSize
    @State private var size: CGSize = .zero

    func body(content: Content) -> some View {
        let margin = 12.0
        let below = anchor.maxY + 10
        let y = below + size.height > bounds.height - margin ? max(margin, anchor.minY - size.height - 10) : below
        let x = min(max(margin, anchor.midX - size.width / 2), max(margin, bounds.width - size.width - margin))
        content
            .background(GeometryReader { g in Color.clear.onAppear { size = g.size }.onChange(of: g.size) { _, s in size = s } })
            .offset(x: x, y: y)
    }
}

struct Banner: View {
    let text: String
    let action: String
    let onAction: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "link").foregroundStyle(Color.yarn(.sky))
            Text(text)
            Button(action, action: onAction).buttonStyle(.link)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.paperRaised, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.yarn(.sky).opacity(0.4)))
        .shadow(color: .black.opacity(0.1), radius: 12, y: 6)
    }
}

struct WorldRepresentable: NSViewRepresentable {
    let reader: ReaderModel
    let lang: Lang
    let openSettings: () -> Void

    func makeNSView(context: Context) -> WorldView {
        var world: WorldView?
        let view = WorldView(model: reader) { cardId in
            let select: (String, String, CGRect) -> Void = { id, text, rect in world?.cardTextSelected(id, text: text, windowRect: rect) }
            if reader.cards.cards.first(where: { $0.id == cardId })?.translatedPage != nil {
                return AnyView(TranslatedPageView(cardId: cardId, reader: reader, lang: lang, openSettings: openSettings, onSelectText: select))
            }
            return AnyView(YarnCardView(cardId: cardId, reader: reader, lang: lang, openSettings: openSettings, onSelectText: select, resizable: true))
        }
        world = view
        view.lang = lang
        return view
    }

    func updateNSView(_ view: WorldView, context: Context) {
        // Read what the surface depends on so SwiftUI updates it when any of it changes.
        _ = reader.cards.cards
        _ = reader.journal
        _ = reader.heights
        _ = reader.pending?.anchors.count
        _ = reader.bridgeHeld?.count
        _ = reader.focusedCard
        _ = reader.cameraCommand
        _ = reader.tool
        _ = reader.pagedReading
        _ = reader.currentPage
        view.lang = lang
        view.sync()
        view.window?.invalidateCursorRects(for: view)
    }
}
