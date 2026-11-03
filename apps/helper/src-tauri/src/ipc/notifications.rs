//! The one notification list (#10190 W04, spec section 3.2 / 3.5): the main
//! window's Notifications tab shows this session's prompt entries
//! ([`super::prompt::PromptTracker::list`]) and its endpoint message cards
//! ([`super::message::MessageTracker::list`]) together. The `message_*` wire
//! contract is unchanged; only the Assist renderer converges.
//!
//! Both trackers live in process memory and are emptied when the agent
//! session ends, so the list never shows another session's entries; the agent
//! replays open prompts and sticky messages after the next authentication.
//!
//! The list reaches the main window only through the label-checked
//! `get_notification_list` command. The `prompt-list-updated` event carries a
//! [`super::prompt::VersionNotice`] and nothing else: Tauri delivers every
//! emit to an untargeted JS `listen()` in ANY window (#10310).

use serde::Serialize;

use super::message::{MessageBridge, MessageView};
use super::prompt::{PromptBridge, PromptView, VersionNotice};

/// What `get_notification_list` returns. `version` is the sum of the two
/// trackers' change counters, so it only ever grows; a window keeps the
/// snapshot with the highest one.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationListView {
    pub version: u64,
    /// Newest first (see `PromptTracker::list`).
    pub prompts: Vec<PromptView>,
    /// Newest first (see `MessageTracker::list`).
    pub messages: Vec<MessageView>,
}

/// The combined change counter of the two trackers.
pub fn list_version(prompts: &PromptBridge, messages: &MessageBridge) -> u64 {
    let p = prompts.tracker().version();
    let m = messages.tracker().version();
    p.saturating_add(m)
}

/// The `prompt-list-updated` payload: the combined counter, nothing else.
pub fn list_notice(prompts: &PromptBridge, messages: &MessageBridge) -> VersionNotice {
    VersionNotice { version: list_version(prompts, messages) }
}

/// A snapshot of the list. Each tracker is locked on its own (never both at
/// once), and each part is read with the counter it was taken at.
pub fn list_view(prompts: &PromptBridge, messages: &MessageBridge, now_ms: i64) -> NotificationListView {
    let (pv, plist) = {
        let t = prompts.tracker();
        (t.version(), t.list(now_ms))
    };
    let (mv, mlist) = {
        let t = messages.tracker();
        (t.version(), t.list())
    };
    NotificationListView { version: pv.saturating_add(mv), prompts: plist, messages: mlist }
}

