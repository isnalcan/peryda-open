import PerydaKit
import SwiftUI

/// Files opened with Peryda from Finder, or dropped on its Dock icon.
final class AppDelegate: NSObject, NSApplicationDelegate {
    var model: AppModel?
    private var waiting: [URL] = []

    func application(_ application: NSApplication, open urls: [URL]) {
        // Only files: Peryda registers no URL scheme, and a web address is never fetched.
        let urls = urls.filter(\.isFileURL)
        guard !urls.isEmpty else { return }
        Task { @MainActor in
            if let model { model.open(urls) } else { waiting += urls }
        }
    }

    @MainActor func attach(_ model: AppModel) {
        self.model = model
        if !waiting.isEmpty {
            model.open(waiting)
            waiting = []
        }
    }
}

@main
struct PerydaMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    var body: some Scene {
        Window("Peryda", id: "library") {
            LibraryView()
                .environment(model)
                .environment(\.openURL, Self.noLinks)
                .frame(minWidth: 720, minHeight: 480)
                .onAppear { delegate.attach(model) }
        }
        .defaultSize(width: 1100, height: 760)
        .commands {
            CommandGroup(replacing: .newItem) {
                ImportCommand(model: model)
            }
            ReaderCommands(model: model)
        }

        // Each book opens in its own window.
        WindowGroup(id: "reader", for: String.self) { $bookId in
            if let bookId, let book = model.books.first(where: { $0.id == bookId }) {
                ReaderView(book: book)
                    .environment(model)
                    .environment(\.openURL, Self.noLinks)
                    .frame(minWidth: 860, minHeight: 560)
            }
        }
        .defaultSize(width: 1360, height: 900)

        Settings {
            SettingsView()
                .environment(model)
        }
    }

    /// Book text, AI answers and journal entries never open anything: a link that slipped through
    /// does nothing when clicked.
    static let noLinks = OpenURLAction { _ in .discarded }
}

struct ImportCommand: View {
    let model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button(model.t["addBook"]) {
            if let book = pickAndImport(model) { openWindow(id: "reader", value: book.id) }
        }
        .keyboardShortcut("o")
    }
}
