import Foundation
import SwiftSoup
import ZIPFoundation

/// An EPUB opened on the Mac: unpacked to a private cache, chapters cleaned and joined into one
/// continuous page. Book scripts, forms, embedded objects, event handlers and remote resources are
/// removed; only the book's own text and images remain.
public struct EPUBBook: Sendable {
    public struct Chapter: Sendable, Hashable {
        public var index: Int
        public var href: String
        public var title: String
    }

    public var title: String
    public var author: String
    public var chapters: [Chapter]
    /// The joined, cleaned page to load into the reader (inside `root`).
    public var pageURL: URL
    public var root: URL

    public enum Failure: Error { case unreadable, tooLarge }

    /// How much a book may unpack to: far beyond real books, a stop for a ZIP bomb.
    public struct Limits: Sendable {
        public var entries: Int
        public var entryBytes: UInt64
        public var totalBytes: UInt64

        public init(entries: Int = 10_000, entryBytes: UInt64 = 100 * 1024 * 1024, totalBytes: UInt64 = 1024 * 1024 * 1024) {
            self.entries = entries
            self.entryBytes = entryBytes
            self.totalBytes = totalBytes
        }

        public static let standard = Limits()
    }

    /// A book's unpacked copy: `parent/<id>`, only for a plain id.
    public static func cacheFolder(parent: URL, id: String) throws -> URL {
        do { return try SafeID.url(in: parent, id: id, isDirectory: true) } catch { throw Failure.unreadable }
    }

    /// Deletes a book's unpacked copy. Only ever a direct child of `parent`, never anything above it.
    public static func removeCache(parent: URL, id: String) throws {
        let dir = try cacheFolder(parent: parent, id: id)
        guard SafeID.isDirectChild(dir, of: parent) else { throw Failure.unreadable }
        if FileManager.default.fileExists(atPath: dir.path) { try FileManager.default.removeItem(at: dir) }
    }

    /// Unpacks `epub` into `cacheParent/<id>` (replacing what is there) and builds the reading page.
    public static func open(_ epub: URL, cacheParent: URL, id: String, limits: Limits = .standard) throws -> EPUBBook {
        let cacheDir = try cacheFolder(parent: cacheParent, id: id)
        try removeCache(parent: cacheParent, id: id)
        try FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        do {
            return try build(epub, cacheDir: cacheDir, limits: limits)
        } catch {
            // Nothing half-unpacked is left behind.
            try? removeCache(parent: cacheParent, id: id)
            throw error
        }
    }

    static func build(_ epub: URL, cacheDir: URL, limits: Limits) throws -> EPUBBook {
        let fm = FileManager.default
        let archive: ZIPFoundation.Archive
        do { archive = try ZIPFoundation.Archive(url: epub, accessMode: .read) } catch { throw Failure.unreadable }
        // What the headers declare is checked first; the bytes are counted again while unpacking,
        // because the headers can lie.
        // Two entries for one path would leave the last on disk while the cover reader (and any
        // other reader of the archive) takes the first: such a book is refused (audit MA-1).
        guard !hasDuplicatePaths(archive) else { throw Failure.unreadable }
        var count = 0
        var declared: UInt64 = 0
        for entry in archive {
            count += 1
            guard count <= limits.entries else { throw Failure.tooLarge }
            guard entry.type == .file else { continue }
            guard entry.uncompressedSize <= limits.entryBytes else { throw Failure.tooLarge }
            declared += entry.uncompressedSize
            guard declared <= limits.totalBytes else { throw Failure.tooLarge }
        }
        let rootPath = cacheDir.standardizedFileURL.path
        var total: UInt64 = 0
        for entry in archive where entry.type == .file {
            // Refuse entries that would land outside the cache folder ("zip slip").
            let target = cacheDir.appendingPathComponent(entry.path).standardizedFileURL
            guard target.path.hasPrefix(rootPath + "/") else { continue }
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard fm.createFile(atPath: target.path, contents: nil) else { throw Failure.unreadable }
            let handle = try FileHandle(forWritingTo: target)
            defer { try? handle.close() }
            var written: UInt64 = 0
            _ = try archive.extract(entry, skipCRC32: false) { chunk in
                written += UInt64(chunk.count)
                total += UInt64(chunk.count)
                guard written <= limits.entryBytes, total <= limits.totalBytes else { throw Failure.tooLarge }
                try handle.write(contentsOf: chunk)
            }
        }

        guard let container = try? String(contentsOf: cacheDir.appendingPathComponent("META-INF/container.xml"), encoding: .utf8),
              let opfPath = try? SwiftSoup.parse(container, "", Parser.xmlParser()).select("rootfile").first()?.attr("full-path"),
              !opfPath.isEmpty
        else { throw Failure.unreadable }
        // The package file must be inside the book too.
        let opfURL = cacheDir.appendingPathComponent(opfPath).standardizedFileURL
        guard opfURL.path.hasPrefix(rootPath + "/"), let opfText = try? String(contentsOf: opfURL, encoding: .utf8) else { throw Failure.unreadable }
        let opf = try SwiftSoup.parse(opfText, "", Parser.xmlParser())
        let title = (try? opf.select("dc|title, title").first()?.text()) ?? ""
        let author = (try? opf.select("dc|creator, creator").first()?.text()) ?? ""
        var manifest: [String: String] = [:]
        for item in try opf.select("manifest > item").array() {
            manifest[try item.attr("id")] = try item.attr("href")
        }
        let opfDir = opfURL.deletingLastPathComponent()
        var chapters: [Chapter] = []
        var sections: [String] = []
        for (i, ref) in try opf.select("spine > itemref").array().enumerated() {
            guard let href = manifest[try ref.attr("idref")]?.removingPercentEncoding else { continue }
            let chapterURL = opfDir.appendingPathComponent(href).standardizedFileURL
            guard chapterURL.path.hasPrefix(rootPath + "/"), let html = try? String(contentsOf: chapterURL, encoding: .utf8) else { continue }
            let (body, heading) = try clean(html, chapterURL: chapterURL, root: cacheDir.standardizedFileURL)
            chapters.append(Chapter(index: chapters.count, href: href, title: heading))
            sections.append("<section class=\"peryda-chapter\" data-chapter=\"\(chapters.count - 1)\" data-spine=\"\(i)\">\(body)</section>")
        }
        guard !chapters.isEmpty else { throw Failure.unreadable }
        let page = cacheDir.appendingPathComponent("peryda-book.html")
        try pageHTML(sections.joined(separator: "\n")).write(to: page, atomically: true, encoding: .utf8)
        return EPUBBook(title: title, author: author, chapters: chapters, pageURL: page, root: cacheDir)
    }

