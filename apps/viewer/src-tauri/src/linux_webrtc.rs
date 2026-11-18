//! Turn WebRTC on in the Linux webview (#9557).
//!
//! WebKitGTK's `enable-webrtc` and `enable-media-stream` settings default to
//! `FALSE`, and wry sets neither, so without this the viewer sees no
//! `RTCPeerConnection` even on a WebKitGTK that was built with WebRTC.
//!
//! This is necessary, not sufficient: the settings are a no-op on a WebKitGTK
//! compiled without `ENABLE_WEB_RTC`, which is what most distributions ship
//! (Ubuntu 22.04 / 24.04, Arch and the GNOME Flatpak runtime were all checked).
//! `scripts/release/probe-webkitgtk-webrtc.py` reports which kind the release
//! build host has, since that is the library the AppImage bundles.

/// Enable WebRTC on `window`'s webview.
///
/// Called right after the window is built, when its first load has already
/// started. That is early enough: WebKit applies a settings change to the
/// document that is still loading (checked against WebKitGTK 2.52 by turning
/// `enable-webaudio` off after `load_html` and finding `AudioContext` gone
/// from that first document).
///
/// Failure is logged and never fatal — the session window still works over the
/// transports that do not need WebRTC.
#[cfg(target_os = "linux")]
pub(crate) fn enable(window: &tauri::WebviewWindow) {
    use webkit2gtk::{SettingsExt, WebViewExt};

    let label = window.label().to_string();
    let result = window.with_webview({
        let label = label.clone();
        move |webview| match webview.inner().settings() {
            Some(settings) => {
                settings.set_enable_webrtc(true);
                settings.set_enable_media_stream(true);
            }
            None => eprintln!("Cannot enable WebRTC for {label}: the webview has no settings"),
        }
    });
    if let Err(err) = result {
        eprintln!("Cannot enable WebRTC for {label}: {err}");
    }
}
