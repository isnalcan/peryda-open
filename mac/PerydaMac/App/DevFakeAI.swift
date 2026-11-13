#if DEBUG
import Foundation
import PerydaKit

/// Development only: launch with `-PerydaFakeAI YES` to stream a canned answer without a key.
struct DevFakeStreamer: AnswerStreaming {
    func stream(_ request: AIRequest) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                let text = "Bu, arayüzü denemek için yerel bir örnek yanıttır. **Gerçek yanıt** senin anahtarınla seçtiğin sağlayıcıdan gelir.\n\n- Kısa bir madde\n- Bir madde daha"
                var i = text.startIndex
                while i < text.endIndex {
                    if Task.isCancelled { break }
                    let next = text.index(i, offsetBy: 6, limitedBy: text.endIndex) ?? text.endIndex
                    continuation.yield(String(text[i..<next]))
                    i = next
                    try? await Task.sleep(for: .milliseconds(30))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

enum DevFlags {
    static var fakeAI: Bool { UserDefaults.standard.bool(forKey: "PerydaFakeAI") }
}
#endif

#if DEBUG
/// Development only: a batch service that "finishes" a few seconds after a job is created.
actor DevFakeBatcher: PageBatching {
    static let shared = DevFakeBatcher()
    private var jobs: [String: (created: Date, keys: [String])] = [:]

    func create(apiKey: String, model: String, items: [GeminiBatch.Item]) async throws -> String {
        let name = "batches/dev-\(UUID().uuidString.prefix(8))"
        jobs[name] = (Date(), items.map(\.key))
        return name
    }

    func status(apiKey: String, name: String) async throws -> GeminiBatch.Status {
        guard let job = jobs[name] else { return .failed("unknown") }
        guard Date().timeIntervalSince(job.created) > 4 else { return .waiting }
        let text = """
        # Örnek çeviri

        Bu, sayfa çevirisini denemek için yerel bir örnek metindir. Gerçek çeviri, senin Gemini anahtarınla Gemini 3.8 Flash'tan toplu iş olarak gelir.

        Sayfa çevirisi PDF sayfasının yanında, aynı boyutta durur. Bu metinden bir yer seçip yeni bir ilmek açabilirsin.

        - Kısa bir madde
        - Bir madde daha
        """
        return .done(texts: Dictionary(uniqueKeysWithValues: job.keys.map { ($0, text) }), errors: [:])
    }

    func cancel(apiKey: String, name: String) async { jobs[name] = nil }
    func delete(apiKey: String, name: String) async { jobs[name] = nil }
}
#endif
