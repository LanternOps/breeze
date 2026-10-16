//! WebKitGTK environment workarounds applied on Linux before the first webview
//! is created (#8764).
//!
//! On the NVIDIA kernel driver, WebKitGTK's DMA-BUF renderer paints nothing:
//! the viewer window opens solid gray with no UI. Setting
//! `WEBKIT_DISABLE_DMABUF_RENDERER=1` sends WebKitGTK down its older
//! compositing path, which still renders on the GPU.

use std::ffi::OsStr;
use std::path::Path;

/// WebKitGTK reads this once, when the first webview is created. Any value
/// other than `0` disables the DMA-BUF renderer.
pub(crate) const DMABUF_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// Paths, relative to the filesystem root, that exist only while the NVIDIA
/// kernel driver (proprietary or open kernel modules) is loaded. Nouveau
/// exposes neither.
const NVIDIA_DRIVER_MARKERS: &[&str] = &["proc/driver/nvidia/version", "sys/module/nvidia"];

/// Whether the NVIDIA kernel driver is loaded on the system rooted at `root`.
pub(crate) fn nvidia_driver_loaded(root: &Path) -> bool {
    NVIDIA_DRIVER_MARKERS
        .iter()
        .any(|marker| root.join(marker).exists())
}

/// The value to give `WEBKIT_DISABLE_DMABUF_RENDERER`, or `None` to leave the
/// environment untouched. An existing value, whatever it is, is the user's
/// explicit choice and always wins.
pub(crate) fn dmabuf_override(
    existing: Option<&OsStr>,
    nvidia_driver: bool,
) -> Option<&'static str> {
    if existing.is_some() || !nvidia_driver {
        return None;
    }
    Some("1")
}

/// Apply the workaround to this process's environment. Must run before the
/// Tauri builder creates any window, and before any other thread starts
/// (`set_var` is not thread-safe).
#[cfg(target_os = "linux")]
pub(crate) fn apply() {
    let existing = std::env::var_os(DMABUF_ENV);
    let nvidia = existing.is_none() && nvidia_driver_loaded(Path::new("/"));
    if let Some(value) = dmabuf_override(existing.as_deref(), nvidia) {
        std::env::set_var(DMABUF_ENV, value);
        eprintln!(
            "NVIDIA driver detected; setting {DMABUF_ENV}={value} to avoid a blank window \
             (set {DMABUF_ENV}=0 to keep the DMA-BUF renderer)"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn temp_root(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("breeze-viewer-8764-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn env_var_name_matches_webkitgtk() {
        // A typo here silently disables the whole workaround.
        assert_eq!(DMABUF_ENV, "WEBKIT_DISABLE_DMABUF_RENDERER");
    }

    #[test]
    fn sets_dmabuf_off_when_nvidia_and_unset() {
        assert_eq!(dmabuf_override(None, true), Some("1"));
    }

    #[test]
    fn leaves_env_alone_without_nvidia() {
        assert_eq!(dmabuf_override(None, false), None);
    }

    #[test]
    fn explicit_user_value_always_wins() {
        for value in ["0", "1", "", "false"] {
            let v = OsString::from(value);
            assert_eq!(
                dmabuf_override(Some(v.as_os_str()), true),
                None,
                "value {value:?}"
            );
            assert_eq!(
                dmabuf_override(Some(v.as_os_str()), false),
                None,
                "value {value:?}"
            );
        }
    }

    #[test]
    fn detects_proprietary_driver_proc_entry() {
        let root = temp_root("proc");
        std::fs::create_dir_all(root.join("proc/driver/nvidia")).unwrap();
        std::fs::write(root.join("proc/driver/nvidia/version"), "NVRM version").unwrap();
        assert!(nvidia_driver_loaded(&root));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn detects_loaded_kernel_module() {
        let root = temp_root("sysmod");
        std::fs::create_dir_all(root.join("sys/module/nvidia")).unwrap();
        assert!(nvidia_driver_loaded(&root));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn no_markers_means_no_nvidia_driver() {
        let root = temp_root("none");
        // nouveau / other drivers expose neither marker.
        std::fs::create_dir_all(root.join("sys/module/nouveau")).unwrap();
        assert!(!nvidia_driver_loaded(&root));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
