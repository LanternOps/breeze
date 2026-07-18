//! Validated open-in-place for workspace UNC paths.
//!
//! The Files view hands us an `openPath` produced by the Workspace extension
//! (UNC-canonical for SMB sources). This module validates the path (UNC only —
//! never arbitrary local paths, URLs, or relative paths), resolves a
//! platform-appropriate open target, and opens it via the shell plugin (same
//! mechanism as the portal-open path).

use serde::Deserialize;
use tauri_plugin_shell::open;

/// The validated components of a UNC path: `\\host\share\<rel...>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UncParts {
    pub host: String,
    pub share: String,
    /// Remaining path segments below the share root (may be empty).
    pub rel: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Windows,
    Linux,
}

fn current_platform() -> Platform {
    #[cfg(target_os = "macos")]
    {
        Platform::MacOs
    }
    #[cfg(target_os = "windows")]
    {
        Platform::Windows
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Platform::Linux
    }
}

/// Accepts only UNC paths: must start with `\\`, at least host + share
/// segments, no `.`/`..` segment, no forward slashes, no interior NUL.
/// Everything else -> Err. Never accepts local paths, URLs, or relative paths.
fn validate_unc(path: &str) -> Result<UncParts, String> {
    if path.contains('\0') {
        return Err("Path must not contain NUL bytes".to_string());
    }
    if path.contains('/') {
        return Err("Path must use backslash separators only".to_string());
    }
    let rest = path
        .strip_prefix(r"\\")
        .ok_or_else(|| r"Path must be a UNC path starting with \\".to_string())?;

    let segments: Vec<&str> = rest.split('\\').collect();
    if segments.len() < 2 {
        return Err("UNC path must include a host and a share".to_string());
    }
    for segment in &segments {
        if segment.is_empty() {
            return Err("UNC path must not contain empty segments".to_string());
        }
        if *segment == "." || *segment == ".." {
            return Err("UNC path must not contain dot segments".to_string());
        }
    }

    Ok(UncParts {
        host: segments[0].to_string(),
        share: segments[1].to_string(),
        rel: segments[2..].iter().map(|s| s.to_string()).collect(),
    })
}

/// macOS: if `/Volumes/<share>/<rel>` exists, open that (share already
/// mounted); otherwise open `smb://<host>/<share>/<rel-with-forward-slashes>`
/// to trigger a mount. Windows: open the UNC string as-is. Linux: Err.
fn resolve_open_target(
    parts: &UncParts,
    platform: Platform,
    volumes_probe: impl Fn(&str) -> bool,
) -> Result<String, String> {
    match platform {
        Platform::MacOs => {
            let mut volumes_path = format!("/Volumes/{}", parts.share);
            for segment in &parts.rel {
                volumes_path.push('/');
                volumes_path.push_str(segment);
            }
            if volumes_probe(&volumes_path) {
                return Ok(volumes_path);
            }
            let mut url = format!("smb://{}/{}", parts.host, parts.share);
            for segment in &parts.rel {
                url.push('/');
                url.push_str(segment);
            }
            Ok(url)
        }
        Platform::Windows => {
            let mut unc = format!(r"\\{}\{}", parts.host, parts.share);
            for segment in &parts.rel {
                unc.push('\\');
                unc.push_str(segment);
            }
            Ok(unc)
        }
        Platform::Linux => Err("Opening shared files is not supported on this platform".to_string()),
    }
}

#[derive(Debug, Deserialize)]
pub struct OpenWorkspacePathInput {
    path: String,
}

