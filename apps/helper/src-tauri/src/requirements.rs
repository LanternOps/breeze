//! `assist-requirements.json`, shipped next to the executable (#10183, P12).
//!
//! The Go agent reads this sidecar before launching Assist on Windows and
//! refuses to start it on a WebView2 runtime older than `minWebView2Version`,
//! reporting `webview2_outdated` instead of letting Assist crash-loop before
//! its own logging is up (`agent/internal/helper/webview2.go`). The agent
//! ignores the file unless `assistVersion` matches the installed executable's
//! version: an update rollback restores only the executable, and a newer
//! build's minimum must not apply to an older build. Without a usable sidecar
//! the agent uses its compiled fallback.
//!
//! `assistVersion` is stamped from the release tag together with
//! `tauri.conf.json`, `Cargo.toml` and `package.json` (release.yml, "Inject
//! version into helper config"); in source it matches the crate version.
//!
//! `minWebView2Version` is the oldest WebView2 runtime this build's wry can
//! create a webview on. wry 0.57 casts to `ICoreWebView2_4` with `?` while
//! attaching the webview's handlers (`src/webview2/mod.rs`, `attach_handlers`);
//! that interface shipped in WebView2 SDK 1.0.902.49, whose runtime is
//! 92.0.902.49. Re-derive it on every wry/Tauri bump: find the newest
//! interface wry casts with `?` (not `if let Ok`) on the webview-creation path.
//! Raising it here protects devices running the new build; the agent's
//! fallback covers builds without a sidecar.
//!
//! Nothing in Assist reads the file at runtime; this module only pins its
//! shape.

#[cfg(test)]
mod tests {
    const SIDECAR: &str = include_str!("../assist-requirements.json");

    fn sidecar() -> serde_json::Value {
        serde_json::from_str(SIDECAR).expect("assist-requirements.json is valid JSON")
    }

    #[test]
    fn requirements_sidecar_matches_crate_version() {
        let v = sidecar();
        assert_eq!(
            v["assistVersion"].as_str(),
            Some(env!("CARGO_PKG_VERSION")),
            "assistVersion must equal the crate version (release.yml stamps both)"
        );
    }

    #[test]
    fn requirements_sidecar_minimum_is_a_four_part_runtime_version() {
        let min = sidecar()["minWebView2Version"]
            .as_str()
            .expect("minWebView2Version is a string")
            .to_owned();
        let parts: Vec<&str> = min.split('.').collect();
        assert_eq!(parts.len(), 4, "minWebView2Version {min:?} is not major.minor.build.patch");
        for p in &parts {
            assert!(
                !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()),
                "minWebView2Version {min:?} has a non-numeric part"
            );
            p.parse::<u32>().expect("each part fits in u32");
        }
        // The Windows 11 21H2 inbox runtime (#10183) must be refused.
        let major: u32 = parts[0].parse().unwrap();
        assert!(major > 90, "minWebView2Version {min:?} admits the 90.x runtime Assist crashes on");
    }

    #[test]
    fn requirements_sidecar_has_only_the_agent_contract_fields() {
        let v = sidecar();
        let keys: Vec<&String> = v.as_object().expect("an object").keys().collect();
        assert_eq!(keys.len(), 2, "unexpected sidecar fields: {keys:?}");
    }

    #[test]
    fn requirements_sidecar_is_bundled_next_to_the_executable() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let resources = conf["bundle"]["resources"]
            .as_array()
            .expect("bundle.resources is a list: on Windows each entry lands in the install dir");
        assert!(
            resources.iter().any(|r| r.as_str() == Some("assist-requirements.json")),
            "bundle.resources must ship assist-requirements.json; got {resources:?}"
        );
    }

    // The release job stamps assistVersion from the tag; without it every
    // released sidecar would say the source version and the agent would
    // always ignore it.
    #[test]
    fn release_workflow_stamps_the_sidecar_version() {
        let release = include_str!("../../../../.github/workflows/release.yml");
        assert!(
            release.contains("src-tauri/assist-requirements.json"),
            "release.yml must stamp assistVersion in assist-requirements.json"
        );
    }
}
