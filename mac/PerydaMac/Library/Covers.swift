import AppKit
import PDFKit
import PerydaKit

/// Book covers for the library: a PDF's first page, or an EPUB's own cover picture. Made once and
/// kept in the app's cache folder.
@MainActor
enum Covers {
    /// Width over height of the library's cover frame.
    nonisolated static let frameRatio: CGFloat = 3 / 4

    enum Fit: Equatable { case fill, letterbox }

    /// Fill the frame when the picture is within 20% of its shape; otherwise show it whole.
    nonisolated static func fit(_ size: CGSize) -> Fit {
        guard size.width > 0, size.height > 0 else { return .letterbox }
        let ratio = (size.width / size.height) / frameRatio
        return (0.8...1.25).contains(ratio) ? .fill : .letterbox
    }

    private static var memory: [String: NSImage] = [:]

    static func cached(_ book: BookRecord) -> NSImage? { memory[book.id] }

    static var folder: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Peryda/covers", isDirectory: true)
    }

    /// The cover file, and the marker left when a book has no cover (so it is not looked for again at
    /// every launch). Named after the book's id, so only for a plain id.
    static func files(_ book: BookRecord) -> (cover: URL, none: URL)? {
        let stamp = String(book.fingerprint.filter(\.isHexDigit).prefix(12))
        guard let cover = try? SafeID.url(in: folder, id: book.id, suffix: "-\(stamp).png"),
              let none = try? SafeID.url(in: folder, id: book.id, suffix: "-\(stamp).none")
        else { return nil }
        return (cover, none)
    }

    static func load(_ book: BookRecord, store: LibraryStore) async -> NSImage? {
        if let image = memory[book.id] { return image }
        guard let files = files(book) else { return nil }
        if let image = NSImage(contentsOf: files.cover) {
            memory[book.id] = image
            return image
        }
        if FileManager.default.fileExists(atPath: files.none.path) { return nil }
        guard let source = try? store.fileURL(for: book) else { return nil }
        let data: Data? = await Task.detached(priority: .utility) {
            switch book.format {
            case .pdf:
                guard let page = PDFDocument(url: source)?.page(at: 0) else { return nil }
                let thumb = page.thumbnail(of: CGSize(width: 420, height: 560), for: .cropBox)
                guard let tiff = thumb.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
                return rep.representation(using: .png, properties: [:])
            case .epub:
                guard let raw = EPUBBook.coverImageData(source), let image = NSImage(data: raw) else { return nil }
                let target = CGSize(width: 420, height: 420 * image.size.height / max(image.size.width, 1))
                let resized = NSImage(size: target)
                resized.lockFocus()
                image.draw(in: CGRect(origin: .zero, size: target))
                resized.unlockFocus()
                guard let tiff = resized.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
                return rep.representation(using: .png, properties: [:])
            }
        }.value
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        guard let data, let image = NSImage(data: data) else {
            try? Data().write(to: files.none)
            return nil
        }
        try? data.write(to: files.cover)
        memory[book.id] = image
        return image
    }

    /// Forgets a deleted book's cover.
    static func remove(_ book: BookRecord) {
        memory[book.id] = nil
        guard let files = files(book) else { return }
        try? FileManager.default.removeItem(at: files.cover)
        try? FileManager.default.removeItem(at: files.none)
    }
}
