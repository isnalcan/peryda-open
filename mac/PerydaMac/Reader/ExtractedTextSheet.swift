import AppKit
import PerydaKit
import SwiftUI
import UniformTypeIdentifiers

/// "Extract page text": the page's text in a clean, selectable view — the PDF's own text, or text
/// read from the page's picture on this Mac for scanned pages. Copy all, adjustable size, and page
/// by page. When this Mac reads pages badly, "Read with Pery" has the reader's AI read their pictures
/// instead: this page, or a range (more than two pages go to Gemini as a batch job at half the
/// price); what Pery read is kept with the book (owner test 14 Nov).
struct ExtractedTextSheet: View {
    let reader: ReaderModel
    let lang: Lang
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openSettings) private var openSettings
    @AppStorage("extractedTextSize") private var size = 18.0
    @State private var page: Int
    @State private var result: PageText.Result?
    @State private var copied = false
    @State private var askingRange = false
    @State private var from = 1
    @State private var to = 1
    /// Saving the text failed (the reason is not hidden, audit MA-14).
    @State private var saveFailed = false

    init(reader: ReaderModel, page: Int, lang: Lang) {
        self.reader = reader
        self.lang = lang
        _page = State(initialValue: page)
    }

    private var t: UIText { UIText(lang) }
    private var readings: PageReadings? { reader.readings }
    /// Pery's reading of this page, if it was asked for.
    private var reading: PageReading? { readings?.readings[page] }
    /// What is shown and copied: Pery's reading once done, else this Mac's.
    private var shown: String? {
        if let reading, reading.state == .done { return reading.text }
        return result?.text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            status
            content
        }
        .frame(minWidth: 680, idealWidth: 780, minHeight: 520, idealHeight: 720)
        .alert(t["saveFailed"], isPresented: $saveFailed) { Button(t["close"], role: .cancel) {} }
        .background(Color.paper)
        .task(id: page) {
            result = nil
            copied = false
            guard let pdfPage = reader.document?.page(at: page - 1) else {
                result = PageText.Result(text: "", recognized: false)
                return
            }
            result = await PageText.read(PageGeometry(page: pdfPage), lang: lang)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            ControlGroup {
                Button { page -= 1 } label: { Image(systemName: "chevron.left") }
                    .help(t["previousPage"])
                    .disabled(page <= 1)
                Button { page += 1 } label: { Image(systemName: "chevron.right") }
                    .help(t["nextPage"])
                    .disabled(page >= reader.pages.count)
            }
            .frame(width: 64)
            VStack(alignment: .leading, spacing: 2) {
                Text(t["extractedText"]).font(.headline)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            ControlGroup {
                Button { size = max(14, size - 2) } label: { Image(systemName: "textformat.size.smaller") }.help(t["zoomOut"])
                Button { size = min(28, size + 2) } label: { Image(systemName: "textformat.size.larger") }.help(t["zoomIn"])
            }
            .frame(width: 80)
            Menu {
                Button(t["readThisPage"]) { readings?.read(page...page, lang: lang) }
                Button(t["readRange"]) { openRange() }
            } label: {
                Label(t["readWithPery"], systemImage: "sparkles")
            } primaryAction: {
                readings?.read(page...page, lang: lang)
            }
            .fixedSize()
            .help(t["readWithPeryHint"])
            .disabled(readings == nil || reading?.state == .reading)
            .popover(isPresented: $askingRange, arrowEdge: .bottom) { rangeForm }
            Menu {
                Button(t["copyAll"]) { copy(shown) }
                if (readings?.done.count ?? 0) > 1 {
                    Button(t["copyAllRead"]) { copy(allRead) }
                    Button(t["saveAllRead"]) { saveAllRead() }
                }
            } label: {
                Text(copied ? t["copied"] : t["copyAll"])
            } primaryAction: {
                copy(shown)
            }
            .fixedSize()
            .disabled(shown?.isEmpty ?? true)
            Button(t["close"]) { dismiss() }.keyboardShortcut(.cancelAction)
        }
        .padding(16)
    }

    private var subtitle: String {
        var parts = [Compose.pageLabel(lang, page)]
        if let shown { parts.append(t("characters", ["n": shown.count])) }
        if reading?.state == .done { parts.append(t["readByPery"]) }
        return parts.joined(separator: " · ")
    }

    /// Pages on their way (with Stop), a failed reading, or the hint to ask Pery.
    @ViewBuilder
    private var status: some View {
        if let readings, readings.pending > 0 {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small).frame(width: 16, height: 16)
                Text(t("readingPages", ["n": readings.pending]))
                if readings.inBatch > 0 {
                    Text(t["readingInBatch"]).foregroundStyle(.secondary)
                }
                Spacer()
                Button { readings.stop() } label: { Label(t["stop"], systemImage: "stop.fill") }
            }
            .font(.callout)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(Color.peryda.opacity(0.06))
        }
        if let reading, reading.state == .failed {
            HStack(spacing: 8) {
                Text(t["readFailed"] + " " + errorText(reading.error ?? ""))
                if reading.error == "no-key" || reading.error == "key" {
                    Button(t["openSettings"]) {
                        dismiss()
                        openSettings()
                    }
                    .buttonStyle(.link)
                }
            }
            .font(.callout)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.red.opacity(0.07))
        } else if reading == nil, result?.recognized == true {
            Text(t["readWithPeryHint"])
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private var content: some View {
        Group {
            if let reading, reading.state == .done || (reading.state == .reading && !reading.text.isEmpty) {
                textView(reading.text)
            } else if let reading, reading.state == .waiting || reading.state == .reading {
                VStack(spacing: 10) {
                    ProgressView()
                    Text(reading.job != nil ? t["readingInBatch"] : t["readingText"]).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                .padding(28)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let result {
                if result.text.isEmpty {
                    Text(t["noTextFound"]).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    textView(result.text)
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

    private func textView(_ text: String) -> some View {
        ScrollView {
            Text(text)
                .font(.reading(size))
                .lineSpacing(size * 0.3)
                .textSelection(.enabled)
                .frame(maxWidth: 680, alignment: .leading)
                .padding(28)
                .frame(maxWidth: .infinity)
        }
    }

    // MARK: A range of pages

    private func openRange() {
        from = page
        to = min(reader.pages.count, page + 9)
        askingRange = true
    }

    private var rangeForm: some View {
        let count = max(0, to - from + 1)
        let limit = TranslateRangeSheet.upperLimit(from: from, pageCount: reader.pages.count)
        return Form {
            PageNumberField(title: t["fromPage"], value: $from, range: 1...max(1, reader.pages.count))
            PageNumberField(title: t["toPage"], value: $to, range: from...max(from, limit))
            Text(t("pagesToRead", ["n": count])).font(.headline)
            if reader.pages.count > CardsModel.maxPages {
                Text(t("rangeLimit", ["n": CardsModel.maxPages])).font(.callout).foregroundStyle(.secondary)
            }
            Text(t["readRangeNote"]).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button(t["cancel"]) { askingRange = false }
                Button(t["read"]) {
                    readings?.read(from...max(from, to), lang: lang)
                    askingRange = false
                }
                .keyboardShortcut(.defaultAction)
                .disabled(count == 0)
            }
        }
        .formStyle(.grouped)
        .frame(width: 400)
        .onChange(of: from) { _, v in to = min(max(to, v), TranslateRangeSheet.upperLimit(from: v, pageCount: reader.pages.count)) }
    }

    // MARK: Copy and save

    /// Every page Pery read, in order, each under its page label.
    private var allRead: String {
        (readings?.done ?? []).map { Compose.pageLabel(lang, $0.page).uppercased(with: Locale(identifier: lang.rawValue)) + "\n\n" + $0.text }.joined(separator: "\n\n\n")
    }

    private func copy(_ text: String?) {
        guard let text, !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = true
    }

    private func saveAllRead() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = "\(reader.book.title).txt"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let text = allRead
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            // A sandboxed save may not make its temporary file next to the chosen one.
            do { try text.write(to: url, atomically: false, encoding: .utf8) } catch { saveFailed = true }
        }
    }

    private func errorText(_ code: String) -> String {
        switch code {
        case "no-key": t["noKeyBody"]
        case "key": t["errorKey"]
        case "quota": t["errorQuota"]
        case "blocked": t["errorBlocked"]
        case "network": t["errorNetwork"]
        case "expired": t["batchExpired"]
        case "batch": t["batchFailed"]
        case "key-changed": t["batchKeyChanged"]
        default: t["errorUnknown"]
        }
    }
}
