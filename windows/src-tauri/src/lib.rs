//! Peryda for Windows: a native window around the web reading engine (web/). Reading, threads, the
//! journal and the reader's own AI keys all live in the web engine; requests go from this computer
//! straight to the reader's provider. The shell adds one thing of its own: the update check, which the
//! web engine runs only when the reader has allowed it (three commands below, nothing else).

use std::sync::Mutex;

use tauri::{webview::DownloadEvent, AppHandle, State, Url, WebviewWindowBuilder};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The window only ever shows the app itself. A dropped file, a stray link or any bug that changes
/// the location would otherwise load another page inside a window that looks like Peryda.
fn is_app_url(url: &Url) -> bool {
    match (url.scheme(), url.host_str()) {
        // Packaged app on Windows (useHttpsScheme) and on other systems during development.
        ("https", Some("tauri.localhost")) | ("tauri", Some("localhost")) => true,
        // `tauri dev` serves the web engine from the Vite dev server.
        ("http", Some("localhost")) => cfg!(debug_assertions) && url.port() == Some(5191),
        // Book images and exported backups are blob: URLs created by the app itself.
        ("blob", _) | ("about", _) | ("data", _) => true,
        _ => false,
    }
}

/// The update check. Unavailable in builds made without the update key (plugins.updater.pubkey).
struct Updates {
    available: bool,
    /// What the last check found, waiting for the reader to install it.
    pending: Mutex<Option<Update>>,
}

/// Whether this build can update itself, and its version.
#[tauri::command]
fn updater_state(app: AppHandle, updates: State<'_, Updates>) -> (bool, String) {
    (updates.available, app.package_info().version.to_string())
}

/// Asks the update address (the latest GitHub release) for a newer version. Returns its version, or
/// None when this one is the newest. Only the request goes out; nothing about the reader is sent.
#[tauri::command]
async fn updater_check(app: AppHandle, updates: State<'_, Updates>) -> Result<Option<String>, String> {
    if !updates.available {
        return Err("unavailable".into());
    }
    let found = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let version = found.as_ref().map(|u| u.version.clone());
    *updates.pending.lock().map_err(|e| e.to_string())? = found;
    Ok(version)
}

/// Downloads the update the last check found, checks its signature against the update key and runs
/// its installer, which closes Peryda and opens it again. An unsigned or altered file is refused.
#[tauri::command]
async fn updater_install(updates: State<'_, Updates>) -> Result<(), String> {
    let update = updates.pending.lock().map_err(|e| e.to_string())?.take().ok_or("no update to install")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())
}

/// True when the build carries the public half of the update key.
fn has_update_key(context: &tauri::Context<tauri::Wry>) -> bool {
    context
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.trim().is_empty())
}

pub fn run() {
    let context = tauri::generate_context!();
    let available = has_update_key(&context);
    let mut builder = tauri::Builder::default();
    if available {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .manage(Updates { available, pending: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![updater_state, updater_check, updater_install])
        .setup(|app| {
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .expect("main window config");
            WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_navigation(|url| is_app_url(url))
                // Only the backup export (a blob: download made by the app) may save a file.
                .on_download(|_, event| match event {
                    DownloadEvent::Requested { url, .. } => url.scheme() == "blob",
                    _ => true,
                })
                .build()?;
            Ok(())
        })
        .run(context)
        .expect("Peryda could not start");
}
