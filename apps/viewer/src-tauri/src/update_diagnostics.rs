//! Auto-updater diagnostics (#7681): which stage a failed update died at, and
//! a persistent `updater.log`.
//!
//! The release Windows build is a GUI-subsystem binary with no console, so the
//! updater's `eprintln!` output went nowhere. A failed update left only
//! "failed — will retry on next launch" in the UI and no trace on disk, which
//! hid that the Windows update bundle was a Deflate zip the updater cannot
//! unpack (v0.110.0, v0.119.0 and v0.120.0 checked). Each updater event now
//! also goes to
//! `<app log dir>/updater.log`, and a failure carries its stage and the
//! plugin's error text to the UI.

use std::io::Write;
use std::path::Path;

/// File name of the updater log inside the app log directory
/// (`%LOCALAPPDATA%\com.breeze.viewer\logs\` on Windows,
/// `~/Library/Logs/com.breeze.viewer/` on macOS,
/// `~/.local/share/com.breeze.viewer/logs/` on Linux).
pub(crate) const UPDATER_LOG_FILE: &str = "updater.log";

/// Size at which the log rotates to `updater.log.1` (one generation kept), so
/// a viewer that fails every launch for months cannot grow it without bound.
pub(crate) const UPDATER_LOG_MAX_BYTES: u64 = 256 * 1024;

/// The updater call that returned the error being classified.
#[derive(Clone, Copy, Debug)]
pub(crate) enum UpdateStep {
    /// `Update::download` — fetches the bundle, then verifies its signature.
    Download,
    /// `Update::install` — unpacks the bundle, then launches the installer
    /// (Windows) or swaps the binary (macOS/Linux).
    Install,
}

/// Where an update attempt failed. Serialized lowercase as the `stage` of the
/// `failed` update-status event and mirrored by `UpdateFailureStage` in
/// `src/lib/updateStatus.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UpdateFailStage {
    /// The bundle could not be fetched (network, TLS, HTTP status).
    Download,
    /// The bundle was fetched but its signature did not verify.
    Verify,
    /// The verified bundle could not be unpacked into an installer: the
    /// archive itself is bad (undecodable zip, no installer inside).
    Extract,
    /// The installer could not be launched or the binary could not be swapped.
    /// Also any I/O error inside `install()` — including temp-dir or file
    /// writes while unpacking — since the plugin reports those as plain `Io`;
    /// the error text tells them apart.
    Install,
}

impl UpdateFailStage {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Download => "download",
            Self::Verify => "verify",
            Self::Extract => "extract",
            Self::Install => "install",
        }
    }
}

/// Map an updater error to the stage it failed at. The step says which call
/// failed. The variant splits that call's two halves: download vs. signature
/// check, and unpack vs. launch.
pub(crate) fn classify_update_error(
    step: UpdateStep,
    err: &tauri_plugin_updater::Error,
) -> UpdateFailStage {
    use tauri_plugin_updater::Error as E;
    match step {
        UpdateStep::Download => match err {
            E::Minisign(_)
            | E::Base64(_)
            | E::SignatureUtf8(_)
            | E::SignedVersionMismatch { .. }
            | E::MissingSignedVersion => UpdateFailStage::Verify,
            _ => UpdateFailStage::Download,
        },
        UpdateStep::Install => match err {
            // The #7681 failure: a zip entry the plugin's `zip` build cannot
            // decompress. The variant only exists on Windows (the plugin's
            // default `zip` feature, which this app keeps enabled).
            #[cfg(target_os = "windows")]
            E::Extract(_) => UpdateFailStage::Extract,
            E::BinaryNotFoundInArchive
            | E::InvalidUpdaterFormat
            | E::FailedToDetermineExtractPath => UpdateFailStage::Extract,
            _ => UpdateFailStage::Install,
        },
    }
}

