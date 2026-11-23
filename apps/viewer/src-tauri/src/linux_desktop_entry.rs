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
/// has an `AppRun`.
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
    /// No file, or one that could not be read as text.
    Missing,
    /// An untouched entry this app generated, for a different launcher (an
    /// older install, a moved AppImage, the pre-#12550 AppDir binary path).
    OursForAnotherLauncher,
    /// `Exec=` is absent or names a program that is not there.
    BrokenExec,
    /// The entry no longer claims `x-scheme-handler/breeze`.
    NoSchemeHandler,
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

/// Decide what to do with the existing desktop entry.
///
/// - `existing`: the file's text, `None` when it is missing or unreadable.
/// - `ours`: what this install would write.
/// - `regenerate`: the entry this app writes for a given launcher path, or
///   `None` when that path cannot be written into `Exec=`.
/// - `program_runs`: whether an `Exec=` program resolves to an executable.
pub(crate) fn entry_action(
    existing: Option<&str>,
    ours: &str,
    regenerate: &dyn Fn(&str) -> Option<String>,
    program_runs: &dyn Fn(&str) -> bool,
) -> EntryAction {
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

/// Whether `program` resolves to an executable: an absolute path is checked
/// as is, a bare name is looked up on `path_env`, and a relative path with a
/// `/` never resolves (`Exec=` runs from an unspecified directory).
pub(crate) fn program_resolves(
    program: &str,
    path_env: Option<&str>,
    is_executable: &dyn Fn(&Path) -> bool,
) -> bool {
    let path = Path::new(program);
    if path.is_absolute() {
        return is_executable(path);
    }
    if program.is_empty() || program.contains('/') {
        return false;
    }
    path_env
        .unwrap_or_default()
        .split(':')
        .map(Path::new)
        .filter(|dir| dir.is_absolute())
        .any(|dir| is_executable(&dir.join(program)))
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
    fn program_resolves_cases() {
        let exe = files(&["/home/u/wrapper.sh", "/usr/bin/env"]);
        assert!(program_resolves("/home/u/wrapper.sh", None, &exe));
        assert!(!program_resolves("/home/u/gone.AppImage", None, &exe));
        assert!(program_resolves(
            "env",
            Some("/usr/local/bin:/usr/bin"),
            &exe
        ));
        assert!(!program_resolves("env", Some("/usr/local/bin"), &exe));
        assert!(!program_resolves("env", None, &exe));
        // Relative PATH entries are skipped, as are relative programs with `/`.
        assert!(!program_resolves(
            "env",
            Some("usr/bin"),
            &files(&["usr/bin/env"])
        ));
        assert!(!program_resolves("./wrapper.sh", Some("/usr/bin"), &exe));
        assert!(!program_resolves("", Some("/usr/bin"), &exe));
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

    fn act(existing: Option<&str>, ours: &str, runs: &[&str]) -> EntryAction {
        let runs: HashSet<String> = runs.iter().map(|s| s.to_string()).collect();
        entry_action(existing, ours, &generated, &|p: &str| runs.contains(p))
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
        // An extra key on an otherwise generated entry also counts as an edit.
        let tweaked = format!(
            "{}Path=/home/u/sq/usr\n",
            generated("/home/u/sq/usr/bin/breeze-viewer").unwrap()
        );
        assert_eq!(
            act(Some(&tweaked), &ours, &["/home/u/sq/usr/bin/breeze-viewer"]),
            EntryAction::KeepUserEdited {
                program: "/home/u/sq/usr/bin/breeze-viewer".into()
            }
        );
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