/// Open a workspace file in place. UNC paths only in v1 — the Files view
/// treats `openPath: null` (local-profile rows, directories) as
/// copy-path-only, so anything that is not a well-formed UNC path is refused.
#[tauri::command]
pub async fn open_workspace_path(
    app: tauri::AppHandle,
    input: OpenWorkspacePathInput,
) -> Result<(), String> {
    let parts = validate_unc(&input.path)?;
    let target = resolve_open_target(&parts, current_platform(), |candidate| {
        std::path::Path::new(candidate).exists()
    })?;

    tauri_plugin_shell::ShellExt::shell(&app)
        .open(&target, None::<open::Program>)
        .map_err(|e| {
            crate::log_helper_error(&format!(
                "[helper] Failed to open workspace path {}: {}",
                target, e
            ));
            "Couldn't open the file on this machine.".to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- validate_unc -------------------------------------------------------

    #[test]
    fn validate_unc_accepts_host_share_and_rel_path() {
        let parts = validate_unc(r"\\srv\share\a\b.pdf").expect("valid UNC");
        assert_eq!(parts.host, "srv");
        assert_eq!(parts.share, "share");
        assert_eq!(parts.rel, vec!["a".to_string(), "b.pdf".to_string()]);
    }

    #[test]
    fn validate_unc_accepts_bare_share_root() {
        let parts = validate_unc(r"\\srv\share").expect("share root is valid");
        assert_eq!(parts.host, "srv");
        assert_eq!(parts.share, "share");
        assert!(parts.rel.is_empty());
    }

    #[test]
    fn validate_unc_rejects_drive_letter_path() {
        assert!(validate_unc(r"C:\x").is_err());
    }

    #[test]
    fn validate_unc_rejects_url() {
        assert!(validate_unc("smb://x").is_err());
    }

    #[test]
    fn validate_unc_rejects_host_only() {
        assert!(validate_unc(r"\\srv").is_err());
    }

    #[test]
    fn validate_unc_rejects_dot_dot_segment() {
        assert!(validate_unc(r"\\srv\share\..\x").is_err());
    }

    #[test]
    fn validate_unc_rejects_forward_slashes() {
        assert!(validate_unc(r"\\srv\share/a/b.pdf").is_err());
    }

    #[test]
    fn validate_unc_rejects_empty_and_relative() {
        assert!(validate_unc("").is_err());
        assert!(validate_unc(r"share\a.pdf").is_err());
    }

    #[test]
    fn validate_unc_rejects_interior_nul() {
        assert!(validate_unc("\\\\srv\\share\\a\0b").is_err());
    }

    #[test]
    fn validate_unc_rejects_empty_segments() {
        assert!(validate_unc(r"\\srv\share\\a.pdf").is_err());
        assert!(validate_unc(r"\\srv\share\a\").is_err());
    }

    // -- resolve_open_target ------------------------------------------------

    fn parts() -> UncParts {
        validate_unc(r"\\srv\share\a\b.pdf").expect("valid UNC")
    }

    #[test]
    fn resolve_macos_mounted_share_opens_volumes_path() {
        let target =
            resolve_open_target(&parts(), Platform::MacOs, |p| p == "/Volumes/share/a/b.pdf")
                .expect("resolves");
        assert_eq!(target, "/Volumes/share/a/b.pdf");
    }

    #[test]
    fn resolve_macos_unmounted_share_opens_smb_url() {
        let target = resolve_open_target(&parts(), Platform::MacOs, |_| false).expect("resolves");
        assert_eq!(target, "smb://srv/share/a/b.pdf");
    }

    #[test]
    fn resolve_macos_share_root_unmounted() {
        let root = validate_unc(r"\\srv\share").expect("valid UNC");
        let target = resolve_open_target(&root, Platform::MacOs, |_| false).expect("resolves");
        assert_eq!(target, "smb://srv/share");
    }

    #[test]
    fn resolve_windows_passes_unc_through() {
        let target = resolve_open_target(&parts(), Platform::Windows, |_| false).expect("resolves");
        assert_eq!(target, r"\\srv\share\a\b.pdf");
    }

    #[test]
    fn resolve_linux_is_not_supported() {
        assert!(resolve_open_target(&parts(), Platform::Linux, |_| false).is_err());
    }
}
