import PerydaKit
import SwiftUI
import UniformTypeIdentifiers

struct LibraryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings
    @State private var dropTargeted = false
    @State private var confirmDelete: BookRecord?
    @State private var editing: BookRecord?
    @State private var query = ""

    /// Most recently read first; the search matches title and author.
    private var shown: [BookRecord] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return model.books
            .filter { q.isEmpty || $0.title.lowercased().contains(q) || $0.author.lowercased().contains(q) }
            .sorted { max($0.openedAt, $0.addedAt) > max($1.openedAt, $1.addedAt) }
    }

    private let columns = [GridItem(.adaptive(minimum: 150, maximum: 190), spacing: 24, alignment: .top)]

    var body: some View {
        let t = model.t
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(t["libraryTitle"])
                    .font(.reading(32).weight(.medium))
                    .foregroundStyle(Color.ink)
                    .padding(.top, 8)
                if model.books.isEmpty {
                    Text(t["libraryEmpty"])
                        .font(.body)
                        .foregroundStyle(Color.inkSoft)
                        .frame(maxWidth: 440, alignment: .leading)
                } else {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 28) {
                        ForEach(shown) { book in
                            BookTile(book: book) { openWindow(id: "reader", value: book.id) }
                                .contextMenu {
                                    Button(t["editInfo"]) { editing = book }
                                    Divider()
                                    Button(t["deleteBook"], role: .destructive) { confirmDelete = book }
                                }
                        }
                    }
                }
            }
            .padding(32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background {
            // Paper, with a quiet thread drawing in the bottom-right corner (wide windows only).
            ZStack(alignment: .bottomTrailing) {
                Color.paper
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 0) {
                        Spacer(minLength: 640)
                        LibraryArt().frame(width: 440)
                    }
                    Color.clear
                }
            }
            .ignoresSafeArea()
        }
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(Color.peryda, style: StrokeStyle(lineWidth: 2, dash: [8, 6]))
                    .background(Color.peryda.opacity(0.06).clipShape(RoundedRectangle(cornerRadius: 16)))
                    .overlay(Text(t["dropHere"]).font(.title3.weight(.semibold)).foregroundStyle(Color.peryda))
                    .padding(16)
                    .allowsHitTesting(false)
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            // A link dragged from a browser is not a book on this Mac.
            let files = urls.filter(\.isFileURL)
            guard !files.isEmpty else { return false }
            Task {
                let book = await model.importFiles(files)
                if AppModel.makesOneBook(files), let book { openWindow(id: "reader", value: book.id) }
            }
            return true
        } isTargeted: { dropTargeted = $0 }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task {
                        if let book = await pickAndImport(model) { openWindow(id: "reader", value: book.id) }
                    }
                } label: {
                    Label(t["addBook"], systemImage: "plus")
                }
            }
        }
        .navigationTitle("Peryda")
        .searchable(text: $query, placement: .toolbar, prompt: t["searchBooks"])
        .sheet(item: $editing) { book in EditBookSheet(book: book) }
        .onChange(of: model.pendingOpen) { _, id in
            if let id {
                openWindow(id: "reader", value: id)
                model.pendingOpen = nil
            }
        }
        .alert(t["deleteBook"], isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })) {
            Button(t["cancel"], role: .cancel) { confirmDelete = nil }
            Button(t["delete"], role: .destructive) {
                if let book = confirmDelete { model.delete(book) }
                confirmDelete = nil
            }
        } message: {
            Text(t["deleteBookConfirm"])
        }
        .alert(model.lastError ?? "", isPresented: Binding(get: { model.lastError != nil }, set: { if !$0 { model.lastError = nil } })) {
            Button("OK") { model.lastError = nil }
        }
        .sheet(isPresented: Binding(get: { model.showWelcome }, set: { if !$0 { model.dismissWelcome() } })) {
            WelcomeView {
                model.dismissWelcome()
                openSettings()
            } onLater: {
                model.dismissWelcome()
            }
        }
    }
}

struct BookTile: View {
    @Environment(AppModel.self) private var model
    let book: BookRecord
    let open: () -> Void
    @State private var hovering = false
    @State private var cover: NSImage?

