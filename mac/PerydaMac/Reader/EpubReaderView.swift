import AppKit
import PerydaKit
import SwiftUI
import WebKit

/// Converts AppKit window rectangles into the surface's own (top-left) coordinates for the menu.
@MainActor
final class SurfaceSpace {
    weak var view: NSView?

    func local(fromWindow rect: CGRect) -> CGRect {
        guard let view else { return rect }
        return view.convert(rect, from: nil)
    }
}

struct SurfaceAnchor: NSViewRepresentable {
    let space: SurfaceSpace

    final class Flipped: NSView {
        override var isFlipped: Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    func makeNSView(context: Context) -> NSView {
        let v = Flipped()
        space.view = v
        return v
    }

    func updateNSView(_ nsView: NSView, context: Context) { space.view = nsView }
}

/// EPUB reading: the cleaned book as one continuous page on the left, thread cards in reading order
/// in a lane on the right, the same selection menu and Book Journal as PDFs.
struct EpubReaderSurface: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openSettings) private var openSettings
    @Bindable var reader: ReaderModel
    @State private var space = SurfaceSpace()
    @State private var webCommand: EpubWebView.Command?
    @AppStorage("epubFontScale") private var fontScale = 100.0
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let t = app.t
        HStack(spacing: 0) {
            EpubWebView(reader: reader, fontScale: fontScale, dark: scheme == .dark, command: $webCommand, onSelect: select)
                .frame(minWidth: 420)
                .background(Color.paper)
                .overlay {
                    // Without its network block the book is not shown at all.
                    if reader.epubBlocked {
                        Text(t["importFailed"]).foregroundStyle(Color.inkSoft).frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.paper)
                    }
                }
            Rectangle().fill(Color.inkFaint.opacity(0.35)).frame(width: 1)
            lane
                .frame(width: 420)
                .background(Color.paperSunken)
        }
        .background(SurfaceAnchor(space: space))
        .overlay(alignment: .topLeading) {
            GeometryReader { geo in
                if reader.pending != nil {
                    SelectionMenuView(reader: reader, lang: app.lang)
                        .modifier(MenuPlacement(anchor: reader.pending!.rect, bounds: geo.size))
                }
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
        }
        .onChange(of: reader.pending == nil) { _, cleared in if cleared { webCommand = .clearSelection } }
        .inspector(isPresented: $reader.showJournal) {
            JournalPanel(reader: reader, lang: app.lang, openSettings: { openSettings() })
                .inspectorColumnWidth(min: 300, ideal: 380, max: 520)
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if let chapter = reader.epubChapter {
                    Text(Compose.chapterLabel(app.lang, chapter)).foregroundStyle(.secondary)
                }
                Toggle(isOn: $reader.showJournal) { Label(t["journal"], systemImage: "book.closed") }
                Toggle(isOn: $reader.hideThreads) {
                    Label(reader.hideThreads ? t["showThreads"] : t["hideThreads"], systemImage: reader.hideThreads ? "eye" : "eye.slash")
                }
                ControlGroup {
                    Button { fontScale = max(70, fontScale - 10) } label: { Image(systemName: "textformat.size.smaller") }.help(t["zoomOut"])
                    Button { fontScale = min(180, fontScale + 10) } label: { Image(systemName: "textformat.size.larger") }.help(t["zoomIn"])
                }
            }
        }
    }

    private var lane: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(orderedCards.filter { reader.isShown($0.card) }, id: \.card.id) { item in
                        Group {
                            if item.card.collapsed {
                                Button { reader.cards.setCollapsed(item.card.id, false) } label: {
                                    HStack(spacing: 8) {
                                        Circle().fill(Color.yarn(item.card.color)).frame(width: 7, height: 7)
                                        Text(Compose.kindTitle(app.lang, item.card.kind)).font(.system(size: 11, weight: .bold)).foregroundStyle(Color.yarn(item.card.color))
                                        Text(item.card.anchors.first?.selectedText ?? "").font(.reading(12)).foregroundStyle(Color.inkSoft).lineLimit(1)
                                    }
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    .background(Capsule().fill(Color.paperRaised))
                                }
                                .buttonStyle(.plain)
                            } else {
                                YarnCardView(cardId: item.card.id, reader: reader, lang: app.lang, openSettings: { openSettings() }, onSelectText: { id, text, rect in
                                    let anchor = YarnAnchor(sourceType: .card, bookId: reader.book.id, pageNumber: 0, selectedText: text, lineRects: [], boundingRect: .zero, sourceCardId: id, context: reader.cardContext(id))
                                    reader.pending = PendingSelection(anchors: [anchor], rect: space.local(fromWindow: rect), parentCardId: id)
                                })
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(reader.focusedCard == item.card.id ? Color.yarn(item.card.color).opacity(0.5) : .clear, lineWidth: 2))
                                .onTapGesture(count: 2) {
                                    if let loc = EPUBBook.parseLocator(item.card.anchors.first { $0.cfi != nil }?.cfi) { webCommand = .scrollTo(loc.chapter, loc.start) }
                                }
                            }
                        }
                        .padding(.leading, CGFloat(item.depth) * 16)
                        .id(item.card.id)
                    }
                }
                .padding(16)
            }
            .onChange(of: reader.focusedCard) { _, id in
                if let id { withAnimation(.spring(duration: 0.3, bounce: 0)) { proxy.scrollTo(id, anchor: .top) } }
            }
        }
    }

    /// Cards in reading order; a thread opened from a card follows its parent.
    private var orderedCards: [(card: YarnCard, depth: Int)] {
        let cards = reader.cards.cards
        func key(_ c: YarnCard) -> (Int, Int, Double) {
            let loc = EPUBBook.parseLocator(c.anchors.first { $0.cfi != nil }?.cfi)
            return (loc?.chapter ?? Int.max, loc?.start ?? 0, c.createdAt)
        }
        let roots = cards.filter { c in c.parentCardId == nil || !cards.contains { $0.id == c.parentCardId } }.sorted { key($0) < key($1) }
        var out: [(YarnCard, Int)] = []
        func visit(_ c: YarnCard, _ depth: Int) {
            out.append((c, depth))
            for child in cards.filter({ $0.parentCardId == c.id }) { visit(child, depth + 1) }
        }
        for r in roots { visit(r, 0) }
        return out
    }

    private func select(_ selection: EpubWebView.Selection, windowRect: CGRect) {
        let anchor = YarnAnchor(
            sourceType: .epubText,
            bookId: reader.book.id,
            pageNumber: selection.chapter + 1,
            selectedText: selection.text,
            lineRects: [],
            boundingRect: .zero,
            cfi: EPUBBook.locator(chapter: selection.chapter, start: selection.start, end: selection.end),
            context: selection.context.isEmpty ? nil : selection.context
        )
        reader.pending = PendingSelection(anchors: [anchor], rect: space.local(fromWindow: windowRect))
    }
}

