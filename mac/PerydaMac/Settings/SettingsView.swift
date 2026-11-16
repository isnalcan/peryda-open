import PerydaKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var draft = ByokSettings()
    @State private var remember = true
    @State private var saved = false
    @State private var loaded = false

    /// Keys or "remember" changed here and not saved yet.
    private var hasUnsavedChanges: Bool {
        loaded && (draft != model.settings || remember != model.rememberKeys)
    }

    var body: some View {
        let t = model.t
        TabView {
            Form {
                Section {
                    Text(t["aiKeysIntro"])
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    // Which models the settings were tuned for.
                    Label(t["modelsNote"], systemImage: "info.circle")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Label(t["keysStoredMac"], systemImage: "lock")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    KeySafety(t: t)
                }
                ForEach(ProviderID.allCases, id: \.self) { provider in
                    ProviderSection(provider: provider, settings: $draft)
                }
                if draft.providersWithKeys.count > 1 {
                    Picker(t["activeProvider"], selection: $draft.activeProvider) {
                        ForEach(draft.providersWithKeys, id: \.self) { p in Text(t["provider_\(p.rawValue)"]).tag(p) }
                    }
                    .pickerStyle(.segmented)
                }
                Section {
                    Toggle(t["rememberKeys"], isOn: $remember)
                    HStack {
                        // Key edits apply only when saved; while they are not, the window says so, so
                        // closing it does not silently drop them (audit KR-5).
                        if hasUnsavedChanges {
                            Label(t["unsavedKeys"], systemImage: "exclamationmark.circle")
                                .font(.callout)
                                .foregroundStyle(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer()
                        Button(saved ? t["saved"] : t["save"]) {
                            // "Saved" only when the Keychain took it (audit K-4); otherwise the reason,
                            // and the switch shows what is really stored.
                            if model.saveSettings(draft, remember: remember) {
                                saved = true
                                Task {
                                    try? await Task.sleep(for: .seconds(1.6))
                                    saved = false
                                }
                            } else {
                                remember = model.rememberKeys
                            }
                        }
                        .keyboardShortcut(.defaultAction)
                    }
                    if let error = model.keychainError {
                        Text(error).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .formStyle(.grouped)
            .tabItem { Label(t["aiKeys"], systemImage: "key") }

            Form {
                Picker(t["language"], selection: Binding(get: { model.lang }, set: { model.lang = $0 })) {
                    ForEach(Lang.allCases, id: \.self) { Text($0.languageName.capitalized).tag($0) }
                }
                Picker(t["theme"], selection: Binding(get: { model.theme }, set: { model.theme = $0 })) {
                    Text(t["themeSystem"]).tag(ThemePreference.system)
                    Text(t["themeLight"]).tag(ThemePreference.light)
                    Text(t["themeDark"]).tag(ThemePreference.dark)
                }
                UpdateSettings(updates: model.updates, t: t)
            }
            .formStyle(.grouped)
            .tabItem { Label(t["theme"], systemImage: "paintbrush") }

            BackupSettings()
                .tabItem { Label(t["backup"], systemImage: "archivebox") }

            PrivacySettings()
                .tabItem { Label(t["privacy"], systemImage: "hand.raised") }
        }
        .frame(width: 600, height: 680)
        .onAppear {
            draft = model.settings
            remember = model.rememberKeys
            loaded = true
        }
    }
}

/// Whether Peryda looks for new versions by itself, and a button to look now.
struct UpdateSettings: View {
    let updates: Updates
    let t: UIText

    var body: some View {
        Section(t["updates"]) {
            if updates.available {
                Toggle(t["updatesAuto"], isOn: Binding(get: { updates.checksAutomatically }, set: { updates.setAutomatic($0) }))
                Text(t["updatesHint"])
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Text(t("versionIs", ["v": updates.version]))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button(t["checkNow"]) { updates.checkNow() }
                        .disabled(!updates.canCheckNow)
                }
            } else {
                Text(t["updatesUnavailable"])
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// One provider: its key, then (with a key) a model for threads and one for page translation. The
/// recommended models come first, marked; "Load models" lists every model the key can use.
struct ProviderSection: View {
    @Environment(AppModel.self) private var model
    let provider: ProviderID
    @Binding var settings: ByokSettings
    @State private var models: [String] = []
    @State private var loading = false
    @State private var error: String?

    private var keyBinding: Binding<String> {
        Binding(get: { settings.chosenKey(provider) }, set: { settings.setKey($0, for: provider) })
    }

    private var placeholder: String {
        switch provider {
        case .gemini: "AIza…"
        case .openai, .deepseek: "sk-…"
        case .claude: "sk-ant-…"
        }
    }

    @State private var helpOpen: Bool

    init(provider: ProviderID, settings: Binding<ByokSettings>, helpOpen: Bool = false) {
        self.provider = provider
        _settings = settings
        _helpOpen = State(initialValue: helpOpen)
    }

    /// Where this provider hands out API keys (the same four pages as the web and Windows apps).
    static func keyPage(_ provider: ProviderID) -> (url: URL, site: String) {
        switch provider {
        case .gemini: (URL(string: "https://aistudio.google.com/apikey")!, "Google AI Studio")
        case .openai: (URL(string: "https://platform.openai.com/api-keys")!, "OpenAI Platform")
        case .deepseek: (URL(string: "https://platform.deepseek.com/api_keys")!, "DeepSeek Platform")
        case .claude: (URL(string: "https://platform.claude.com/settings/keys")!, "Claude Console")
        }
    }

    static func helpKey(_ provider: ProviderID) -> String {
        switch provider {
        case .gemini: "keyHelpGemini"
        case .openai: "keyHelpOpenai"
        case .deepseek: "keyHelpDeepseek"
        case .claude: "keyHelpClaude"
        }
    }

    var body: some View {
        let t = model.t
        let page = Self.keyPage(provider)
        Section {
            if helpOpen {
                VStack(alignment: .leading, spacing: 6) {
                    Text(t[Self.helpKey(provider)])
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Link(t("keyHelpOpen", ["site": page.site]) + " ↗", destination: page.url)
                        .font(.callout.weight(.semibold))
                }
                .padding(.vertical, 2)
            }
            SecureField(placeholder, text: keyBinding)
                .textContentType(.password)
            if ByokSettings.hasUsableKey(settings.chosenKey(provider)) {
                ModelPicker(title: t["threadModel"], provider: provider, task: .thread, settings: $settings, loaded: models, t: t)
                ModelPicker(title: t["translationModel"], provider: provider, task: .translation, settings: $settings, loaded: models, t: t)
                HStack {
                    Spacer()
                    if loading { ProgressView().controlSize(.small) }
                    Button(t["loadModels"]) {
                        loading = true
                        error = nil
                        Task {
                            do {
                                models = try await model.client.listModels(provider: provider, apiKey: settings.key(for: provider))
                            } catch let e as AIError {
                                error = e.kind == .key ? t["errorKey"] : t["errorNetwork"]
                            } catch {
                                self.error = t["errorNetwork"]
                            }
                            loading = false
                        }
                    }
                    .disabled(loading)
                }
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        } header: {
            // How to get this provider's key, left of its name (owner, 16 Nov).
            HStack(spacing: 6) {
                Button { helpOpen.toggle() } label: {
                    Image(systemName: helpOpen ? "info.circle.fill" : "info.circle")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(helpOpen ? Color.peryda : Color.secondary)
                .help(t["keyHelp"])
                .accessibilityLabel(t["keyHelp"])
                Text(t["\(provider.rawValue)Key"])
            }
        }
    }
}

/// A model menu: recommended models first with their badge, then the rest the key can use.
struct ModelPicker: View {
    let title: String
    let provider: ProviderID
    let task: AITask
    @Binding var settings: ByokSettings
    let loaded: [String]
    let t: UIText

    var body: some View {
        let recommended = ModelAdvice.recommended(provider, task)
        let current = settings.model(for: provider, task: task)
        let others = Array(Set(loaded + [current])).filter { !recommended.contains($0) }.sorted()
        HStack {
            Picker(title, selection: Binding(get: { current }, set: { settings.setModel($0, for: provider, task: task) })) {
                Section(t["recommended"]) {
                    ForEach(recommended, id: \.self) { m in Text(m).tag(m) }
                }
                if !others.isEmpty {
                    Section(t["otherModels"]) {
                        ForEach(others, id: \.self) { m in Text(m).tag(m) }
                    }
                }
            }
            if ModelAdvice.isRecommended(current, provider, task) {
                Text(t["recommended"])
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.peryda.opacity(0.14)))
                    .foregroundStyle(Color.peryda)
            }
        }
    }
}

struct BackupSettings: View {
    @Environment(AppModel.self) private var model
    @State private var message: String?
    @State private var busy = false

    var body: some View {
        let t = model.t
        Form {
            Section {
                Text(t["backupIntro"]).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button(t["exportData"]) {
                        let panel = NSSavePanel()
                        panel.nameFieldStringValue = Backup.fileName()
                        panel.allowedContentTypes = [.zip]
                        guard panel.runModal() == .OK, let url = panel.url else { return }
                        run {
                            try Backup.export(store: $0, to: url)
                            return t["exported"]
                        } failed: { error in
                            (error as? Backup.Failure) == .tooLarge ? t["backupTooLarge"] : t["errorUnknown"]
                        }
                    }
                    Button(t["importData"]) {
                        let panel = NSOpenPanel()
                        panel.allowedContentTypes = [.zip]
                        guard panel.runModal() == .OK, let url = panel.url else { return }
                        run { store in
                            let scoped = url.startAccessingSecurityScopedResource()
                            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                            let n = try Backup.restore(store: store, from: url)
                            return t("imported", ["n": n])
                        } failed: { _ in
                            t["importBackupFailed"]
                        }
                    }
                    if busy { ProgressView().controlSize(.small) }
                }
                .disabled(busy)
                if let message { Text(message).font(.callout).foregroundStyle(.secondary) }
            }
        }
        .formStyle(.grouped)
    }

    /// Export and restore read and write the whole library: off the main thread, so the app stays
    /// responsive with a large (or crafted) backup (audit MA-11).
    private func run(_ work: @escaping @Sendable (LibraryStore) throws -> String, failed: @escaping @Sendable (Error) -> String) {
        busy = true
        message = nil
        let store = model.store
        Task {
            let result: String = await Task.detached(priority: .userInitiated) {
                do { return try work(store) } catch { return failed(error) }
            }.value
            model.reloadBooks()
            message = result
            busy = false
        }
    }
}

/// What stays on this Mac and what goes to the reader's provider: the shared privacy text, in full.
struct PrivacySettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let text = PrivacyText.of(model.lang)
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(model.t["privacyIntro"])
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text(text.updated)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                ForEach(Array(text.sections.enumerated()), id: \.offset) { _, section in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(section.heading).font(.headline)
                        ForEach(Array(section.blocks.enumerated()), id: \.offset) { _, block in
                            if let p = block.p {
                                Text(p)
                            } else if let items = block.ul {
                                VStack(alignment: .leading, spacing: 6) {
                                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                                            Text("•").foregroundStyle(.secondary)
                                            Text(item)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .font(.callout)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
    }
}

/// "Is your key safe?" (owner, 16 Nov): where the key is kept, where it goes, what the reader can do,
/// and the limit, plainly; folded until opened.
struct KeySafety: View {
    let t: UIText
    @State private var open: Bool

    init(t: UIText, open: Bool = false) {
        self.t = t
        _open = State(initialValue: open)
    }

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(["keySafetyWhereMac", "keySafetyGoes", "keySafetyYou", "keySafetyLimitMac"], id: \.self) { key in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•")
                        Text(t[key]).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            .padding(.top, 6)
        } label: {
            Label(t["keySafetyTitle"], systemImage: "checkmark.shield").font(.callout.weight(.semibold))
        }
    }
}