/// Append one timestamped line to the updater log, creating its directory and
/// rotating at [`UPDATER_LOG_MAX_BYTES`]. Line breaks in `message` (multi-line
/// error text) are flattened so each event stays one line.
pub(crate) fn append_log_line(path: &Path, unix_secs: u64, message: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::metadata(path).is_ok_and(|m| m.len() >= UPDATER_LOG_MAX_BYTES) {
        let mut rotated = path.as_os_str().to_owned();
        rotated.push(".1");
        if std::fs::rename(path, rotated).is_err() {
            // Can't rotate (on Windows: the file held open by AV or another
            // viewer). Start the log over rather than drop this line — the
            // log stays over the cap, so every later line would drop too.
            std::fs::File::create(path)?;
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let line = message.replace(['\r', '\n'], " ");
    writeln!(file, "{} {line}", format_utc(unix_secs))
}

/// `YYYY-MM-DDTHH:MM:SSZ` for a Unix timestamp. Hand-rolled (civil-from-days)
/// so the log needs no date crate.
pub(crate) fn format_utc(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let secs_of_day = unix_secs % 86_400;
    let (hour, minute, second) = (
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    );

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_updater::Error;

    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "breeze-viewer-update-diag-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn download_step_separates_signature_failures_from_transfer_failures() {
        let transfer = [
            Error::Network("Download request failed with status: 404 Not Found".into()),
            Error::Io(std::io::Error::other("connection reset")),
        ];
        for err in &transfer {
            assert_eq!(
                classify_update_error(UpdateStep::Download, err),
                UpdateFailStage::Download,
                "{err}"
            );
        }

        let signature = [
            Error::SignatureUtf8("not-base64".into()),
            Error::SignedVersionMismatch {
                signed: "0.118.0".into(),
                announced: "0.119.0".into(),
            },
            Error::MissingSignedVersion,
        ];
        for err in &signature {
            assert_eq!(
                classify_update_error(UpdateStep::Download, err),
                UpdateFailStage::Verify,
                "{err}"
            );
        }
    }

    #[test]
    fn install_step_separates_unpacking_from_launching_the_installer() {
        for err in [Error::InvalidUpdaterFormat, Error::BinaryNotFoundInArchive] {
            assert_eq!(
                classify_update_error(UpdateStep::Install, &err),
                UpdateFailStage::Extract,
                "{err}"
            );
        }
        // e.g. ShellExecuteW refused (UAC cancelled), or the binary swap failed.
        let launch = Error::Io(std::io::Error::other(
            "The operation was canceled by the user.",
        ));
        assert_eq!(
            classify_update_error(UpdateStep::Install, &launch),
            UpdateFailStage::Install
        );
    }

    #[test]
    fn fail_stage_serializes_to_the_ts_union() {
        let cases = [
            (UpdateFailStage::Download, "download"),
            (UpdateFailStage::Verify, "verify"),
            (UpdateFailStage::Extract, "extract"),
            (UpdateFailStage::Install, "install"),
        ];
        for (stage, wire) in cases {
            assert_eq!(
                serde_json::to_value(stage).unwrap(),
                serde_json::json!(wire)
            );
            assert_eq!(stage.as_str(), wire);
        }
    }

    #[test]
    fn format_utc_renders_iso8601() {
        assert_eq!(format_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(format_utc(1_790_949_929), "2026-10-02T14:05:29Z");
        assert_eq!(format_utc(4_102_444_799), "2099-12-31T23:59:59Z");
    }

    #[test]
    fn append_log_line_creates_the_log_dir_and_appends_one_line_per_event() {
        let dir = scratch_dir("append");
        let path = dir.join("logs").join(UPDATER_LOG_FILE);

        append_log_line(&path, 0, "first").unwrap();
        append_log_line(&path, 60, "second\r\nwith a newline").unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            "1970-01-01T00:00:00Z first\n1970-01-01T00:01:00Z second  with a newline\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_log_line_rotates_one_generation_at_the_size_cap() {
        let dir = scratch_dir("rotate");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(UPDATER_LOG_FILE);
        let rotated = dir.join(format!("{UPDATER_LOG_FILE}.1"));
        std::fs::write(&rotated, "oldest").unwrap();
        std::fs::write(&path, vec![b'x'; UPDATER_LOG_MAX_BYTES as usize]).unwrap();

        append_log_line(&path, 0, "after rotation").unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "1970-01-01T00:00:00Z after rotation\n"
        );
        assert_eq!(
            std::fs::metadata(&rotated).unwrap().len(),
            UPDATER_LOG_MAX_BYTES,
            "the full log becomes .1, replacing the older generation"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A rotation that cannot rename (on Windows: the file held open by AV or
    /// a second viewer) must not drop the event being logged — and since the
    /// log stays over the cap, it would otherwise drop every later one too.
    #[test]
    fn append_log_line_still_writes_when_rotation_cannot_rename() {
        let dir = scratch_dir("rotate-blocked");
        let path = dir.join(UPDATER_LOG_FILE);
        // A non-empty directory at the rotation target makes rename() fail.
        let rotated = dir.join(format!("{UPDATER_LOG_FILE}.1"));
        std::fs::create_dir_all(&rotated).unwrap();
        std::fs::write(rotated.join("keep"), "x").unwrap();
        std::fs::write(&path, vec![b'x'; UPDATER_LOG_MAX_BYTES as usize]).unwrap();

        append_log_line(&path, 0, "must not be lost").unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "1970-01-01T00:00:00Z must not be lost\n",
            "starts over instead of growing past the cap"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