/// The book page in WebKit. The book's own scripts are off and the network is blocked; a small Peryda
/// script, in its own world, reports selections and positions and draws highlights.
struct EpubWebView: NSViewRepresentable {
    struct Selection {
        var text: String
        var chapter: Int
        var start: Int
        var end: Int
        /// The start of the chapter's text, sent with the selection.
        var context: String = ""
    }

    enum Command: Equatable {
        case clearSelection
        case scrollTo(Int, Int)
    }

    let reader: ReaderModel
    let fontScale: Double
    let dark: Bool
    @Binding var command: Command?
    let onSelect: (Selection, CGRect) -> Void
    /// The network block (tests pass a broken one to see the page refuse to load).
    var rules = Self.offlineRules

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.websiteDataStore = .nonPersistent()
        let controller = config.userContentController
        controller.addUserScript(WKUserScript(source: Self.bridge, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        controller.add(context.coordinator, contentWorld: .defaultClient, name: "peryda")
        let view = WKWebView(frame: .zero, configuration: config)
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = context.coordinator
        context.coordinator.webView = view
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "peryda-offline", encodedContentRuleList: rules) { list, _ in
            Task { @MainActor in
                // Fail closed: a book is only loaded behind the block.
                guard let list, let epub = reader.epub else {
                    reader.epubBlocked = true
                    return
                }
                config.userContentController.add(list)
                view.loadFileURL(epub.pageURL, allowingReadAccessTo: epub.root)
            }
        }
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        _ = reader.cards.cards
        context.coordinator.applyStyle()
        context.coordinator.applyHighlights()
        if let command {
            DispatchQueue.main.async {
                context.coordinator.run(command)
                self.command = nil
            }
        }
    }

    /// Everything is blocked, then the book's own files (and inline data) are let through: nothing a
    /// book carries can reach the network, whatever its scheme.
    static let offlineRules = """
    [{"trigger": {"url-filter": ".*"}, "action": {"type": "block"}},
     {"trigger": {"url-filter": "^file:"}, "action": {"type": "ignore-previous-rules"}},
     {"trigger": {"url-filter": "^data:"}, "action": {"type": "ignore-previous-rules"}}]
    """

