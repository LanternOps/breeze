//! Save a session screenshot to a local folder (#8241).
//!
//! The webview hands over PNG bytes; this side picks the folder and the file
//! name, so nothing from the page decides where a file lands. Local only:
//! nothing is uploaded.

use std::path::{Path, PathBuf};

/// A 4K RGBA frame as PNG is well under this; anything larger is not a frame.
pub const MAX_SCREENSHOT_BYTES: usize = 64 * 1024 * 1024;

const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

pub fn is_png(bytes: &[u8]) -> bool {
    bytes.len() >= PNG_MAGIC.len() && bytes[..PNG_MAGIC.len()] == PNG_MAGIC
}

/// Gregorian (year, month, day) for days since 1970-01-01 (Howard Hinnant's
/// civil_from_days), so naming a file does not need a date crate.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `breeze-screenshot-YYYYMMDD-HHMMSS.png`, UTC.
pub fn screenshot_file_name(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let rem = unix_secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "breeze-screenshot-{y:04}{m:02}{d:02}-{:02}{:02}{:02}.png",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// `dir/name`, or `dir/stem-N.ext` for the first N that does not exist.
pub fn unique_path(dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    let mut n = 1u32;
    loop {
        let candidate = if ext.is_empty() {
            dir.join(format!("{stem}-{n}"))
        } else {
            dir.join(format!("{stem}-{n}.{ext}"))
        };
        if !exists(&candidate) || n == u32::MAX {
            return candidate;
        }
        n += 1;
    }
}

/// Validates and writes `bytes` into `dir`; returns the written path.
pub fn write_screenshot(dir: &Path, bytes: &[u8], unix_secs: u64) -> Result<PathBuf, String> {
    if bytes.len() > MAX_SCREENSHOT_BYTES {
        return Err("screenshot too large".into());
    }
    if !is_png(bytes) {
        return Err("not a PNG image".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create folder: {e}"))?;
    let path = unique_path(dir, &screenshot_file_name(unix_secs), |p| p.exists());
    // create_new: never replace a file, even one that appeared since the check.
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("cannot create file: {e}"))?;
    std::io::Write::write_all(&mut file, bytes).map_err(|e| format!("cannot write file: {e}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_magic_is_required() {
        let mut png = PNG_MAGIC.to_vec();
        png.extend_from_slice(b"rest");
        assert!(is_png(&png));
        assert!(!is_png(b"GIF89a....."));
        assert!(!is_png(&PNG_MAGIC[..7]));
        assert!(!is_png(&[]));
    }

    #[test]
    fn file_name_is_a_utc_timestamp() {
        assert_eq!(screenshot_file_name(0), "breeze-screenshot-19700101-000000.png");
        // 2026-10-12 16:29:47 UTC
        assert_eq!(screenshot_file_name(1_791_822_587), "breeze-screenshot-20261012-162947.png");
        // Leap day.
        assert_eq!(screenshot_file_name(951_782_400), "breeze-screenshot-20000229-000000.png");
    }

    #[test]
    fn unique_path_never_overwrites() {
        let dir = Path::new("/pics");
        let name = "breeze-screenshot-20261012-162947.png";
        assert_eq!(unique_path(dir, name, |_| false), dir.join(name));
        let taken = [dir.join(name), dir.join("breeze-screenshot-20261012-162947-1.png")];
        assert_eq!(
            unique_path(dir, name, |p| taken.iter().any(|t| t == p)),
            dir.join("breeze-screenshot-20261012-162947-2.png")
        );
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("breeze-viewer-shot-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn write_screenshot_writes_png_and_refuses_anything_else() {
        let dir = temp_dir("write");
        let mut png = PNG_MAGIC.to_vec();
        png.extend_from_slice(b"frame");
        let a = write_screenshot(&dir, &png, 0).expect("first write");
        let b = write_screenshot(&dir, &png, 0).expect("second write");
        assert_ne!(a, b, "a second shot in the same second must not overwrite the first");
        assert_eq!(std::fs::read(&a).unwrap(), png);
        assert!(write_screenshot(&dir, b"<html>", 0).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_screenshot_rejects_oversized_input_before_touching_disk() {
        let dir = temp_dir("big");
        let mut big = PNG_MAGIC.to_vec();
        big.resize(MAX_SCREENSHOT_BYTES + 1, 0);
        assert!(write_screenshot(&dir, &big, 0).is_err());
        assert!(!dir.exists());
    }
}
