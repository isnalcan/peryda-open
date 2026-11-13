import PerydaKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var draft = ByokSettings()
    @State private var remember = true
    @State private var saved = false

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
                        Spacer()
                        Button(saved ? t["saved"] : t["save"]) {
                            model.saveSettings(draft, remember: remember)
                            saved = true
                            Task {
                                try? await Task.sleep(for: .seconds(1.6))
                                saved = false
                            }
                        }
                        .keyboardShortcut(.defaultAction)
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

    var body: some View {
        let t = model.t
        Section(t["\(provider.rawValue)Key"]) {
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
                        do {
                            try Backup.export(store: model.store, to: url)
                            message = t["exported"]
                        } catch {
                            message = t["errorUnknown"]
                        }
                    }
                    Button(t["importData"]) {
                        let panel = NSOpenPanel()
                        panel.allowedContentTypes = [.zip]
                        guard panel.runModal() == .OK, let url = panel.url else { return }
                        let scoped = url.startAccessingSecurityScopedResource()
                        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                        do {
                            let n = try Backup.restore(store: model.store, from: url)
                            model.reloadBooks()
                            message = t("imported", ["n": n])
                        } catch {
                            message = t["importBackupFailed"]
                        }
                    }
                }
                if let message { Text(message).font(.callout).foregroundStyle(.secondary) }
            }
        }
        .formStyle(.grouped)
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