    /// Only the book's own page loads; links, forms and anything dropped on the view are refused.
    static func allows(_ url: URL?, type: WKNavigationType, page: URL) -> Bool {
        guard type == .other, let url, url.isFileURL else { return false }
        return url.standardizedFileURL.resolvingSymlinksInPath().path == page.standardizedFileURL.resolvingSymlinksInPath().path
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: EpubWebView
        weak var webView: WKWebView?
        private var loaded = false
        private var lastHighlights = ""
        private var lastStyle = ""

        init(_ parent: EpubWebView) { self.parent = parent }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loaded = true
            lastHighlights = ""
            lastStyle = ""
            applyStyle()
            applyHighlights()
            if let pos = parent.reader.savedPosition?.cfi, let loc = EPUBBook.parseLocator(pos) { run(.scrollTo(loc.chapter, loc.start)) }
        }

        // Navigation away from the book (links, forms, a dropped file) is refused.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let page = parent.reader.epub?.pageURL else { return .cancel }
            return EpubWebView.allows(action.request.url, type: action.navigationType, page: page) ? .allow : .cancel
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String, let webView else { return }
            switch type {
            case "selection":
                guard let text = body["text"] as? String, let chapter = body["chapter"] as? Int,
                      let start = body["start"] as? Int, let end = body["end"] as? Int, let r = body["rect"] as? [String: Double] else { return }
                let clean = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
                guard !clean.isEmpty else { return }
                let local = CGRect(x: r["x"] ?? 0, y: r["y"] ?? 0, width: r["w"] ?? 0, height: r["h"] ?? 0)
                let windowRect = webView.convert(local, to: nil)
                parent.onSelect(Selection(text: clean, chapter: chapter, start: start, end: end, context: (body["context"] as? String) ?? ""), windowRect)
            case "clear":
                if parent.reader.pending?.anchors.first?.sourceType == .epubText { parent.reader.pending = nil }
            case "mark":
                if let id = body["cardId"] as? String {
                    if parent.reader.cards.cards.first(where: { $0.id == id })?.collapsed == true { parent.reader.cards.setCollapsed(id, false) }
                    if parent.reader.hideThreads { parent.reader.revealed.insert(id) }
                    parent.reader.focusedCard = id
                }
            case "position":
                if let chapter = body["chapter"] as? Int, let start = body["start"] as? Int {
                    parent.reader.epubChapter = chapter + 1
                    parent.reader.saveEpubPosition(EPUBBook.locator(chapter: chapter, start: start, end: start))
                }
            default:
                break
            }
        }

        func applyStyle() {
            guard loaded, let webView else { return }
            let dark = parent.dark
            let p = SharedContract.tokens.palette[dark ? "dark" : "light"]!
            let style = "\(p.ink)|\(p.paper)|\(parent.fontScale)"
            guard style != lastStyle else { return }
            lastStyle = style
            webView.evaluateJavaScript("perydaStyle('\(p.ink)', '\(p.paper)', \(parent.fontScale / 100 * 17))", in: nil, in: .defaultClient) { _ in }
        }

        func applyHighlights() {
            guard loaded, let webView else { return }
            let dark = parent.dark
            var items: [[String: Any]] = []
            for card in parent.reader.cards.cards {
                for a in card.anchors where a.sourceType == .epubText {
                    guard let loc = EPUBBook.parseLocator(a.cfi) else { continue }
                    let tone = SharedContract.tokens.tone(card.color)
                    let hex = dark ? tone.dark : tone.light
                    items.append(["cardId": card.id, "chapter": loc.chapter, "start": loc.start, "end": loc.end, "color": hex, "alpha": dark ? 0.3 : tone.highlightAlpha, "blend": dark ? "normal" : "multiply"])
                }
            }
            guard let data = try? JSONSerialization.data(withJSONObject: items), let json = String(data: data, encoding: .utf8), json != lastHighlights else { return }
            lastHighlights = json
            webView.evaluateJavaScript("perydaHighlight(\(json))", in: nil, in: .defaultClient) { _ in }
        }

        func run(_ command: Command) {
            guard let webView else { return }
            switch command {
            case .clearSelection:
                webView.evaluateJavaScript("perydaClearSelection()", in: nil, in: .defaultClient) { _ in }
            case .scrollTo(let chapter, let start):
                webView.evaluateJavaScript("perydaScrollTo(\(chapter), \(start))", in: nil, in: .defaultClient) { _ in }
            }
        }
    }

    static let bridge = #"""
    (() => {
      const post = (m) => window.webkit.messageHandlers.peryda.postMessage(m);
      const sectionOf = (node) => { const el = node && (node.nodeType === 1 ? node : node.parentElement); return el ? el.closest('section.peryda-chapter') : null; };
      const offsetIn = (section, node, offset) => { const r = document.createRange(); r.selectNodeContents(section); r.setEnd(node, offset); return r.toString().length; };
      document.addEventListener('mouseup', () => setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        const sec = sectionOf(range.startContainer);
        if (!sec) return;
        const start = offsetIn(sec, range.startContainer, range.startOffset);
        const end = sectionOf(range.endContainer) === sec ? offsetIn(sec, range.endContainer, range.endOffset) : sec.textContent.length;
        const r = range.getBoundingClientRect();
        post({ type: 'selection', text: sel.toString(), chapter: +sec.dataset.chapter, start, end, context: (() => { const t = sec.textContent; const side = Math.max(0, Math.floor((1200 - (end - start)) / 2)); let a = Math.max(0, start - side), b = Math.min(t.length, end + side); if (a === 0) b = Math.min(t.length, Math.max(b, 1200)); if (b === t.length) a = Math.max(0, Math.min(a, t.length - 1200)); return t.slice(a, b).replace(/\s+/g, ' ').trim(); })(), rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
      }, 0));
      document.addEventListener('mousedown', (e) => { if (!e.target.closest('mark.peryda-mark')) post({ type: 'clear' }); });
      document.addEventListener('click', (e) => { const m = e.target.closest('mark.peryda-mark'); if (m) post({ type: 'mark', cardId: m.dataset.card }); });
      window.perydaClearSelection = () => window.getSelection().removeAllRanges();
      window.perydaStyle = (ink, paper, size) => { document.documentElement.style.background = paper; document.body.style.color = ink; document.body.style.fontSize = size + 'px'; };
      const hex = (h, a) => { const n = parseInt(h.slice(1), 16); return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; };
      window.perydaHighlight = (items) => {
        for (const m of [...document.querySelectorAll('mark.peryda-mark')]) { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize(); }
        for (const it of items) {
          const sec = document.querySelector(`section.peryda-chapter[data-chapter="${it.chapter}"]`);
          if (!sec) continue;
          const walker = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
          let pos = 0; const parts = [];
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const len = n.data.length; const a = Math.max(it.start, pos), b = Math.min(it.end, pos + len);
            if (b > a) parts.push([n, a - pos, b - pos]);
            pos += len; if (pos >= it.end) break;
          }
          for (const [node, a, b] of parts) {
            const r = document.createRange(); r.setStart(node, a); r.setEnd(node, b);
            const mark = document.createElement('mark'); mark.className = 'peryda-mark'; mark.dataset.card = it.cardId;
            mark.style.background = hex(it.color, it.alpha); mark.style.mixBlendMode = it.blend;
            try { r.surroundContents(mark); } catch (e) {}
          }
        }
      };
      window.perydaScrollTo = (chapter, start) => {
        const sec = document.querySelector(`section.peryda-chapter[data-chapter="${chapter}"]`);
        if (!sec) return;
        const walker = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
        let pos = 0;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (pos + n.data.length >= start) { const r = document.createRange(); r.setStart(n, Math.max(0, start - pos)); r.collapse(true); const rect = r.getBoundingClientRect(); window.scrollBy(0, rect.top - 80); return; }
          pos += n.data.length;
        }
        sec.scrollIntoView();
      };
      let timer;
      window.addEventListener('scroll', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          for (const sec of document.querySelectorAll('section.peryda-chapter')) {
            const r = sec.getBoundingClientRect();
            if (r.bottom <= 0) continue;
            const caret = document.caretRangeFromPoint ? document.caretRangeFromPoint(window.innerWidth / 2, Math.max(1, Math.min(60, r.bottom - 1))) : null;
            const start = caret && sec.contains(caret.startContainer) ? offsetIn(sec, caret.startContainer, caret.startOffset) : 0;
            post({ type: 'position', chapter: +sec.dataset.chapter, start });
            break;
          }
        }, 300);
      }, { passive: true });
    })();
    """#
}
