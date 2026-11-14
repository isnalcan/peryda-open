import PerydaKit
import SwiftUI

/// The Book Journal beside the open book: clipped passages, saved threads, notes, and Pery's summary.
struct JournalPanel: View {
    let reader: ReaderModel
    let lang: Lang
    let openSettings: () -> Void
    @State private var note = ""
    /// The entry waiting for "Delete": a journal entry (often the reader's own note) cannot be brought
    /// back, so it is not deleted on a single click (audit MA-9, 15 Nov).
    @State private var confirmDelete: String?

    private var t: UIText { UIText(lang) }

    private func addNote() {
        reader.addNote(note)
        note = ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(t["journal"]).font(.reading(19).weight(.medium))
                Spacer()
                if reader.summarizing {
                    Button(t["stop"]) { reader.stopSummary() }
                } else {
                    Button { reader.summarize(lang: lang) } label: { Label(t["summarize"], systemImage: "text.append") }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                TextField(t["addNote"], text: $note, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.reading(14))
                    .lineLimit(1...6)
                    .onSubmit(addNote)
                Button(action: addNote) { SendLabel(symbol: "plus", enabled: !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                    .buttonStyle(.borderless)
                    .disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .help(t["save"])
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let error = reader.summaryError {
                        HStack {
                            Text(error).font(.callout).foregroundStyle(Color.inkSoft)
                            if error == t["noKeyBody"] { Button(t["openSettings"], action: openSettings).buttonStyle(.link) }
                        }
                    }
                    if let summary = reader.summary, !summary.text.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("⁂ " + t["summaryTitle"].uppercased(with: Locale(identifier: lang.rawValue)))
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundStyle(Color.peryda)
                                Spacer()
                                Text(summary.createdAt, style: .date).font(.caption).foregroundStyle(Color.inkFaint)
                            }
                            SelectableAnswer(text: summary.text)
                        }
                        .padding(12)
                        .background(Color.peryda.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                    }
                    if reader.journal.isEmpty {
                        Text(t["journalEmpty"]).foregroundStyle(Color.inkSoft)
                    }
                    ForEach(reader.journal) { entry in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 6) {
                                Text(entry.source == .clip ? t["sourceClip"] : entry.source == .thread ? t["sourceThread"] : t["sourceNote"])
                                if entry.pageNumber > 0 {
                                    // A click on the page goes there.
                                    Button("· " + Compose.pageLabel(lang, entry.pageNumber)) { reader.cameraCommand = .goToPage(entry.pageNumber) }
                                        .buttonStyle(.borderless)
                                        .help(t["goToPage"])
                                        .disabled(reader.epub != nil)
                                }
                                Text("·")
                                Text(Date(timeIntervalSince1970: entry.createdAt / 1000), style: .date)
                                Spacer()
                                Button { confirmDelete = entry.id } label: { Image(systemName: "trash") }
                                    .buttonStyle(.borderless)
                                    .help(t["deleteEntry"])
                            }
                            .font(.caption)
                            .foregroundStyle(Color.inkFaint)
                            if !entry.quote.isEmpty {
                                Text(entry.quote)
                                    .font(.reading(14))
                                    .foregroundStyle(Color.inkSoft)
                                    .padding(.leading, 10)
                                    .overlay(alignment: .leading) { Rectangle().fill(Color.peryda).frame(width: 2) }
                            }
                            if !entry.text.isEmpty {
                                SelectableAnswer(text: entry.text)
                            }
                        }
                        .padding(.vertical, 6)
                        Divider()
                    }
                }
                .padding(16)
            }
        }
        .frame(minWidth: 300, idealWidth: 380)
        .background(Color.paper)
        .confirmationDialog(t["deleteEntryConfirm"], isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })) {
            Button(t["deleteEntry"], role: .destructive) {
                if let id = confirmDelete { reader.deleteJournal(id) }
                confirmDelete = nil
            }
            Button(t["cancel"], role: .cancel) { confirmDelete = nil }
        }
    }
}
