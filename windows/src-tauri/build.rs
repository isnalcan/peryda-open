fn main() {
    // The window's own commands (the update check) are declared here, so each needs a permission in
    // capabilities/default.json and an undeclared command is refused (audit 15 Nov, WW-6).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["updater_state", "updater_check", "updater_install"])),
    )
    .expect("tauri-build failed");
}
