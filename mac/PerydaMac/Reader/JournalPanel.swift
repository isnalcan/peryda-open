import AppKit
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
    @State private var confirmSummaryDelete = false
    /// Entries whose answer is open (all closed when the journal opens).
    @State private var expanded: Set<String> = []

    private var t: UIText { UIText(lang) }

    private func addNote() {
        reader.addNote(note)
        note = ""
    }

    static func sourceLabel(_ source: JournalRecord.Source, _ t: UIText) -> String {
        switch source {
        case .clip: t["sourceClip"]
        case .thread: t["sourceThread"]
        case .note: t["sourceNote"]
        case .highlight: t["sourceHighlight"]
        }
    }

    private func toggle(_ id: String) {
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
    }

    /// The entry's passage: a highlight on the yellow of its highlighter, any other passage behind a bar.
    @ViewBuilder
    private func quote(_ entry: JournalRecord) -> some View {
        if entry.source == .highlight {
            Text(entry.quote)
                .font(.reading(14))
                .foregroundStyle(Color(nsColor: TranslatedPageView.ink))
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 3).fill(Color(nsColor: Theme.highlighter(entry.highlightColor))))
                .background(RoundedRectangle(cornerRadius: 3).fill(Color.white))
        } else {
            Text(entry.quote)
                .font(.reading(14))
                .foregroundStyle(Color.inkSoft)
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(Color.peryda).frame(width: 2) }
        }
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
                            // Folds to this row, or is deleted (owner, 16 Nov).
                            HStack(spacing: 6) {
                                Button { reader.summaryCollapsed.toggle() } label: {
                                    HStack(spacing: 6) {
                                        Image(systemName: reader.summaryCollapsed ? "chevron.right" : "chevron.down")
                                            .font(.system(size: 10, weight: .bold))
                                            .frame(width: 12)
                                        Text("⁂ " + t["summaryTitle"].uppercased(with: Locale(identifier: lang.rawValue)))
                                            .font(.system(size: 11, weight: .bold))
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.borderless)
                                .foregroundStyle(Color.peryda)
                                .help(reader.summaryCollapsed ? t["show"] : t["hide"])
                                .accessibilityLabel(reader.summaryCollapsed ? t["show"] : t["hide"])
                                Spacer()
                                Text(summary.createdAt, style: .date).font(.caption).foregroundStyle(Color.inkFaint)
                                Button { confirmSummaryDelete = true } label: { Image(systemName: "trash").font(.system(size: 11)) }
                                    .buttonStyle(.borderless)
                                    .foregroundStyle(Color.inkFaint)
                                    .help(t["deleteSummary"])
                                    .accessibilityLabel(t["deleteSummary"])
                            }
                            if !reader.summaryCollapsed {
                                SelectableAnswer(text: summary.text)
                            }
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
                                Text(Self.sourceLabel(entry.source, t))
                                if entry.pageNumber > 0 {
                                    // A click on the page goes there.
                                    // In an EPUB the number is the chapter, and the click goes to that chapter.
                                    Button("· " + (reader.epub != nil ? Compose.chapterLabel(lang, entry.pageNumber) : Compose.pageLabel(lang, entry.pageNumber))) {
                                        if reader.epub != nil { reader.goToChapter(entry.pageNumber) } else { reader.cameraCommand = .goToPage(entry.pageNumber) }
                                    }
                                        .buttonStyle(.borderless)
                                        .help(reader.epub != nil ? t["goToChapter"] : t["goToPage"])
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
                                // A click on a saved thread's passage opens or closes Pery's answer.
                                quote(entry)
                                    .contentShape(Rectangle())
                                    .onTapGesture { if entry.source != .note, !entry.text.isEmpty { toggle(entry.id) } }
                            }
                            // A note is its text. A saved thread shows its passage; Pery's answer opens
                            // on a click, so the journal stays a list of passages (owner test 15 Nov).
                            if entry.source == .note, !entry.text.isEmpty {
                                SelectableAnswer(text: entry.text)
                            } else if !entry.text.isEmpty {
                                let open = expanded.contains(entry.id)
                                Button { toggle(entry.id) } label: {
                                    Label(open ? t["hideAnswer"] : t["showAnswer"], systemImage: open ? "chevron.up" : "chevron.down")
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(Color.inkFaint)
                                }
                                .buttonStyle(.borderless)
                                .accessibilityIdentifier("journalAnswerToggle")
                                if open {
                                    SelectableAnswer(text: entry.text)
                                }
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
        .confirmationDialog(t["deleteSummaryConfirm"], isPresented: $confirmSummaryDelete) {
            Button(t["deleteSummary"], role: .destructive) { reader.deleteSummary() }
            Button(t["cancel"], role: .cancel) {}
        }
    }
}

/// Escape closes the Book Journal, but never while typing (a note's draft must survive it) and never
/// while something smaller is open: the selection menu, the find bar, a sheet or a popover close first.
struct JournalEscape: ViewModifier {
    let reader: ReaderModel
    @State private var monitor: Any?

    func body(content: Content) -> some View {
        content
            .onAppear {
                guard monitor == nil else { return }
                monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak reader] event in
                    guard event.keyCode == 53, let reader, JournalEscape.closes(reader: reader, event: event) else { return event }
                    reader.showJournal = false
                    return nil
                }
            }
            .onDisappear {
                if let monitor { NSEvent.removeMonitor(monitor) }
                monitor = nil
            }
    }

    @MainActor
    static func closes(reader: ReaderModel, event: NSEvent) -> Bool {
        guard reader.showJournal, reader.pending == nil, !reader.finding, event.modifierFlags.intersection([.command, .option, .control, .shift]).isEmpty,
              let window = event.window, window.attachedSheet == nil, !(window is NSPanel),
              !(window.childWindows ?? []).contains(where: \.isVisible) else { return false }
        if let text = window.firstResponder as? NSTextView, text.isEditable { return false }
        return true
    }
}
