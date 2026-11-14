import AppKit
import PerydaKit
import UniformTypeIdentifiers

/// Shows the open panel and imports the chosen PDF and EPUB files; returns the book when one file was picked.
@MainActor
func pickAndImport(_ model: AppModel) async -> BookRecord? {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.pdf, .init(filenameExtension: "epub") ?? .data]
    panel.allowsMultipleSelection = true
    panel.canChooseDirectories = false
    guard panel.runModal() == .OK else { return nil }
    let book = await model.importFiles(panel.urls)
    return panel.urls.count == 1 ? book : nil
}
