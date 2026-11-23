//! Pure decisions behind the Linux `breeze://` desktop entry (#12550).
//!
//! Two questions, kept free of fs and env access so they test on any machine:
//!
//! - **What should `Exec=` launch?** An extracted AppImage (an AppDir) must be
//!   started through its `AppRun`, never through `usr/bin/breeze-viewer`
//!   directly. The bundler binary-patches libwebkit2gtk so it finds
//!   `WebKitNetworkProcess` at `././/lib/...`, a path relative to the working
//!   directory, and `AppRun` is what `cd`s into `<AppDir>/usr` (and sets the
//!   library and GTK paths) before it starts the binary. Launched directly, the
//!   viewer opens with "Connection Error: Load failed".
//! - **May the existing entry be replaced?** Only when it is missing, when it
//!   is an untouched entry this app generated (so it is ours to repoint), or
//!   when it cannot work. A file the user edited is left alone while it still
//!   launches something and still claims `breeze://`.

use std::path::{Path, PathBuf};

/// The MIME type that carries the `breeze://` scheme association.
pub(crate) const BREEZE_SCHEME_MIME: &str = "x-scheme-handler/breeze";

/// `<AppDir>/AppRun` when `exe` is `<AppDir>/usr/bin/<binary>` and that AppDir
/// has an `AppRun` (`is_file` is given the `AppRun` path; Linux passes an
/// executable-file check).
///
/// Derived from the executable path, not from `$APPDIR`: the environment is
/// inherited by child processes, so `$APPDIR` can name another app's AppDir.
pub(crate) fn appdir_launcher(exe: &Path, is_file: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    if !exe.is_absolute() {
        return None;
    }
    let bin = exe
        .parent()
        .filter(|p| p.file_name() == Some("bin".as_ref()))?;
    let usr = bin
        .parent()
        .filter(|p| p.file_name() == Some("usr".as_ref()))?;
    let apprun = usr.parent()?.join("AppRun");
    is_file(&apprun).then_some(apprun)
}

/// Why the entry is (re)written. Logged, so a field report says which rule fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteReason {
    /// No file.
    Missing,
    /// An untouched entry this app generated, for a different launcher (an
    /// older install, a moved AppImage, the pre-#12550 AppDir binary path).
    OursForAnotherLauncher,
    /// `Exec=` is absent or names a program that cannot start
    /// ([`program_is_missing`]).
    BrokenExec,
    /// The entry no longer claims `x-scheme-handler/breeze`.
    NoSchemeHandler,
    /// `Exec=` starts an AppDir's `usr/bin` binary directly, skipping the
    /// `AppRun` beside it, with no `Path=` to set the working directory: the
    /// #12550 handler that opens with "Connection Error: Load failed".
    BypassesAppRun,
}