    /// Elements that run, load, embed or animate something; removed with their content. (SVG names
    /// are lower case after parsing.)
    static let removedTags = "script, iframe, frame, frameset, object, embed, applet, form, input, button, select, textarea, link, meta, base, style, noscript, audio, video, source, track, portal, "
        + "animate, animatemotion, animatetransform, animatecolor, set, use, feimage, foreignobject, tref"

    /// Attributes that load or do something, or that Peryda's own reading page uses (a book must not
    /// pose as a highlight or a chapter).
    static let removedAttributes: Set<String> = [
        "style", "srcset", "formaction", "action", "background", "ping", "poster", "lowsrc", "dynsrc", "codebase",
        "data-card", "data-chapter", "data-spine",
    ]

    /// Keeps the chapter's body text and images; rewrites image paths to be relative to the cache root.
    static func clean(_ html: String, chapterURL: URL, root: URL) throws -> (body: String, heading: String) {
        let doc = try SwiftSoup.parse(html)
        try doc.select(removedTags).remove()
        for element in try doc.getAllElements().array() {
            let tag = element.tagName().lowercased()
            for attribute in element.getAttributes()?.asList() ?? [] {
                let key = attribute.getKey().lowercased()
                let raw = attribute.getValue().trimmingCharacters(in: .whitespacesAndNewlines)
                let compact = raw.lowercased().filter { !$0.isWhitespace && $0 != "\\" }
                var drop = key.hasPrefix("on") || removedAttributes.contains(key) || compact.contains("url(") || compact.contains("image-set(")
                // Links go nowhere: links are kept as text, and elsewhere only a reference inside the
                // same document (`#id`) stays. An image's own reference is checked below.
                if key == "href" || key.hasSuffix(":href"), tag != "image" {
                    drop = drop || tag == "a" || tag == "area" || !raw.hasPrefix("#")
                }
                if key == "src", tag != "img" { drop = true }
                if drop { try element.removeAttr(attribute.getKey()) }
            }
            if element.hasAttr("class") {
                let kept = try element.attr("class").split(whereSeparator: \.isWhitespace).filter { !$0.lowercased().hasPrefix("peryda") }
                if kept.isEmpty { try element.removeAttr("class") } else { try element.attr("class", kept.joined(separator: " ")) }
            }
        }
        for img in try doc.select("img[src], image").array() {
            let attr: String
            if img.tagName().lowercased() == "img" {
                attr = "src"
            } else {
                // SVG: `href` wins over `xlink:href`; only the one that is used is kept.
                attr = img.hasAttr("href") ? "href" : "xlink:href"
                try img.removeAttr(attr == "href" ? "xlink:href" : "href")
            }
            let src = try img.attr(attr)
            let resolved = chapterURL.deletingLastPathComponent().appendingPathComponent(src.removingPercentEncoding ?? src).standardizedFileURL
            // A scheme or `//host` points away from the book; only the book's own files are shown.
            if src.isEmpty || src.contains(":") || src.hasPrefix("//") || !resolved.path.hasPrefix(root.path + "/") {
                try img.remove()
            } else {
                try img.attr(attr, String(resolved.path.dropFirst(root.path.count + 1)))
            }
        }
        let heading = (try? doc.select("h1, h2, title").first()?.text()) ?? ""
        return (try doc.body()?.html() ?? "", heading)
    }

