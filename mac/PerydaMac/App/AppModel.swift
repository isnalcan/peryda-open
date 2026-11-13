import AppKit
import Observation
import PDFKit
import PerydaKit
import SwiftUI

enum ThemePreference: String, CaseIterable {
    case system, light, dark
}

/// App-wide state: the library, the reader's key settings, language and appearance.
@MainActor
@Observable
final class AppModel {
    let store: LibraryStore
    let client = AIClient()

    /// What streams answers: the provider client, or a local stand-in in development builds.
    var streamer: AnswerStreaming {
        #if DEBUG
        if DevFlags.fakeAI { return DevFakeStreamer() }
        #endif
        return client
    }
    /// What runs whole-page translation batch jobs (Gemini, or a local stand-in in development builds).
    let batcher: PageBatching
    private(set) var books: [BookRecord] = []
    var settings: ByokSettings
    var rememberKeys: Bool {
        didSet { UserDefaults.standard.set(rememberKeys, forKey: "rememberKeys") }
    }
    var lang: Lang {
        didSet { UserDefaults.standard.set(lang.rawValue, forKey: "lang") }
    }
    var theme: ThemePreference {
        didSet {
            UserDefaults.standard.set(theme.rawValue, forKey: "theme")
            applyTheme()
        }
    }
    var showWelcome: Bool
    var lastError: String?
    /// A book opened from Finder, for the library window to open in a reader window.
    var pendingOpen: String?

    private let keychain = KeychainVault()

    var t: UIText { UIText(lang) }

    init() {
        // Before anything else touches the network: earlier builds left provider requests (with their
        // key headers) and cookies on disk.
        ProviderCacheCleanup.runOnce(
            library: FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0],
            bundleID: Bundle.main.bundleIdentifier ?? "com.isnalcan.peryda.mac",
            defaults: .standard, urlCache: .shared, cookies: .shared
        )
        do {
            store = try LibraryStore(root: try LibraryStore.defaultRoot())
        } catch {
            fatalError("Peryda could not create its library folder: \(error)")
        }
        var batcher: PageBatching = GeminiBatch()
        #if DEBUG
        if DevFlags.fakeAI { batcher = DevFakeBatcher.shared }
        #endif
        self.batcher = batcher
        let defaults = UserDefaults.standard
        rememberKeys = defaults.object(forKey: "rememberKeys") as? Bool ?? true
        lang = Lang(rawValue: defaults.string(forKey: "lang") ?? "") ?? Lang.preferred()
        theme = ThemePreference(rawValue: defaults.string(forKey: "theme") ?? "") ?? .system
        showWelcome = !defaults.bool(forKey: "welcomed")
        settings = (defaults.object(forKey: "rememberKeys") as? Bool ?? true) ? KeychainVault().load() : ByokSettings()
        books = store.books()
        #if DEBUG
        if DevFlags.fakeAI, settings.resolvedProvider == nil {
            // A placeholder so the interface behaves as if a key were set; it is never sent anywhere.
            settings = ByokSettings(activeProvider: .gemini, geminiApiKey: "local-development-placeholder")
        }
        #endif
        applyTheme()
    }

    /// For off-screen tests: a given library, no Keychain or saved preferences.
    init(store: LibraryStore, settings: ByokSettings, lang: Lang, batcher: PageBatching = GeminiBatch()) {
        self.store = store
        self.batcher = batcher
        self.settings = settings
        self.lang = lang
        rememberKeys = false
        theme = .system
        showWelcome = false
        books = store.books()
    }

    func applyTheme() {
        switch theme {
        case .system: NSApp?.appearance = nil
        case .light: NSApp?.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp?.appearance = NSAppearance(named: .darkAqua)
        }
    }

    func dismissWelcome() {
        showWelcome = false
        UserDefaults.standard.set(true, forKey: "welcomed")
    }

    func saveSettings(_ next: ByokSettings, remember: Bool) {
        settings = next
        rememberKeys = remember
        if remember {
            try? keychain.save(next)
        } else {
            try? keychain.clear()
        }
    }

    func reloadBooks() {
        books = store.books()
    }

    func updateBook(_ id: String, title: String, author: String) {
        store.updateBook(id, title: title, author: author)
        reloadBooks()
    }

    /// Files opened with Peryda from Finder (or dropped on its Dock icon): add them and open the last.
    func open(_ urls: [URL]) {
        if let book = importFiles(urls) { pendingOpen = book.id }
    }

    /// The largest file Peryda adds (far above real books; it is read whole to fingerprint it).
    static let maxImportMB = 2048

    /// Where opened EPUBs are unpacked (one folder per book).
    static var epubCache: URL? {
        try? FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Peryda/epub", isDirectory: true)
    }

    /// Imports PDF and EPUB files; returns the last book added.
    @discardableResult
    func importFiles(_ urls: [URL]) -> BookRecord? {
        var last: BookRecord?
        for url in urls {
            // Only files on this Mac: a web link dragged in is never fetched.
            guard url.isFileURL, LibraryStore.format(of: url) != nil else {
                lastError = t["unsupportedFile"]
                continue
            }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > Self.maxImportMB * 1024 * 1024 {
                lastError = t("fileTooLarge", ["n": Self.maxImportMB])
                continue
            }
            do {
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                var title: String?
                var author: String?
                var pages = 0
                if LibraryStore.format(of: url) == .pdf {
                    guard let doc = PDFDocument(data: data) else {
                        lastError = t["importFailed"]
                        continue
                    }
                    let attrs = doc.documentAttributes ?? [:]
                    title = (attrs[PDFDocumentAttribute.titleAttribute] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let t = title, t.range(of: "^(untitled|microsoft word|document\\d*$)", options: [.regularExpression, .caseInsensitive]) != nil { title = nil }
                    author = attrs[PDFDocumentAttribute.authorAttribute] as? String
                    pages = doc.pageCount
                } else {
                    // EPUB: read title and author from a throwaway unpack.
                    let temp = FileManager.default.temporaryDirectory
                    let id = "peryda-import-\(UUID().uuidString)"
                    defer { try? EPUBBook.removeCache(parent: temp, id: id) }
                    guard let epub = try? EPUBBook.open(url, cacheParent: temp, id: id) else {
                        lastError = t["importFailed"]
                        continue
                    }
                    title = epub.title
                    author = epub.author
                    pages = epub.chapters.count
                }
                last = try store.importBook(data: data, fileName: url.lastPathComponent, title: title, author: author, pageCount: pages)
            } catch {
                lastError = t["importFailed"]
            }
        }
        reloadBooks()
        return last
    }

    /// Deletes a book and everything kept about it: its file, threads, journal and position, its
    /// unpacked EPUB, its cover, its preferences, and any batch job its pages were waiting on.
    func delete(_ book: BookRecord) {
        let jobs = store.cards(for: book.id).filter { $0.batchJob != nil }
        try? store.deleteBook(book.id)
        if let cache = Self.epubCache { try? EPUBBook.removeCache(parent: cache, id: book.id) }
        Covers.remove(book)
        for prefix in SafeID.perBookDefaults {
            if let key = SafeID.defaultsKey(prefix, book.id) { UserDefaults.standard.removeObject(forKey: key) }
        }
        if !jobs.isEmpty {
            let key = settings.key(for: .gemini)
            let batcher = batcher
            pendingWork.append(Task { await CardsModel.abandonBatches(of: jobs, apiKey: key, batcher: batcher) })
        }
        reloadBooks()
    }

    /// Requests still on their way (tests wait for them).
    @ObservationIgnored private(set) var pendingWork: [Task<Void, Never>] = []
}
