import AppKit
import ImageIO
import PDFKit
import PerydaKit
import UniformTypeIdentifiers
import XCTest

/// Owner, 16 Nov: photos of pages (JPEG, PNG, HEIC) can be added; photos chosen together make one
/// book, in file-name order, and it opens; PDFs chosen with them are added as before.
@MainActor
final class PhotoImportTests: XCTestCase {
    var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("peryda-photo-import-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    /// A photo file: white, with a dark block whose size tells the photos apart.
    func photo(_ name: String, width: Int, height: Int, type: UTType) throws -> URL {
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let ctx = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.setFillColor(CGColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1))
        ctx.fill(CGRect(x: 20, y: 20, width: width / 3, height: height / 5))
        let url = dir.appendingPathComponent(name)
        let dest = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, try XCTUnwrap(ctx.makeImage()), nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return url
    }

    func testPhotosChosenTogetherMakeOneBookInNameOrder() async throws {
        let app = AppModel(store: try LibraryStore(root: dir.appendingPathComponent("lib")), settings: ByokSettings(), lang: .tr)
        let ten = try photo("Sayfa_10.jpg", width: 900, height: 1200, type: .jpeg)
        let two = try photo("Sayfa_2.png", width: 1200, height: 800, type: .png)
        let heic = try photo("Sayfa_3.heic", width: 1000, height: 1400, type: .heic)
        let urls = [ten, two, heic]
        XCTAssertTrue(AppModel.makesOneBook(urls), "photos only: one book, which opens")
        let imported = await app.importFiles(urls)
        let book = try XCTUnwrap(imported)
        XCTAssertNil(app.lastError)
        XCTAssertEqual(app.books.count, 1)
        XCTAssertEqual(book.format, .pdf)
        XCTAssertEqual(book.pageCount, 3)
        XCTAssertEqual(book.title, "Sayfa 2", "named after the first photo")
        let doc = try XCTUnwrap(PDFDocument(url: try app.store.fileURL(for: book)))
        XCTAssertEqual(doc.pageCount, 3)
        // Name order: Sayfa_2 (wide), Sayfa_3 (tall), Sayfa_10 (tall).
        let first = try XCTUnwrap(doc.page(at: 0)).bounds(for: .mediaBox)
        XCTAssertGreaterThan(first.width, first.height)
        let reader = try XCTUnwrap(ReaderModel(book: book, store: app.store, lang: .tr, settings: ByokSettings(), streamer: InstantStreamer()))
        XCTAssertEqual(reader.pages.count, 3, "it opens like any PDF")

        // The same photos again: the same book.
        let importedAgain = await app.importFiles(urls)
        let again = try XCTUnwrap(importedAgain)
        XCTAssertEqual(again.id, book.id)
        XCTAssertEqual(app.books.count, 1)
    }

    func testAPDFChosenWithPhotosIsItsOwnBook() async throws {
        let app = AppModel(store: try LibraryStore(root: dir.appendingPathComponent("lib")), settings: ByokSettings(), lang: .tr)
        let source = try XCTUnwrap(PDFDocument(url: LayoutAndPagingTests.repo.appendingPathComponent("web/dev-samples/okuma.pdf")))
        let pdf = dir.appendingPathComponent("okuma.pdf")
        XCTAssertTrue(source.write(to: pdf))
        let a = try photo("a.jpg", width: 800, height: 1000, type: .jpeg)
        let b = try photo("b.jpg", width: 800, height: 1000, type: .jpeg)
        XCTAssertFalse(AppModel.makesOneBook([pdf, a, b]))
        _ = await app.importFiles([pdf, a, b])
        XCTAssertEqual(app.books.count, 2, "the PDF, and one book of the two photos")
        XCTAssertEqual(app.books.map(\.pageCount).sorted(), [2, source.pageCount].sorted())
    }

    func testABrokenPhotoIsReported() async throws {
        let app = AppModel(store: try LibraryStore(root: dir.appendingPathComponent("lib")), settings: ByokSettings(), lang: .tr)
        let fake = dir.appendingPathComponent("bozuk.jpg")
        try Data("not a photo".utf8).write(to: fake)
        let book = await app.importFiles([fake])
        XCTAssertNil(book)
        XCTAssertEqual(app.lastError, UIText(.tr)["importFailed"])
        XCTAssertTrue(app.books.isEmpty)
    }
}
