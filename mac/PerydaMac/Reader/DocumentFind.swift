import Foundation
import PDFKit
import PerydaKit

/// Searches a PDF for the reader's query off the main thread (owner, 16 Nov: "ctrl f"). It opens its
/// own copy of the file, so the pages on screen are never touched from another thread, and sends what it
/// found every few pages, so a long book shows its first matches at once.
enum DocumentFind {
    struct Hit: Sendable, Hashable {
        var page: Int
        var rects: [NormalizedRect]
    }

    /// What arrives: matches page by page, and whether the search stopped at TextFind.maxHits.
    enum Event: Sendable {
        case hits([Hit])
        case capped
    }

    static func search(url: URL, query: String, every batchPages: Int = 12) -> AsyncStream<Event> {
        AsyncStream { continuation in
            let task = Task.detached(priority: .userInitiated) {
                guard let doc = PDFDocument(url: url) else {
                    continuation.finish()
                    return
                }
                var batch: [Hit] = []
                var found = 0
                for i in 0..<doc.pageCount {
                    if Task.isCancelled { break }
                    guard let page = doc.page(at: i), let text = page.string, !text.isEmpty else { continue }
                    let geometry = PageGeometry(page: page)
                    for range in TextFind.ranges(of: query, in: text, limit: TextFind.maxHits - found) {
                        if Task.isCancelled { break }
                        found += 1
                        guard let selection = page.selection(for: range) else { continue }
                        let rects = selection.selectionsByLine()
                            .map { geometry.normalized(fromPage: $0.bounds(for: page)) }
                            .filter { $0.width > 0 && $0.height > 0 }
                        if !rects.isEmpty { batch.append(Hit(page: i + 1, rects: rects)) }
                    }
                    if (i + 1) % batchPages == 0, !batch.isEmpty {
                        continuation.yield(.hits(batch))
                        batch = []
                    }
                    if found >= TextFind.maxHits {
                        if !batch.isEmpty { continuation.yield(.hits(batch)) }
                        continuation.yield(.capped)
                        continuation.finish()
                        return
                    }
                }
                if !batch.isEmpty { continuation.yield(.hits(batch)) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
