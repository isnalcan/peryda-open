import Foundation
import Testing
import ZIPFoundation
@testable import PerydaKit

@Suite("Library details")
struct LibraryDetailsTests {
    @Test func theReaderCanRenameABookAndSetItsAuthor() throws {
        let store = try tempStore()
        let book = try store.importBook(data: Data("%PDF x".utf8), fileName: "a.pdf", title: "a", author: nil, pageCount: 3)
        store.updateBook(book.id, title: "  Yavaş Okuma  ", author: " Peryda Örnek ")
        let saved = try #require(store.books().first)
        #expect(saved.title == "Yavaş Okuma")
        #expect(saved.author == "Peryda Örnek")
        store.updateBook(book.id, title: "   ", author: "")
        #expect(store.books().first?.title == "Yavaş Okuma", "an empty title keeps the old one")
    }

    func epub(_ opf: String, files: [String: Data]) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("cover-\(UUID().uuidString).epub")
        let archive = try Archive(url: url, accessMode: .create)
        func add(_ path: String, _ data: Data) throws {
            try archive.addEntry(with: path, type: .file, uncompressedSize: Int64(data.count), provider: { position, size in
                data.subdata(in: Int(position)..<Int(position) + size)
            })
        }
        try add("mimetype", Data("application/epub+zip".utf8))
        try add("META-INF/container.xml", Data(#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#.utf8))
        try add("OEBPS/content.opf", Data(opf.utf8))
        for (path, data) in files { try add(path, data) }
        return url
    }

    @Test func readsAnEPUB3Cover() throws {
        let png = Data([0x89, 0x50, 0x4E, 0x47, 1, 2, 3])
        let url = try epub(#"<package><manifest><item id="c" href="images/cover.png" properties="cover-image" media-type="image/png"/></manifest></package>"#, files: ["OEBPS/images/cover.png": png])
        #expect(EPUBBook.coverImageData(url) == png)
    }

    @Test func readsAnEPUB2Cover() throws {
        let jpg = Data([0xFF, 0xD8, 9, 9])
        let url = try epub(#"<package><metadata><meta name="cover" content="img"/></metadata><manifest><item id="img" href="../cover.jpg" media-type="image/jpeg"/></manifest></package>"#, files: ["cover.jpg": jpg])
        #expect(EPUBBook.coverImageData(url) == jpg)
    }

    @Test func aBookWithoutACoverHasNone() {
        let sample = Vectors.sharedDir.deletingLastPathComponent().appendingPathComponent("web/dev-samples/kenar.epub")
        #expect(EPUBBook.coverImageData(sample) == nil)
    }
}
