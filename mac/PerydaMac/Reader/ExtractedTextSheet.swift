import AppKit
import PerydaKit
import SwiftUI

/// "Extract page text": the page's text in a clean, selectable view — the PDF's own text, or text
/// read from the page's picture on this Mac for scanned pages. Copy all, adjustable size.
struct ExtractedTextSheet: View {
    let reader: ReaderModel
    let page: Int
    let lang: Lang
    @Environment(\.dismiss) private var dismiss
    @AppStorage("extractedTextSize") private var size = 18.0
    @State private var result: PageText.Result?
    @State private var copied = false

    private var t: UIText { UIText(lang) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(t["extractedText"]).font(.headline)
                    Text(Compose.pageLabel(lang, page) + (result.map { " · " + t("characters", ["n": $0.text.count]) } ?? ""))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                ControlGroup {
                    Button { size = max(14, size - 2) } label: { Image(systemName: "textformat.size.smaller") }.help(t["zoomOut"])
                    Button { size = min(28, size + 2) } label: { Image(systemName: "textformat.size.larger") }.help(t["zoomIn"])
                }
                .frame(width: 80)
                Button(copied ? t["copied"] : t["copyAll"]) {
                    guard let text = result?.text else { return }
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                    copied = true
                }
                .disabled(result?.text.isEmpty ?? true)
                Button(t["close"]) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding(16)
            Divider()
            Group {
                if let result {
                    if result.text.isEmpty {
                        Text(t["noTextFound"]).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        ScrollView {
                            Text(result.text)
                                .font(.reading(size))
                                .lineSpacing(size * 0.3)
                                .textSelection(.enabled)
                                .frame(maxWidth: 680, alignment: .leading)
                                .padding(28)
                                .frame(maxWidth: .infinity)
                        }
                    }
                } else {
                    VStack(spacing: 10) {
                        ProgressView()
                        Text(t["readingText"]).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .frame(minWidth: 640, idealWidth: 760, minHeight: 520, idealHeight: 720)
        .background(Color.paper)
        .task {
            guard let pdfPage = reader.document?.page(at: page - 1) else {
                result = PageText.Result(text: "", recognized: false)
                return
            }
            result = await PageText.read(PageGeometry(page: pdfPage), lang: lang)
        }
    }
}
