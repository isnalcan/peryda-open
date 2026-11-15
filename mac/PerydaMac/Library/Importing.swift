import AppKit
import PerydaKit
import UniformTypeIdentifiers

/// Shows the open panel and imports the chosen PDF, EPUB and photo files; returns the book when they
/// made one book (one file, or photos only).
@MainActor
func pickAndImport(_ model: AppModel) async -> BookRecord? {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.pdf, .init(filenameExtension: "epub") ?? .data, .jpeg, .png, .heic, .heif, .webP, .tiff]
    panel.allowsMultipleSelection = true
    panel.canChooseDirectories = false
    guard panel.runModal() == .OK else { return nil }
    let book = await model.importFiles(panel.urls)
    return AppModel.makesOneBook(panel.urls) ? book : nil
}