impl WriteReason {
    /// Plain-language reason, for the log line and the idle card.
    pub(crate) fn describe(self) -> &'static str {
        match self {
            Self::Missing => "it did not exist",
            Self::OursForAnotherLauncher => "it was written for a different launcher",
            Self::BrokenExec => "its Exec= program does not exist",
            Self::NoSchemeHandler => "it no longer handles breeze:// links",
            Self::BypassesAppRun => {
                "its Exec= starts the AppImage's binary directly, skipping AppRun"
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EntryAction {
    Write(WriteReason),
    /// Already exactly what this install would write.
    UpToDate,
    /// Edited by someone else and still a working handler: left as it is.
    KeepUserEdited {
        program: String,
    },
}

/// The existing entry's text from the result of reading it.
///
/// Missing is `Ok(None)`. Bytes that are not UTF-8 are decoded lossily, so a
/// corrupt file still goes through [`entry_action`] (and is rewritten as
/// broken) instead of being taken for absent. Any other error, such as a file
/// the user cannot read or a directory at that path, is returned: writing would
/// fail the same way, and "could not read" is the accurate message.
pub(crate) fn existing_entry_text(
    read: std::io::Result<Vec<u8>>,
    path: &Path,
) -> Result<Option<String>, String> {
    match read {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("could not read {}: {err}", path.display())),
    }
}

/// Decide what to do with the existing desktop entry.
///
/// - `existing`: the file's text (see [`existing_entry_text`]), `None` when it
///   is missing.
/// - `ours`: what this install would write.
/// - `regenerate`: the entry this app writes for a given launcher path, or
///   `None` when that path cannot be written into `Exec=`.
/// - `is_executable`: whether a path is an executable file.
pub(crate) fn entry_action(
    existing: Option<&str>,
    ours: &str,
    regenerate: &dyn Fn(&str) -> Option<String>,
    is_executable: &dyn Fn(&Path) -> bool,
) -> EntryAction {
    let program_runs = |program: &str| !program_is_missing(program, is_executable);
    let Some(existing) = existing else {
        return EntryAction::Write(WriteReason::Missing);
    };
    if existing == ours {
        return EntryAction::UpToDate;
    }
    let Some(program) = exec_program(existing) else {
        return EntryAction::Write(WriteReason::BrokenExec);
    };
    // Byte-identical to what this app generates for the program it names: an
    // entry nobody has touched, written by some Breeze install. Repoint it, so
    // the last-launched install keeps the scheme (and a moved AppImage, or the
    // pre-#12550 raw AppDir binary, heals).
    if regenerate(&program).as_deref() == Some(existing) {
        return EntryAction::Write(WriteReason::OursForAnotherLauncher);
    }
    if !program_runs(&program) {
        return EntryAction::Write(WriteReason::BrokenExec);
    }
    // The 0.130.0 shape, edited: launching the AppDir binary itself fails
    // unless `Path=` gives it the working directory `AppRun` would have.
    if appdir_launcher(Path::new(&program), is_executable).is_some()
        && desktop_entry_value(existing, "Path").is_none()
    {
        return EntryAction::Write(WriteReason::BypassesAppRun);
    }
    if !claims_breeze_scheme(existing) {
        return EntryAction::Write(WriteReason::NoSchemeHandler);
    }
    EntryAction::KeepUserEdited { program }
}

/// `key=value` pairs of the `[Desktop Entry]` group, values with the
/// string-level escapes (`\s`, `\n`, `\t`, `\r`, `\\`) decoded.
fn desktop_entry_values(contents: &str) -> impl Iterator<Item = (&str, String)> {
    let mut in_main_group = false;
    contents.lines().filter_map(move |line| {
        let line = line.trim();
        if line.starts_with('[') {
            in_main_group = line == "[Desktop Entry]";
            return None;
        }
        if !in_main_group || line.starts_with('#') {
            return None;
        }
        let (key, value) = line.split_once('=')?;
        Some((key.trim(), decode_string_value(value.trim())))
    })
}

fn desktop_entry_value(contents: &str, key: &str) -> Option<String> {
    desktop_entry_values(contents)
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v)
}

fn decode_string_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            // Not a string-level escape: leave it for the Exec-level parser.
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// The program `Exec=` starts: its first argument, unquoted and unescaped per
/// the Desktop Entry spec. Read from the `[Desktop Entry]` group only.
pub(crate) fn exec_program(contents: &str) -> Option<String> {
    let exec = desktop_entry_value(contents, "Exec")?;
    let exec = exec.trim_start();
    let mut chars = exec.chars();
    let mut program = String::new();
    if exec.starts_with('"') {
        chars.next();
        loop {
            match chars.next()? {
                '"' => break,
                '\\' => program.push(chars.next()?),
                ch => program.push(ch),
            }
        }
    } else {
        program.extend(chars.take_while(|c| !c.is_whitespace()));
    }
    // A literal `%` is written `%%` (a lone `%x` is a field code).
    let program = program.replace("%%", "%");
    (!program.is_empty()).then_some(program)
}

/// Whether the `[Desktop Entry]` group's `MimeType=` lists `breeze://`.
pub(crate) fn claims_breeze_scheme(contents: &str) -> bool {
    desktop_entry_value(contents, "MimeType").is_some_and(|types| {
        types
            .split(';')
            .any(|mime| mime.trim() == BREEZE_SCHEME_MIME)
    })
}

/// Whether `Exec=`'s program certainly cannot start.
///
/// An absolute path must be an executable file. A bare name is never called
/// missing: the desktop resolves it on its own `PATH`, which can include
/// directories (`~/.local/bin`) this process's does not, and a false "missing"
/// would overwrite a working edit. A relative path with a `/`, or an empty
/// program, cannot work: `Exec=` runs from an unspecified directory.
pub(crate) fn program_is_missing(program: &str, is_executable: &dyn Fn(&Path) -> bool) -> bool {
    let path = Path::new(program);
    if path.is_absolute() {
        return !is_executable(path);
    }
    program.is_empty() || program.contains('/')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn files(paths: &[&str]) -> impl Fn(&Path) -> bool {
        let set: HashSet<PathBuf> = paths.iter().map(PathBuf::from).collect();
        move |p: &Path| set.contains(p)
    }

    // ── appdir_launcher ──────────────────────────────────────────────────

    /// The reporter's layout: `--appimage-extract` output, viewer started from
    /// it. Exec must go through AppRun, which sets the working directory.
    #[test]
    fn extracted_appimage_launches_through_apprun() {
        let exe = Path::new("/home/u/squashfs-root/usr/bin/breeze-viewer");
        assert_eq!(
            appdir_launcher(exe, &files(&["/home/u/squashfs-root/AppRun"])),
            Some(PathBuf::from("/home/u/squashfs-root/AppRun"))
        );
    }

    #[test]
    fn not_an_appdir_without_apprun_or_the_usr_bin_layout() {
        // A distro-style install: /usr/bin/breeze-viewer, and no /AppRun.
        assert_eq!(
            appdir_launcher(Path::new("/usr/bin/breeze-viewer"), &files(&[])),
            None
        );
        // The usr/bin layout but no AppRun beside it.
        assert_eq!(
            appdir_launcher(Path::new("/opt/b/usr/bin/breeze-viewer"), &files(&[])),
            None
        );
        // An AppRun exists, but the binary is not at usr/bin/<binary>.
        assert_eq!(
            appdir_launcher(
                Path::new("/opt/b/bin/breeze-viewer"),
                &files(&["/opt/b/AppRun", "/opt/AppRun"])
            ),
            None
        );
        assert_eq!(
            appdir_launcher(
                Path::new("/opt/b/usr/lib/breeze-viewer"),
                &files(&["/opt/b/AppRun"])
            ),
            None
        );
        // Relative paths never produce a launcher.
        assert_eq!(
            appdir_launcher(
                Path::new("squashfs-root/usr/bin/breeze-viewer"),
                &files(&["squashfs-root/AppRun"])
            ),
            None
        );
    }

    // ── exec_program ─────────────────────────────────────────────────────

    #[test]
    fn exec_program_reads_quoted_and_bare_programs() {
        let entry = |exec: &str| format!("[Desktop Entry]\nType=Application\nExec={exec}\n");
        assert_eq!(
            exec_program(&entry("\"/home/u/My Apps/b.AppImage\" %u")).as_deref(),
            Some("/home/u/My Apps/b.AppImage")
        );
        assert_eq!(
            exec_program(&entry("/home/u/wrapper.sh %u")).as_deref(),
            Some("/home/u/wrapper.sh")
        );
        assert_eq!(
            exec_program(&entry("env FOO=1 /x %u")).as_deref(),
            Some("env")
        );
        // Escapes inside quotes, and a doubled `%`.
        assert_eq!(
            exec_program(&entry("\"/home/u/a\\$b\\`c\\\"d%%20\" %u")).as_deref(),
            Some("/home/u/a$b`c\"d%20")
        );
        // Spaces around `=` are allowed by the spec.
        assert_eq!(
            exec_program("[Desktop Entry]\nExec = /x/y %u\n").as_deref(),
            Some("/x/y")
        );
    }

    #[test]
    fn exec_program_ignores_other_groups_keys_and_locales() {
        let contents = "[Desktop Action new]\nExec=/action/only\n\
                        [Desktop Entry]\nTryExec=/try\nExec[de]=/localized\nExec=/main %u\n";
        assert_eq!(exec_program(contents).as_deref(), Some("/main"));
        assert_eq!(exec_program("[Desktop Entry]\nName=x\n"), None);
        assert_eq!(exec_program("[Desktop Entry]\nExec=\n"), None);
        assert_eq!(
            exec_program("[Desktop Entry]\nExec=\"/unterminated\n"),
            None
        );
        assert_eq!(exec_program("Exec=/no/group\n"), None);
    }

    // ── claims_breeze_scheme ─────────────────────────────────────────────

    #[test]
    fn claims_breeze_scheme_cases() {
        assert!(claims_breeze_scheme(
            "[Desktop Entry]\nMimeType=x-scheme-handler/breeze;\n"
        ));
        assert!(claims_breeze_scheme(
            "[Desktop Entry]\nMimeType=text/plain; x-scheme-handler/breeze\n"
        ));
        assert!(!claims_breeze_scheme(
            "[Desktop Entry]\nMimeType=x-scheme-handler/breezy;\n"
        ));
        assert!(!claims_breeze_scheme("[Desktop Entry]\nExec=/x\n"));
        assert!(!claims_breeze_scheme(
            "[Other]\nMimeType=x-scheme-handler/breeze;\n[Desktop Entry]\nExec=/x\n"
        ));
    }

    // ── program_resolves ─────────────────────────────────────────────────

    #[test]
    fn program_is_missing_cases() {
        let exe = files(&["/home/u/wrapper.sh"]);
        assert!(!program_is_missing("/home/u/wrapper.sh", &exe));
        assert!(program_is_missing("/home/u/gone.AppImage", &exe));
        // A bare name is looked up on the PATH the desktop's launcher has,
        // which is not necessarily this process's: never call it missing.
        assert!(!program_is_missing("breeze-wrapper", &exe));
        assert!(!program_is_missing("env", &files(&[])));
        // A relative path runs from an unspecified directory, and an empty
        // program runs nothing.
        assert!(program_is_missing("./wrapper.sh", &exe));
        assert!(program_is_missing("bin/wrapper.sh", &exe));
        assert!(program_is_missing("", &exe));
    }

    // ── existing_entry_text ──────────────────────────────────────────────

    #[test]
    fn existing_entry_text_cases() {
        use std::io::{Error, ErrorKind};
        let path = Path::new("/home/u/.local/share/applications/breeze-viewer.desktop");
        assert_eq!(
            existing_entry_text(Ok(b"[Desktop Entry]\n".to_vec()), path),
            Ok(Some("[Desktop Entry]\n".to_string()))
        );
        assert_eq!(
            existing_entry_text(Err(Error::from(ErrorKind::NotFound)), path),
            Ok(None)
        );
        // Not UTF-8: still text, so it is judged (and replaced), not "missing".
        let lossy = existing_entry_text(Ok(b"Exec=/x\xff\n".to_vec()), path)
            .unwrap()
            .unwrap();
        assert!(lossy.starts_with("Exec=/x"), "{lossy}");
        // Anything else is a real error, naming the file.
        let err =
            existing_entry_text(Err(Error::from(ErrorKind::PermissionDenied)), path).unwrap_err();
        assert!(err.contains("could not read"), "{err}");
        assert!(err.contains("breeze-viewer.desktop"), "{err}");
    }

    // ── entry_action ─────────────────────────────────────────────────────

    /// Stand-in for lib.rs's generator: same shape, enough to tell "untouched
    /// generator output" from "edited".
    fn generated(launcher: &str) -> Option<String> {
        if launcher.contains('\n') {
            return None;
        }
        Some(format!(
            "[Desktop Entry]\nType=Application\nExec=\"{launcher}\" %u\nMimeType={BREEZE_SCHEME_MIME};\n"
        ))
    }

    /// `executables`: the absolute paths that exist and are executable.
    fn act(existing: Option<&str>, ours: &str, executables: &[&str]) -> EntryAction {
        entry_action(existing, ours, &generated, &files(executables))
    }

    #[test]
    fn missing_entry_is_written() {
        let ours = generated("/home/u/sq/AppRun").unwrap();
        assert_eq!(
            act(None, &ours, &[]),
            EntryAction::Write(WriteReason::Missing)
        );
    }

    #[test]
    fn identical_entry_is_not_rewritten() {
        let ours = generated("/home/u/sq/AppRun").unwrap();
        assert_eq!(
            act(Some(&ours), &ours, &["/home/u/sq/AppRun"]),
            EntryAction::UpToDate
        );
    }

    /// The file 0.130.0 left behind: generated by us, Exec at the AppDir's raw
    /// binary. The binary still exists, so only the ownership rule can repoint
    /// it at AppRun; a "keep anything that runs" rule would keep it broken.
    #[test]
    fn untouched_entry_from_an_older_launcher_is_repointed() {
        let old = generated("/home/u/sq/usr/bin/breeze-viewer").unwrap();
        let ours = generated("/home/u/sq/AppRun").unwrap();
        assert_eq!(
            act(Some(&old), &ours, &["/home/u/sq/usr/bin/breeze-viewer"]),
            EntryAction::Write(WriteReason::OursForAnotherLauncher)
        );
        // Same for an AppImage that moved or a second install: last launched wins.
        let other = generated("/home/u/Downloads/b.AppImage").unwrap();
        assert_eq!(
            act(Some(&other), &ours, &["/home/u/Downloads/b.AppImage"]),
            EntryAction::Write(WriteReason::OursForAnotherLauncher)
        );
    }

    /// The reporter's wrapper: edited by hand, still runs, still claims the
    /// scheme. It survives every start.
    #[test]
    fn user_edited_working_entry_is_kept() {
        let ours = generated("/home/u/sq/AppRun").unwrap();
        let edited = "[Desktop Entry]\nType=Application\nName=Breeze (mine)\n\
                      Exec=/home/u/bin/breeze-wrapper %u\n\
                      MimeType=x-scheme-handler/breeze;\n";
        assert_eq!(
            act(Some(edited), &ours, &["/home/u/bin/breeze-wrapper"]),
            EntryAction::KeepUserEdited {
                program: "/home/u/bin/breeze-wrapper".into()
            }
        );
        // A bare program name is not checked against this process's PATH.
        let bare = "[Desktop Entry]\nExec=breeze-wrapper %u\nMimeType=x-scheme-handler/breeze;\n";
        assert_eq!(
            act(Some(bare), &ours, &[]),
            EntryAction::KeepUserEdited {
                program: "breeze-wrapper".into()
            }
        );
        // The raw AppDir binary is fine when the user set its working
        // directory with `Path=` (the fix the issue asked for).
        let with_path = format!(
            "{}Path=/home/u/sq/usr\n",
            generated("/home/u/sq/usr/bin/breeze-viewer").unwrap()
        );
        assert_eq!(
            act(
                Some(&with_path),
                &ours,
                &["/home/u/sq/usr/bin/breeze-viewer", "/home/u/sq/AppRun"]
            ),
            EntryAction::KeepUserEdited {
                program: "/home/u/sq/usr/bin/breeze-viewer".into()
            }
        );
    }

    /// A 0.130.0 entry the user touched (here, a renamed `Name=`) still starts
    /// the raw AppDir binary. Keeping it would keep #12550.
    #[test]
    fn edited_entry_that_skips_apprun_is_replaced() {
        let ours = generated("/home/u/sq/AppRun").unwrap();
        let renamed = generated("/home/u/sq/usr/bin/breeze-viewer")
            .unwrap()
            .replace("Type=Application\n", "Type=Application\nName=Remote\n");
        assert_eq!(
            act(
                Some(&renamed),
                &ours,
                &["/home/u/sq/usr/bin/breeze-viewer", "/home/u/sq/AppRun"]
            ),
            EntryAction::Write(WriteReason::BypassesAppRun)
        );
    }

    #[test]
    fn every_write_reason_has_a_description() {
        for reason in [
            WriteReason::Missing,
            WriteReason::OursForAnotherLauncher,
            WriteReason::BrokenExec,
            WriteReason::NoSchemeHandler,
            WriteReason::BypassesAppRun,
        ] {
            assert!(!reason.describe().is_empty(), "{reason:?}");
        }
    }

    #[test]
    fn user_edited_entry_that_cannot_work_is_replaced() {
        let ours = generated("/home/u/sq/AppRun").unwrap();
        let gone =
            "[Desktop Entry]\nExec=/home/u/bin/deleted %u\nMimeType=x-scheme-handler/breeze;\n";
        assert_eq!(
            act(Some(gone), &ours, &[]),
            EntryAction::Write(WriteReason::BrokenExec)
        );
        let no_exec = "[Desktop Entry]\nName=x\nMimeType=x-scheme-handler/breeze;\n";
        assert_eq!(
            act(Some(no_exec), &ours, &[]),
            EntryAction::Write(WriteReason::BrokenExec)
        );
        let corrupt = "\u{0}\u{1}garbage";
        assert_eq!(
            act(Some(corrupt), &ours, &[]),
            EntryAction::Write(WriteReason::BrokenExec)
        );
        let no_scheme = "[Desktop Entry]\nExec=/home/u/bin/w %u\nMimeType=text/plain;\n";
        assert_eq!(
            act(Some(no_scheme), &ours, &["/home/u/bin/w"]),
            EntryAction::Write(WriteReason::NoSchemeHandler)
        );
    }
}
