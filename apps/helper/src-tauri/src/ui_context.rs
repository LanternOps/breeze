//! Locale + runtime branding of this Helper session (BRZ-7567, Phase 2, W3).
//!
//! The Agent writes both into the per-session `helper_config.yaml` (see
//! `agent/internal/helper/branding.go`). The Agent validates them before
//! writing; this module validates them again when read, so a hand-edited or
//! corrupt file can never put control characters, markup-bearing colours or
//! oversize text in front of the user. A field that fails is dropped and that
//! slot keeps its Breeze default; the rest of the section survives.
//!
//! Plain text only: there is no URL, image, CSS or HTML field.

use serde::{Deserialize, Serialize};

/// Code-point limits; mirror `agent/internal/helper/branding.go` and
/// `apps/api/src/services/helperBranding.ts`.
const MAX_DISPLAY_NAME: usize = 60;
const MAX_COMPANY_NAME: usize = 60;
const MAX_WELCOME_TITLE: usize = 120;
const MAX_WELCOME_MESSAGE: usize = 500;
const MAX_SUPPORT_LABEL: usize = 40;
const MAX_PORTAL_LABEL: usize = 40;

/// The `branding:` section of `helper_config.yaml`. `scope_id` is the Agent's
/// opaque tenant-change marker; the Helper never sends it to the webview.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HelperBranding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub welcome_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub welcome_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portal_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<String>,
}

/// Characters the Agent rejects: control (Cc), the common format (Cf) and
/// separator (Zl/Zp) code points, private use (Co) and tag characters. ZWNJ and
/// ZWJ stay allowed (some scripts and emoji need them).
fn forbidden_char(c: char) -> bool {
    if c == '\u{200C}' || c == '\u{200D}' {
        return false;
    }
    c.is_control()
        || matches!(
            c,
            '\u{00AD}'
                | '\u{0600}'..='\u{0605}'
                | '\u{061C}'
                | '\u{06DD}'
                | '\u{070F}'
                | '\u{08E2}'
                | '\u{110BD}'
                | '\u{1D173}'..='\u{1D17A}'
                | '\u{180E}'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{206F}'
                | '\u{FEFF}'
                | '\u{FFF9}'..='\u{FFFB}'
                | '\u{E000}'..='\u{F8FF}'
                | '\u{F0000}'..='\u{10FFFF}'
                | '\u{E0000}'..='\u{E007F}'
        )
}

fn valid_text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.chars().count() <= max && !s.chars().any(forbidden_char)
}

/// Strict `#RRGGBB`: no names, shorthand, alpha or functions.
pub fn valid_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn keep_text(v: Option<String>, max: usize) -> Option<String> {
    v.filter(|s| valid_text(s, max))
}

impl HelperBranding {
    /// Drops every invalid field; `None` when nothing valid is left.
    pub fn sanitized(self) -> Option<Self> {
        let out = Self {
            scope_id: None,
            display_name: keep_text(self.display_name, MAX_DISPLAY_NAME),
            company_name: keep_text(self.company_name, MAX_COMPANY_NAME),
            welcome_title: keep_text(self.welcome_title, MAX_WELCOME_TITLE),
            welcome_message: keep_text(self.welcome_message, MAX_WELCOME_MESSAGE),
            support_label: keep_text(self.support_label, MAX_SUPPORT_LABEL),
            portal_label: keep_text(self.portal_label, MAX_PORTAL_LABEL),
            primary_color: self.primary_color.filter(|c| valid_hex_color(c)),
            accent_color: self.accent_color.filter(|c| valid_hex_color(c)),
        };
        (out != Self::default()).then_some(out)
    }
}

/// What the webview receives from `get_ui_context`: the negotiated locale and
/// the validated branding, in camelCase like every other Helper IPC payload.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiContext {
    pub locale: String,
    pub branding: BrandingView,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandingView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub welcome_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub welcome_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portal_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<String>,
}

impl From<Option<&HelperBranding>> for BrandingView {
    fn from(b: Option<&HelperBranding>) -> Self {
        let Some(b) = b else { return Self::default() };
        Self {
            display_name: b.display_name.clone(),
            company_name: b.company_name.clone(),
            welcome_title: b.welcome_title.clone(),
            welcome_message: b.welcome_message.clone(),
            support_label: b.support_label.clone(),
            portal_label: b.portal_label.clone(),
            primary_color: b.primary_color.clone(),
            accent_color: b.accent_color.clone(),
        }
    }
}

/// The UI locale: the session `locale` the Agent wrote, else the OS UI
/// language, negotiated onto the eight shared locales (`en` when unknown).
pub fn resolve_locale(configured: Option<&str>, os_tag: &str) -> &'static str {
    let tag = configured.map(str::trim).filter(|t| !t.is_empty()).unwrap_or(os_tag);
    crate::chrome::negotiate(tag)
}

const EN: &str = include_str!("../../src/locales/en.json");
const PT_BR: &str = include_str!("../../src/locales/pt-BR.json");

fn catalog_lookup(raw: &str, key: &str) -> Option<String> {
    let map: std::collections::HashMap<String, String> = serde_json::from_str(raw).ok()?;
    map.get(key).cloned()
}