    /// "Page 12 / 300 · Last read 2 days ago", or the format for a book not opened yet.
    private var detail: String {
        let t = model.t
        var parts: [String] = []
        if !book.author.isEmpty { parts.append(book.author) }
        if book.format == .pdf {
            if let page = model.store.position(for: book.id)?.page, page > 1 {
                parts.append(t("pageOf", ["p": page, "n": book.pageCount]))
            } else {
                parts.append(t("pages", ["n": book.pageCount]))
            }
        } else {
            parts.append("EPUB")
        }
        if book.openedAt > 0 {
            let f = RelativeDateTimeFormatter()
            f.locale = Locale(identifier: model.lang.rawValue)
            f.unitsStyle = .full
            f.dateTimeStyle = .named
            let now = Date()
            let when = min(Date(timeIntervalSince1970: book.openedAt / 1000), now)
            // Under a minute ago reads as "now", not "0 seconds ago".
            let text = now.timeIntervalSince(when) < 60 ? f.localizedString(fromTimeInterval: 0) : f.localizedString(for: when, relativeTo: now)
            parts.append(t("lastRead", ["when": text]))
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 10) {
                // Every cover sits in the same 3:4 frame and cannot push it: the picture is drawn
                // over the frame, never sizes it (a wide scan once spilled over its neighbour).
                Color.clear
                    .aspectRatio(Covers.frameRatio, contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .overlay {
                        if let cover {
                            CoverPicture(image: cover)
                        } else {
                            ZStack(alignment: .bottomLeading) {
                                LinearGradient(
                                    colors: book.format == .pdf ? [Color.peryda, Color.peryda.opacity(0.78)] : [Color.yarn(.sky), Color.yarn(.sky).opacity(0.78)],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                                Text(book.title)
                                    .font(.reading(16))
                                    .foregroundStyle(Color.paper)
                                    .lineLimit(4)
                                    .padding(14)
                            }
                        }
                    }
                    .clipped()
                .task(id: book.id) {
                    cover = Covers.cached(book)
                    if cover == nil { cover = await Covers.load(book, store: model.store) }
                }
                .clipShape(UnevenRoundedRectangle(topLeadingRadius: 5, bottomLeadingRadius: 5, bottomTrailingRadius: 10, topTrailingRadius: 10))
                .shadow(color: .black.opacity(0.10), radius: hovering ? 12 : 8, y: hovering ? 6 : 4)
                .offset(y: hovering ? -2 : 0)
                VStack(alignment: .leading, spacing: 2) {
                    Text(book.title).font(.callout.weight(.semibold)).foregroundStyle(Color.ink).lineLimit(2)
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(Color.inkFaint)
                        .lineLimit(2)
                }
            }
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.spring(duration: 0.25, bounce: 0)) { hovering = h } }
    }
}

struct WelcomeView: View {
    @Environment(AppModel.self) private var model
    let onAddKey: () -> Void
    let onLater: () -> Void

    var body: some View {
        let t = model.t
        VStack(alignment: .leading, spacing: 16) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 56, height: 56)
            Text(t["welcomeTitle"]).font(.reading(26).weight(.medium))
            VStack(alignment: .leading, spacing: 12) {
                Label(t["welcomeRead"], systemImage: "book")
                Label { Text(t["welcomeIlmek"]) } icon: { Text("⁂").foregroundStyle(Color.peryda) }
                Label(t["welcomeKey"], systemImage: "key")
            }
            .foregroundStyle(Color.inkSoft)
            .labelStyle(.titleAndIcon)
            HStack {
                Spacer()
                Button(t["welcomeLater"], action: onLater)
                Button(t["welcomeAddKey"], action: onAddKey).keyboardShortcut(.defaultAction)
            }
            .padding(.top, 8)
        }
        .padding(28)
        .frame(width: 460)
    }
}

/// A cover close to the frame's shape fills it; a very different one (a wide two-page scan, a tall
/// strip) is shown whole on paper, centred, rather than cropped or allowed to overflow.
struct CoverPicture: View {
    let image: NSImage

    var body: some View {
        switch Covers.fit(image.size) {
        case .fill:
            Image(nsImage: image).resizable().scaledToFill()
        case .letterbox:
            ZStack {
                Color.white
                Image(nsImage: image).resizable().scaledToFit().padding(8)
            }
        }
    }
}

/// The reader's own title and author for a book.
struct EditBookSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let book: BookRecord
    @State private var title = ""
    @State private var author = ""

    var body: some View {
        let t = model.t
        Form {
            TextField(t["bookTitleField"], text: $title)
            TextField(t["bookAuthorField"], text: $author)
            HStack {
                Spacer()
                Button(t["cancel"]) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(t["save"]) {
                    model.updateBook(book.id, title: title, author: author)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .formStyle(.grouped)
        .frame(width: 420)
        .onAppear {
            title = book.title
            author = book.author
        }
    }
}
