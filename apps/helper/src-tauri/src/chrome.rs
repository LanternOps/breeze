//! Localized chrome for the surfaces Rust draws itself (the tray), and the OS
//! UI language Assist reports in `AuthRequest.uiLocale` (#10190, W03, plan P6).
//!
//! The strings are the shared `common` catalog namespace, compiled in with
//! `include_str!` (plan P3): the same file the agent embeds and the webview
//! reads through the `@prompt-catalog` alias. Locale negotiation mirrors
//! `negotiatePromptLocale` (TS) and `promptcatalog.Negotiate` (Go); the three
//! are pinned by `fixtures/prompt-catalog/locale-negotiation.json`.

use std::collections::HashMap;
use std::sync::OnceLock;

const COMMON_JSON: &str = include_str!("../../../../packages/shared/src/promptCatalog/catalog/common.json");

/// The eight prompt locales, in the catalog's canonical order.
pub const PROMPT_LOCALES: [&str; 8] = ["en", "de-DE", "es-419", "fr-FR", "fr-CA", "it-IT", "pt-BR", "tr-TR"];
pub const DEFAULT_LOCALE: &str = "en";

/// Longest OS locale tag forwarded to the agent; anything longer is dropped.
const MAX_LOCALE_TAG: usize = 64;

type Messages = HashMap<String, HashMap<String, String>>;

#[derive(serde::Deserialize)]
struct CatalogFile {
    messages: Messages,
}

fn messages() -> &'static Messages {
    static MESSAGES: OnceLock<Messages> = OnceLock::new();
    MESSAGES.get_or_init(|| {
        serde_json::from_str::<CatalogFile>(COMMON_JSON)
            .map(|f| f.messages)
            .unwrap_or_else(|e| {
                // Unreachable for a shipped build (a unit test parses the file).
                eprintln!("[helper] prompt catalog common.json did not parse: {e}");
                HashMap::new()
            })
    })
}

/// Map any OS / BCP 47 / POSIX tag onto one of the eight prompt locales.
/// Same steps as the TS and Go versions: trim ASCII whitespace only; a tag
/// with anything but ASCII letters, digits and `_ - . @` is `en`.
pub fn negotiate(tag: &str) -> &'static str {
    let t = tag.trim_matches(|c| matches!(c, ' ' | '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r'));
    if !t.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'@')) {
        return DEFAULT_LOCALE;
    }
    let mut t = t.to_ascii_lowercase().replace('_', "-");
    if let Some(at) = t.find('@') {
        t.truncate(at);
    }
    if let Some(dot) = t.find('.') {
        t.truncate(dot);
    }
    if let Some(exact) = PROMPT_LOCALES.iter().find(|l| l.to_ascii_lowercase() == t) {
        return exact;
    }
    if t.starts_with("fr-ca-") {
        return "fr-CA";
    }
    let primary = t.split('-').next().unwrap_or("");
    match primary {
        "en" => "en",
        "de" => "de-DE",
        "es" => "es-419",
        "fr" => "fr-FR",
        "it" => "it-IT",
        "pt" => "pt-BR",
        "tr" => "tr-TR",
        _ => DEFAULT_LOCALE,
    }
}

/// The `common` catalog string `key` in `locale` (negotiated, falling back to
/// `en`, then to the key itself). `{name}` parameters are substituted in one
/// pass, so a value is never re-read as a placeholder; a missing one stays
/// literal.
pub fn chrome_string(key: &str, locale: &str, params: &[(&str, &str)]) -> String {
    let Some(by_locale) = messages().get(key) else { return key.to_string() };
    let text = by_locale
        .get(negotiate(locale))
        .or_else(|| by_locale.get(DEFAULT_LOCALE))
        .map(String::as_str)
        .unwrap_or(key);
    substitute(text, params)
}

