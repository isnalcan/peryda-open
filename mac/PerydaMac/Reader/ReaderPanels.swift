import AppKit
import PDFKit
import PerydaKit
import SwiftUI

// Owner, 16 Nov: find in the document, page thumbnails as in Preview, and a book's details.

/// The find bar at the top of the book: what to look for, which match of how many, previous and next.
/// Return goes to the next match, ⇧Return to the previous; Escape closes it and the matches go.
struct FindBar: View {
    let reader: ReaderModel
    let t: UIText
    @State private var query = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Color.inkFaint)
            TextField(t["findPlaceholder"], text: $query)
                .textFieldStyle(.plain)
                .frame(width: 220)
                .focused($focused)
                .onChange(of: query) { _, q in reader.find(q) }
                .onKeyPress(.return, phases: .down) { press in
                    reader.stepFind(press.modifiers.contains(.shift) ? -1 : 1)
                    return .handled
                }
            Text(status)
                .font(.callout)
                .monospacedDigit()
                .foregroundStyle(Color.inkSoft)
                .frame(minWidth: 64, alignment: .trailing)
            ControlGroup {
                Button { reader.stepFind(-1) } label: { Image(systemName: "chevron.up") }
                    .help(t["findPrevious"])
                    .accessibilityLabel(t["findPrevious"])
                Button { reader.stepFind(1) } label: { Image(systemName: "chevron.down") }
                    .help(t["findNext"])
                    .accessibilityLabel(t["findNext"])
            }
            .disabled(reader.findHits.isEmpty)
            .frame(width: 64)
            Button { reader.closeFind() } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.inkFaint) }
                .buttonStyle(.borderless)
                .help(t["close"])
                .accessibilityLabel(t["close"])
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.paperRaised, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.1)))
        .shadow(color: .black.opacity(0.12), radius: 14, y: 6)
        .onAppear { focused = true }
        .onExitCommand { reader.closeFind() }
    }

    /// "3 / 17", "Not found", or nothing yet.
    private var status: String {
        let n = reader.findHits.count
        if query.trimmingCharacters(in: .whitespaces).isEmpty { return "" }
        if n == 0 { return reader.findSearching ? "…" : t["findNone"] }
        return "\((reader.findIndex ?? 0) + 1) / \(n)" + (reader.findCapped ? "+" : "") + (reader.findSearching ? "…" : "")
    }
}

/// Page thumbnails down the left side, drawn as they come into view. The page being read is ringed in
/// green and kept in view; a click goes to that page, at the zoom in use.
struct ThumbnailSidebar: View {
    let reader: ReaderModel
    let lang: Lang

    private var t: UIText { UIText(lang) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 14) {
                    ForEach(1...max(1, reader.pages.count), id: \.self) { n in
                        Button { reader.cameraCommand = .goToPage(n) } label: {
                            VStack(spacing: 5) {
                                PageThumbnail(reader: reader, page: n)
                                    .overlay(RoundedRectangle(cornerRadius: 3).stroke(n == reader.currentPage ? Color.peryda : Color.primary.opacity(0.12), lineWidth: n == reader.currentPage ? 2.5 : 1))
                                Text("\(n)")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(n == reader.currentPage ? Color.peryda : Color.inkSoft)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .id(n)
                        .accessibilityLabel(Compose.pageLabel(lang, n))
                    }
                }
                .padding(.vertical, 14)
                .padding(.horizontal, 22)
            }
            .background(Color.paperSunken)
            .onAppear { proxy.scrollTo(reader.currentPage, anchor: .center) }
            .onChange(of: reader.currentPage) { _, n in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(n) }
            }
        }
        .accessibilityLabel(t["thumbnails"])
    }
}

/// One page's thumbnail, drawn once and kept while the book is open.
struct PageThumbnail: View {
    let reader: ReaderModel
    let page: Int
    @State private var image: NSImage?

    var body: some View {
        let size = thumbnailSize
        Group {
            if let image {
                Image(nsImage: image).resizable().interpolation(.high)
            } else {
                Color.white
            }
        }
        .frame(width: size.width, height: size.height)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 3))
        .task(id: page) { image = reader.thumbnail(page) }
    }

    private var thumbnailSize: CGSize {
        guard page >= 1, page <= reader.pages.count else { return CGSize(width: 120, height: 160) }
        let box = reader.pages[page - 1]
        return CGSize(width: 120, height: 120 * box.height / max(box.width, 1))
    }
}

/// A book's details: what file it is, how large, how long, when it came and was last read, and how
/// much of the reader's work it holds.
struct BookInfoSheet: View {
    let book: BookRecord
    let store: LibraryStore
    let lang: Lang
    @Environment(\.dismiss) private var dismiss

    private var t: UIText { UIText(lang) }

    var body: some View {
        // The library's own record: opening the book has just updated when it was last opened.
        let book = store.books().first { $0.id == self.book.id } ?? self.book
        let cards = store.cards(for: book.id)
        let journal = store.journal(for: book.id)
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(book.title).font(.reading(20).weight(.medium)).fixedSize(horizontal: false, vertical: true)
                if !book.author.isEmpty { Text(book.author).foregroundStyle(Color.inkSoft) }
            }
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                row(t["infoFormat"], book.format == .pdf ? "PDF" : "EPUB")
                row(t["infoSize"], Self.size(book.size, lang))
                row(book.format == .pdf ? t["infoPages"] : t["infoChapters"], "\(book.pageCount)")
                Divider().gridCellColumns(2)
                row(t["infoAdded"], Self.date(book.addedAt, lang))
                row(t["infoOpened"], book.openedAt > 0 ? Self.date(book.openedAt, lang) : t["infoNeverOpened"])
                Divider().gridCellColumns(2)
                row(t["infoThreads"], "\(cards.filter { $0.translatedPage == nil }.count)")
                row(t["infoJournal"], "\(journal.count)")
                row(t["infoHighlights"], "\(journal.filter { $0.source == .highlight }.count)")
            }
            HStack {
                Spacer()
                Button(t["close"]) { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
        .frame(width: 380)
        .background(Color.paper)
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(Color.inkSoft)
            Text(value).monospacedDigit().textSelection(.enabled)
        }
    }

    /// "4,2 MB" or "820 KB", in the reader's language.
    static func size(_ bytes: Int, _ lang: Lang) -> String {
        let locale = Locale(identifier: lang.rawValue)
        let mb = Double(bytes) / 1_000_000
        if mb >= 1 { return mb.formatted(.number.precision(.fractionLength(1)).locale(locale)) + " MB" }
        return max(1, Int((Double(bytes) / 1_000).rounded())).formatted(.number.locale(locale)) + " KB"
    }

    /// A date and time from milliseconds, in the reader's language.
    static func date(_ ms: Double, _ lang: Lang) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(.dateTime.day().month(.wide).year().hour().minute().locale(Locale(identifier: lang.rawValue)))
    }
}