/// How many entries the list holds (the tray's "Notifications (n)").
pub fn list_len(prompts: Option<&PromptBridge>, messages: Option<&MessageBridge>, now_ms: i64) -> usize {
    let p = prompts.map(|b| b.tracker().list_len(now_ms)).unwrap_or(0);
    let m = messages.map(|b| b.tracker().count()).unwrap_or(0);
    p + m
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::message::{MessageShow, ShowAction};
    use crate::ipc::prompt::{PromptShow, ShowOutcome};

    const NOW: i64 = 1_793_000_000_000;
    const SHOW_NOTICE: &str = include_str!("../../../../../packages/shared/src/fixtures/prompt-host/show.notice.json");

    fn message(id: &str) -> MessageShow {
        let exp = chrono::DateTime::from_timestamp_millis(NOW + 3_600_000).unwrap().to_rfc3339();
        serde_json::from_str(&format!(
            r##"{{"messageId":"{id}","title":"Maintenance tonight","body":"Please save your work.","severity":"info","requiresAck":false,"expiresAt":"{exp}","branding":{{"companyName":"Example IT","displayName":"Example","accent":null}}}}"##
        ))
        .unwrap()
    }

    fn notice() -> PromptShow {
        serde_json::from_str(SHOW_NOTICE).unwrap()
    }

    #[test]
    fn notification_list_holds_message_and_prompt_entries() {
        let prompts = PromptBridge::default();
        let messages = MessageBridge::default();
        let empty = list_view(&prompts, &messages, NOW);
        assert!(empty.prompts.is_empty() && empty.messages.is_empty());
        assert_eq!(list_len(Some(&prompts), Some(&messages), NOW), 0);

        assert!(matches!(prompts.tracker().on_show(NOW, &notice()), ShowOutcome::Render { .. }));
        assert!(matches!(messages.tracker().on_show(NOW, &message("m-1")), ShowAction::Show { .. }));
        let list = list_view(&prompts, &messages, NOW);
        assert_eq!(list.prompts.iter().map(|v| v.prompt_id.as_str()).collect::<Vec<_>>(), vec!["notice:safe_mode:7f3c2a10"]);
        assert_eq!(list.messages.iter().map(|v| v.message_id.as_str()).collect::<Vec<_>>(), vec!["m-1"]);
        assert!(list.version > empty.version);
        assert_eq!(list.version, list_notice(&prompts, &messages).version);
        assert_eq!(list_len(Some(&prompts), Some(&messages), NOW), 2);
        assert_eq!(list_len(None, Some(&messages), NOW), 1);
    }

    #[test]
    fn notification_list_is_this_sessions_only() {
        let prompts = PromptBridge::default();
        let messages = MessageBridge::default();
        prompts.tracker().on_show(NOW, &notice());
        messages.tracker().on_show(NOW, &message("m-1"));
        let before = list_view(&prompts, &messages, NOW);
        assert_eq!(before.prompts.len() + before.messages.len(), 2);
        // The agent session ends (BridgeClearGuard): both trackers forget.
        prompts.disconnect();
        messages.tracker().clear();
        let after = list_view(&prompts, &messages, NOW);
        assert!(after.prompts.is_empty() && after.messages.is_empty(), "nothing survives the session");
        assert!(after.version > before.version, "the window replaces its list");
        assert_eq!(list_len(Some(&prompts), Some(&messages), NOW), 0);
    }

    #[test]
    fn list_notice_is_version_only() {
        let prompts = PromptBridge::default();
        let messages = MessageBridge::default();
        messages.tracker().on_show(NOW, &message("m-1"));
        let json = serde_json::to_value(list_notice(&prompts, &messages)).unwrap();
        assert_eq!(json.as_object().unwrap().keys().collect::<Vec<_>>(), vec!["version"]);
    }

    /// The keys of a TS `interface <name> { ... }` block (one `key:` per line).
    fn ts_keys(src: &str, name: &str) -> std::collections::BTreeSet<String> {
        let start = src.find(&format!("export interface {name} {{")).unwrap_or_else(|| panic!("{name}"));
        let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
        body.lines()
            .skip(1)
            .map(str::trim)
            .filter(|l| !l.starts_with('/') && !l.starts_with('*'))
            .filter_map(|l| l.split_once(':').map(|(k, _)| k.trim_end_matches('?').to_string()))
            .filter(|k| k.chars().all(|c| c.is_ascii_alphanumeric()))
            .collect()
    }

    fn keys(v: &serde_json::Value) -> std::collections::BTreeSet<String> {
        v.as_object().unwrap().keys().cloned().collect()
    }

    #[test]
    fn list_wire_keys_match_the_ts_contract() {
        let prompts = PromptBridge::default();
        let messages = MessageBridge::default();
        prompts.tracker().on_show(NOW, &notice());
        messages.tracker().on_show(NOW, &message("m-1"));
        let json = serde_json::to_value(list_view(&prompts, &messages, NOW)).unwrap();
        let types = include_str!("../../../src/prompt/types.ts");
        assert_eq!(keys(&json), ts_keys(types, "NotificationListView"));
        assert_eq!(keys(&json["prompts"][0]), ts_keys(types, "PromptView"));
        let card = include_str!("../../../src/components/MessageCard.tsx");
        assert_eq!(keys(&json["messages"][0]), ts_keys(card, "MessageView"));
        assert_eq!(keys(&serde_json::to_value(list_notice(&prompts, &messages)).unwrap()), ts_keys(types, "VersionNotice"));
    }
}