fn substitute(text: &str, params: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let name_len = after
            .char_indices()
            .take_while(|(i, c)| if *i == 0 { c.is_ascii_alphabetic() } else { c.is_ascii_alphanumeric() || *c == '_' })
            .count();
        let name = &after[..name_len];
        let value = (name_len > 0 && after[name_len..].starts_with('}'))
            .then(|| params.iter().find(|(k, _)| *k == name).map(|(_, v)| *v))
            .flatten();
        match value {
            Some(v) => {
                out.push_str(v);
                rest = &after[name_len + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// An OS locale tag safe to put on the wire: BCP 47 / POSIX characters only,
/// bounded; anything else becomes "" (the key is then omitted).
pub fn sanitize_locale_tag(tag: &str) -> String {
    let t = tag.trim();
    if t.is_empty()
        || t.len() > MAX_LOCALE_TAG
        || !t.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'@'))
    {
        return String::new();
    }
    t.to_string()
}

/// The user's OS UI language (first preferred language), probed once per
/// process: Windows `GetUserPreferredUILanguages`, macOS `CFLocale` preferred
/// languages, Linux `LANGUAGE`/`LC_ALL`/`LC_MESSAGES`/`LANG` (sys-locale).
/// "" when the OS reports nothing usable.
pub fn os_ui_locale() -> &'static str {
    static OS_LOCALE: OnceLock<String> = OnceLock::new();
    OS_LOCALE.get_or_init(|| sys_locale::get_locale().map(|t| sanitize_locale_tag(&t)).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEGOTIATION: &str =
        include_str!("../../../../packages/shared/src/fixtures/prompt-catalog/locale-negotiation.json");

    #[test]
    fn negotiate_matches_the_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(NEGOTIATION).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() > 10);
        for c in cases {
            let input = c["input"].as_str().unwrap();
            assert_eq!(negotiate(input), c["expected"].as_str().unwrap(), "input {input:?}");
        }
    }

    #[test]
    fn catalog_parses_with_every_locale() {
        let m = messages();
        for key in ["chrome.notifications", "chrome.notificationsCount", "identity.generic"] {
            for l in PROMPT_LOCALES {
                assert!(m[key].get(l).is_some_and(|s| !s.is_empty()), "{key} {l}");
            }
        }
    }

    #[test]
    fn chrome_string_localizes_and_falls_back_to_en() {
        assert_eq!(chrome_string("chrome.notificationsCount", "de-DE", &[("count", "3")]), "Benachrichtigungen (3)");
        assert_eq!(chrome_string("chrome.notificationsCount", "de_AT.UTF-8", &[("count", "3")]), "Benachrichtigungen (3)");
        assert_eq!(chrome_string("chrome.notificationsCount", "zh-CN", &[("count", "1")]), "Notifications (1)");
        assert_eq!(chrome_string("chrome.notificationsCount", "", &[("count", "1")]), "Notifications (1)");
        assert_eq!(chrome_string("no.such.key", "en", &[]), "no.such.key");
    }

    #[test]
    fn chrome_string_substitutes_in_one_pass() {
        assert_eq!(chrome_string("native.windowTitle", "en", &[("partner", "{partner}")]), "{partner} · Message");
        assert_eq!(chrome_string("chrome.remainingAnnounce", "en", &[]), "{seconds} seconds remaining");
        assert_eq!(substitute("{a}{b} {time:1} {", &[("a", "{b}"), ("b", "x")]), "{b}x {time:1} {");
    }

    #[test]
    fn locale_tag_is_sanitized_for_the_wire() {
        assert_eq!(sanitize_locale_tag(" de-DE "), "de-DE");
        assert_eq!(sanitize_locale_tag("fr_CA.UTF-8"), "fr_CA.UTF-8");
        assert_eq!(sanitize_locale_tag("en\"-US"), "");
        assert_eq!(sanitize_locale_tag("de-DE\u{202E}"), "");
        assert_eq!(sanitize_locale_tag(&"a".repeat(65)), "");
        assert_eq!(sanitize_locale_tag(""), "");
        // The probe returns a sanitized (possibly empty) tag.
        assert_eq!(os_ui_locale(), sanitize_locale_tag(os_ui_locale()));
    }
}
