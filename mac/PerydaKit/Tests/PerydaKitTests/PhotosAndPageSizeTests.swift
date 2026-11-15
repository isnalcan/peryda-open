import CoreGraphics
import Foundation
import ImageIO
import PDFKit
import Testing
import UniformTypeIdentifiers
@testable import PerydaKit

/// Owner, 16 Nov: photos of pages become a book; the pages can be resized and the threads the reader
/// placed move with them; the page size is kept in backups.
@Suite("Photos and page size")
struct PhotosAndPageSizeTests {
    /// A photo of the given size: a white page with a dark block, encoded as `type`, optionally
    /// marked as taken rotated (EXIF orientation 6: the camera was turned a quarter).
    static func photo(width: Int, height: Int, type: UTType = .jpeg, orientation: Int? = nil, alpha: Bool = false) throws -> Data {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let info = alpha ? CGImageAlphaInfo.premultipliedLast.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue
        let ctx = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: info))
        if !alpha {
            ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
            ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
        ctx.setFillColor(CGColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1))
        ctx.fill(CGRect(x: width / 8, y: height / 8, width: width / 2, height: height / 4))
        let image = try #require(ctx.makeImage())
        let out = NSMutableData()
        let dest = try #require(CGImageDestinationCreateWithData(out as CFMutableData, type.identifier as CFString, 1, nil))
        var props: [CFString: Any] = [:]
        if let orientation { props[kCGImagePropertyOrientation] = orientation }
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        #expect(CGImageDestinationFinalize(dest))
        return out as Data
    }

    @Test func photosBecomeOnePageEach() throws {
        let a = try Self.photo(width: 1200, height: 1600)
        let b = try Self.photo(width: 1600, height: 1000, type: .png)
        let pdf = try #require(ImageBook.pdf(from: [a, b]))
        let doc = try #require(PDFDocument(data: pdf))
        #expect(doc.pageCount == 2)
        let first = try #require(doc.page(at: 0)).bounds(for: .mediaBox)
        let second = try #require(doc.page(at: 1)).bounds(for: .mediaBox)
        // The longest side is 842 points; the shape is the photo's.
        #expect(first.height == 842 && abs(first.width - 631.5) <= 1)
        #expect(second.width == 842 && abs(second.height - 526.25) <= 1)
    }

    @Test func aPhotoTakenSidewaysIsUpright() throws {
        // Stored 1600 wide and 1200 high, marked "turned a quarter": seen upright it is tall.
        let sideways = try Self.photo(width: 1600, height: 1200, orientation: 6)
        let pdf = try #require(ImageBook.pdf(from: [sideways]))
        let page = try #require(PDFDocument(data: pdf)?.page(at: 0)).bounds(for: .mediaBox)
        #expect(page.height > page.width)
    }

    @Test func aLargePhotoKeepsTheBookLight() throws {
        let big = try Self.photo(width: 6000, height: 8000, type: .png)
        let pdf = try #require(ImageBook.pdf(from: [big]))
        // Kept as a JPEG at most 3200 pixels long, not as raw pixels (which would be tens of MB).
        #expect(pdf.count < 3_000_000)
    }

    @Test func aTransparentPhotoSitsOnWhite() throws {
        let png = try Self.photo(width: 400, height: 400, type: .png, alpha: true)
        let image = try #require(ImageBook.upright(png))
        #expect(image.alphaInfo == .none || image.alphaInfo == .noneSkipLast || image.alphaInfo == .noneSkipFirst)
    }

    @Test func notAPhotoIsRefused() {
        #expect(ImageBook.pdf(from: [Data("not an image".utf8)]) == nil)
        #expect(ImageBook.pdf(from: []) == nil)
    }

    @Test func photosAreTakenInNameOrder() {
        let urls = ["IMG_10.jpg", "IMG_2.heic", "IMG_1.png"].map { URL(fileURLWithPath: "/tmp/\($0)") }
        #expect(ImageBook.ordered(urls).map(\.lastPathComponent) == ["IMG_1.png", "IMG_2.heic", "IMG_10.jpg"])
        #expect(ImageBook.isImage(URL(fileURLWithPath: "/a/b.HEIC")) && !ImageBook.isImage(URL(fileURLWithPath: "/a/b.pdf")))
    }

    @Test func theSamePhotosAreTheSameBook() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("peryda-photos-\(UUID().uuidString)")
        let store = try LibraryStore(root: dir)
        defer { try? FileManager.default.removeItem(at: dir) }
        let photos = [try Self.photo(width: 800, height: 1000), try Self.photo(width: 900, height: 1200)]
        // The PDF is made again each time (and may differ), the photos are the same.
        let one = try store.importBook(data: try #require(ImageBook.pdf(from: photos)), fileName: "IMG_1.pdf", title: nil, author: nil, pageCount: 2, fingerprint: ImageBook.fingerprint(photos))
        let two = try store.importBook(data: try #require(ImageBook.pdf(from: photos)), fileName: "IMG_1.pdf", title: nil, author: nil, pageCount: 2, fingerprint: ImageBook.fingerprint(photos))
        #expect(one.id == two.id)
        #expect(one.title == "IMG 1" && one.format == .pdf && one.pageCount == 2)
        #expect(ImageBook.fingerprint(photos) != ImageBook.fingerprint(photos.reversed()))
    }

    @MainActor @Test func placedCardsMoveInOneWrite() throws {
        let cards = CardsModel(bookId: "book-1", bookTitle: "B", lang: .tr, settings: ByokSettings(), store: try tempStore(), streamer: FakeStreamer())
        let a = cards.create(color: .mint, kind: .quick(.mint), anchors: [], text: "a")
        let b = cards.create(color: .coral, kind: .quick(.coral), anchors: [], text: "b")
        cards.pinAll([a.id: CGPoint(x: 1200, y: 300), b.id: CGPoint(x: -400, y: 900)])
        let moved = cards.cards
        #expect(moved.first { $0.id == a.id }.map { $0.isPinned && $0.x == 1200 && $0.y == 300 } == true)
        #expect(moved.first { $0.id == b.id }.map { $0.isPinned && $0.x == -400 && $0.y == 900 } == true)
    }

    @Test func thePageSizeTravelsInBackups() throws {
        let defaults = try #require(UserDefaults(suiteName: "peryda-test-\(UUID().uuidString)"))
        #expect(Backup.pageScalePref(bookId: "book-1", defaults: defaults) == nil)
        defaults.set(1.6, forKey: "pageScale:book-1")
        let row = try #require(Backup.pageScalePref(bookId: "book-1", defaults: defaults))
        #expect(row.key == "pageScale:book-1")
        #expect(Backup.pageScale(from: [row], bookId: "book-1") == 1.6)
        // Out of range or not a number: clamped or ignored.
        #expect(Backup.pageScale(from: [Backup.Pref(key: "pageScale:book-1", value: AnyCodable(40.0))], bookId: "book-1") == 2.5)
        #expect(Backup.pageScale(from: [Backup.Pref(key: "pageScale:book-1", value: AnyCodable("big"))], bookId: "book-1") == nil)
        #expect(Backup.pageScale(from: [Backup.Pref(key: "pageScale:book-1", value: AnyCodable(-1.0))], bookId: "book-1") == nil)
    }
}

