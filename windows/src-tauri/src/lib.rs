//! Peryda for Windows: a native window around the web reading engine (web/). Reading, threads, the
//! journal and the reader's own AI keys all live in the web engine; requests go from this computer
//! straight to the reader's provider. The shell adds no network access and no native commands.

use tauri::{webview::DownloadEvent, Url, WebviewWindowBuilder};

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

pub fn run() {
    tauri::Builder::default()
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
        .run(tauri::generate_context!())
        .expect("Peryda could not start");
}
