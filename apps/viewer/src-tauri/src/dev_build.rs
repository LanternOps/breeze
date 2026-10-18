//! Development-build guards (#8956).
//!
//! A local `tauri build` is conventionally bumped to version `999.0.0` so the
//! updater cannot "downgrade" it to the latest release while it is being
//! tested. Two things then went wrong together:
//!
//! - Every launch re-registered the running bundle as the `breeze://` handler,
//!   so once a dev bundle had been launched, the console's deep links went to
//!   it instead of the installed release.
//! - Its updater compared `999.0.0` against each real release, found it newer,
//!   and never replaced it.
//!
//! The result was a machine whose `breeze://` handler was a six-month-old dev
//! bundle that nothing would ever replace. This module decides, from the
//! running version alone, whether a build may claim the scheme and whether a
//! published release supersedes it. Release builds (`0.x`) keep their existing
//! behavior on both counts.

use std::time::Duration;

/// Opt-in for a development build to register itself as the `breeze://`
/// handler anyway, for testing the deep-link path end to end.
pub(crate) const DEV_REGISTER_ENV: &str = "BREEZE_VIEWER_REGISTER_DEV_BUILD";

/// How long after it was built a development build keeps the "the updater may
/// not replace it" protection. Past this, a published release replaces it like
/// any older version, so a forgotten dev bundle heals itself instead of staying
/// the handler forever.
#[cfg_attr(debug_assertions, allow(dead_code))] // only `auto_update` (release builds) uses it
pub(crate) const DEV_BUILD_UPDATE_GRACE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Lowest major version treated as the development-build marker. Released
/// viewers are versioned `0.x`; nothing published comes anywhere near this.
const DEV_MARKER_MAJOR: u64 = 999;

/// True when `major` is the development-build marker (`999.*` and above).
pub(crate) fn is_dev_marker(major: u64) -> bool {
    major >= DEV_MARKER_MAJOR
}

/// What the running build is, for update purposes.
#[cfg_attr(debug_assertions, allow(dead_code))] // only `auto_update` (release builds) uses it
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BuildKind {
    /// A published release, or anything not carrying the dev marker.
    Release,
    /// A dev-marker build younger than [`DEV_BUILD_UPDATE_GRACE`].
    DevFresh,
    /// A dev-marker build older than the grace period, or whose age cannot be
    /// determined.
    DevStale,
}

/// Classify the running build. `build_age` is `None` when the age is unknown
/// (unreadable binary metadata, or a modification time in the future); an
/// unknown age counts as stale, because wrongly keeping a forgotten dev build
/// is the unrecoverable failure and wrongly offering an update is not.
#[cfg_attr(debug_assertions, allow(dead_code))] // only `auto_update` (release builds) uses it
pub(crate) fn classify_build(current_major: u64, build_age: Option<Duration>) -> BuildKind {
    if !is_dev_marker(current_major) {
        return BuildKind::Release;
    }
    match build_age {
        Some(age) if age < DEV_BUILD_UPDATE_GRACE => BuildKind::DevFresh,
        _ => BuildKind::DevStale,
    }
}

/// Whether a remote release should be installed over the running build.
///
/// `remote_is_newer` is the updater's default rule (remote version greater than
/// the current one). Releases and fresh dev builds keep exactly that rule — for
/// a fresh dev build it is never true against a real release, which is the
/// protection the dev marker exists for. A stale dev build accepts any release
/// that is not itself a dev build.
#[cfg_attr(debug_assertions, allow(dead_code))] // only `auto_update` (release builds) uses it
pub(crate) fn release_supersedes(
    kind: BuildKind,
    remote_major: u64,
    remote_is_newer: bool,
) -> bool {
    match kind {
        BuildKind::Release | BuildKind::DevFresh => remote_is_newer,
        BuildKind::DevStale => !is_dev_marker(remote_major),
    }
}