/// A Helper catalog string (`src/locales/*.json`, the same files the webview
/// reads) in `locale`, falling back to `en`, then to the key.
pub fn catalog_string(key: &str, locale: &str) -> String {
    let localized = match crate::chrome::negotiate(locale) {
        "pt-BR" => catalog_lookup(PT_BR, key),
        _ => None,
    };
    localized.or_else(|| catalog_lookup(EN, key)).unwrap_or_else(|| key.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full() -> HelperBranding {
        HelperBranding {
            scope_id: Some("scope-1".into()),
            display_name: Some("Example Assist".into()),
            company_name: Some("Example IT".into()),
            welcome_title: Some("Welcome".into()),
            welcome_message: Some("Hello there".into()),
            support_label: Some("Get help".into()),
            portal_label: Some("My portal".into()),
            primary_color: Some("#336699".into()),
            accent_color: Some("#AABBCC".into()),
        }
    }

    #[test]
    fn valid_branding_survives_and_drops_scope_id() {
        let out = full().sanitized().unwrap();
        assert_eq!(out.display_name.as_deref(), Some("Example Assist"));
        assert_eq!(out.primary_color.as_deref(), Some("#336699"));
        assert_eq!(out.scope_id, None, "opaque scope marker never leaves Rust");
    }

    #[test]
    fn invalid_fields_are_dropped_individually() {
        let mut b = full();
        b.display_name = Some("x".repeat(MAX_DISPLAY_NAME + 1));
        b.company_name = Some("Bad\nName".into());
        b.welcome_title = Some("\u{202E}spoof".into());
        b.primary_color = Some("red".into());
        b.accent_color = Some("#abc".into());
        let out = b.sanitized().unwrap();
        assert_eq!(out.display_name, None);
        assert_eq!(out.company_name, None);
        assert_eq!(out.welcome_title, None);
        assert_eq!(out.primary_color, None);
        assert_eq!(out.accent_color, None);
        assert_eq!(out.welcome_message.as_deref(), Some("Hello there"));
        assert_eq!(out.support_label.as_deref(), Some("Get help"));
    }

    #[test]
    fn limits_count_code_points_not_bytes() {
        assert!(valid_text(&"é".repeat(MAX_DISPLAY_NAME), MAX_DISPLAY_NAME));
        assert!(!valid_text(&"é".repeat(MAX_DISPLAY_NAME + 1), MAX_DISPLAY_NAME));
        assert!(valid_text("a\u{200D}b", 10), "ZWJ is allowed");
        assert!(!valid_text("a\u{200B}b", 10), "zero-width space is a format char");
        assert!(!valid_text("", 10));
    }

    #[test]
    fn only_strict_hex_colours() {
        for ok in ["#000000", "#AbCdEf", "#336699"] {
            assert!(valid_hex_color(ok), "{ok}");
        }
        for bad in ["", "#fff", "336699", "#33669", "#3366999", "#33669G", "rgb(0,0,0)", "#336699;", "#33669\u{e9}"] {
            assert!(!valid_hex_color(bad), "{bad}");
        }
    }

    #[test]
    fn empty_or_all_invalid_is_no_branding() {
        assert_eq!(HelperBranding::default().sanitized(), None);
        let only_scope = HelperBranding { scope_id: Some("s".into()), ..Default::default() };
        assert_eq!(only_scope.sanitized(), None);
    }

    #[test]
    fn locale_prefers_config_then_os_then_english() {
        assert_eq!(resolve_locale(Some("pt_BR"), "de-DE"), "pt-BR");
        assert_eq!(resolve_locale(None, "de-AT"), "de-DE");
        assert_eq!(resolve_locale(Some("  "), "tr"), "tr-TR");
        assert_eq!(resolve_locale(Some("xx-YY"), "de-DE"), "en", "an unknown configured tag is English, not the OS language");
        assert_eq!(resolve_locale(None, ""), "en");
    }

    #[test]
    fn catalogs_parse_and_fall_back_to_english() {
        assert_eq!(catalog_string("native.consent.title", "en"), "Remote Session Request");
        assert_eq!(catalog_string("native.consent.title", "pt-BR"), "Solicitação de sessão remota");
        // No de-DE catalog yet: deterministic English.
        assert_eq!(catalog_string("native.consent.title", "de-DE"), "Remote Session Request");
        assert_eq!(catalog_string("no.such.key", "pt-BR"), "no.such.key");
    }

    #[test]
    fn webview_view_serializes_camel_case_without_scope() {
        let view = UiContext { locale: "en".into(), branding: BrandingView::from(full().sanitized().as_ref()) };
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["branding"]["displayName"], "Example Assist");
        assert_eq!(json["branding"]["primaryColor"], "#336699");
        assert!(json["branding"].get("scopeId").is_none() && json["branding"].get("scope_id").is_none());
        let empty = serde_json::to_value(UiContext { locale: "en".into(), branding: BrandingView::default() }).unwrap();
        assert_eq!(empty["branding"], serde_json::json!({}));
    }
}