    static func pageHTML(_ sections: String) -> String {
        """
        <!doctype html>
        <html><head><meta charset="utf-8">
        <style>
          :root { color-scheme: light dark; }
          body { margin: 0 auto; max-width: 680px; padding: 32px 28px 120px; font: 17px/1.65 "New York", ui-serif, Georgia, serif; color: var(--ink, #211F1A); background: transparent; -webkit-font-smoothing: antialiased; }
          h1, h2, h3 { line-height: 1.25; font-weight: 600; }
          img { max-width: 100%; height: auto; }
          section.peryda-chapter + section.peryda-chapter { margin-top: 48px; padding-top: 24px; border-top: 1px solid rgba(127,127,127,.25); }
          mark.peryda-mark { color: inherit; border-radius: 2px; cursor: pointer; }
          ::selection { background: rgba(51, 96, 79, .28); }
        </style></head>
        <body>
        \(sections)
        </body></html>
        """
    }

    /// Whether two entries name the same file once the path is resolved the way the disk sees it
    /// ("a/./b" and "a/b", or "A/b" and "a/b" on a case-insensitive volume). At most `limit` entries
    /// are looked at; a longer archive is refused elsewhere.
    public static func hasDuplicatePaths(_ archive: ZIPFoundation.Archive, limit: Int = Limits.standard.entries) -> Bool {
        var seen = Set<String>()
        var count = 0
        for entry in archive {
            count += 1
            if count > limit { return false }
            var parts: [String] = []
            for piece in entry.path.split(separator: "/", omittingEmptySubsequences: true) {
                switch piece {
                case ".": continue
                case "..": _ = parts.popLast()
                default: parts.append(String(piece))
                }
            }
            let key = parts.joined(separator: "/").precomposedStringWithCanonicalMapping.lowercased()
            guard !key.isEmpty else { continue }
            if !seen.insert(key).inserted { return true }
        }
        return false
    }

    /// The book's cover picture, read straight from the file (EPUB 3 `cover-image`, or the EPUB 2
    /// `<meta name="cover">` item), without unpacking the book.
    public static func coverImageData(_ epub: URL, limit: UInt64 = 20_000_000) -> Data? {
        guard let archive = try? ZIPFoundation.Archive(url: epub, accessMode: .read, pathEncoding: nil), !hasDuplicatePaths(archive) else { return nil }
        // Nothing larger than `limit` is read: the declared size is checked first, and reading stops
        // as soon as the bytes go past it.
        func read(_ path: String) -> Data? {
            guard let entry = archive[path], entry.type == .file, entry.uncompressedSize <= limit else { return nil }
            var data = Data()
            do {
                _ = try archive.extract(entry, skipCRC32: true) { chunk in
                    data.append(chunk)
                    if UInt64(data.count) > limit { throw Failure.tooLarge }
                }
            } catch {
                return nil
            }
            return data
        }
        guard let containerData = read("META-INF/container.xml"), let container = String(data: containerData, encoding: .utf8),
              let opfPath = try? SwiftSoup.parse(container, "", Parser.xmlParser()).select("rootfile").first()?.attr("full-path"),
              let opfData = read(opfPath), let opfText = String(data: opfData, encoding: .utf8),
              let opf = try? SwiftSoup.parse(opfText, "", Parser.xmlParser())
        else { return nil }
        var href = (try? opf.select("manifest > item[properties~=cover-image]").first()?.attr("href")) ?? ""
        if href.isEmpty, let id = try? opf.select("meta[name=cover]").first()?.attr("content"), !id.isEmpty {
            href = (try? opf.select("manifest > item").array().first { (try? $0.attr("id")) == id }?.attr("href")) ?? ""
        }
        guard !href.isEmpty else { return nil }
        // Resolve the href against the package folder; a path climbing out of the book is refused.
        var parts = (opfPath as NSString).deletingLastPathComponent.split(separator: "/").map(String.init)
        for piece in (href.removingPercentEncoding ?? href).split(separator: "/").map(String.init) {
            switch piece {
            case ".", "": continue
            case "..":
                guard !parts.isEmpty else { return nil }
                parts.removeLast()
            default: parts.append(piece)
            }
        }
        return read(parts.joined(separator: "/"))
    }

    /// Locator text stored in an anchor's `cfi` field for EPUBs read on the Mac.
    public static func locator(chapter: Int, start: Int, end: Int) -> String { "peryda:c=\(chapter);s=\(start);e=\(end)" }

    public static func parseLocator(_ s: String?) -> (chapter: Int, start: Int, end: Int)? {
        guard let s, s.hasPrefix("peryda:") else { return nil }
        var values: [String: Int] = [:]
        for part in s.dropFirst("peryda:".count).split(separator: ";") {
            let kv = part.split(separator: "=")
            if kv.count == 2, let v = Int(kv[1]) { values[String(kv[0])] = v }
        }
        guard let c = values["c"], let st = values["s"], let e = values["e"] else { return nil }
        return (c, st, e)
    }
}
