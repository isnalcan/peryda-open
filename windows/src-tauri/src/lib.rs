//! Peryda for Windows: a native window around the web reading engine (web/). Reading, threads, the
//! journal and the reader's own AI keys all live in the web engine; requests go from this computer
//! straight to the reader's provider. The shell adds two things of its own: the update check, which the
//! web engine runs only when the reader has allowed it (three commands below), and opening a provider's
//! API key page in the reader's browser (one command, four fixed addresses). Nothing else.

use std::sync::Mutex;

use tauri::http::HeaderValue;
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

/// The app's Content Security Policy, sent as a header with every file the window loads. The page also
/// carries it in a <meta> tag, but a worker (pdf.js, which parses untrusted PDFs) takes its policy only
/// from its own response, and Tauri adds a policy header to HTML files only (audit 15 Nov, WW-2/K-2).
/// The same policy as the Windows build's meta tag; web/src/test/csp.test.ts checks they match.
const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' blob:; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' https://generativelanguage.googleapis.com https://api.openai.com https://api.deepseek.com https://api.anthropic.com ipc: http://ipc.localhost; worker-src 'self' blob:; frame-src 'self' blob:; child-src 'self' blob:; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

/// The update check. Unavailable in builds made without the update key (plugins.updater.pubkey).
struct Updates {
    available: bool,
    /// What the last check found, waiting for the reader to install it.
    pending: Mutex<Option<Update>>,
}

/// The page where each provider hands out API keys (Settings, the (i) beside each key; owner, 16 Nov).
/// These four are the only addresses the window can open: the page names a provider, and the address
/// always comes from here, never from the page.
fn key_page(provider: &str) -> Option<&'static str> {
    match provider {
        "gemini" => Some("https://aistudio.google.com/apikey"),
        "openai" => Some("https://platform.openai.com/api-keys"),
        "deepseek" => Some("https://platform.deepseek.com/api_keys"),
        "claude" => Some("https://platform.claude.com/settings/keys"),
        _ => None,
    }
}

/// Opens a provider's API key page in the reader's default browser (outside the app's window).
#[tauri::command]
fn open_key_page(provider: String) -> Result<(), String> {
    let url = key_page(&provider).ok_or("unknown provider")?;
    open_in_browser(url).map_err(|e| e.to_string())
}

/// Windows: explorer.exe from the Windows folder (not whatever comes first on PATH) hands the address
/// to the default browser.
#[cfg(windows)]
fn open_in_browser(url: &'static str) -> std::io::Result<()> {
    let windows = std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap_or_else(|| "C:\\Windows".into());
    std::process::Command::new(windows.join("explorer.exe")).arg(url).spawn().map(|_| ())
}

/// Development on a Mac.
#[cfg(target_os = "macos")]
fn open_in_browser(url: &'static str) -> std::io::Result<()> {
    std::process::Command::new("/usr/bin/open").arg(url).spawn().map(|_| ())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn open_in_browser(url: &'static str) -> std::io::Result<()> {
    std::process::Command::new("xdg-open").arg(url).spawn().map(|_| ())
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
        .invoke_handler(tauri::generate_handler![updater_state, updater_check, updater_install, open_key_page])
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
                // Every file the app serves carries the policy, so workers are bound by it too.
                .on_web_resource_request(|_request, response| {
                    let headers = response.headers_mut();
                    headers.insert("Content-Security-Policy", HeaderValue::from_static(CONTENT_SECURITY_POLICY));
                    headers.insert("X-Content-Type-Options", HeaderValue::from_static("nosniff"));
                })
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

#[cfg(test)]
mod tests {
    use super::key_page;

    #[test]
    fn only_the_four_key_pages_can_be_opened() {
        assert_eq!(key_page("gemini"), Some("https://aistudio.google.com/apikey"));
        assert_eq!(key_page("openai"), Some("https://platform.openai.com/api-keys"));
        assert_eq!(key_page("deepseek"), Some("https://platform.deepseek.com/api_keys"));
        assert_eq!(key_page("claude"), Some("https://platform.claude.com/settings/keys"));
        for other in ["", "https://evil.example", "gemini ", "GEMINI", "file:///C:/Windows/System32/calc.exe"] {
            assert_eq!(key_page(other), None, "{other}");
        }
    }
}