/// Whether this build may register itself as the `breeze://` handler.
///
/// `Err` carries the reason it did not, worded for the idle card: the card shows
/// it under "Breeze links aren't registered", which is true — the scheme will
/// keep resolving to whichever install already holds it.
pub(crate) fn scheme_registration_allowed(
    version: &str,
    current_major: u64,
    bundle_path: &str,
    opt_in: Option<&str>,
) -> Result<(), String> {
    if !is_dev_marker(current_major) || opt_in.map(str::trim) == Some("1") {
        return Ok(());
    }
    Err(format!(
        "This is a development build ({version}) at {bundle_path}, so it did not claim \
         breeze:// links. Launch it with {DEV_REGISTER_ENV}=1 to register it anyway."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: Duration = Duration::from_secs(24 * 60 * 60);

    #[test]
    fn dev_marker_is_999_and_above_only() {
        assert!(!is_dev_marker(0));
        assert!(!is_dev_marker(1));
        assert!(!is_dev_marker(998));
        assert!(is_dev_marker(999));
        assert!(is_dev_marker(9999));
    }

    #[test]
    fn releases_are_never_classified_as_dev_whatever_their_age() {
        assert_eq!(classify_build(0, Some(Duration::ZERO)), BuildKind::Release);
        assert_eq!(classify_build(0, Some(400 * DAY)), BuildKind::Release);
        assert_eq!(classify_build(0, None), BuildKind::Release);
    }

    #[test]
    fn dev_build_is_fresh_inside_the_grace_period_and_stale_after() {
        assert_eq!(
            classify_build(999, Some(Duration::ZERO)),
            BuildKind::DevFresh
        );
        assert_eq!(classify_build(999, Some(6 * DAY)), BuildKind::DevFresh);
        assert_eq!(
            classify_build(999, Some(DEV_BUILD_UPDATE_GRACE)),
            BuildKind::DevStale
        );
        assert_eq!(classify_build(999, Some(183 * DAY)), BuildKind::DevStale);
    }

    #[test]
    fn dev_build_with_unknown_age_is_stale() {
        assert_eq!(classify_build(999, None), BuildKind::DevStale);
    }

    #[test]
    fn release_builds_keep_the_default_newer_only_rule() {
        assert!(release_supersedes(BuildKind::Release, 0, true));
        assert!(!release_supersedes(BuildKind::Release, 0, false));
    }

    #[test]
    fn fresh_dev_build_is_not_replaced_by_a_release() {
        // 999.0.0 vs 0.13.14: the default rule says "not newer".
        assert!(!release_supersedes(BuildKind::DevFresh, 0, false));
    }

    #[test]
    fn fresh_dev_build_still_follows_the_default_rule_when_remote_is_newer() {
        // Only a newer dev-marker build could be "newer" than 999.x; the default
        // rule must still let it through, not hard-code "never update".
        assert!(release_supersedes(BuildKind::DevFresh, 999, true));
    }

    #[test]
    fn stale_dev_build_is_replaced_by_any_real_release() {
        // The #8956 machine: a 999.0.0 bundle built six months ago, offered 0.13.14.
        assert!(release_supersedes(BuildKind::DevStale, 0, false));
        assert!(release_supersedes(BuildKind::DevStale, 0, true));
    }

    #[test]
    fn stale_dev_build_is_never_replaced_by_another_dev_build() {
        assert!(!release_supersedes(BuildKind::DevStale, 999, false));
        assert!(!release_supersedes(BuildKind::DevStale, 999, true));
    }

    #[test]
    fn release_build_registers_the_scheme() {
        assert_eq!(
            scheme_registration_allowed("0.13.14", 0, "/Applications/Breeze Viewer.app", None),
            Ok(())
        );
        // The opt-in is irrelevant to a release.
        assert_eq!(
            scheme_registration_allowed("0.13.14", 0, "/Applications/Breeze Viewer.app", Some("0")),
            Ok(())
        );
    }

    #[test]
    fn dev_build_does_not_register_and_says_why() {
        let err =
            scheme_registration_allowed("999.0.0", 999, "/tmp/target/Breeze Viewer.app", None)
                .expect_err("a dev build must not claim breeze://");
        assert!(err.contains("999.0.0"), "names the version: {err}");
        assert!(
            err.contains("/tmp/target/Breeze Viewer.app"),
            "names the bundle: {err}"
        );
        assert!(err.contains(DEV_REGISTER_ENV), "names the opt-in: {err}");
    }

    #[test]
    fn dev_build_registers_only_with_an_explicit_opt_in() {
        let path = "/tmp/target/Breeze Viewer.app";
        assert_eq!(
            scheme_registration_allowed("999.0.0", 999, path, Some("1")),
            Ok(())
        );
        assert_eq!(
            scheme_registration_allowed("999.0.0", 999, path, Some(" 1 ")),
            Ok(())
        );
        for value in ["", "0", "false", "yes", "true"] {
            assert!(
                scheme_registration_allowed("999.0.0", 999, path, Some(value)).is_err(),
                "{value:?} is not the opt-in"
            );
        }
    }
}
