import Foundation
import Testing
@testable import PerydaKit

@Suite("EPUB")
struct EPUBTests {
    let sample = Vectors.sharedDir.deletingLastPathComponent().appendingPathComponent("web/dev-samples/kenar.epub")

    @Test func opensChaptersAndRemovesScripts() throws {
        let book = try EPUBBook.open(sample, cacheParent: FileManager.default.temporaryDirectory, id: "peryda-epub-\(UUID().uuidString)")
        #expect(book.title == "Kenar Notları Üzerine")
        #expect(book.author == "Peryda Örnek")
        #expect(book.chapters.count == 2)
        #expect(book.chapters[0].title.contains("Birinci Bölüm"))
        let page = try String(contentsOf: book.pageURL, encoding: .utf8)
        #expect(page.contains("Kenar notu, okurun metinle konuştuğunun kanıtıdır."))
        #expect(!page.contains("SCRIPT RAN"))
        #expect(!page.lowercased().contains("<script"))
        #expect(page.contains("data-chapter=\"1\""))
    }

    @Test func cleaningDropsHandlersFormsAndRemoteImages() throws {
        let root = URL(fileURLWithPath: "/tmp/peryda-root")
        let html = """
        <html><body onload="x()"><h1>Başlık</h1><p onclick="steal()" style="color:red">Metin</p>
        <form action="https://evil"><input name="p"></form><img src="https://tracker/p.gif"><img src="images/a.png">
        <a href="javascript:alert(1)">bağlantı</a><iframe src="https://x"></iframe></body></html>
        """
        let (body, heading) = try EPUBBook.clean(html, chapterURL: root.appendingPathComponent("OEBPS/c1.xhtml"), root: root)
        #expect(heading == "Başlık")
        for banned in ["onclick", "onload", "style=", "<form", "<input", "tracker", "javascript", "<iframe", "href="] {
            #expect(!body.contains(banned), "\(banned) survived")
        }
        #expect(body.contains("OEBPS/images/a.png"))
    }

    @Test func locatorRoundTrips() {
        let s = EPUBBook.locator(chapter: 3, start: 120, end: 180)
        #expect(EPUBBook.parseLocator(s)! == (3, 120, 180))
        #expect(EPUBBook.parseLocator("epubcfi(/6/4!/4/2)") == nil)
    }
}
