//! Prompt host renderer (#10190, W02): the agent -> Assist `prompt_*` contract,
//! kept free of Tauri window types so it is unit-tested without a window.
//!
//! Wire contract: `packages/shared/src/promptHost/{kinds.ts,schema.ts}` and the
//! golden fixtures in `packages/shared/src/fixtures/prompt-host/` (the tests
//! below decode and re-encode every one of them).
//!   * agent -> Assist: `prompt_show`, `prompt_update`, `prompt_close`,
//!     `prompt_action_result`, `prompt_branding_sync`
//!   * Assist -> agent: `prompt_presented`, `prompt_action`, `prompt_closed`
//!
//! A kind is drawn only when [`ADVERTISED_PROMPT_KINDS`] lists it (W04:
//! `notice.info@1`; W05: `restart.prompt@1`, `restart.final@1`; W06:
//! `remote.consent@1`, `remote.session@1`; W07: `elevation.request@1`). The agent sends a kind only to a
//! session that advertised it and only when the server enables it; one that
//! arrives anyway is answered `prompt_closed{render_failed, unadvertised_kind}`.
//!
//! Rules this module enforces (spec section 3.1):
//!   * `rev` is monotonic per promptId: a show or update whose rev is not
//!     greater than the last one applied is dropped. A close is honoured at the
//!     current rev too (closing is always the safe direction).
//!   * A decision (`state == pending` and `presentation != indicator`) carries
//!     exactly one `safe` action and `defaultActionId` names it, else refused.
//!   * A breeze-class kind (and any kind outside the registry) with operator
//!     text is refused.
//!   * One action in flight per prompt; a disconnect drops it, so nothing is
//!     ever replayed on a later session.
//!
//! START-HIDDEN (#8138): a prompt renders in its own `prompt-<hash>` card window
//! or only in the notification list. Nothing here can reach the main Assist
//! window. Assist keeps no durable state: everything lives in process memory
//! and the agent replays open prompts after the helper re-authenticates.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::consent::Outbound;
use super::message::FocusLimiter;

/// The `promptProtocolVersion` this build speaks (envelope + common fields).
pub const PROMPT_PROTOCOL_VERSION: u32 = 1;

/// The `"<kind>@<n>"` entries this build advertises in `AuthRequest.promptKinds`.
/// A kind is added here only by the wave that ships it (plan P2). W04: notice
/// cards (`src/prompt/kinds/notice.tsx`). W05: restart cards
/// (`src/prompt/kinds/restart.tsx`). W06: the remote consent card
/// (`kinds/consent.tsx`) and the remote session pill (`kinds/session.tsx`).
/// W07: the elevation request cards (`kinds/elevation.tsx`): the first
/// question when UAC is not on the secure desktop, then waiting, approved,
/// denied, expired, failed and cancelled.
pub const ADVERTISED_PROMPT_KINDS: &[&str] = &[
    "notice.info@1",
    "restart.prompt@1",
    "restart.final@1",
    "remote.consent@1",
    "remote.session@1",
    "elevation.request@1",
];

// The agent -> helper types are matched by literal in `client.rs` (its source
// scans look for the arms); these exist for the contract test against kinds.ts.
#[allow(dead_code)]
pub const TYPE_PROMPT_SHOW: &str = "prompt_show";
#[allow(dead_code)]
pub const TYPE_PROMPT_UPDATE: &str = "prompt_update";
#[allow(dead_code)]
pub const TYPE_PROMPT_CLOSE: &str = "prompt_close";
#[allow(dead_code)]
pub const TYPE_PROMPT_ACTION_RESULT: &str = "prompt_action_result";
#[allow(dead_code)]
pub const TYPE_PROMPT_BRANDING_SYNC: &str = "prompt_branding_sync";
pub const TYPE_PROMPT_PRESENTED: &str = "prompt_presented";
pub const TYPE_PROMPT_ACTION: &str = "prompt_action";
pub const TYPE_PROMPT_CLOSED: &str = "prompt_closed";

/// `prompt_closed.detail` tokens (`^[a-z][a-z0-9_]*$`, at most 64).
pub const DETAIL_UNADVERTISED_KIND: &str = "unadvertised_kind";
pub const DETAIL_OPERATOR_TEXT: &str = "operator_text_on_breeze_kind";
pub const DETAIL_NO_SAFE_DEFAULT: &str = "no_safe_default";
pub const DETAIL_MALFORMED: &str = "malformed";
pub const DETAIL_UNKNOWN_PROMPT: &str = "unknown_prompt";
pub const DETAIL_WINDOW_FAILED: &str = "window_failed";
pub const DETAIL_UNSUPPORTED_TYPE: &str = "unsupported_type";

/// At most this many card windows per session; the rest collapse into the list.
pub const MAX_VISIBLE_CARDS: usize = 3;
/// An action with no `prompt_action_result` after this long is released so the
/// person can act again (the agent de-duplicates on promptId/actionId/rev).
pub const ACTION_RESULT_TIMEOUT_MS: i64 = 30_000;
/// Bound on the remembered revs of prompts that are no longer tracked.
const CLOSED_REV_CAP: usize = 1024;

/// Card window label prefix; the full label is `prompt-<8 hex>`.
pub const WINDOW_LABEL_PREFIX: &str = "prompt-";

/// Shown when an action cannot be delivered because no agent session is live.
pub const NOT_CONNECTED: &str = "Not connected to your IT provider's agent. Try again in a moment.";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptState {
    Pending,
    Waiting,
    Approved,
    Denied,
    Expired,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Presentation {
    Modal,
    Card,
    Indicator,
    ListOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionRole {
    Safe,
    Proceed,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FocusMode {
    Steal,
    NoActivate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Ltr,
    Rtl,
}

/// `prompt_close.reason` (agent -> renderer).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseReason {
    Resolved,
    Superseded,
    Withdrawn,
    Expired,
    Fenced,
}

/// `prompt_closed.reason` (renderer -> agent).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClosedReason {
    Hidden,
    RenderFailed,
    Replaced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionResultKind {
    Accepted,
    RejectedStale,
    RejectedInvalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionVia {
    Click,
    Keyboard,
    List,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptLease {
    pub renderer_session: String,
    pub epoch: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptActionSpec {
    pub id: String,
    pub label: String,
    pub role: ActionRole,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCopy {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consequence: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator_note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptFact {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptExpiry {
    /// Always emitted: `null` when expiry is a stated consequence, not an action.
    #[serde(default)]
    pub action_id: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTiming {
    pub present_within_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_unix_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expiry: Option<PromptExpiry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptListEntry {
    pub persistent: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptIdentityRef {
    pub scope_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_sha256: Option<String>,
}

/// `prompt_show`: the full current state of one prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptShow {
    pub prompt_id: String,
    pub rev: u64,
    pub lease: PromptLease,
    pub kind: String,
    pub kind_version: u32,
    pub state: PromptState,
    pub presentation: Presentation,
    pub copy: PromptCopy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facts: Option<Vec<PromptFact>>,
    pub actions: Vec<PromptActionSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_action_id: Option<String>,
    pub timing: PromptTiming,
    pub focus: FocusMode,
    pub list_entry: PromptListEntry,
    pub locale: String,
    pub direction: Direction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_ref: Option<PromptIdentityRef>,
}

/// `prompt_update`: a present field replaces the old one. `actions: []` is
/// distinct from absent (it clears the actions, and with them the default).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptUpdate {
    pub prompt_id: String,
    pub rev: u64,
    pub lease: PromptLease,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<PromptState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy: Option<PromptCopy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facts: Option<Vec<PromptFact>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<PromptActionSpec>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_action_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing: Option<PromptTiming>,
}

/// `prompt_close` (agent -> renderer).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptClose {
    pub prompt_id: String,
    pub rev: u64,
    pub lease: PromptLease,
    pub reason: CloseReason,
}

/// `prompt_presented` (renderer -> agent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptPresented {
    pub prompt_id: String,
    pub rev: u64,
    pub lease: PromptLease,
    pub visible: bool,
}

/// `prompt_action` (renderer -> agent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptActionMsg {
    pub prompt_id: String,
    pub rev: u64,
    pub lease: PromptLease,
    pub action_id: String,
    pub via: ActionVia,
}

/// `prompt_action_result` (agent -> renderer, on the `prompt_action` envelope).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptActionResult {
    pub prompt_id: String,
    pub action_id: String,
    pub result: ActionResultKind,
    pub rev: u64,
}

/// `prompt_closed` (renderer -> agent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptClosed {
    pub prompt_id: String,
    pub rev: u64,
    pub lease: PromptLease,
    pub reason: ClosedReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptLogo {
    pub sha256: String,
    pub mime: String,
    pub bytes: u32,
    pub data: String,
}

/// `prompt_branding_sync`: the effective MSP identity, or `cleared: true`.
/// One flat struct; `cleared` is always serialized (contract: required).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptBrandingSync {
    #[serde(default)]
    pub cleared: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partner_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<PromptLogo>,
    pub locale: String,
}

/// The three fields every agent -> renderer prompt message carries; decoded on
/// its own when the full payload is malformed, so the refusal can be addressed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRef {
    pub prompt_id: String,
    pub rev: u64,
    pub lease: PromptLease,
}

/// An agent -> renderer prompt message addressed by promptId / rev / lease.
pub trait Addressed {
    fn reference(&self) -> PromptRef;
}

macro_rules! addressed {
    ($($t:ty),*) => {$(
        impl Addressed for $t {
            fn reference(&self) -> PromptRef {
                PromptRef { prompt_id: self.prompt_id.clone(), rev: self.rev, lease: self.lease.clone() }
            }
        }
    )*};
}
addressed!(PromptShow, PromptUpdate, PromptClose, PromptRef);

// ---------------------------------------------------------------------------
// Kind table
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyClass {
    /// Breeze-owned copy only; never operator text.
    Breeze,
    /// May carry MSP copy verbatim.
    Operator,
}

/// Copy class per kind (mirrors `PROMPT_KINDS` in `kinds.ts`). A kind outside
/// the registry is treated as breeze-class: it fails closed.
pub fn prompt_kind_class(kind: &str) -> CopyClass {
    match kind {
        "restart.prompt" | "restart.final" => CopyClass::Operator,
        _ => CopyClass::Breeze,
    }
}

/// `remote.session` "Report a problem" (W06, P7: a wire action the agent
/// answers `accepted`, after which Assist opens Request Support).
pub const REPORT_PROBLEM_ACTION: &str = "report_problem";
/// `remote.session` prompt ids are `session:<sessionId>` (contract section 3).
pub const SESSION_PROMPT_PREFIX: &str = "session:";

/// Whether a presentation shares the bottom-right card stack (and its cap).
fn stacks(p: Presentation) -> bool {
    p == Presentation::Card
}

/// Whether `kind` is in the closed registry.
pub fn is_registry_kind(kind: &str) -> bool {
    matches!(
        kind,
        "notice.info" | "restart.prompt" | "restart.final" | "remote.consent" | "remote.session" | "elevation.request"
    )
}

/// A decision waits on the person at the keyboard and is not a session indicator.
pub fn is_decision(state: PromptState, presentation: Presentation) -> bool {
    state == PromptState::Pending && presentation != Presentation::Indicator
}

// Per-kind host rules. Each kind's rule is one arm here; the card itself is
// `src/prompt/kinds/<kind>.tsx`.

/// Kinds whose card never takes focus, whatever `focus` the agent sends: a
/// notice is informational (W04), and a restart prompt waits beside the
/// person's work (W05, spec 3.3; only the closing `restart.final` card steals).
fn never_activates(kind: &str) -> bool {
    matches!(kind, "notice.info" | "restart.prompt")
}

/// Kinds whose card comes back when the agent sends a newer full
/// `prompt_show` for the same id after the card was hidden or collapsed:
/// each restart warning rung (W05) re-surfaces the one card, never a second.
fn resurfaces_on_reshow(kind: &str) -> bool {
    kind == "restart.prompt"
}

/// An accepted action after which the card collapses to its list entry:
/// Postpone on a restart prompt (spec 3.3, "postponing does not reopen the
/// prompt"), and OK, its safe action when Postpone is not offered ("got it":
/// the agent answers `accepted` and changes nothing). The next warning rung
/// brings the card back. Restart now is not here: it lingers, then closes.
///
/// W07: Hide on the elevation waiting card. The agent answers `accepted` and
/// changes nothing; the request stays with IT and Cancel request stays
/// reachable from the list. Cancel request is not here: the agent answers
/// with the `cancelled` state, which the card shows until the agent closes it.
fn collapses_after_accepted(kind: &str, action_id: &str) -> bool {
    match kind {
        "restart.prompt" => matches!(action_id, "postpone" | "ok"),
        "elevation.request" => action_id == ELEVATION_HIDE_ACTION,
        _ => false,
    }
}

/// `elevation.request` "Hide" (W07): a wire action the agent answers
/// `accepted` with no state change, after which the card collapses.
pub const ELEVATION_HIDE_ACTION: &str = "hide";

// ---------------------------------------------------------------------------
// Window identity
// ---------------------------------------------------------------------------

/// `prompt-<first 8 hex of sha256(promptId)>`: a promptId may hold characters a
/// window label cannot, and the label must not grow with the id.
pub fn window_label(prompt_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = hex::encode(Sha256::digest(prompt_id.as_bytes()));
    format!("{WINDOW_LABEL_PREFIX}{}", &digest[..8])
}

/// The card's URL. The id is validated to `[A-Za-z0-9._:-]` before any window
/// is built, so it is safe in a URL fragment.
pub fn window_url(prompt_id: &str) -> String {
    format!("index.html#prompt/{prompt_id}")
}

/// Whether `label` is exactly the card window for `prompt_id`.
pub fn label_matches(label: &str, prompt_id: &str) -> bool {
    label == window_label(prompt_id)
}

/// Refuse a `prompt-*` caller. Called by `message::deny_message_window`, the
/// guard every privileged Tauri command already uses: a card renders agent
/// and (for restart) operator text, so it gets only its own label-checked
/// commands.
pub fn deny_prompt_window(label: &str) -> Result<(), String> {
    if label.starts_with(WINDOW_LABEL_PREFIX) {
        return Err("command not available to prompt windows".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/// A card window the IPC loop should build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowPlan {
    pub prompt_id: String,
    pub label: String,
    pub url: String,
    /// Stack position, 0 = bottom. Only `card` windows stack; a `modal` is
    /// centred and an `indicator` sits at the top of the screen.
    pub slot: usize,
    /// Where and how big the window is (desktop.rs `show_prompt_window`).
    pub presentation: Presentation,
    /// Take keyboard focus when built (rate limited; eligible kinds only).
    pub focused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShowOutcome {
    /// A new prompt: build `window` (None = list only), then reply `prompt_presented`.
    Render { window: Option<WindowPlan> },
    /// A newer rev of a prompt already on screen or in the list: never a second
    /// window. `card_open` says whether an existing card should be refreshed.
    Replace { card_open: bool },
    /// Not newer than what is applied: dropped.
    DropStale,
    /// Cannot be drawn: reply `prompt_closed{render_failed, <detail>}`.
    RenderFailed(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateOutcome {
    Applied { card_open: bool },
    DropStale,
    RenderFailed(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseOutcome {
    /// Applied; `had_card` says whether a card window must be closed.
    Closed { had_card: bool },
    DropStale,
    Untracked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionRefusal {
    UnknownPrompt,
    Closed,
    InvalidAction,
    Pending,
}

impl ActionRefusal {
    pub fn message(self) -> &'static str {
        match self {
            ActionRefusal::UnknownPrompt | ActionRefusal::Closed => "This notification is no longer active.",
            ActionRefusal::InvalidAction => "That choice is not available.",
            ActionRefusal::Pending => "Your earlier choice is still being sent.",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Dismiss {
    /// A pending decision: Esc / the close box chose the safe action.
    Action(Outbound),
    /// The card was hidden; send this `prompt_closed{hidden}`.
    Hidden(Outbound),
    Refused(ActionRefusal),
    /// Nothing on screen to hide.
    Nothing,
    /// An open session indicator (W06): it is never hidden while the session
    /// runs, like the legacy banner. Nothing is sent; the window stays.
    Kept,
}

/// What changed on the 250 ms tick.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExpireReport {
    /// Prompts whose card view changed (a stuck action was released).
    pub views: Vec<String>,
    pub list_changed: bool,
}

/// What the card window and the Notifications tab render.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptView {
    pub prompt_id: String,
    pub kind: String,
    pub kind_version: u32,
    pub state: PromptState,
    pub presentation: Presentation,
    pub copy: PromptCopy,
    pub facts: Vec<PromptFact>,
    pub actions: Vec<PromptActionSpec>,
    pub default_action_id: Option<String>,
    /// A pending decision: Esc and the close box choose `safe_action_id`.
    pub decision: bool,
    pub safe_action_id: Option<String>,
    /// The `{remaining}` deadline: `deadlineUnixMs`, or first shown + `responseMs`.
    pub countdown_deadline_unix_ms: Option<i64>,
    pub expiry_text: Option<String>,
    pub locale: String,
    pub direction: Direction,
    /// An action is on its way to the agent ("Working...").
    pub pending_action_id: Option<String>,
    /// `accepted` | `rejected_stale` | `rejected_invalid` | `timed_out`.
    pub last_outcome: Option<&'static str>,
    /// Resolved or expired: kept in the list, no actions.
    pub closed: bool,
    /// Has a card window right now.
    pub card: bool,
    /// Why the last attempt to act could not be sent (close box, no session).
    pub last_error: Option<String>,
    /// Tracker change counter when this view was taken: a window keeps the
    /// highest one, so a fetched snapshot never overwrites a newer update.
    pub version: u64,
}

/// The MSP identity for the webview's header, with the tracker's change
/// counter (a window keeps the highest). `state` is `set` or `none` (never
/// synced on this session, or `cleared`). The logo is the agent's bytes
/// (base64), drawn from a local Blob URL; no remote URL is ever involved.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptIdentityView {
    pub version: u64,
    pub state: &'static str,
    pub partner_name: Option<String>,
    pub primary_color: Option<String>,
    pub logo: Option<PromptLogo>,
    pub locale: Option<String>,
}

/// The payload of every prompt event (`prompt-updated`, `prompt-list-updated`,
/// `prompt-identity-updated`): a change notice and NOTHING else (#10310, W04).
/// In Tauri 2.12 a JS `listen()` with no target registers `Any`, and every
/// emit (`emit`, `emit_to`, `emit_filter` alike) reaches it in ANY window, so
/// a payload could never be kept to one window. The window that hears a notice
/// pulls what it may see through its label-checked command. Exactly one field:
/// `lib.rs` `prompt_events_carry_only_version_notices` pins it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionNotice {
    pub version: u64,
}

/// The `prompt-identity-updated` payload (W03 name): a [`VersionNotice`].
pub type PromptIdentityNotice = VersionNotice;

/// The synced MSP logo for the caller-verify window (W04): the bytes (base64)
/// and their type, nothing else. Handed out only for the sha the window asks
/// for, and only when it is the synced identity's logo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerVerifyLogo {
    pub mime: String,
    pub data: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Surface {
    Card { slot: usize },
    /// In the list only (list_only, or beyond the visible-card cap).
    Collapsed,
    /// The person hid the card (or it was closed and kept in the list).
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Pending {
    action_id: String,
    /// The `prompt_action` envelope; its result is the reply on this envelope.
    envelope_id: String,
    since_ms: i64,
}

#[derive(Debug, Clone)]
struct Tracked {
    show: PromptShow,
    surface: Surface,
    closed: bool,
    pending: Option<Pending>,
    last_outcome: Option<&'static str>,
    last_error: Option<String>,
    first_seen_ms: i64,
    seq: u64,
    /// A persistent entry whose expiresAtUnixMs passed while the prompt is open.
    list_lapsed: bool,
}

/// Prompts this session's agent has shown, in process memory only.
#[derive(Debug)]
pub struct PromptTracker {
    advertised: Vec<String>,
    prompts: HashMap<String, Tracked>,
    closed_revs: HashMap<String, u64>,
    focus: FocusLimiter,
    /// The MSP identity from the last `prompt_branding_sync`; never a cleared one.
    identity: Option<PromptBrandingSync>,
    /// The negotiated locale of the last valid branding sync (set or cleared).
    /// Kept across a disconnect so the tray does not flip language.
    sync_locale: Option<String>,
    seq: u64,
    /// Bumped by every `&mut self` method; stamped on every view.
    version: u64,
    /// The session id of a `remote.session` "Report a problem" the agent has
    /// just `accepted` (OD-6 (b)): taken once by the IPC loop, which then opens
    /// the main window's Request Support flow. Nothing else sets it.
    request_support: Option<RequestSupport>,
}

/// Request Support to open for a remote session (W06, OD-6 (b)): the session
/// id from `session:<id>` and the session prompt's locale (already validated
/// with the show), so the pre-filled draft is in the person's language.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestSupport {
    pub session_id: String,
    pub locale: String,
}

impl Default for PromptTracker {
    fn default() -> Self {
        Self::new(ADVERTISED_PROMPT_KINDS)
    }
}

impl PromptTracker {
    pub fn new(advertised: &[&str]) -> Self {
        Self {
            advertised: advertised.iter().map(|s| s.to_string()).collect(),
            prompts: HashMap::new(),
            closed_revs: HashMap::new(),
            focus: FocusLimiter::default(),
            identity: None,
            sync_locale: None,
            seq: 0,
            version: 0,
            request_support: None,
        }
    }

    /// Whether this build advertised exactly `kind@version`. A kind outside the
    /// registry is never drawn, whatever the list says.
    fn advertises(&self, kind: &str, version: u32) -> bool {
        is_registry_kind(kind) && self.advertised.iter().any(|ad| *ad == format!("{kind}@{version}"))
    }

    /// The last rev applied for `prompt_id`, tracked or already closed.
    fn applied_rev(&self, prompt_id: &str) -> Option<u64> {
        self.prompts
            .get(prompt_id)
            .map(|t| t.show.rev)
            .or_else(|| self.closed_revs.get(prompt_id).copied())
    }

    fn remember_closed(&mut self, prompt_id: &str, rev: u64) {
        if self.closed_revs.len() >= CLOSED_REV_CAP {
            self.closed_revs.clear();
        }
        let r = self.closed_revs.entry(prompt_id.to_string()).or_insert(rev);
        *r = (*r).max(rev);
    }

    /// `prompt_show`: the full state of one prompt.
    pub fn on_show(&mut self, now_ms: i64, show: &PromptShow) -> ShowOutcome {
        self.version += 1;
        if validate_ref(&show.prompt_id, show.rev, &show.lease).is_err() {
            return ShowOutcome::RenderFailed(DETAIL_MALFORMED);
        }
        if self.applied_rev(&show.prompt_id).is_some_and(|r| show.rev <= r) {
            return ShowOutcome::DropStale;
        }
        if !self.advertises(&show.kind, show.kind_version) {
            return ShowOutcome::RenderFailed(DETAIL_UNADVERTISED_KIND);
        }
        if let Err(detail) = validate_show(show) {
            // Whatever was on screen for this id no longer matches the agent.
            self.prompts.remove(&show.prompt_id);
            return ShowOutcome::RenderFailed(detail);
        }
        if let Some(t) = self.prompts.get_mut(&show.prompt_id).filter(|t| !t.closed) {
            // Same prompt, newer rev: replace in place, never a second window.
            t.show = show.clone();
            t.last_error = None;
            let on_screen = matches!(t.surface, Surface::Card { .. });
            if on_screen || !resurfaces_on_reshow(&show.kind) {
                return ShowOutcome::Replace { card_open: on_screen };
            }
            // A newer rung of a card that was hidden or collapsed comes back
            // (its kind never activates, so it never takes focus); with every
            // slot taken it stays in the list. The earlier outcome belongs to
            // the earlier rung.
            t.last_outcome = None;
            debug_assert!(never_activates(&show.kind), "a re-surfaced card must never take focus");
            let window = self.plan_window(now_ms, show);
            return match (window, self.prompts.get_mut(&show.prompt_id)) {
                (Some(w), Some(t)) => {
                    t.surface = Surface::Card { slot: w.slot };
                    ShowOutcome::Render { window: Some(w) }
                }
                _ => ShowOutcome::Replace { card_open: false },
            };
        }
        self.closed_revs.remove(&show.prompt_id);
        let window = self.plan_window(now_ms, show);
        let surface = match &window {
            Some(w) => Surface::Card { slot: w.slot },
            None => Surface::Collapsed,
        };
        self.seq += 1;
        self.prompts.insert(
            show.prompt_id.clone(),
            Tracked {
                show: show.clone(),
                surface,
                closed: false,
                pending: None,
                last_outcome: None,
                last_error: None,
                first_seen_ms: now_ms,
                seq: self.seq,
                list_lapsed: false,
            },
        );
        ShowOutcome::Render { window }
    }

    /// A card window for a new prompt, or None (list only): `list_only`, all
    /// visible slots taken, or a label already used by another open card.
    fn plan_window(&mut self, now_ms: i64, show: &PromptShow) -> Option<WindowPlan> {
        if show.presentation == Presentation::ListOnly {
            return None;
        }
        let label = window_label(&show.prompt_id);
        let mut used = Vec::new();
        for (id, t) in &self.prompts {
            if let Surface::Card { slot } = t.surface {
                if id != &show.prompt_id && window_label(id) == label {
                    return None;
                }
                if stacks(t.show.presentation) {
                    used.push(slot);
                }
            }
        }
        // Only `card` windows share the bottom-right stack (and its cap). A
        // modal (remote consent, centred) and the session indicator (top of
        // the screen) are drawn outside it, so a full stack never collapses
        // them into the list (W06: consent is never deferred, and the person
        // must always see that a remote session is running).
        let slot = if stacks(show.presentation) { (0..MAX_VISIBLE_CARDS).find(|s| !used.contains(s))? } else { 0 };
        // `steal` only for a modal answering the user, remote.consent and
        // restart.final, and at most once per focus interval (message.rs rule).
        // A notice is informational and a restart prompt waits beside the
        // person's work: neither ever activates (spec 3.2, 3.3), whatever the
        // agent asks for.
        let eligible = !never_activates(&show.kind)
            && (show.presentation == Presentation::Modal
                || show.kind == "remote.consent"
                || show.kind == "restart.final");
        let focused = show.focus == FocusMode::Steal && eligible && self.focus.try_take(now_ms);
        Some(WindowPlan {
            prompt_id: show.prompt_id.clone(),
            label,
            url: window_url(&show.prompt_id),
            slot,
            presentation: show.presentation,
            focused,
        })
    }

    /// `prompt_update`: present fields replace; the merged state must still be
    /// a valid `prompt_show` (`applyPromptUpdate` in schema.ts).
    pub fn on_update(&mut self, _now_ms: i64, update: &PromptUpdate) -> UpdateOutcome {
        self.version += 1;
        if validate_ref(&update.prompt_id, update.rev, &update.lease).is_err() {
            return UpdateOutcome::RenderFailed(DETAIL_MALFORMED);
        }
        let Some(current) = self.prompts.get(&update.prompt_id) else {
            if self.applied_rev(&update.prompt_id).is_some_and(|r| update.rev <= r) {
                return UpdateOutcome::DropStale;
            }
            return UpdateOutcome::RenderFailed(DETAIL_UNKNOWN_PROMPT);
        };
        if update.rev <= current.show.rev {
            return UpdateOutcome::DropStale;
        }
        let merged = match apply_update(&current.show, update) {
            Ok(m) => m,
            Err(detail) => {
                self.prompts.remove(&update.prompt_id);
                return UpdateOutcome::RenderFailed(detail);
            }
        };
        if let Err(detail) = validate_show(&merged) {
            self.prompts.remove(&update.prompt_id);
            return UpdateOutcome::RenderFailed(detail);
        }
        let t = self.prompts.get_mut(&update.prompt_id).expect("checked above");
        t.show = merged;
        t.last_error = None;
        UpdateOutcome::Applied { card_open: !t.closed && matches!(t.surface, Surface::Card { .. }) }
    }

    /// `prompt_close`. `resolved` / `expired` keep a persistent entry in the
    /// list (no actions); `fenced` / `withdrawn` / `superseded` remove it.
    pub fn on_close(&mut self, now_ms: i64, close: &PromptClose) -> CloseOutcome {
        self.version += 1;
        let Some(t) = self.prompts.get_mut(&close.prompt_id) else {
            if validate_ref(&close.prompt_id, close.rev, &close.lease).is_ok() {
                self.remember_closed(&close.prompt_id, close.rev);
            }
            return CloseOutcome::Untracked;
        };
        // Closing is the safe direction: honoured at the current rev as well.
        if close.rev < t.show.rev {
            return CloseOutcome::DropStale;
        }
        let had_card = !t.closed && matches!(t.surface, Surface::Card { .. });
        let keep =matches!(close.reason, CloseReason::Resolved | CloseReason::Expired)
            && t.show.list_entry.persistent
            && !list_expired(&t.show, now_ms);
        if keep {
            t.closed = true;
            t.surface = Surface::Hidden;
            t.pending = None;
            t.show.rev = t.show.rev.max(close.rev);
        } else {
            let rev = t.show.rev.max(close.rev);
            self.prompts.remove(&close.prompt_id);
            self.remember_closed(&close.prompt_id, rev);
        }
        CloseOutcome::Closed { had_card }
    }

    /// The person chose `action_id` (card click / key, or the list). One action
    /// in flight per prompt until its `prompt_action_result`.
    pub fn action(&mut self, now_ms: i64, prompt_id: &str, action_id: &str, via: ActionVia) -> Result<Outbound, ActionRefusal> {
        self.version += 1;
        let t = self.prompts.get_mut(prompt_id).ok_or(ActionRefusal::UnknownPrompt)?;
        if t.closed {
            return Err(ActionRefusal::Closed);
        }
        if t.pending.is_some() {
            return Err(ActionRefusal::Pending);
        }
        if !t.show.actions.iter().any(|a| a.id == action_id) {
            return Err(ActionRefusal::InvalidAction);
        }
        let msg = PromptActionMsg {
            prompt_id: prompt_id.to_string(),
            rev: t.show.rev,
            lease: t.show.lease.clone(),
            action_id: action_id.to_string(),
            via,
        };
        let id = self.fresh_id();
        let t = self.prompts.get_mut(prompt_id).expect("checked above");
        t.pending = Some(Pending { action_id: action_id.to_string(), envelope_id: id.clone(), since_ms: now_ms });
        t.last_outcome = None;
        t.last_error = None;
        Ok(Outbound { id, typ: TYPE_PROMPT_ACTION, payload: to_value(&msg) })
    }

    /// The action frame could not be handed to a live session: forget it so
    /// the person can try again (nothing is queued for a later session).
    pub fn on_send_failed(&mut self, prompt_id: &str, action_id: &str) {
        self.version += 1;
        if let Some(t) = self.prompts.get_mut(prompt_id) {
            if t.pending.as_ref().is_some_and(|p| p.action_id == action_id) {
                t.pending = None;
            }
        }
    }

    /// `prompt_action_result` (the reply on the `prompt_action` envelope
    /// `envelope_id`): releases the action it answers. A result on any other
    /// envelope (an earlier action, a session that is gone) releases nothing.
    /// True when the view changed. Its `rev` is information only.
    pub fn on_action_result(&mut self, envelope_id: &str, result: &PromptActionResult) -> bool {
        self.version += 1;
        let Some(t) = self.prompts.get_mut(&result.prompt_id) else { return false };
        if !t
            .pending
            .as_ref()
            .is_some_and(|p| p.action_id == result.action_id && p.envelope_id == envelope_id)
        {
            return false;
        }
        t.pending = None;
        t.last_outcome = Some(match result.result {
            ActionResultKind::Accepted => "accepted",
            ActionResultKind::RejectedStale => "rejected_stale",
            ActionResultKind::RejectedInvalid => "rejected_invalid",
        });
        // W06: the person's "Report a problem" on the session pill, accepted
        // by the agent, opens Request Support for that session. A rejected or
        // unanswered click opens nothing.
        if result.result == ActionResultKind::Accepted
            && result.action_id == REPORT_PROBLEM_ACTION
            && t.show.kind == "remote.session"
        {
            if let Some(session_id) = result.prompt_id.strip_prefix(SESSION_PROMPT_PREFIX).filter(|s| !s.is_empty()) {
                let locale = t.show.locale.clone();
                self.request_support = Some(RequestSupport { session_id: session_id.to_string(), locale });
            }
        }
        true
    }

    /// The Request Support the IPC loop should open now, once (see
    /// `request_support`). The caller opens it with no tracker lock held.
    pub fn take_request_support(&mut self) -> Option<RequestSupport> {
        self.version += 1;
        self.request_support.take()
    }

    /// Whether `prompt_id` is an open session indicator with its pill window
    /// up: the only prompt whose window may be resized (`prompt_pill_expand`).
    pub fn indicator_open(&self, prompt_id: &str) -> bool {
        self.prompts.get(prompt_id).is_some_and(|t| {
            !t.closed && t.show.presentation == Presentation::Indicator && matches!(t.surface, Surface::Card { .. })
        })
    }

    /// After [`Self::on_action_result`] applied `result`: when the accepted
    /// action is one after which the card collapses (`collapses_after_accepted`:
    /// Postpone or OK on a restart prompt), take the card off screen, keep the prompt
    /// and its list entry, and return the `prompt_closed{hidden}` for the agent.
    fn collapse_after(&mut self, result: &PromptActionResult) -> Option<Outbound> {
        if result.result != ActionResultKind::Accepted {
            return None;
        }
        let t = self.prompts.get(&result.prompt_id)?;
        if !collapses_after_accepted(&t.show.kind, &result.action_id) {
            return None;
        }
        self.version += 1;
        let frame = self.hide(&result.prompt_id)?;
        // Collapsed, not Hidden: the entry is listed even when the agent sent
        // no persistent list entry, so Restart now stays reachable.
        if let Some(t) = self.prompts.get_mut(&result.prompt_id) {
            t.surface = Surface::Collapsed;
        }
        Some(frame)
    }

    /// Esc or the window close box: the safe action on a pending decision,
    /// "hide" everywhere else, except an open session indicator, which stays
    /// on screen (W06: a remote-session indicator is a transparency control).
    pub fn dismiss(&mut self, now_ms: i64, prompt_id: &str, via: ActionVia) -> Dismiss {
        self.version += 1;
        if self.indicator_open(prompt_id) {
            return Dismiss::Kept;
        }
        let Some(t) = self.prompts.get(prompt_id) else { return Dismiss::Nothing };
        if !t.closed && is_decision(t.show.state, t.show.presentation) {
            let Some(safe) = t.show.default_action_id.clone() else {
                return Dismiss::Refused(ActionRefusal::InvalidAction);
            };
            return match self.action(now_ms, prompt_id, &safe, via) {
                Ok(frame) => Dismiss::Action(frame),
                Err(e) => Dismiss::Refused(e),
            };
        }
        match self.hide(prompt_id) {
            Some(frame) => Dismiss::Hidden(frame),
            None => Dismiss::Nothing,
        }
    }

    /// Take the card off screen; the prompt (and its list entry) stays.
    fn hide(&mut self, prompt_id: &str) -> Option<Outbound> {
        let t = self.prompts.get_mut(prompt_id)?;
        if t.closed || !matches!(t.surface, Surface::Card { .. }) {
            return None;
        }
        t.surface = Surface::Hidden;
        let r = t.show.reference();
        let id = self.fresh_id();
        Some(closed_frame(&id, &r, ClosedReason::Hidden, None))
    }

    /// The OS destroyed a card the tracker did not close. A pending decision
    /// can no longer be answered there, so it is reported `render_failed` (the
    /// agent falls back); anything else was simply hidden.
    pub fn window_gone(&mut self, prompt_id: &str) -> Option<Outbound> {
        self.version += 1;
        let t = self.prompts.get(prompt_id)?;
        if t.closed || !matches!(t.surface, Surface::Card { .. }) {
            return None;
        }
        if is_decision(t.show.state, t.show.presentation) {
            let r = t.show.reference();
            self.prompts.remove(prompt_id);
            let id = self.fresh_id();
            return Some(closed_frame(&id, &r, ClosedReason::RenderFailed, Some(DETAIL_WINDOW_FAILED)));
        }
        self.hide(prompt_id)
    }

    /// The card window could not be built: forget the prompt (the caller
    /// answers `render_failed`, and the agent falls back).
    pub fn on_window_failed(&mut self, prompt_id: &str) {
        self.version += 1;
        self.prompts.remove(prompt_id);
    }

    /// Forget one prompt (its message was refused); true when it was tracked.
    pub fn forget(&mut self, prompt_id: &str) -> bool {
        self.version += 1;
        self.prompts.remove(prompt_id).is_some()
    }

    /// The session ended: forget everything, including any action in flight,
    /// so nothing is ever replayed on a later session. Returns the prompts that
    /// had a card window, for the caller to close. The agent replays open
    /// prompts after the next authentication.
    pub fn on_disconnect(&mut self) -> Vec<String> {
        self.version += 1;
        let mut cards: Vec<String> = self
            .prompts
            .iter()
            .filter(|(_, t)| matches!(t.surface, Surface::Card { .. }))
            .map(|(id, _)| id.clone())
            .collect();
        cards.sort();
        self.prompts.clear();
        self.closed_revs.clear();
        self.identity = None;
        self.request_support = None;
        cards
    }

    /// The 250 ms tick: release actions stuck without a result and drop list
    /// entries past `expiresAtUnixMs`. Expiry of a decision is the agent's.
    pub fn expire_due(&mut self, now_ms: i64) -> ExpireReport {
        self.version += 1;
        let mut report = ExpireReport::default();
        for (id, t) in self.prompts.iter_mut() {
            if t.pending.as_ref().is_some_and(|p| now_ms.saturating_sub(p.since_ms) >= ACTION_RESULT_TIMEOUT_MS) {
                t.pending = None;
                t.last_outcome = Some("timed_out");
                report.views.push(id.clone());
            }
        }
        report.views.sort();
        let expired: Vec<String> = self
            .prompts
            .iter()
            .filter(|(_, t)| t.closed && list_expired(&t.show, now_ms))
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            if let Some(t) = self.prompts.remove(&id) {
                self.remember_closed(&id, t.show.rev);
                report.list_changed = true;
            }
        }
        // An open prompt whose entry lapses leaves the list but stays tracked.
        for t in self.prompts.values_mut() {
            if !t.list_lapsed && t.show.list_entry.persistent && list_expired(&t.show, now_ms) {
                t.list_lapsed = true;
                report.list_changed = true;
            }
        }
        report
    }

    pub fn view(&self, prompt_id: &str, _now_ms: i64) -> Option<PromptView> {
        self.prompts.get(prompt_id).map(|t| view_of(t, self.version))
    }

    /// Record why acting on a prompt failed, for its card and list entry.
    pub fn note_error(&mut self, prompt_id: &str, message: &str) {
        self.version += 1;
        if let Some(t) = self.prompts.get_mut(prompt_id) {
            t.last_error = Some(message.to_string());
        }
    }

    /// The change counter: bumped by every `&mut self` method, never by a read.
    pub fn version(&self) -> u64 {
        self.version
    }

    /// The `prompt-updated` payload for a card: the change counter only.
    pub fn change_notice(&self) -> VersionNotice {
        VersionNotice { version: self.version }
    }

    /// The notification list, newest first: persistent entries until they
    /// expire, plus open prompts that have no card (collapsed or list only).
    pub fn list(&self, now_ms: i64) -> Vec<PromptView> {
        let mut entries: Vec<&Tracked> = self.prompts.values().filter(|t| in_list(t, now_ms)).collect();
        entries.sort_by(|a, b| b.seq.cmp(&a.seq));
        entries.into_iter().map(|t| view_of(t, self.version)).collect()
    }

    pub fn list_len(&self, now_ms: i64) -> usize {
        self.prompts.values().filter(|t| in_list(t, now_ms)).count()
    }

    /// `prompt_branding_sync`: kept in memory and rendered as the card's
    /// identity header (W03). `cleared: true` drops the identity (the cards
    /// then show the localized generic name); its locale still applies. A sync
    /// that is neither `cleared` nor a complete identity is ignored.
    pub fn on_branding_sync(&mut self, b: PromptBrandingSync) -> bool {
        self.version += 1;
        if !valid_branding(&b) {
            return false;
        }
        self.sync_locale = Some(b.locale.clone());
        self.identity = if b.cleared { None } else { Some(b) };
        true
    }

    /// The identity last synced on this session, if it is set.
    pub fn identity(&self) -> Option<&PromptBrandingSync> {
        self.identity.as_ref()
    }

    /// The locale for Assist's own chrome (tray, list heading), if a branding
    /// sync has set one.
    pub fn chrome_locale(&self) -> Option<&str> {
        self.sync_locale.as_deref()
    }

    /// The `prompt-identity-updated` payload: the change counter only.
    pub fn identity_notice(&self) -> VersionNotice {
        VersionNotice { version: self.version }
    }

    /// The synced identity's logo, for the caller-verify window, only when
    /// `sha256` (64 lowercase hex, from `/helper/config` `branding.logo`) is
    /// that logo's sha. Anything else (no identity, cleared, another sha) is
    /// None, so a stale or another partner's logo is never handed out.
    pub fn identity_logo_for(&self, sha256: &str) -> Option<CallerVerifyLogo> {
        if !is_hex(sha256, 64) {
            return None;
        }
        // The stored logo already passed `valid_branding` (type, size, and
        // its bytes hash to its sha256), so a sha match is a bytes match.
        let logo = self.identity.as_ref()?.logo.as_ref()?;
        (logo.sha256 == sha256).then(|| CallerVerifyLogo { mime: logo.mime.clone(), data: logo.data.clone() })
    }

    /// What the webview's identity header renders (`get_prompt_identity`).
    pub fn identity_view(&self) -> PromptIdentityView {
        let id = self.identity.as_ref();
        PromptIdentityView {
            version: self.version,
            state: if id.is_some() { "set" } else { "none" },
            partner_name: id.and_then(|b| b.partner_name.clone()),
            primary_color: id.and_then(|b| b.primary_color.clone()),
            logo: id.and_then(|b| b.logo.clone()),
            locale: self.sync_locale.clone(),
        }
    }

    /// A unique envelope id for an unsolicited frame.
    fn fresh_id(&mut self) -> String {
        self.seq += 1;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("prompt-{nanos:x}-{}", self.seq)
    }
}

fn list_expired(show: &PromptShow, now_ms: i64) -> bool {
    show.list_entry.expires_at_unix_ms.is_some_and(|e| e <= now_ms)
}

fn in_list(t: &Tracked, now_ms: i64) -> bool {
    (t.show.list_entry.persistent && !list_expired(&t.show, now_ms)) || (!t.closed && t.surface == Surface::Collapsed)
}

fn view_of(t: &Tracked, version: u64) -> PromptView {
    let s = &t.show;
    let decision = !t.closed && is_decision(s.state, s.presentation);
    PromptView {
        prompt_id: s.prompt_id.clone(),
        kind: s.kind.clone(),
        kind_version: s.kind_version,
        state: s.state,
        presentation: s.presentation,
        copy: s.copy.clone(),
        facts: s.facts.clone().unwrap_or_default(),
        actions: if t.closed { Vec::new() } else { s.actions.clone() },
        default_action_id: s.default_action_id.clone(),
        decision,
        safe_action_id: if decision { s.default_action_id.clone() } else { None },
        countdown_deadline_unix_ms: s
            .timing
            .deadline_unix_ms
            .or_else(|| s.timing.response_ms.map(|r| t.first_seen_ms.saturating_add(r as i64))),
        expiry_text: s.timing.expiry.as_ref().map(|e| e.text.clone()),
        locale: s.locale.clone(),
        direction: s.direction,
        pending_action_id: t.pending.as_ref().map(|p| p.action_id.clone()),
        last_outcome: t.last_outcome,
        closed: t.closed,
        card: !t.closed && matches!(t.surface, Surface::Card { .. }),
        last_error: t.last_error.clone(),
        version,
    }
}

// ---------------------------------------------------------------------------
// Validation (mirrors schema.ts; string limits count code points)
// ---------------------------------------------------------------------------

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn chars(s: &str) -> usize {
    s.chars().count()
}

/// `^[a-z][a-z_]*:[A-Za-z0-9._:-]+$`, at most 200.
pub fn valid_prompt_id(id: &str) -> bool {
    let Some((domain, rest)) = id.split_once(':') else { return false };
    id.len() <= 200
        && domain.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && domain.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        && !rest.is_empty()
        && rest.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/// `^[a-z][a-z0-9_]{0,31}$`.
fn valid_action_id(id: &str) -> bool {
    id.len() <= 32
        && id.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`, at most 35.
pub fn valid_locale(l: &str) -> bool {
    if l.len() > 35 {
        return false;
    }
    let mut parts = l.split('-');
    let lang = parts.next().unwrap_or("");
    (2..=3).contains(&lang.len())
        && lang.bytes().all(|b| b.is_ascii_lowercase())
        && parts.all(|p| (2..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

fn validate_ref(prompt_id: &str, rev: u64, lease: &PromptLease) -> Result<(), &'static str> {
    let session = chars(&lease.renderer_session);
    if !valid_prompt_id(prompt_id) || rev == 0 || rev > MAX_SAFE_INTEGER || lease.epoch == 0 || session == 0 || session > 200 {
        return Err(DETAIL_MALFORMED);
    }
    Ok(())
}

/// The full `prompt_show` rules: security refusals first (operator text on a
/// breeze-class kind, a decision without its single safe default), then shape.
fn validate_show(s: &PromptShow) -> Result<(), &'static str> {
    validate_ref(&s.prompt_id, s.rev, &s.lease)?;
    if prompt_kind_class(&s.kind) == CopyClass::Breeze && s.copy.operator_note.as_deref().is_some_and(|n| !n.is_empty()) {
        return Err(DETAIL_OPERATOR_TEXT);
    }
    if is_decision(s.state, s.presentation) {
        let mut safe = s.actions.iter().filter(|a| a.role == ActionRole::Safe);
        let (Some(only), None) = (safe.next(), safe.next()) else {
            return Err(DETAIL_NO_SAFE_DEFAULT);
        };
        if s.default_action_id.as_deref() != Some(only.id.as_str()) {
            return Err(DETAIL_NO_SAFE_DEFAULT);
        }
    }
    let facts_ok = s.facts.as_ref().is_none_or(|f| {
        f.len() <= 8 && f.iter().all(|x| (1..=60).contains(&chars(&x.label)) && chars(&x.value) <= 4000)
    });
    let identity_ok = s
        .identity_ref
        .as_ref()
        .is_none_or(|r| is_hex(&r.scope_id, 32) && r.logo_sha256.as_deref().is_none_or(|h| is_hex(h, 64)));
    let shape_ok = (1..=999).contains(&s.kind_version)
        && valid_copy(&s.copy)
        && facts_ok
        && valid_actions(&s.actions, s.default_action_id.as_deref())
        && valid_timing(&s.timing, &s.actions)
        && s.list_entry.expires_at_unix_ms.is_none_or(|e| e >= 1)
        && valid_locale(&s.locale)
        && identity_ok;
    if !shape_ok {
        return Err(DETAIL_MALFORMED);
    }
    Ok(())
}

fn valid_copy(c: &PromptCopy) -> bool {
    let max = |v: &Option<String>, n: usize| v.as_deref().is_none_or(|s| chars(s) <= n);
    (1..=200).contains(&chars(&c.title))
        && max(&c.body, 2000)
        && max(&c.consequence, 500)
        && max(&c.operator_note, 1000)
        && max(&c.state_detail, 500)
}

fn valid_actions(actions: &[PromptActionSpec], default: Option<&str>) -> bool {
    if actions.len() > MAX_ACTIONS {
        return false;
    }
    let mut ids: Vec<&str> = Vec::new();
    for a in actions {
        if !valid_action_id(&a.id) || !(1..=80).contains(&chars(&a.label)) || ids.contains(&a.id.as_str()) {
            return false;
        }
        ids.push(&a.id);
    }
    default.is_none_or(|d| ids.contains(&d))
}

/// At most this many actions per state.
const MAX_ACTIONS: usize = 3;

fn valid_timing(t: &PromptTiming, actions: &[PromptActionSpec]) -> bool {
    (1..=60_000).contains(&t.present_within_ms)
        && !(t.deadline_unix_ms.is_some() && t.response_ms.is_some())
        && t.deadline_unix_ms.is_none_or(|d| d >= 1)
        && t.response_ms.is_none_or(|r| (1..=86_400_000).contains(&r))
        && t.expiry.as_ref().is_none_or(|e| {
            chars(&e.text) <= 500 && e.action_id.as_deref().is_none_or(|id| actions.iter().any(|a| a.id == id))
        })
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The renderer's own integrity check on the logo (the agent checks too, but
/// the wire can carry anything): `data` is strict base64 whose decoded length
/// is the declared `bytes` and whose sha256 is the declared `sha256`.
fn logo_bytes_match(l: &PromptLogo) -> bool {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    // Bound the work before decoding: base64 of 256 KB.
    if l.data.len() > 262_144usize.div_ceil(3) * 4 {
        return false;
    }
    match base64::engine::general_purpose::STANDARD.decode(l.data.as_bytes()) {
        Ok(bytes) => bytes.len() as u64 == u64::from(l.bytes) && hex::encode(Sha256::digest(&bytes)) == l.sha256,
        Err(_) => false,
    }
}

fn valid_branding(b: &PromptBrandingSync) -> bool {
    if !valid_locale(&b.locale) {
        return false;
    }
    if b.cleared {
        return true;
    }
    let color_ok = b
        .primary_color
        .as_deref()
        .is_none_or(|c| c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|x| x.is_ascii_hexdigit()));
    let logo_ok = b.logo.as_ref().is_none_or(|l| {
        is_hex(&l.sha256, 64)
            && matches!(l.mime.as_str(), "image/png" | "image/jpeg" | "image/webp")
            && (1..=262_144).contains(&l.bytes)
            && logo_bytes_match(l)
    });
    b.scope_id.as_deref().is_some_and(|s| is_hex(s, 32))
        && b.partner_name.as_deref().is_some_and(|n| (1..=120).contains(&chars(n)))
        && color_ok
        && logo_ok
}

/// `applyPromptUpdate`: a present field replaces; `actions` replaces the
/// actions AND the default (absent default = none); the update's rev and lease
/// become current.
fn apply_update(show: &PromptShow, u: &PromptUpdate) -> Result<PromptShow, &'static str> {
    if u.default_action_id.is_some() && u.actions.is_none() {
        return Err(DETAIL_MALFORMED);
    }
    let mut m = show.clone();
    m.rev = u.rev;
    m.lease = u.lease.clone();
    if let Some(state) = u.state {
        m.state = state;
    }
    if let Some(copy) = &u.copy {
        m.copy = copy.clone();
    }
    if let Some(facts) = &u.facts {
        m.facts = Some(facts.clone());
    }
    if let Some(timing) = &u.timing {
        m.timing = timing.clone();
    }
    if let Some(actions) = &u.actions {
        m.actions = actions.clone();
        m.default_action_id = u.default_action_id.clone();
    }
    Ok(m)
}

// ---------------------------------------------------------------------------
// Decoding and frames
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decoded<T> {
    Ok(T),
    /// The payload is not a valid message, but its reference is: answer it.
    Malformed(PromptRef),
    /// Nothing to address a reply to.
    Unaddressable,
}

/// Decode an addressed message. A reply is only ever addressed to a valid
/// reference: a payload whose promptId / rev / lease are themselves invalid
/// is unaddressable (logged, never echoed back).
pub fn decode<T: serde::de::DeserializeOwned + Addressed>(raw: Option<&str>) -> Decoded<T> {
    let Some(raw) = raw else { return Decoded::Unaddressable };
    let valid = |r: &PromptRef| validate_ref(&r.prompt_id, r.rev, &r.lease).is_ok();
    if let Ok(v) = serde_json::from_str::<T>(raw) {
        return if valid(&v.reference()) { Decoded::Ok(v) } else { Decoded::Unaddressable };
    }
    match serde_json::from_str::<PromptRef>(raw) {
        Ok(r) if valid(&r) => Decoded::Malformed(r),
        _ => Decoded::Unaddressable,
    }
}

fn to_value<T: Serialize>(v: &T) -> serde_json::Value {
    serde_json::to_value(v).unwrap_or_else(|e| {
        eprintln!("[helper] prompt frame could not be serialized: {e}");
        serde_json::Value::Null
    })
}

/// `prompt_presented` on envelope `id`.
pub fn presented_frame(id: &str, r: &PromptRef, visible: bool) -> Outbound {
    let msg = PromptPresented { prompt_id: r.prompt_id.clone(), rev: r.rev, lease: r.lease.clone(), visible };
    Outbound { id: id.to_string(), typ: TYPE_PROMPT_PRESENTED, payload: to_value(&msg) }
}

/// `prompt_closed` on envelope `id`.
pub fn closed_frame(id: &str, r: &PromptRef, reason: ClosedReason, detail: Option<&str>) -> Outbound {
    let msg = PromptClosed {
        prompt_id: r.prompt_id.clone(),
        rev: r.rev,
        lease: r.lease.clone(),
        reason,
        detail: detail.map(str::to_string),
    };
    Outbound { id: id.to_string(), typ: TYPE_PROMPT_CLOSED, payload: to_value(&msg) }
}

/// Whether an inbound `prompt_*` type is one this renderer sends (never acted on).
pub fn is_renderer_type(typ: &str) -> bool {
    matches!(typ, TYPE_PROMPT_PRESENTED | TYPE_PROMPT_ACTION | TYPE_PROMPT_CLOSED)
}

/// Bridge held in Tauri managed state: the tracker (shared by the IPC loop and
/// the card / list Tauri commands) and the live session's frame sender.
#[derive(Default)]
pub struct PromptBridge {
    tracker: Mutex<PromptTracker>,
    sender: Mutex<Option<tokio::sync::mpsc::UnboundedSender<Outbound>>>,
    /// Told whenever the identity a window may show has changed (lib.rs wires
    /// it to `desktop::publish_prompt_identity`). Called with no lock held.
    identity_notifier: Mutex<Option<IdentityNotifier>>,
}

type IdentityNotifier = Box<dyn Fn() + Send + Sync>;

/// What a dismiss did, for the caller that owns the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DismissEffect {
    /// The safe action was sent; the card stays up ("Working...").
    ActionSent,
    /// The card is hidden; the caller closes its window.
    Hidden,
    /// Nothing tracked on screen; the caller closes any stray window.
    Nothing,
    /// An open session indicator: the caller keeps its window (W06).
    Kept,
}

/// What a `prompt_action_result` did, for the caller that owns the window.
/// Every variant but `Ignored` means the action was released and the caller
/// publishes the prompt state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultEffect {
    /// It answers no action in flight (another envelope, a session that is gone).
    Ignored,
    /// The action was released; the view (card or list entry) shows the outcome.
    Applied,
    /// Released, and the card collapsed to its list entry (an accepted
    /// Postpone or OK on a restart card, or Hide on an elevation card): the
    /// caller closes its window.
    Collapsed,
    /// Released, and the agent accepted the person's own "Report a problem"
    /// on the session pill (W06, OD-6 (b)): the caller opens Request Support
    /// for that session, once, with no tracker lock held.
    OpenSupport(RequestSupport),
}

impl PromptBridge {
    /// A bridge around a given tracker (tests advertise kinds W02 does not).
    #[cfg(test)]
    pub fn with_tracker(tracker: PromptTracker) -> Self {
        Self { tracker: Mutex::new(tracker), sender: Mutex::new(None), identity_notifier: Mutex::new(None) }
    }

    /// Lock the tracker. Never hold the guard across an `.await` or a window call.
    pub fn tracker(&self) -> MutexGuard<'_, PromptTracker> {
        self.tracker.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn set_identity_notifier(&self, f: impl Fn() + Send + Sync + 'static) {
        if let Ok(mut g) = self.identity_notifier.lock() {
            *g = Some(Box::new(f));
        }
    }

    fn notify_identity(&self) {
        if let Ok(g) = self.identity_notifier.lock() {
            if let Some(f) = g.as_ref() {
                f();
            }
        }
    }

    /// `prompt_branding_sync`: store it (see [`PromptTracker::on_branding_sync`])
    /// and, when it was applied, tell the windows. False when it was ignored.
    pub fn branding_sync(&self, sync: PromptBrandingSync) -> bool {
        let stored = self.tracker().on_branding_sync(sync);
        if stored {
            self.notify_identity();
        }
        stored
    }

    /// The session ended: [`PromptTracker::on_disconnect`], and the windows are
    /// told when an identity was dropped, so no header keeps a stale MSP name.
    /// Returns the prompts that had a card.
    pub fn disconnect(&self) -> Vec<String> {
        let (had_identity, cards) = {
            let mut t = self.tracker();
            let had = t.identity().is_some();
            (had, t.on_disconnect())
        };
        if had_identity {
            self.notify_identity();
        }
        cards
    }

    pub fn set_sender(&self, tx: tokio::sync::mpsc::UnboundedSender<Outbound>) {
        if let Ok(mut g) = self.sender.lock() {
            *g = Some(tx);
        }
    }

    pub fn clear_sender(&self) {
        if let Ok(mut g) = self.sender.lock() {
            *g = None;
        }
    }

    /// Hand a frame to the live session loop; false when there is none.
    fn send(&self, frame: Outbound) -> bool {
        match self.sender.lock() {
            Ok(g) => g.as_ref().is_some_and(|tx| tx.send(frame).is_ok()),
            Err(_) => false,
        }
    }

    /// Send the person's action. Err (shown on the card) when it was refused
    /// or there is no live session; then nothing stays pending.
    pub fn act(&self, now_ms: i64, prompt_id: &str, action_id: &str, via: ActionVia) -> Result<(), String> {
        let frame = self
            .tracker()
            .action(now_ms, prompt_id, action_id, via)
            .map_err(|e| e.message().to_string())?;
        if self.send(frame) {
            return Ok(());
        }
        self.tracker().on_send_failed(prompt_id, action_id);
        Err(NOT_CONNECTED.to_string())
    }

    /// Esc / close box / the card's hide: see [`PromptTracker::dismiss`]. A
    /// refusal is also recorded on the prompt (`last_error`), because the close
    /// box has no caller that could show it.
    pub fn dismiss(&self, now_ms: i64, prompt_id: &str, via: ActionVia) -> Result<DismissEffect, String> {
        let result = self.dismiss_inner(now_ms, prompt_id, via);
        if let Err(message) = &result {
            self.tracker().note_error(prompt_id, message);
        }
        result
    }

    fn dismiss_inner(&self, now_ms: i64, prompt_id: &str, via: ActionVia) -> Result<DismissEffect, String> {
        let outcome = self.tracker().dismiss(now_ms, prompt_id, via);
        match outcome {
            Dismiss::Action(frame) => {
                let action_id = frame.payload["actionId"].as_str().unwrap_or_default().to_string();
                if self.send(frame) {
                    Ok(DismissEffect::ActionSent)
                } else {
                    self.tracker().on_send_failed(prompt_id, &action_id);
                    Err(NOT_CONNECTED.to_string())
                }
            }
            Dismiss::Hidden(frame) => {
                // Hidden locally either way; without a session the agent
                // learns the current state from its next replay.
                self.send(frame);
                Ok(DismissEffect::Hidden)
            }
            Dismiss::Refused(e) => Err(e.message().to_string()),
            Dismiss::Nothing => Ok(DismissEffect::Nothing),
            Dismiss::Kept => Ok(DismissEffect::Kept),
        }
    }

    /// `prompt_action_result`: release the action it answers
    /// ([`PromptTracker::on_action_result`]) and then, under the same lock:
    ///   * after an accepted Postpone or OK on a restart card (W05), collapse
    ///     the card to its list entry and tell the agent (`prompt_closed{hidden}`).
    ///     On `Collapsed` the caller takes the window down.
    ///   * after an accepted "Report a problem" on the session pill (W06), hand
    ///     out the Request Support one-shot ([`PromptTracker::take_request_support`]).
    ///     It is taken only after this result released the person's own action
    ///     on its own envelope, so a rejected, late or repeated answer opens nothing.
    ///
    /// The two are exclusive by kind (`restart.prompt` vs `remote.session`).
    pub fn action_result(&self, envelope_id: &str, result: &PromptActionResult) -> ResultEffect {
        let (collapsed, support) = {
            let mut t = self.tracker();
            if !t.on_action_result(envelope_id, result) {
                return ResultEffect::Ignored;
            }
            (t.collapse_after(result), t.take_request_support())
        };
        debug_assert!(collapsed.is_none() || support.is_none(), "collapse and Request Support are exclusive by kind");
        if let Some(frame) = collapsed {
            // Hidden locally either way; without a session the agent
            // learns the current state from its next replay.
            self.send(frame);
            return ResultEffect::Collapsed;
        }
        match support {
            Some(req) => ResultEffect::OpenSupport(req),
            None => ResultEffect::Applied,
        }
    }

    /// A card window was destroyed: report it if the tracker did not close it.
    pub fn window_gone(&self, prompt_id: &str) {
        let frame = self.tracker().window_gone(prompt_id);
        if let Some(frame) = frame {
            self.send(frame);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_793_000_000_000;
    const FIXTURES: &str = "../../../../../packages/shared/src/fixtures/prompt-host";

    const SHOW_NOTICE: &str = include_str!("../../../../../packages/shared/src/fixtures/prompt-host/show.notice.json");
    const SHOW_RESTART: &str = include_str!("../../../../../packages/shared/src/fixtures/prompt-host/show.restart.json");
    const SHOW_ELEVATION: &str =
        include_str!("../../../../../packages/shared/src/fixtures/prompt-host/show.elevation.waiting.json");
    const UPDATE_STATE: &str = include_str!("../../../../../packages/shared/src/fixtures/prompt-host/update.state.json");
    const UPDATE_CLEARED: &str =
        include_str!("../../../../../packages/shared/src/fixtures/prompt-host/update.cleared_actions.json");
    const CLOSE_FENCED: &str = include_str!("../../../../../packages/shared/src/fixtures/prompt-host/close.fenced.json");
    const PRESENTED: &str = include_str!("../../../../../packages/shared/src/fixtures/prompt-host/presented.json");
    const ACTION: &str = include_str!("../../../../../packages/shared/src/fixtures/prompt-host/action.json");
    const RESULT_ACCEPTED: &str =
        include_str!("../../../../../packages/shared/src/fixtures/prompt-host/action_result.accepted.json");
    const RESULT_STALE: &str =
        include_str!("../../../../../packages/shared/src/fixtures/prompt-host/action_result.rejected_stale.json");
    const CLOSED_FAILED: &str =
        include_str!("../../../../../packages/shared/src/fixtures/prompt-host/closed.render_failed.json");
    const BRANDING_SET: &str = include_str!("../../../../../packages/shared/src/fixtures/prompt-host/branding_sync.set.json");
    const BRANDING_CLEARED: &str =
        include_str!("../../../../../packages/shared/src/fixtures/prompt-host/branding_sync.cleared.json");
    const KINDS_TS: &str = include_str!("../../../../../packages/shared/src/promptHost/kinds.ts");

    /// Fixtures that are not prompt_* wire messages Assist decodes (auth is
    /// checked in client.rs; heartbeat and skew rows are agent/API shapes).
    const NOT_DECODED_HERE: &[&str] = &[
        "auth.legacy.json",
        "auth.prompt_v1.json",
        "heartbeat.prompt_host.json",
        "heartbeat.prompt_host.empty.json",
        "skew-matrix.json",
    ];

    const ALL_KINDS: &[&str] = &[
        "notice.info@1",
        "restart.prompt@1",
        "restart.final@1",
        "remote.consent@1",
        "remote.session@1",
        "elevation.request@1",
    ];

    fn canonical(s: &str) -> serde_json::Value {
        serde_json::from_str(s).expect("fixture is JSON")
    }

    fn round_trip<T>(name: &str, fixture: &str)
    where
        T: serde::de::DeserializeOwned + Serialize,
    {
        let decoded: T = serde_json::from_str(fixture).unwrap_or_else(|e| panic!("{name}: decode: {e}"));
        let encoded = serde_json::to_string(&decoded).unwrap();
        assert_eq!(canonical(&encoded), canonical(fixture), "{name} does not round-trip");
    }

    fn tracker() -> PromptTracker {
        PromptTracker::new(ALL_KINDS)
    }

    fn notice() -> PromptShow {
        serde_json::from_str(SHOW_NOTICE).unwrap()
    }
    fn restart() -> PromptShow {
        serde_json::from_str(SHOW_RESTART).unwrap()
    }
    fn elevation() -> PromptShow {
        serde_json::from_str(SHOW_ELEVATION).unwrap()
    }

    fn with_id(mut s: PromptShow, id: &str) -> PromptShow {
        s.prompt_id = id.to_string();
        s
    }

    fn update(id: &str, rev: u64) -> PromptUpdate {
        PromptUpdate {
            prompt_id: id.into(),
            rev,
            lease: PromptLease { renderer_session: "assist-user-4242".into(), epoch: 1 },
            state: None,
            copy: None,
            facts: None,
            actions: None,
            default_action_id: None,
            timing: None,
        }
    }

    fn close(id: &str, rev: u64, reason: CloseReason) -> PromptClose {
        PromptClose {
            prompt_id: id.into(),
            rev,
            lease: PromptLease { renderer_session: "assist-user-4242".into(), epoch: 1 },
            reason,
        }
    }

    fn rendered(o: &ShowOutcome) -> bool {
        matches!(o, ShowOutcome::Render { .. })
    }

    // ----- wire: golden fixtures -----

    #[test]
    fn prompt_fixtures_round_trip() {
        round_trip::<PromptShow>("show.notice", SHOW_NOTICE);
        round_trip::<PromptShow>("show.restart", SHOW_RESTART);
        round_trip::<PromptShow>("show.elevation.waiting", SHOW_ELEVATION);
        round_trip::<PromptUpdate>("update.state", UPDATE_STATE);
        round_trip::<PromptUpdate>("update.cleared_actions", UPDATE_CLEARED);
        round_trip::<PromptClose>("close.fenced", CLOSE_FENCED);
        round_trip::<PromptPresented>("presented", PRESENTED);
        round_trip::<PromptActionMsg>("action", ACTION);
        round_trip::<PromptActionResult>("action_result.accepted", RESULT_ACCEPTED);
        round_trip::<PromptActionResult>("action_result.rejected_stale", RESULT_STALE);
        round_trip::<PromptClosed>("closed.render_failed", CLOSED_FAILED);
        round_trip::<PromptBrandingSync>("branding_sync.set", BRANDING_SET);
        round_trip::<PromptBrandingSync>("branding_sync.cleared", BRANDING_CLEARED);

        // Optional slots are omitted, never `null` (Go omitempty); every fixture
        // carries a body, so pin the bare copy here.
        let minimal = PromptCopy { title: "t".into(), ..PromptCopy::default() };
        assert_eq!(serde_json::to_value(&minimal).unwrap(), serde_json::json!({ "title": "t" }));
        let mut bare = notice();
        bare.identity_ref = None;
        let v = serde_json::to_value(&bare).unwrap();
        for absent in ["facts", "identityRef"] {
            assert!(v.get(absent).is_none(), "{absent} must be omitted when None");
        }
        // `actions: []` is not "absent": it clears the actions.
        let cleared: PromptUpdate = serde_json::from_str(UPDATE_CLEARED).unwrap();
        assert_eq!(cleared.actions, Some(Vec::new()));
        // expiry.actionId is emitted as null, never skipped.
        let r = serde_json::to_value(restart()).unwrap();
        assert!(r["timing"]["expiry"].as_object().unwrap().contains_key("actionId"));
        assert!(r["timing"]["expiry"]["actionId"].is_null());
        // cleared is always present on branding sync.
        let b = serde_json::to_value(serde_json::from_str::<PromptBrandingSync>(BRANDING_SET).unwrap()).unwrap();
        assert_eq!(b["cleared"], false);
    }

    /// Every fixture in the shared directory is either decoded above or named
    /// as out of scope, so a new prompt_* fixture cannot slip past this suite.
    #[test]
    fn every_prompt_fixture_is_accounted_for() {
        let decoded = [
            "show.notice.json",
            "show.restart.json",
            "show.elevation.waiting.json",
            "update.state.json",
            "update.cleared_actions.json",
            "close.fenced.json",
            "presented.json",
            "action.json",
            "action_result.accepted.json",
            "action_result.rejected_stale.json",
            "closed.render_failed.json",
            "branding_sync.set.json",
            "branding_sync.cleared.json",
        ];
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/ipc").join(FIXTURES);
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".json"))
            .collect();
        names.sort();
        for n in &names {
            assert!(
                decoded.contains(&n.as_str()) || NOT_DECODED_HERE.contains(&n.as_str()),
                "fixture {n} is neither decoded by prompt_fixtures_round_trip nor listed as out of scope"
            );
        }
        for n in decoded.iter().chain(NOT_DECODED_HERE) {
            assert!(names.iter().any(|x| x == n), "fixture {n} is listed but missing");
        }
    }

    /// Unknown keys are ignored (forward compatible), never a decode error.
    #[test]
    fn unknown_fields_are_ignored() {
        let mut v = canonical(SHOW_NOTICE);
        v["futureField"] = serde_json::json!({"x": 1});
        v["copy"]["futureSlot"] = serde_json::json!("y");
        let s: PromptShow = serde_json::from_value(v).expect("unknown keys ignored");
        assert_eq!(s, notice());
    }

    #[test]
    fn type_strings_match_the_shared_contract() {
        for (key, value) in [
            ("show", TYPE_PROMPT_SHOW),
            ("update", TYPE_PROMPT_UPDATE),
            ("close", TYPE_PROMPT_CLOSE),
            ("actionResult", TYPE_PROMPT_ACTION_RESULT),
            ("brandingSync", TYPE_PROMPT_BRANDING_SYNC),
            ("presented", TYPE_PROMPT_PRESENTED),
            ("action", TYPE_PROMPT_ACTION),
            ("closed", TYPE_PROMPT_CLOSED),
        ] {
            let line = format!("  {key}: '{value}',");
            assert!(KINDS_TS.contains(&line), "kinds.ts has no `{line}`");
        }
        assert!(KINDS_TS.contains(&format!("export const PROMPT_PROTOCOL_VERSION = {PROMPT_PROTOCOL_VERSION};")));
    }

    #[test]
    fn kind_classes_match_the_shared_registry() {
        let mut seen = 0;
        for line in KINDS_TS.lines() {
            let t = line.trim();
            let Some(rest) = t.strip_prefix('\'') else { continue };
            let Some((kind, tail)) = rest.split_once("': { copyClass: '") else { continue };
            let class = tail.split('\'').next().unwrap();
            seen += 1;
            assert!(is_registry_kind(kind), "{kind} missing from is_registry_kind");
            let want = if class == "operator" { CopyClass::Operator } else { CopyClass::Breeze };
            assert_eq!(prompt_kind_class(kind), want, "{kind}");
        }
        assert_eq!(seen, 6, "parsed {seen} kinds from kinds.ts");
        assert_eq!(prompt_kind_class("future.kind"), CopyClass::Breeze, "unknown kinds fail closed");
        assert!(!is_registry_kind("future.kind"));
    }

    /// A kind is advertised only by the wave that ships it (plan P2); the
    /// exact list is pinned by `client.rs` `advertises_shipped_kinds_v1`.
    /// Every entry must be a registry kind shaped `<kind>@<1-999>`.
    #[test]
    fn advertised_kinds_are_well_formed() {
        for ad in ADVERTISED_PROMPT_KINDS.iter().chain(ALL_KINDS) {
            let (kind, ver) = ad.rsplit_once('@').expect(ad);
            assert!(is_registry_kind(kind), "{ad}");
            assert!(!ver.starts_with('0') && (1..=3).contains(&ver.len()) && ver.bytes().all(|b| b.is_ascii_digit()), "{ad}");
        }
    }

    // ----- show -----

    #[test]
    fn unadvertised_kind_render_failed() {
        // The production tracker advertises every registry kind at version 1
        // (W04-W07): a version it does not advertise is refused, a notice renders.
        let mut t = PromptTracker::default();
        let mut v2 = elevation();
        v2.kind_version = 2;
        assert_eq!(t.on_show(NOW, &v2), ShowOutcome::RenderFailed(DETAIL_UNADVERTISED_KIND));
        assert!(rendered(&PromptTracker::default().on_show(NOW, &notice())));
        // The refusal frame is exactly the golden fixture.
        let frame = closed_frame("env-1", &notice().reference(), ClosedReason::RenderFailed, Some(DETAIL_UNADVERTISED_KIND));
        assert_eq!(frame.id, "env-1");
        assert_eq!(frame.typ, TYPE_PROMPT_CLOSED);
        assert_eq!(frame.payload, canonical(CLOSED_FAILED));
        // A kind advertised at another version is not advertised.
        let mut t = PromptTracker::new(&["notice.info@2"]);
        assert_eq!(t.on_show(NOW, &notice()), ShowOutcome::RenderFailed(DETAIL_UNADVERTISED_KIND));
        // A kind outside the registry, even if somehow advertised, is refused.
        let mut t = PromptTracker::new(&["future.kind@1"]);
        let mut s = notice();
        s.kind = "future.kind".into();
        assert_eq!(t.on_show(NOW, &s), ShowOutcome::RenderFailed(DETAIL_UNADVERTISED_KIND));
        // The advertised one renders.
        assert!(rendered(&tracker().on_show(NOW, &notice())));
    }

    #[test]
    fn breeze_kind_with_operator_note_refused() {
        for kind in ["notice.info", "remote.consent", "remote.session", "elevation.request"] {
            let mut s = notice();
            s.kind = kind.into();
            s.copy.operator_note = Some("Call 555-0100".into());
            assert_eq!(tracker().on_show(NOW, &s), ShowOutcome::RenderFailed(DETAIL_OPERATOR_TEXT), "{kind}");
        }
        // Operator-class kinds carry operator text.
        assert!(restart().copy.operator_note.is_some());
        assert!(rendered(&tracker().on_show(NOW, &restart())));
        let mut s = restart();
        s.kind = "restart.final".into();
        assert!(rendered(&tracker().on_show(NOW, &s)));
        // An update cannot smuggle operator text onto a breeze-class prompt.
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &notice())));
        let mut u = update(&notice().prompt_id, 2);
        u.copy = Some(PromptCopy { title: "x".into(), operator_note: Some("y".into()), ..PromptCopy::default() });
        assert_eq!(t.on_update(NOW, &u), UpdateOutcome::RenderFailed(DETAIL_OPERATOR_TEXT));
    }

    #[test]
    fn decision_without_single_safe_default_refused() {
        let refuse = |s: &PromptShow| tracker().on_show(NOW, s);
        // No safe action.
        let mut s = restart();
        s.actions.retain(|a| a.role != ActionRole::Safe);
        s.default_action_id = None;
        assert_eq!(refuse(&s), ShowOutcome::RenderFailed(DETAIL_NO_SAFE_DEFAULT));
        // Two safe actions.
        let mut s = restart();
        s.actions[1].role = ActionRole::Safe;
        assert_eq!(refuse(&s), ShowOutcome::RenderFailed(DETAIL_NO_SAFE_DEFAULT));
        // A default that is not the safe action.
        let mut s = restart();
        s.default_action_id = Some("restart_now".into());
        assert_eq!(refuse(&s), ShowOutcome::RenderFailed(DETAIL_NO_SAFE_DEFAULT));
        // No default at all.
        let mut s = restart();
        s.default_action_id = None;
        assert_eq!(refuse(&s), ShowOutcome::RenderFailed(DETAIL_NO_SAFE_DEFAULT));
        // Not a decision: waiting, or an indicator, needs no safe default.
        assert!(rendered(&refuse(&elevation())));
        let mut s = restart();
        s.presentation = Presentation::Indicator;
        s.default_action_id = None;
        s.actions.retain(|a| a.role != ActionRole::Safe);
        assert!(rendered(&refuse(&s)));
        // An update that leaves a pending decision without its default is refused.
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &restart())));
        let mut u = update("restart:42", 2);
        u.actions = Some(vec![PromptActionSpec { id: "restart_now".into(), label: "Restart now".into(), role: ActionRole::Proceed }]);
        assert_eq!(t.on_update(NOW, &u), UpdateOutcome::RenderFailed(DETAIL_NO_SAFE_DEFAULT));
        // ...and the refused prompt is no longer tracked.
        assert!(t.view("restart:42", NOW).is_none());
    }

    #[test]
    fn malformed_content_is_refused() {
        let cases: Vec<(&str, Box<dyn Fn(&mut PromptShow)>)> = vec![
            ("bad id", Box::new(|s| s.prompt_id = "no-domain".into())),
            ("empty title", Box::new(|s| s.copy.title.clear())),
            ("long title", Box::new(|s| s.copy.title = "t".repeat(201))),
            ("rev 0", Box::new(|s| s.rev = 0)),
            ("epoch 0", Box::new(|s| s.lease.epoch = 0)),
            ("duplicate action", Box::new(|s| {
                let a = s.actions[0].clone();
                s.actions.push(PromptActionSpec { role: ActionRole::Neutral, ..a });
            })),
            ("four actions", Box::new(|s| {
                for id in ["a", "b", "c"] {
                    s.actions.push(PromptActionSpec { id: id.into(), label: id.into(), role: ActionRole::Neutral });
                }
            })),
            ("bad action id", Box::new(|s| s.actions[0].id = "Ok!".into())),
            ("both budgets", Box::new(|s| s.timing.response_ms = Some(30_000))),
            ("expiry names no action", Box::new(|s| {
                s.timing.expiry.as_mut().unwrap().action_id = Some("nope".into());
            })),
            ("bad locale", Box::new(|s| s.locale = "EN_us".into())),
        ];
        for (name, mutate) in cases {
            let mut s = restart();
            mutate(&mut s);
            let got = tracker().on_show(NOW, &s);
            assert!(matches!(got, ShowOutcome::RenderFailed(_)), "{name}: {got:?}");
        }
        // Code points, not bytes: a 200-character non-ASCII title is fine.
        let mut s = restart();
        s.copy.title = "é".repeat(200);
        assert!(rendered(&tracker().on_show(NOW, &s)));
    }

    #[test]
    fn stale_rev_dropped() {
        let mut t = tracker();
        let mut s = restart();
        s.rev = 2;
        assert!(rendered(&t.on_show(NOW, &s)));
        // Same rev and older revs are dropped, for shows and updates alike.
        assert_eq!(t.on_show(NOW, &s), ShowOutcome::DropStale);
        s.rev = 1;
        assert_eq!(t.on_show(NOW, &s), ShowOutcome::DropStale);
        assert_eq!(t.on_update(NOW, &update("restart:42", 2)), UpdateOutcome::DropStale);
        assert_eq!(t.on_update(NOW, &update("restart:42", 1)), UpdateOutcome::DropStale);
        // A newer show replaces (never a second window).
        s.rev = 3;
        assert!(matches!(t.on_show(NOW, &s), ShowOutcome::Replace { .. }));
        assert_eq!(t.on_update(NOW, &update("restart:42", 4)), UpdateOutcome::Applied { card_open: true });
        // A close older than what is applied is dropped; at the current rev it applies.
        assert_eq!(t.on_close(NOW, &close("restart:42", 3, CloseReason::Withdrawn)), CloseOutcome::DropStale);
        assert_eq!(t.on_close(NOW, &close("restart:42", 4, CloseReason::Withdrawn)), CloseOutcome::Closed { had_card: true });
        // After the close, the closed rev is remembered: a late show cannot resurrect it.
        assert_eq!(t.on_show(NOW, &s), ShowOutcome::DropStale);
        s.rev = 4;
        assert_eq!(t.on_show(NOW, &s), ShowOutcome::DropStale);
        assert_eq!(t.on_update(NOW, &update("restart:42", 4)), UpdateOutcome::DropStale);
    }

    #[test]
    fn update_for_an_unknown_prompt_is_refused() {
        assert_eq!(tracker().on_update(NOW, &update("restart:9", 2)), UpdateOutcome::RenderFailed(DETAIL_UNKNOWN_PROMPT));
    }

    #[test]
    fn update_replaces_present_fields_and_actions_carry_the_default() {
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &elevation())));
        let u: PromptUpdate = serde_json::from_str(UPDATE_STATE).unwrap();
        assert_eq!(t.on_update(NOW, &u), UpdateOutcome::Applied { card_open: true });
        let v = t.view(&u.prompt_id, NOW).unwrap();
        assert_eq!(v.state, PromptState::Approved);
        assert_eq!(v.copy.title, "Request approved");
        assert_eq!(v.copy.state_detail, None, "copy is replaced whole");
        assert_eq!(v.facts.len(), 3, "absent facts are unchanged");
        assert_eq!(v.default_action_id.as_deref(), Some("ok"));
        // `actions: []` clears the actions and the default.
        let u: PromptUpdate = serde_json::from_str(UPDATE_CLEARED).unwrap();
        assert_eq!(t.on_update(NOW, &u), UpdateOutcome::Applied { card_open: true });
        let v = t.view(&u.prompt_id, NOW).unwrap();
        assert!(v.actions.is_empty());
        assert_eq!(v.default_action_id, None);
        // A default without actions is malformed.
        let mut u = update(&u.prompt_id, 5);
        u.default_action_id = Some("ok".into());
        assert_eq!(t.on_update(NOW, &u), UpdateOutcome::RenderFailed(DETAIL_MALFORMED));
    }

    #[test]
    fn at_most_three_card_windows_and_the_rest_collapse_into_the_list() {
        let mut t = tracker();
        let mut slots = Vec::new();
        for i in 0..4 {
            match t.on_show(NOW, &with_id(notice(), &format!("notice:test:{i}"))) {
                ShowOutcome::Render { window } => slots.push(window.map(|w| w.slot)),
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(slots, vec![Some(0), Some(1), Some(2), None]);
        // The collapsed one is in the list even when not persistent.
        let mut s = with_id(notice(), "notice:test:5");
        s.list_entry.persistent = false;
        assert_eq!(t.on_show(NOW, &s), ShowOutcome::Render { window: None });
        assert!(t.list(NOW).iter().any(|v| v.prompt_id == "notice:test:5"));
        // A freed slot is reused.
        assert_eq!(t.on_close(NOW, &close("notice:test:1", 2, CloseReason::Withdrawn)), CloseOutcome::Closed { had_card: true });
        match t.on_show(NOW, &with_id(notice(), "notice:test:6")) {
            ShowOutcome::Render { window: Some(w) } => {
                assert_eq!(w.slot, 1);
                assert_eq!(w.label, window_label("notice:test:6"));
                assert_eq!(w.url, "index.html#prompt/notice:test:6");
            }
            other => panic!("{other:?}"),
        }
        // list_only never gets a window.
        let mut s = with_id(notice(), "notice:test:7");
        s.presentation = Presentation::ListOnly;
        let mut t = tracker();
        assert_eq!(t.on_show(NOW, &s), ShowOutcome::Render { window: None });
    }

    #[test]
    fn focus_steal_only_for_eligible_kinds_and_rate_limited() {
        let focused = |t: &mut PromptTracker, s: PromptShow, now: i64| match t.on_show(now, &s) {
            ShowOutcome::Render { window: Some(w) } => w.focused,
            other => panic!("{other:?}"),
        };
        let mut t = tracker();
        // A card that asks to steal but is not an eligible kind never gets focus.
        let mut s = with_id(notice(), "notice:a:1");
        s.focus = FocusMode::Steal;
        assert!(!focused(&mut t, s, NOW));
        // restart.final may, once per interval.
        let mut s = with_id(restart(), "restart:1");
        s.kind = "restart.final".into();
        s.focus = FocusMode::Steal;
        assert!(focused(&mut t, s.clone(), NOW));
        let s2 = with_id(s.clone(), "restart:2");
        assert!(!focused(&mut t, s2, NOW + 60_000));
        // no_activate never takes focus.
        let mut s3 = with_id(s.clone(), "restart:3");
        s3.focus = FocusMode::NoActivate;
        let mut t = tracker();
        assert!(!focused(&mut t, s3, NOW));
        // A modal answering the user is eligible.
        let mut s = with_id(elevation(), "elevation:a:2");
        s.presentation = Presentation::Modal;
        s.focus = FocusMode::Steal;
        assert!(focused(&mut tracker(), s, NOW));
        // A notice never is, not even as a modal (spec 3.2: non-activating).
        let mut s = with_id(notice(), "notice:a:2");
        s.presentation = Presentation::Modal;
        s.focus = FocusMode::Steal;
        assert!(!focused(&mut tracker(), s, NOW));
    }

    // ----- notice.info (W04) -----

    #[test]
    fn notice_card_is_non_activating_and_listed() {
        // The production tracker: what this build really advertises.
        let mut t = PromptTracker::default();
        let mut s = notice();
        // Even asked to steal focus as a modal (the eligible shape for other kinds).
        s.focus = FocusMode::Steal;
        s.presentation = Presentation::Modal;
        match t.on_show(NOW, &s) {
            ShowOutcome::Render { window: Some(w) } => {
                assert!(!w.focused, "a notice card never takes focus");
                assert_eq!(w.label, window_label(&s.prompt_id));
            }
            other => panic!("{other:?}"),
        }
        // Persistent: listed while its card is up.
        let ids = |t: &PromptTracker| t.list(NOW).into_iter().map(|v| v.prompt_id).collect::<Vec<_>>();
        assert_eq!(ids(&t), vec![s.prompt_id.clone()]);
        // Esc on the pending notice is its safe action, `ok`.
        let Dismiss::Action(frame) = t.dismiss(NOW, &s.prompt_id, ActionVia::Keyboard) else { panic!("Esc = ok") };
        assert_eq!(frame.payload["actionId"], "ok");
        let result = PromptActionResult {
            prompt_id: s.prompt_id.clone(),
            action_id: "ok".into(),
            rev: 1,
            result: ActionResultKind::Accepted,
        };
        assert!(t.on_action_result(&frame.id, &result));
        // Resolved: the entry stays in the list, without actions.
        assert_eq!(t.on_close(NOW, &close(&s.prompt_id, 1, CloseReason::Resolved)), CloseOutcome::Closed { had_card: true });
        let list = t.list(NOW);
        assert_eq!(list.len(), 1);
        assert!(list[0].closed && list[0].actions.is_empty());
    }

    #[test]
    fn open_settings_action_sends_prompt_action() {
        let mut t = PromptTracker::default();
        let mut s = with_id(notice(), "notice:tcc:0a1b2c3d");
        s.actions.push(PromptActionSpec { id: "open_settings".into(), label: "Open Settings".into(), role: ActionRole::Neutral });
        assert!(rendered(&t.on_show(NOW, &s)));
        let frame = t.action(NOW, &s.prompt_id, "open_settings", ActionVia::Click).unwrap();
        assert_eq!(frame.typ, TYPE_PROMPT_ACTION);
        assert_eq!(frame.payload["actionId"], "open_settings");
        assert_eq!(frame.payload["promptId"], "notice:tcc:0a1b2c3d");
        assert_eq!(frame.payload["via"], "click");
    }

    // ----- remote.consent / remote.session (W06) -----

    const SESSION_ID: &str = "8d1f6c2e-0b5a-4f7e-9a3c-2e4b6d8f0a1c";

    fn spec(id: &str, label: &str, role: ActionRole) -> PromptActionSpec {
        PromptActionSpec { id: id.into(), label: label.into(), role }
    }

    /// The agent's `remote.consent@1` (contract section 3): a modal that
    /// steals focus; Allow (proceed) and Deny (safe, the default).
    fn consent() -> PromptShow {
        let mut s = with_id(notice(), "consent:9f2c4e1a");
        s.kind = "remote.consent".into();
        s.presentation = Presentation::Modal;
        s.focus = FocusMode::Steal;
        s.copy = PromptCopy { title: "Remote support request".into(), ..PromptCopy::default() };
        s.facts = Some(vec![PromptFact { label: "Technician".into(), value: "Alex Rivera".into() }]);
        s.actions = vec![spec("allow", "Allow", ActionRole::Proceed), spec("deny", "Deny", ActionRole::Safe)];
        s.default_action_id = Some("deny".into());
        s.timing = PromptTiming {
            present_within_ms: 10_000,
            deadline_unix_ms: None,
            response_ms: Some(30_000),
            expiry: Some(PromptExpiry {
                action_id: None,
                text: "If no one answers, the session is declined in {remaining}.".into(),
            }),
        };
        s.list_entry = PromptListEntry { persistent: false, expires_at_unix_ms: None };
        s
    }

    /// The agent's `remote.session@1`: an indicator that never activates,
    /// with End session (policy allowed) and Report a problem.
    fn session() -> PromptShow {
        let mut s = with_id(notice(), &format!("session:{SESSION_ID}"));
        s.kind = "remote.session".into();
        s.presentation = Presentation::Indicator;
        s.focus = FocusMode::NoActivate;
        s.copy = PromptCopy { title: "Remote session in progress".into(), ..PromptCopy::default() };
        s.actions = vec![
            spec("end_session", "End session", ActionRole::Neutral),
            spec("report_problem", "Report a problem", ActionRole::Neutral),
        ];
        s.default_action_id = None;
        s.list_entry = PromptListEntry { persistent: false, expires_at_unix_ms: None };
        s
    }

    #[test]
    fn production_tracker_renders_the_remote_and_restart_kinds() {
        let mut t = PromptTracker::default();
        assert!(rendered(&t.on_show(NOW, &consent())));
        assert!(rendered(&t.on_show(NOW, &session())));
        // W05's restart kinds render beside them (merge of #10347 + #10348).
        assert!(rendered(&t.on_show(NOW, &restart())));
        assert!(rendered(&t.on_show(NOW, &restart_final())));
        // W07's elevation card renders beside them.
        assert!(rendered(&t.on_show(NOW, &elevation())));
    }

    #[test]
    fn consent_is_a_focused_modal_decision_with_deny_as_its_safe_default() {
        let mut t = PromptTracker::default();
        let s = consent();
        match t.on_show(NOW, &s) {
            ShowOutcome::Render { window: Some(w) } => {
                assert!(w.focused, "consent steals focus (spec 3.2)");
                assert_eq!(w.presentation, Presentation::Modal);
            }
            other => panic!("{other:?}"),
        }
        let v = t.view(&s.prompt_id, NOW).unwrap();
        assert!(v.decision);
        assert_eq!(v.safe_action_id.as_deref(), Some("deny"));
        assert_eq!(v.countdown_deadline_unix_ms, Some(NOW + 30_000), "responseMs counts from presentation");
        // Esc and the close box choose Deny, never Allow.
        let Dismiss::Action(frame) = t.dismiss(NOW, &s.prompt_id, ActionVia::Keyboard) else { panic!("Esc = deny") };
        assert_eq!(frame.payload["actionId"], "deny");
        // A consent that names Allow as its default is refused, not drawn.
        let mut bad = consent();
        bad.default_action_id = Some("allow".into());
        assert_eq!(PromptTracker::default().on_show(NOW, &bad), ShowOutcome::RenderFailed(DETAIL_NO_SAFE_DEFAULT));
        // Asked not to activate, it does not.
        let mut quiet = with_id(consent(), "consent:0b1c2d3e");
        quiet.focus = FocusMode::NoActivate;
        match PromptTracker::default().on_show(NOW, &quiet) {
            ShowOutcome::Render { window: Some(w) } => assert!(!w.focused),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn modal_and_indicator_take_no_card_slot() {
        let mut t = PromptTracker::default();
        for i in 0..MAX_VISIBLE_CARDS {
            match t.on_show(NOW, &with_id(notice(), &format!("notice:a:{i}"))) {
                ShowOutcome::Render { window: Some(w) } => assert_eq!(w.presentation, Presentation::Card),
                other => panic!("{other:?}"),
            }
        }
        // The stack is full: the next notice is list only...
        assert_eq!(t.on_show(NOW, &with_id(notice(), "notice:a:9")), ShowOutcome::Render { window: None });
        // ...but consent (centred) and the session pill (top of the screen) are
        // drawn outside the stack and are never collapsed into the list.
        for s in [consent(), session()] {
            match t.on_show(NOW, &s) {
                ShowOutcome::Render { window: Some(w) } => assert_eq!(w.presentation, s.presentation),
                other => panic!("{}: {other:?}", s.kind),
            }
        }
        // And they leave the stack's slots alone: with a pill and a consent
        // up, three cards still stack from the bottom.
        let mut t = PromptTracker::default();
        assert!(rendered(&t.on_show(NOW, &session())));
        assert!(rendered(&t.on_show(NOW, &consent())));
        for i in 0..MAX_VISIBLE_CARDS {
            match t.on_show(NOW, &with_id(notice(), &format!("notice:b:{i}"))) {
                ShowOutcome::Render { window: Some(w) } => assert_eq!(w.slot, i),
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn session_pill_never_takes_focus_and_is_not_a_decision() {
        let mut t = PromptTracker::default();
        let mut s = session();
        // Even if asked to steal focus.
        s.focus = FocusMode::Steal;
        match t.on_show(NOW, &s) {
            ShowOutcome::Render { window: Some(w) } => {
                assert!(!w.focused);
                assert_eq!(w.presentation, Presentation::Indicator);
            }
            other => panic!("{other:?}"),
        }
        let v = t.view(&s.prompt_id, NOW).unwrap();
        assert!(!v.decision);
        assert_eq!(v.safe_action_id, None);
        assert!(t.indicator_open(&s.prompt_id));
    }

    /// The confirm step is the agent's: an action-set swap inside `pending`
    /// (states are closed), with Keep session as the safe default. The close
    /// box on the pill only hides it; it never ends the session.
    #[test]
    fn end_session_confirm_is_an_action_swap_inside_pending() {
        let mut t = PromptTracker::default();
        let s = session();
        assert!(rendered(&t.on_show(NOW, &s)));
        let f = t.action(NOW, &s.prompt_id, "end_session", ActionVia::Click).unwrap();
        assert_eq!(f.payload["actionId"], "end_session");
        assert!(t.on_action_result(&f.id, &result(&s.prompt_id, "end_session", 1, ActionResultKind::Accepted)));
        let mut u = update(&s.prompt_id, 2);
        u.copy = Some(PromptCopy {
            title: "Remote session in progress".into(),
            state_detail: Some("End this remote session? The technician will be disconnected.".into()),
            ..PromptCopy::default()
        });
        u.actions = Some(vec![
            spec("end_confirm", "End session", ActionRole::Proceed),
            spec("keep_session", "Keep session", ActionRole::Safe),
        ]);
        u.default_action_id = Some("keep_session".into());
        assert_eq!(t.on_update(NOW, &u), UpdateOutcome::Applied { card_open: true });
        let v = t.view(&s.prompt_id, NOW).unwrap();
        assert_eq!(v.state, PromptState::Pending);
        assert_eq!(v.actions.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["end_confirm", "keep_session"]);
        assert_eq!(v.default_action_id.as_deref(), Some("keep_session"));
        assert!(t.indicator_open(&s.prompt_id));
        // The close box / Alt+F4 neither ends the session nor hides the pill:
        // a remote-session indicator stays on screen while the session runs.
        assert_eq!(t.dismiss(NOW, &s.prompt_id, ActionVia::Click), Dismiss::Kept);
        assert!(t.indicator_open(&s.prompt_id), "the pill stays");
        assert_eq!(t.view(&s.prompt_id, NOW).unwrap().pending_action_id, None, "nothing was sent");
    }

    /// W06 review: the session indicator is a transparency control, like the
    /// legacy banner that cannot be closed. Its close box and Alt+F4 (and a
    /// stray hide) send nothing, in either action set, and the window stays.
    #[test]
    fn indicator_close_box_never_hides_the_pill() {
        let bridge = PromptBridge::with_tracker(PromptTracker::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        bridge.set_sender(tx);
        let s = session();
        assert!(rendered(&bridge.tracker().on_show(NOW, &s)));
        for via in [ActionVia::Click, ActionVia::Keyboard] {
            assert_eq!(bridge.dismiss(NOW, &s.prompt_id, via), Ok(DismissEffect::Kept), "{via:?}");
        }
        // The confirm step (a safe default on the indicator) is no different.
        let mut u = update(&s.prompt_id, 2);
        u.actions = Some(vec![
            spec("end_confirm", "End session", ActionRole::Proceed),
            spec("keep_session", "Keep session", ActionRole::Safe),
        ]);
        u.default_action_id = Some("keep_session".into());
        assert_eq!(bridge.tracker().on_update(NOW, &u), UpdateOutcome::Applied { card_open: true });
        assert_eq!(bridge.dismiss(NOW, &s.prompt_id, ActionVia::Click), Ok(DismissEffect::Kept));
        assert!(rx.try_recv().is_err(), "no prompt_closed{{hidden}} and no action was sent");
        assert!(bridge.tracker().indicator_open(&s.prompt_id), "the pill is still up");
        assert!(bridge.tracker().list(NOW).is_empty(), "and not collapsed into the list");
        // A card is still hidden by its close box (unchanged).
        let mut t = PromptTracker::new(ALL_KINDS);
        assert!(rendered(&t.on_show(NOW, &elevation())));
        assert!(matches!(t.dismiss(NOW, &elevation().prompt_id, ActionVia::Click), Dismiss::Hidden(_)));
    }

    #[test]
    fn report_a_problem_opens_request_support_with_the_session_id_after_accepted() {
        let mut t = PromptTracker::default();
        let mut s = session();
        s.locale = "de-DE".into();
        assert!(rendered(&t.on_show(NOW, &s)));
        assert_eq!(t.take_request_support(), None);
        let f = t.action(NOW, &s.prompt_id, "report_problem", ActionVia::Click).unwrap();
        assert_eq!(t.take_request_support(), None, "nothing opens before the agent answers");
        assert!(t.on_action_result(&f.id, &result(&s.prompt_id, "report_problem", 1, ActionResultKind::Accepted)));
        assert_eq!(
            t.take_request_support(),
            Some(RequestSupport { session_id: SESSION_ID.into(), locale: "de-DE".into() }),
            "the session id from session:<id>, in the prompt's locale"
        );
        assert_eq!(t.take_request_support(), None, "once per accepted click");

        // Rejected (stale or invalid): nothing opens.
        for kind in [ActionResultKind::RejectedStale, ActionResultKind::RejectedInvalid] {
            let f = t.action(NOW, &s.prompt_id, "report_problem", ActionVia::Click).unwrap();
            assert!(t.on_action_result(&f.id, &result(&s.prompt_id, "report_problem", 1, kind)));
            assert_eq!(t.take_request_support(), None, "{kind:?}");
        }
        // An accepted result on another envelope (an earlier click) releases nothing.
        t.action(NOW, &s.prompt_id, "report_problem", ActionVia::Click).unwrap();
        assert!(!t.on_action_result("prompt-other", &result(&s.prompt_id, "report_problem", 1, ActionResultKind::Accepted)));
        assert_eq!(t.take_request_support(), None);
        // No answer in time: nothing opens.
        t.expire_due(NOW + ACTION_RESULT_TIMEOUT_MS);
        assert_eq!(t.take_request_support(), None);
        // Another action accepted: nothing opens.
        let f = t.action(NOW, &s.prompt_id, "end_session", ActionVia::Click).unwrap();
        assert!(t.on_action_result(&f.id, &result(&s.prompt_id, "end_session", 1, ActionResultKind::Accepted)));
        assert_eq!(t.take_request_support(), None);
        // The same action id on another kind: nothing opens.
        let mut n = with_id(notice(), "notice:x:1");
        n.actions.push(spec("report_problem", "Report a problem", ActionRole::Neutral));
        assert!(rendered(&t.on_show(NOW, &n)));
        let f = t.action(NOW, &n.prompt_id, "report_problem", ActionVia::Click).unwrap();
        assert!(t.on_action_result(&f.id, &result(&n.prompt_id, "report_problem", 1, ActionResultKind::Accepted)));
        assert_eq!(t.take_request_support(), None);
        // From the Notifications tab (via list) it opens too; a disconnect
        // before it is taken drops it.
        let f = t.action(NOW, &s.prompt_id, "report_problem", ActionVia::List).unwrap();
        assert!(t.on_action_result(&f.id, &result(&s.prompt_id, "report_problem", 1, ActionResultKind::Accepted)));
        t.on_disconnect();
        assert_eq!(t.take_request_support(), None);
    }

    /// Contract amendment (W06): the agent closes the pill with
    /// `prompt_close{withdrawn}` when the session stops, and may show the same
    /// `session:<id>` again on a viewer reconnect (a newer rev, a new lease).
    /// Withdrawn takes the pill down and leaves no list entry; the re-show is
    /// a fresh pill with its own window. A late copy of the old show (rev not
    /// above the closed one) stays dropped.
    #[test]
    fn withdrawn_pill_closes_and_the_same_session_can_show_again() {
        let mut t = PromptTracker::default();
        // Even a pill the agent marked persistent leaves no entry on withdrawn
        // (a `resolved` close would keep one).
        let mut s = session();
        s.list_entry = PromptListEntry { persistent: true, expires_at_unix_ms: Some(NOW + 86_400_000) };
        assert!(rendered(&t.on_show(NOW, &s)));
        let f = t.action(NOW, &s.prompt_id, "report_problem", ActionVia::Click).unwrap();
        assert_eq!(t.on_close(NOW, &close(&s.prompt_id, 3, CloseReason::Withdrawn)), CloseOutcome::Closed { had_card: true });
        assert!(!t.indicator_open(&s.prompt_id));
        assert!(t.view(&s.prompt_id, NOW).is_none(), "withdrawn: not tracked");
        assert!(t.list(NOW).is_empty(), "withdrawn: no list entry");
        assert_eq!(t.action(NOW, &s.prompt_id, "end_session", ActionVia::Click), Err(ActionRefusal::UnknownPrompt));
        // The answer to a click on the withdrawn pill opens nothing.
        assert!(!t.on_action_result(&f.id, &result(&s.prompt_id, "report_problem", 1, ActionResultKind::Accepted)));
        assert_eq!(t.take_request_support(), None);

        // A late copy of the closed pill is dropped.
        let mut late = session();
        late.rev = 3;
        assert_eq!(t.on_show(NOW, &late), ShowOutcome::DropStale);

        // The viewer reconnects: same id, newer rev, new lease: a fresh pill.
        let mut again = s.clone();
        again.rev = 4;
        again.lease = PromptLease { renderer_session: "assist-user-4242".into(), epoch: 2 };
        match t.on_show(NOW + 60_000, &again) {
            ShowOutcome::Render { window: Some(w) } => {
                assert_eq!(w.presentation, Presentation::Indicator);
                assert_eq!(w.label, window_label(&again.prompt_id));
                assert!(!w.focused);
            }
            other => panic!("{other:?}"),
        }
        assert!(t.indicator_open(&again.prompt_id));
        let v = t.view(&again.prompt_id, NOW).unwrap();
        assert_eq!(v.pending_action_id, None, "nothing carried over from the old pill");
        assert_eq!(v.last_outcome, None);
        // Its actions echo the new rev and lease.
        let f = t.action(NOW, &again.prompt_id, "end_session", ActionVia::Click).unwrap();
        assert_eq!(f.payload["rev"], 4);
        assert_eq!(f.payload["lease"]["epoch"], 2);
        // A second withdrawn closes it cleanly again.
        assert_eq!(t.on_close(NOW, &close(&again.prompt_id, 5, CloseReason::Withdrawn)), CloseOutcome::Closed { had_card: true });
        assert!(!t.indicator_open(&again.prompt_id));
    }

    /// After an agent restart (the IPC session ends; the agent's in-memory rev
    /// floor is gone) the same promptId may start at rev 1 again. The tracker
    /// forgets every applied and closed rev on disconnect, so that show is
    /// drawn, whether the pill was open or already withdrawn.
    #[test]
    fn agent_restart_rev_1_show_is_drawn_after_disconnect() {
        // Withdrawn before the restart (its rev remembered as closed).
        let mut t = PromptTracker::default();
        let mut s = session();
        s.rev = 5;
        assert!(rendered(&t.on_show(NOW, &s)));
        t.on_close(NOW, &close(&s.prompt_id, 6, CloseReason::Withdrawn));
        let mut restarted = session();
        restarted.rev = 1;
        restarted.lease = PromptLease { renderer_session: "assist-user-5151".into(), epoch: 1 };
        assert_eq!(t.on_show(NOW, &restarted), ShowOutcome::DropStale, "same session: stale");
        t.on_disconnect();
        match t.on_show(NOW, &restarted) {
            ShowOutcome::Render { window: Some(w) } => assert_eq!(w.presentation, Presentation::Indicator),
            other => panic!("{other:?}"),
        }
        // Still open when the agent died.
        let mut t = PromptTracker::default();
        assert!(rendered(&t.on_show(NOW, &s)));
        assert_eq!(t.on_show(NOW, &restarted), ShowOutcome::DropStale, "same session: stale");
        assert_eq!(t.on_disconnect(), vec![s.prompt_id.clone()], "its card is closed");
        assert!(matches!(t.on_show(NOW, &restarted), ShowOutcome::Render { window: Some(_) }));
        assert_eq!(t.view(&s.prompt_id, NOW).unwrap().version, t.version());
        let f = t.action(NOW, &s.prompt_id, "end_session", ActionVia::Click).unwrap();
        assert_eq!(f.payload["rev"], 1);
        assert_eq!(f.payload["lease"]["rendererSession"], "assist-user-5151");
    }

    #[test]
    fn indicator_open_only_for_an_open_pill_with_a_card() {
        let mut t = PromptTracker::default();
        assert!(!t.indicator_open("session:none"));
        assert!(rendered(&t.on_show(NOW, &notice())));
        assert!(!t.indicator_open(&notice().prompt_id), "a notice card is not a pill");
        assert!(rendered(&t.on_show(NOW, &consent())));
        assert!(!t.indicator_open(&consent().prompt_id), "a modal is not a pill");
        let s = session();
        assert!(rendered(&t.on_show(NOW, &s)));
        assert!(t.indicator_open(&s.prompt_id));
        t.on_close(NOW, &close(&s.prompt_id, 2, CloseReason::Resolved));
        assert!(!t.indicator_open(&s.prompt_id));
    }

    // ----- restart.prompt / restart.final (W05, Task 5.2) -----

    /// A rung where Postpone is not offered (policy off, budget used, too close
    /// to the deadline): still a pending decision, `OK` (safe, default) beside
    /// Restart now, so neither Enter nor Esc can ever restart the computer.
    fn restart_no_postpone() -> PromptShow {
        let mut s = restart();
        s.actions = vec![
            PromptActionSpec { id: "ok".into(), label: "OK".into(), role: ActionRole::Safe },
            PromptActionSpec { id: "restart_now".into(), label: "Restart now".into(), role: ActionRole::Proceed },
        ];
        s.default_action_id = Some("ok".into());
        s.copy.state_detail = Some("No postponements left".into());
        s
    }

    /// The closing rung while the OS countdown runs.
    fn restart_final() -> PromptShow {
        let mut s = with_id(restart(), "restart:42:final");
        s.kind = "restart.final".into();
        s.focus = FocusMode::Steal;
        s.copy = PromptCopy {
            title: "This computer is restarting".into(),
            body: Some("This computer restarts in {remaining}. Save your work now.".into()),
            ..PromptCopy::default()
        };
        s.actions = vec![PromptActionSpec { id: "ok".into(), label: "OK".into(), role: ActionRole::Safe }];
        s.default_action_id = Some("ok".into());
        s
    }

    fn result(id: &str, action: &str, rev: u64, kind: ActionResultKind) -> PromptActionResult {
        PromptActionResult { prompt_id: id.into(), action_id: action.into(), rev, result: kind }
    }

    fn window_of(o: ShowOutcome) -> WindowPlan {
        match o {
            ShowOutcome::Render { window: Some(w) } => w,
            other => panic!("expected a card window, got {other:?}"),
        }
    }

    #[test]
    fn production_tracker_draws_both_restart_kinds() {
        let mut t = PromptTracker::default();
        assert!(rendered(&t.on_show(NOW, &restart())));
        assert!(rendered(&t.on_show(NOW, &restart_final())));
        assert!(rendered(&t.on_show(NOW, &with_id(restart_no_postpone(), "restart:43"))));
    }

    /// Postpone offered: a pending decision whose default (Esc, close box)
    /// is Postpone, never Restart now.
    #[test]
    fn restart_pending_defaults_to_postpone() {
        let mut t = PromptTracker::default();
        assert!(rendered(&t.on_show(NOW, &restart())));
        let v = t.view("restart:42", NOW).unwrap();
        assert!(v.decision);
        assert_eq!(v.default_action_id.as_deref(), Some("postpone"));
        assert_eq!(v.safe_action_id.as_deref(), Some("postpone"));
        let Dismiss::Action(f) = t.dismiss(NOW, "restart:42", ActionVia::Keyboard) else { panic!("Esc = postpone") };
        assert_eq!(f.payload["actionId"], "postpone");
    }

    /// Postpone not offered: an ordinary decision whose default (Esc, close
    /// box) is OK, never Restart now.
    #[test]
    fn no_postpone_card_defaults_to_ok() {
        let mut t = PromptTracker::default();
        assert!(!window_of(t.on_show(NOW, &restart_no_postpone())).focused);
        let v = t.view("restart:42", NOW).unwrap();
        assert!(v.decision);
        assert_eq!(v.default_action_id.as_deref(), Some("ok"));
        assert_eq!(v.safe_action_id.as_deref(), Some("ok"));
        let Dismiss::Action(f) = t.dismiss(NOW, "restart:42", ActionVia::Keyboard) else { panic!("Esc = ok") };
        assert_eq!(f.payload["actionId"], "ok");
        // A rung update that withdraws Postpone (OK in its place) applies.
        let mut t = PromptTracker::default();
        assert!(rendered(&t.on_show(NOW, &restart())));
        let mut u = update("restart:42", 2);
        u.actions = Some(restart_no_postpone().actions);
        u.default_action_id = Some("ok".into());
        assert_eq!(t.on_update(NOW, &u), UpdateOutcome::Applied { card_open: true });
        assert_eq!(t.view("restart:42", NOW).unwrap().safe_action_id.as_deref(), Some("ok"));
    }

    /// The agent answers `ok` with `accepted` and changes nothing (same rev,
    /// no update): the card collapses to its list entry exactly as it was,
    /// and the next rung brings it back.
    #[test]
    fn accepted_ok_collapses_the_card_without_changing_it() {
        let b = PromptBridge::with_tracker(PromptTracker::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        assert!(rendered(&b.tracker().on_show(NOW, &restart_no_postpone())));
        let before = b.tracker().view("restart:42", NOW).unwrap();
        assert_eq!(b.dismiss(NOW, "restart:42", ActionVia::Keyboard), Ok(DismissEffect::ActionSent));
        let sent = rx.try_recv().unwrap();
        assert_eq!(sent.payload["actionId"], "ok");
        assert_eq!(
            b.action_result(&sent.id, &result("restart:42", "ok", 1, ActionResultKind::Accepted)),
            ResultEffect::Collapsed
        );
        let hidden = rx.try_recv().expect("the agent is told the card was hidden");
        assert_eq!(hidden.payload["reason"], "hidden");
        assert_eq!(hidden.payload["rev"], 1);
        let v = b.tracker().view("restart:42", NOW).unwrap();
        assert!(!v.card && !v.closed);
        assert_eq!((v.state, &v.copy, &v.actions, &v.default_action_id), (before.state, &before.copy, &before.actions, &before.default_action_id));
        assert_eq!(v.countdown_deadline_unix_ms, before.countdown_deadline_unix_ms);
        let list = b.tracker().list(NOW);
        assert_eq!(list.len(), 1, "still in the Notifications list");
        assert_eq!(list[0].actions, before.actions, "with OK and Restart now");
        // The window client.rs then destroys is not reported as a lost decision
        // (that would make the agent fall back and drop the entry).
        b.window_gone("restart:42");
        assert!(rx.try_recv().is_err(), "nothing sent for the collapsed card's window");
        assert_eq!(b.tracker().list(NOW).len(), 1);
        // OK again from the list: released, but there is no card to collapse.
        assert_eq!(b.act(NOW, "restart:42", "ok", ActionVia::List), Ok(()));
        let sent = rx.try_recv().unwrap();
        assert_eq!(
            b.action_result(&sent.id, &result("restart:42", "ok", 1, ActionResultKind::Accepted)),
            ResultEffect::Applied
        );
        assert!(rx.try_recv().is_err(), "no second prompt_closed{{hidden}}");
        // The next rung re-surfaces it, without focus.
        let mut rung = restart_no_postpone();
        rung.rev = 2;
        assert!(!window_of(b.tracker().on_show(NOW, &rung)).focused);
        assert!(b.tracker().view("restart:42", NOW).unwrap().card);
    }

    /// A rung that arrives while every card slot is taken leaves the restart
    /// card in the list (no window), with the old outcome cleared; a re-shown
    /// restart prompt never spends the focus allowance `restart.final` needs.
    #[test]
    fn resurface_with_every_slot_taken_stays_listed() {
        let b = PromptBridge::with_tracker(PromptTracker::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        assert!(rendered(&b.tracker().on_show(NOW, &restart())));
        b.act(NOW, "restart:42", "postpone", ActionVia::Click).unwrap();
        let sent = rx.try_recv().unwrap();
        assert_eq!(b.action_result(&sent.id, &result("restart:42", "postpone", 1, ActionResultKind::Accepted)), ResultEffect::Collapsed);
        for i in 0..MAX_VISIBLE_CARDS {
            assert!(window_of(b.tracker().on_show(NOW, &with_id(notice(), &format!("notice:fill:{i}")))).slot < MAX_VISIBLE_CARDS);
        }
        let mut rung = restart();
        rung.rev = 2;
        rung.focus = FocusMode::Steal;
        assert_eq!(b.tracker().on_show(NOW, &rung), ShowOutcome::Replace { card_open: false });
        let v = b.tracker().view("restart:42", NOW).unwrap();
        assert!(!v.card);
        assert_eq!(v.last_outcome, None);
        assert!(b.tracker().list(NOW).iter().any(|e| e.prompt_id == "restart:42"));
        // Collapsed, not merely hidden: listed even when the agent did not ask
        // for a persistent entry, so Restart now stays reachable.
        let b = PromptBridge::with_tracker(PromptTracker::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        let mut s = restart_no_postpone();
        s.list_entry.persistent = false;
        assert!(rendered(&b.tracker().on_show(NOW, &s)));
        b.act(NOW, "restart:42", "ok", ActionVia::Click).unwrap();
        let sent = rx.try_recv().unwrap();
        assert_eq!(b.action_result(&sent.id, &result("restart:42", "ok", 1, ActionResultKind::Accepted)), ResultEffect::Collapsed);
        assert!(b.tracker().list(NOW).iter().any(|e| e.prompt_id == "restart:42"), "a collapsed card is always listed");
        // The closing card still gets its one focus steal.
        b.tracker().on_close(NOW, &close("notice:fill:0", 2, CloseReason::Withdrawn));
        assert!(window_of(b.tracker().on_show(NOW, &restart_final())).focused);
    }

    /// `restart.prompt` never takes focus, whatever the agent asks for.
    #[test]
    fn restart_prompt_never_steals_focus() {
        for presentation in [Presentation::Card, Presentation::Modal] {
            let mut s = restart();
            s.focus = FocusMode::Steal;
            s.presentation = presentation;
            assert!(!window_of(PromptTracker::default().on_show(NOW, &s)).focused, "{presentation:?}");
        }
    }

    /// `restart.final` may steal focus where `notice.info` may not: once, under
    /// the message card's once-per-interval rule, and never again on a re-show.
    #[test]
    fn restart_final_steals_focus_once_where_a_notice_may_not() {
        use super::super::message::FOCUS_INTERVAL_MS;
        let mut t = PromptTracker::default();
        let mut n = notice();
        n.focus = FocusMode::Steal;
        assert!(!window_of(t.on_show(NOW, &n)).focused, "a notice never steals");
        assert!(window_of(t.on_show(NOW, &restart_final())).focused, "the closing card steals");
        // A newer rev of the same final card refreshes in place, no second steal.
        let mut again = restart_final();
        again.rev = 2;
        assert_eq!(t.on_show(NOW + 1_000, &again), ShowOutcome::Replace { card_open: true });
        // Only OK, and OK is the default.
        let v = t.view("restart:42:final", NOW).unwrap();
        assert_eq!(v.actions.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["ok"]);
        assert_eq!(v.default_action_id.as_deref(), Some("ok"));
        assert!(v.decision);
        // Another final card within the focus interval does not steal...
        let mut t = PromptTracker::default();
        assert!(window_of(t.on_show(NOW, &restart_final())).focused);
        assert!(!window_of(t.on_show(NOW + 60_000, &with_id(restart_final(), "restart:43:final"))).focused);
        // ...one after it may.
        assert!(window_of(t.on_show(NOW + FOCUS_INTERVAL_MS, &with_id(restart_final(), "restart:44:final"))).focused);
    }

    /// Spec 3.3 "Postponing does not reopen the prompt": an accepted Postpone
    /// collapses the card to its list entry; the next rung (a full
    /// `prompt_show`, same id, higher rev) brings it back without focus.
    #[test]
    fn restart_card_collapses_after_accepted_postpone_and_resurfaces_on_next_rung() {
        let b = PromptBridge::with_tracker(PromptTracker::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        assert!(rendered(&b.tracker().on_show(NOW, &restart())));
        assert_eq!(b.act(NOW, "restart:42", "postpone", ActionVia::Click), Ok(()));
        let sent = rx.try_recv().unwrap();
        // The agent re-plans: prompt_update with the new time, then the result.
        let mut u = update("restart:42", 2);
        let mut timing = restart().timing;
        timing.deadline_unix_ms = Some(1_793_023_200_000);
        u.timing = Some(timing);
        u.actions = Some(restart().actions);
        u.default_action_id = Some("postpone".into());
        assert_eq!(b.tracker().on_update(NOW, &u), UpdateOutcome::Applied { card_open: true });
        assert_eq!(
            b.action_result(&sent.id, &result("restart:42", "postpone", 2, ActionResultKind::Accepted)),
            ResultEffect::Collapsed
        );
        let hidden = rx.try_recv().expect("the agent is told the card was hidden");
        assert_eq!(hidden.typ, TYPE_PROMPT_CLOSED);
        assert_eq!(hidden.payload["reason"], "hidden");
        assert_eq!(hidden.payload["rev"], 2);
        let v = b.tracker().view("restart:42", NOW).unwrap();
        assert!(!v.card && !v.closed);
        assert_eq!(v.pending_action_id, None);
        assert_eq!(v.last_outcome, Some("accepted"));
        assert_eq!(v.countdown_deadline_unix_ms, Some(1_793_023_200_000));
        let list = b.tracker().list(NOW);
        assert_eq!(list.len(), 1, "still in the Notifications list");
        assert_eq!(list[0].actions.len(), 2, "with its actions");
        // A later update does not reopen it.
        assert_eq!(b.tracker().on_update(NOW, &update("restart:42", 3)), UpdateOutcome::Applied { card_open: false });
        // The next warning rung re-surfaces it, without activation...
        let mut rung = restart();
        rung.rev = 4;
        rung.focus = FocusMode::Steal;
        let w = window_of(b.tracker().on_show(NOW + 60_000, &rung));
        assert!(!w.focused);
        assert_eq!(w.label, window_label("restart:42"));
        let v = b.tracker().view("restart:42", NOW).unwrap();
        assert!(v.card);
        assert_eq!(v.last_outcome, None, "the new rung starts without the old outcome");
        // ...and a duplicate of that rung changes nothing.
        assert_eq!(b.tracker().on_show(NOW + 60_000, &rung), ShowOutcome::DropStale);
    }

    /// Only an accepted Postpone or OK on a restart prompt collapses its card.
    #[test]
    fn only_an_accepted_postpone_or_ok_collapses_a_restart_card() {
        let collapse = |show: PromptShow, action: &str, kind: ActionResultKind| {
            let b = PromptBridge::with_tracker(PromptTracker::default());
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            b.set_sender(tx);
            let id = show.prompt_id.clone();
            assert!(rendered(&b.tracker().on_show(NOW, &show)));
            b.act(NOW, &id, action, ActionVia::Click).unwrap();
            let sent = rx.try_recv().unwrap();
            let effect = b.action_result(&sent.id, &result(&id, action, 1, kind));
            let card = b.tracker().view(&id, NOW).unwrap().card;
            (effect, card, rx.try_recv().is_ok())
        };
        // Another session decided first: the card stays, the update follows.
        assert_eq!(collapse(restart(), "postpone", ActionResultKind::RejectedStale), (ResultEffect::Applied, true, false));
        assert_eq!(collapse(restart(), "postpone", ActionResultKind::RejectedInvalid), (ResultEffect::Applied, true, false));
        assert_eq!(collapse(restart_no_postpone(), "ok", ActionResultKind::RejectedStale), (ResultEffect::Applied, true, false));
        // Restart now: the card stays for the terminal state and its linger.
        assert_eq!(collapse(restart(), "restart_now", ActionResultKind::Accepted), (ResultEffect::Applied, true, false));
        // The final card's OK, and a notice's OK, close on prompt_close.
        assert_eq!(collapse(restart_final(), "ok", ActionResultKind::Accepted), (ResultEffect::Applied, true, false));
        assert_eq!(collapse(notice(), "ok", ActionResultKind::Accepted), (ResultEffect::Applied, true, false));
        // A result that matches no action in flight does nothing.
        let b = PromptBridge::with_tracker(PromptTracker::default());
        assert!(rendered(&b.tracker().on_show(NOW, &restart())));
        assert_eq!(
            b.action_result("prompt-nobody", &result("restart:42", "postpone", 1, ActionResultKind::Accepted)),
            ResultEffect::Ignored
        );
        assert!(b.tracker().view("restart:42", NOW).unwrap().card);
    }

    // ----- elevation.request (W07, Task 7.3) -----

    const ELEVATION_ID: &str = "elevation:00000000-0000-4000-8000-0000000000e1";

    /// The first question on Assist (`PromptOnSecureDesktop` = 0, W07
    /// contract): a focused modal decision, Send request (proceed) and Cancel
    /// (safe, the default), 90 s from presentation.
    fn elevation_first_question() -> PromptShow {
        let mut s = elevation();
        s.rev = 1;
        s.state = PromptState::Pending;
        s.presentation = Presentation::Modal;
        s.focus = FocusMode::Steal;
        s.copy = PromptCopy {
            title: "Ask your IT support team for administrator access?".into(),
            body: Some("7-Zip File Manager needs administrator rights.".into()),
            ..PromptCopy::default()
        };
        s.actions =
            vec![spec("send_request", "Send request", ActionRole::Proceed), spec("cancel", "Cancel", ActionRole::Safe)];
        s.default_action_id = Some("cancel".into());
        s.timing = PromptTiming {
            present_within_ms: 10_000,
            deadline_unix_ms: None,
            response_ms: Some(90_000),
            expiry: Some(PromptExpiry { action_id: None, text: "If you don't answer in {remaining}, nothing is sent.".into() }),
        };
        s
    }

    #[test]
    fn advertises_elevation_v1() {
        // W07 appends elevation.request@1 after W06's two kinds (append-only).
        assert_eq!(
            ADVERTISED_PROMPT_KINDS,
            &[
                "notice.info@1",
                "restart.prompt@1",
                "restart.final@1",
                "remote.consent@1",
                "remote.session@1",
                "elevation.request@1",
            ]
        );
        // The production tracker draws the golden waiting card and the first question.
        assert!(rendered(&PromptTracker::default().on_show(NOW, &elevation())));
        assert!(rendered(&PromptTracker::default().on_show(NOW, &elevation_first_question())));
        // Another version is still unadvertised.
        let mut v2 = elevation();
        v2.kind_version = 2;
        assert_eq!(PromptTracker::default().on_show(NOW, &v2), ShowOutcome::RenderFailed(DETAIL_UNADVERTISED_KIND));
    }

    #[test]
    fn elevation_first_question_is_a_focused_modal_and_esc_cancels() {
        let b = PromptBridge::with_tracker(PromptTracker::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        let w = window_of(b.tracker().on_show(NOW, &elevation_first_question()));
        assert_eq!(w.presentation, Presentation::Modal);
        assert!(w.focused, "a modal answering what the user just did may take focus");
        let v = b.tracker().view(ELEVATION_ID, NOW).unwrap();
        assert!(v.decision);
        assert_eq!(v.safe_action_id.as_deref(), Some("cancel"));
        // Esc / the close box answer Cancel, never Send request.
        assert_eq!(b.dismiss(NOW, ELEVATION_ID, ActionVia::Keyboard), Ok(DismissEffect::ActionSent));
        let sent = rx.try_recv().unwrap();
        assert_eq!(sent.payload["actionId"], "cancel");
        // An accepted Cancel does not collapse: the agent moves the prompt on.
        assert_eq!(
            b.action_result(&sent.id, &result(ELEVATION_ID, "cancel", 1, ActionResultKind::Accepted)),
            ResultEffect::Applied
        );
        assert!(rx.try_recv().is_err());
        assert!(b.tracker().view(ELEVATION_ID, NOW).unwrap().card);
    }

    #[test]
    fn elevation_waiting_card_hide_collapses_to_the_list() {
        let b = PromptBridge::with_tracker(PromptTracker::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        let w = window_of(b.tracker().on_show(NOW, &elevation()));
        assert_eq!(w.presentation, Presentation::Card);
        assert!(!w.focused, "the waiting card never takes focus");
        let before = b.tracker().view(ELEVATION_ID, NOW).unwrap();
        assert!(!before.decision, "waiting is not a decision");
        b.act(NOW, ELEVATION_ID, "hide", ActionVia::Click).unwrap();
        let sent = rx.try_recv().unwrap();
        assert_eq!(sent.payload["actionId"], "hide");
        assert_eq!(
            b.action_result(&sent.id, &result(ELEVATION_ID, "hide", 2, ActionResultKind::Accepted)),
            ResultEffect::Collapsed
        );
        let hidden = rx.try_recv().expect("the agent is told the card was hidden");
        assert_eq!(hidden.payload["reason"], "hidden");
        let v = b.tracker().view(ELEVATION_ID, NOW).unwrap();
        assert!(!v.card && !v.closed);
        assert_eq!(v.actions, before.actions, "Cancel request stays reachable from the list");
        assert_eq!(b.tracker().list(NOW).len(), 1);

        // A rejected Hide collapses nothing.
        let b = PromptBridge::with_tracker(PromptTracker::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        assert!(rendered(&b.tracker().on_show(NOW, &elevation())));
        b.act(NOW, ELEVATION_ID, "hide", ActionVia::Click).unwrap();
        let sent = rx.try_recv().unwrap();
        assert_eq!(
            b.action_result(&sent.id, &result(ELEVATION_ID, "hide", 2, ActionResultKind::RejectedStale)),
            ResultEffect::Applied
        );
        assert!(rx.try_recv().is_err());
        assert!(b.tracker().view(ELEVATION_ID, NOW).unwrap().card);
    }

    /// The agent (7B) delivers approved / denied / expired / failed by
    /// re-placing the prompt: `prompt_close{fenced}`, then a new
    /// `prompt_show` at a higher rev on a new lease. A waiting card the
    /// person hid must come back with the outcome: the person sees it.
    #[test]
    fn elevation_outcome_after_hide_resurfaces_as_a_card() {
        for state in [PromptState::Approved, PromptState::Denied, PromptState::Expired, PromptState::Failed] {
            let b = PromptBridge::with_tracker(PromptTracker::default());
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            b.set_sender(tx);
            assert!(rendered(&b.tracker().on_show(NOW, &elevation())));
            b.act(NOW, ELEVATION_ID, "hide", ActionVia::Click).unwrap();
            let sent = rx.try_recv().unwrap();
            assert_eq!(
                b.action_result(&sent.id, &result(ELEVATION_ID, "hide", 2, ActionResultKind::Accepted)),
                ResultEffect::Collapsed
            );
            assert!(!b.tracker().view(ELEVATION_ID, NOW).unwrap().card, "{state:?}: collapsed");
            // Fenced: the collapsed copy is dropped.
            assert_eq!(b.tracker().on_close(NOW, &close(ELEVATION_ID, 2, CloseReason::Fenced)), CloseOutcome::Closed { had_card: false });
            let mut outcome = elevation();
            outcome.rev = 3;
            outcome.lease.epoch = 2;
            outcome.state = state;
            outcome.copy = PromptCopy { title: format!("{state:?}"), ..PromptCopy::default() };
            outcome.actions = vec![];
            outcome.default_action_id = None;
            let w = window_of(b.tracker().on_show(NOW, &outcome));
            assert_eq!(w.presentation, Presentation::Card, "{state:?}");
            assert!(!w.focused, "{state:?}: an outcome never takes focus");
            let v = b.tracker().view(ELEVATION_ID, NOW).unwrap();
            assert!(v.card && !v.closed, "{state:?}: the outcome is on screen");
            assert_eq!(v.state, state);
        }
    }

    #[test]
    fn elevation_cancel_request_accepted_keeps_the_card_and_close_box_hides() {
        let b = PromptBridge::with_tracker(PromptTracker::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        assert!(rendered(&b.tracker().on_show(NOW, &elevation())));
        b.act(NOW, ELEVATION_ID, "cancel_request", ActionVia::Click).unwrap();
        let sent = rx.try_recv().unwrap();
        assert_eq!(
            b.action_result(&sent.id, &result(ELEVATION_ID, "cancel_request", 2, ActionResultKind::Accepted)),
            ResultEffect::Applied,
            "the agent answers with the cancelled state; the card shows it"
        );
        assert!(rx.try_recv().is_err());
        assert!(b.tracker().view(ELEVATION_ID, NOW).unwrap().card);
        // The close box on the waiting card hides it; it never cancels the request.
        assert_eq!(b.dismiss(NOW, ELEVATION_ID, ActionVia::Click), Ok(DismissEffect::Hidden));
        let hidden = rx.try_recv().unwrap();
        assert_eq!(hidden.typ, TYPE_PROMPT_CLOSED);
        assert_eq!(hidden.payload["reason"], "hidden");
    }

    #[test]
    fn elevation_terminal_card_stays_until_the_agent_closes_it() {
        let mut t = PromptTracker::default();
        assert!(rendered(&t.on_show(NOW, &elevation())));
        let mut u = update(ELEVATION_ID, 3);
        u.state = Some(PromptState::Approved);
        u.copy = Some(PromptCopy {
            title: "Request approved".into(),
            body: Some("Approved by Alex at Example IT.".into()),
            ..PromptCopy::default()
        });
        u.actions = Some(vec![]);
        assert_eq!(t.on_update(NOW, &u), UpdateOutcome::Applied { card_open: true });
        // Eight seconds later Assist has not taken it down on its own.
        let v = t.view(ELEVATION_ID, NOW + 8_000).unwrap();
        assert!(v.card && !v.closed);
        assert!(v.actions.is_empty());
        assert_eq!(v.state, PromptState::Approved);
        // The agent's close after its linger takes the card down; the outcome stays listed.
        assert_eq!(
            t.on_close(NOW + 8_000, &close(ELEVATION_ID, 3, CloseReason::Resolved)),
            CloseOutcome::Closed { had_card: true }
        );
        let v = t.view(ELEVATION_ID, NOW + 8_000).unwrap();
        assert!(v.closed && !v.card);
        assert_eq!(t.list(NOW + 8_000).len(), 1);
    }

    #[test]
    fn elevation_first_question_fenced_then_waiting_card_gets_a_card_window() {
        // send_request moves the prompt onto a new lease: the agent fences the
        // modal and shows the waiting card, which stacks bottom-right and does
        // not take focus.
        let mut t = PromptTracker::default();
        let w = window_of(t.on_show(NOW, &elevation_first_question()));
        assert_eq!(w.presentation, Presentation::Modal);
        assert_eq!(t.on_close(NOW, &close(ELEVATION_ID, 1, CloseReason::Fenced)), CloseOutcome::Closed { had_card: true });
        let mut waiting = elevation();
        waiting.lease.epoch = 2;
        let w = window_of(t.on_show(NOW, &waiting));
        assert_eq!(w.presentation, Presentation::Card);
        assert!(!w.focused);
        assert_eq!(t.view(ELEVATION_ID, NOW).unwrap().state, PromptState::Waiting);
    }

    // ----- change notices (W04 event exposure fix) -----

    #[test]
    fn change_notices_carry_only_a_version() {
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &notice())));
        let n: VersionNotice = t.change_notice();
        assert_eq!(serde_json::to_value(n).unwrap(), serde_json::json!({ "version": t.version() }));
        // The identity notice is the same version-only type.
        let _: VersionNotice = t.identity_notice();
    }

    // ----- caller-verify logo bytes (W04, Todd's W03 decision 1) -----

    #[test]
    fn caller_verify_logo_only_for_the_synced_sha() {
        let mut t = tracker();
        let set: PromptBrandingSync = serde_json::from_str(BRANDING_SET).unwrap();
        let sha = set.logo.as_ref().unwrap().sha256.clone();
        // No identity synced: nothing.
        assert_eq!(t.identity_logo_for(&sha), None);
        assert!(t.on_branding_sync(set.clone()));
        let logo = t.identity_logo_for(&sha).expect("the synced logo");
        assert_eq!(logo.mime, set.logo.as_ref().unwrap().mime);
        assert_eq!(logo.data, set.logo.as_ref().unwrap().data);
        // The wire carries the bytes and type only.
        let keys: Vec<String> = serde_json::to_value(&logo).unwrap().as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, vec!["data".to_string(), "mime".to_string()]);
        // Another sha (a stale or another partner's logo) gets nothing.
        assert_eq!(t.identity_logo_for(&"0".repeat(64)), None);
        assert_eq!(t.identity_logo_for(&sha.to_uppercase()), None, "lowercase hex only");
        assert_eq!(t.identity_logo_for(""), None);
        assert_eq!(t.identity_logo_for(&sha[..63]), None);
        // Cleared or disconnected: nothing.
        assert!(t.on_branding_sync(serde_json::from_str(BRANDING_CLEARED).unwrap()));
        assert_eq!(t.identity_logo_for(&sha), None);
        assert!(t.on_branding_sync(set));
        t.on_disconnect();
        assert_eq!(t.identity_logo_for(&sha), None);
    }

    // ----- close and the list -----

    #[test]
    fn close_reasons_decide_whether_the_list_entry_stays() {
        for (reason, kept) in [
            (CloseReason::Resolved, true),
            (CloseReason::Expired, true),
            (CloseReason::Fenced, false),
            (CloseReason::Withdrawn, false),
            (CloseReason::Superseded, false),
        ] {
            let mut t = tracker();
            assert!(rendered(&t.on_show(NOW, &notice())));
            assert_eq!(t.list(NOW).len(), 1);
            let id = notice().prompt_id;
            assert_eq!(t.on_close(NOW, &close(&id, 2, reason)), CloseOutcome::Closed { had_card: true }, "{reason:?}");
            let list = t.list(NOW);
            assert_eq!(list.len(), usize::from(kept), "{reason:?}");
            if kept {
                assert!(list[0].closed);
                assert!(!list[0].card);
                // A closed entry takes no action.
                assert_eq!(t.action(NOW, &id, "ok", ActionVia::List), Err(ActionRefusal::Closed));
            }
        }
        // A non-persistent prompt leaves nothing behind once resolved.
        let mut t = tracker();
        let mut s = notice();
        s.list_entry.persistent = false;
        assert!(rendered(&t.on_show(NOW, &s)));
        t.on_close(NOW, &close(&s.prompt_id, 2, CloseReason::Resolved));
        assert!(t.list(NOW).is_empty());
    }

    #[test]
    fn list_entries_expire_at_expires_at() {
        let mut t = tracker();
        let s = notice();
        let exp = s.list_entry.expires_at_unix_ms.unwrap();
        assert!(rendered(&t.on_show(NOW, &s)));
        t.on_close(NOW, &close(&s.prompt_id, 2, CloseReason::Resolved));
        assert_eq!(t.list(exp - 1).len(), 1);
        assert_eq!(t.expire_due(exp - 1), ExpireReport::default());
        let report = t.expire_due(exp);
        assert!(report.list_changed);
        assert!(t.list(exp).is_empty());
        assert_eq!(t.expire_due(exp + 1), ExpireReport::default());
    }

    #[test]
    fn untracked_close_is_ignored_but_remembered() {
        let mut t = tracker();
        assert_eq!(t.on_close(NOW, &close("restart:42", 5, CloseReason::Resolved)), CloseOutcome::Untracked);
        let mut s = restart();
        s.rev = 5;
        assert_eq!(t.on_show(NOW, &s), ShowOutcome::DropStale);
        s.rev = 6;
        assert!(rendered(&t.on_show(NOW, &s)));
    }

    // ----- actions -----

    #[test]
    fn action_frame_echoes_rev_and_lease() {
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &restart())));
        let f = t.action(NOW, "restart:42", "postpone", ActionVia::Click).unwrap();
        assert_eq!(f.typ, TYPE_PROMPT_ACTION);
        assert_eq!(f.payload, canonical(ACTION));
        assert!(f.id.starts_with("prompt-"));
        assert_eq!(t.view("restart:42", NOW).unwrap().pending_action_id.as_deref(), Some("postpone"));
        // An action the prompt does not offer is refused.
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &restart())));
        assert_eq!(t.action(NOW, "restart:42", "format_disk", ActionVia::Click), Err(ActionRefusal::InvalidAction));
        assert_eq!(t.action(NOW, "restart:9", "postpone", ActionVia::Click), Err(ActionRefusal::UnknownPrompt));
    }

    #[test]
    fn one_action_in_flight_until_its_result() {
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &restart())));
        let sent = t.action(NOW, "restart:42", "postpone", ActionVia::Click).unwrap();
        assert_eq!(t.action(NOW, "restart:42", "restart_now", ActionVia::Click), Err(ActionRefusal::Pending));
        // A result for another action does not release it.
        let mut other: PromptActionResult = serde_json::from_str(RESULT_STALE).unwrap();
        other.action_id = "something_else".into();
        assert!(!t.on_action_result(&sent.id, &other));
        assert_eq!(t.action(NOW, "restart:42", "restart_now", ActionVia::Click), Err(ActionRefusal::Pending));
        // Its own result does.
        let accepted: PromptActionResult = serde_json::from_str(RESULT_ACCEPTED).unwrap();
        assert!(t.on_action_result(&sent.id, &accepted));
        let v = t.view("restart:42", NOW).unwrap();
        assert_eq!(v.pending_action_id, None);
        assert_eq!(v.last_outcome, Some("accepted"));
        assert!(t.action(NOW, "restart:42", "restart_now", ActionVia::Click).is_ok());
    }

    /// The result's rev is information, not an applied state: the update that
    /// carries the same rev must still apply.
    #[test]
    fn action_result_does_not_advance_the_applied_rev() {
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &restart())));
        let sent = t.action(NOW, "restart:42", "postpone", ActionVia::Click).unwrap();
        let accepted: PromptActionResult = serde_json::from_str(RESULT_ACCEPTED).unwrap();
        assert!(t.on_action_result(&sent.id, &accepted));
        assert_eq!(t.on_update(NOW, &update("restart:42", accepted.rev)), UpdateOutcome::Applied { card_open: true });
    }

    /// `prompt_action_result` is the reply on the `prompt_action` envelope: a
    /// result on any other envelope (an earlier action, another session) never
    /// releases the action in flight.
    #[test]
    fn action_result_matches_only_its_own_envelope() {
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &restart())));
        let first = t.action(NOW, "restart:42", "postpone", ActionVia::Click).unwrap();
        let accepted: PromptActionResult = serde_json::from_str(RESULT_ACCEPTED).unwrap();
        assert!(!t.on_action_result("prompt-someone-else", &accepted));
        assert_eq!(t.view("restart:42", NOW).unwrap().pending_action_id.as_deref(), Some("postpone"));
        assert!(t.on_action_result(&first.id, &accepted));
        // A duplicate of that result, after a second click, does not release the second.
        let second = t.action(NOW, "restart:42", "postpone", ActionVia::Click).unwrap();
        assert_ne!(first.id, second.id);
        assert!(!t.on_action_result(&first.id, &accepted));
        assert_eq!(t.view("restart:42", NOW).unwrap().pending_action_id.as_deref(), Some("postpone"));
    }

    /// Every change bumps the view version, so a window can tell a fetched
    /// snapshot from a newer pushed update (subscribe first, then fetch).
    #[test]
    fn view_version_increases_with_every_change() {
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &restart())));
        let v1 = t.view("restart:42", NOW).unwrap().version;
        let sent = t.action(NOW, "restart:42", "postpone", ActionVia::Click).unwrap();
        let v2 = t.view("restart:42", NOW).unwrap().version;
        assert!(v2 > v1);
        let accepted: PromptActionResult = serde_json::from_str(RESULT_ACCEPTED).unwrap();
        assert!(t.on_action_result(&sent.id, &accepted));
        let v3 = t.view("restart:42", NOW).unwrap().version;
        assert!(v3 > v2);
        t.note_error("restart:42", "x");
        let version = t.version();
        assert!(version > v3);
        let list = t.list(NOW);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].version, version);
        // Reading never bumps it.
        assert_eq!(t.view("restart:42", NOW).unwrap().version, version);
        assert_eq!(t.version(), version);
    }

    #[test]
    fn a_stuck_action_is_released_after_the_timeout() {
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &restart())));
        t.action(NOW, "restart:42", "postpone", ActionVia::Click).unwrap();
        assert_eq!(t.expire_due(NOW + ACTION_RESULT_TIMEOUT_MS - 1), ExpireReport::default());
        let report = t.expire_due(NOW + ACTION_RESULT_TIMEOUT_MS);
        assert_eq!(report.views, vec!["restart:42".to_string()]);
        let v = t.view("restart:42", NOW).unwrap();
        assert_eq!(v.pending_action_id, None);
        assert_eq!(v.last_outcome, Some("timed_out"));
        assert!(t.action(NOW, "restart:42", "postpone", ActionVia::Click).is_ok());
    }

    #[test]
    fn no_replay_of_unacked_action_after_disconnect() {
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &restart())));
        let dropped = t.action(NOW, "restart:42", "postpone", ActionVia::Click).unwrap();
        // The session drops with the action unacknowledged.
        assert_eq!(t.on_disconnect(), vec!["restart:42".to_string()]);
        assert!(t.view("restart:42", NOW).is_none(), "nothing survives the session");
        assert!(t.list(NOW).is_empty());
        // Nothing is waiting to be re-sent: the tick produces nothing...
        assert_eq!(t.expire_due(NOW + ACTION_RESULT_TIMEOUT_MS * 2), ExpireReport::default());
        // ...the agent's replay renders the current state without any action...
        let mut replay = restart();
        replay.lease = PromptLease { renderer_session: "assist-user-4243".into(), epoch: 2 };
        assert!(rendered(&t.on_show(NOW, &replay)), "the replay at the same rev is accepted on the new session");
        let v = t.view("restart:42", NOW).unwrap();
        assert_eq!(v.pending_action_id, None);
        // ...and the person acts again, on the new lease.
        let f = t.action(NOW, "restart:42", "postpone", ActionVia::Click).unwrap();
        assert_eq!(f.payload["lease"]["epoch"], 2);
        assert_eq!(f.payload["lease"]["rendererSession"], "assist-user-4243");
        // A late result for the dropped action (its own envelope) does not
        // release the new one, even with the same action id...
        let accepted: PromptActionResult = serde_json::from_str(RESULT_ACCEPTED).unwrap();
        assert!(!t.on_action_result(&dropped.id, &accepted));
        assert_eq!(t.view("restart:42", NOW).unwrap().pending_action_id.as_deref(), Some("postpone"));
        // ...only the new action's own result does.
        assert!(t.on_action_result(&f.id, &accepted));
        assert_eq!(t.view("restart:42", NOW).unwrap().pending_action_id, None);
    }

    #[test]
    fn dismiss_maps_to_safe_action_on_pending_decision_and_hide_otherwise() {
        // Pending decision: Esc / close box = the safe action, never hide.
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &restart())));
        match t.dismiss(NOW, "restart:42", ActionVia::Keyboard) {
            Dismiss::Action(f) => {
                assert_eq!(f.payload["actionId"], "postpone");
                assert_eq!(f.payload["via"], "keyboard");
            }
            other => panic!("{other:?}"),
        }
        assert!(t.view("restart:42", NOW).unwrap().card, "the decision card stays up");
        // Anything else: hide, reported as prompt_closed{hidden}; the entry stays.
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &elevation())));
        let id = elevation().prompt_id;
        match t.dismiss(NOW, &id, ActionVia::Keyboard) {
            Dismiss::Hidden(f) => {
                assert_eq!(f.typ, TYPE_PROMPT_CLOSED);
                assert_eq!(f.payload["reason"], "hidden");
                assert_eq!(f.payload["rev"], 2);
                assert!(f.payload.get("detail").is_none());
            }
            other => panic!("{other:?}"),
        }
        let v = t.view(&id, NOW).unwrap();
        assert!(!v.card);
        assert_eq!(t.list(NOW).len(), 1, "hiding is never a domain action");
        assert_eq!(t.dismiss(NOW, &id, ActionVia::Keyboard), Dismiss::Nothing);
        // The hidden prompt is still actionable from the list.
        assert!(t.action(NOW, &id, "cancel_request", ActionVia::List).is_ok());
    }

    #[test]
    fn os_destroying_a_card_reports_it_and_fails_a_decision_closed() {
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &elevation())));
        let id = elevation().prompt_id;
        let f = t.window_gone(&id).expect("hidden frame");
        assert_eq!(f.payload["reason"], "hidden");
        assert_eq!(t.window_gone(&id), None, "once");
        // A pending decision whose window vanished cannot be answered: render_failed.
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &restart())));
        let f = t.window_gone("restart:42").expect("render_failed frame");
        assert_eq!(f.payload["reason"], "render_failed");
        assert_eq!(f.payload["detail"], DETAIL_WINDOW_FAILED);
        assert!(t.view("restart:42", NOW).is_none());
        // Windows the tracker closed itself are not reported again.
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &notice())));
        t.on_close(NOW, &close(&notice().prompt_id, 2, CloseReason::Withdrawn));
        assert_eq!(t.window_gone(&notice().prompt_id), None);
    }

    #[test]
    fn countdown_deadline_comes_from_timing() {
        let mut t = tracker();
        assert!(rendered(&t.on_show(NOW, &restart())));
        assert_eq!(t.view("restart:42", NOW).unwrap().countdown_deadline_unix_ms, Some(1_793_019_600_000));
        let mut s = with_id(notice(), "consent:n1");
        s.kind = "remote.consent".into();
        s.timing.response_ms = Some(30_000);
        assert!(rendered(&t.on_show(NOW, &s)));
        // A replay never restarts a responseMs window.
        let mut again = s.clone();
        again.rev = 2;
        assert!(matches!(t.on_show(NOW + 5_000, &again), ShowOutcome::Replace { .. }));
        assert_eq!(t.view("consent:n1", NOW).unwrap().countdown_deadline_unix_ms, Some(NOW + 30_000));
    }

    // ----- branding -----

    #[test]
    fn branding_sync_is_stored_in_memory_only() {
        let mut t = tracker();
        assert!(t.identity().is_none());
        let set: PromptBrandingSync = serde_json::from_str(BRANDING_SET).unwrap();
        assert!(t.on_branding_sync(set.clone()));
        assert_eq!(t.identity(), Some(&set));
        // An identity without a scope or name is ignored (the previous one stays).
        let mut bad = set.clone();
        bad.scope_id = None;
        assert!(!t.on_branding_sync(bad));
        assert_eq!(t.identity(), Some(&set));
        t.on_disconnect();
        assert!(t.identity().is_none());
        assert_eq!(t.identity_view().state, "none");
        // The tray keeps the last synced language across a reconnect.
        assert_eq!(t.chrome_locale(), Some("de-DE"));
    }

    #[test]
    fn branding_sync_cleared_drops_identity() {
        let mut t = tracker();
        assert_eq!(t.chrome_locale(), None);
        let set: PromptBrandingSync = serde_json::from_str(BRANDING_SET).unwrap();
        assert!(t.on_branding_sync(set));
        let view = t.identity_view();
        assert_eq!(view.state, "set");
        assert_eq!(view.partner_name.as_deref(), Some("Example IT Services"));
        assert_eq!(view.primary_color.as_deref(), Some("#1F5FAD"));
        assert_eq!(view.logo.as_ref().map(|l| l.mime.as_str()), Some("image/png"));
        assert_eq!(view.locale.as_deref(), Some("de-DE"));

        let cleared: PromptBrandingSync = serde_json::from_str(BRANDING_CLEARED).unwrap();
        assert!(t.on_branding_sync(cleared));
        assert!(t.identity().is_none(), "cleared drops the identity");
        let view = t.identity_view();
        assert_eq!(view.state, "none");
        assert!(view.partner_name.is_none() && view.primary_color.is_none() && view.logo.is_none());
        // ...but its locale still drives the chrome.
        assert_eq!(view.locale.as_deref(), Some("en"));
        assert_eq!(t.chrome_locale(), Some("en"));
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["state"], "none");
        assert!(json["version"].as_u64().unwrap() > 0);
    }

    // ----- decoding -----

    #[test]
    fn decode_addresses_a_refusal_when_only_the_reference_is_valid() {
        match decode::<PromptShow>(Some(SHOW_NOTICE)) {
            Decoded::Ok(s) => assert_eq!(s, notice()),
            other => panic!("{other:?}"),
        }
        let mut v = canonical(SHOW_NOTICE);
        v["state"] = serde_json::json!("pondering");
        match decode::<PromptShow>(Some(&v.to_string())) {
            Decoded::Malformed(r) => assert_eq!(r, notice().reference()),
            other => panic!("{other:?}"),
        }
        let mut v = canonical(SHOW_NOTICE);
        v["promptId"] = serde_json::json!("not an id");
        assert_eq!(decode::<PromptShow>(Some(&v.to_string())), Decoded::Unaddressable);
        assert_eq!(decode::<PromptShow>(None), Decoded::Unaddressable);
        assert_eq!(decode::<PromptShow>(Some("[1,2]")), Decoded::Unaddressable);
    }

    // ----- window identity -----

    #[test]
    fn window_label_is_prompt_dash_first_8_hex_of_sha256() {
        use sha2::{Digest, Sha256};
        let id = "restart:42";
        let want = format!("prompt-{}", &hex::encode(Sha256::digest(id.as_bytes()))[..8]);
        assert_eq!(window_label(id), want);
        assert_eq!(window_label(id).len(), "prompt-".len() + 8);
        assert!(label_matches(&want, id));
        assert!(!label_matches(&want, "restart:43"));
        assert!(!label_matches("main", id));
    }

    #[test]
    fn prompt_windows_are_refused_privileged_commands() {
        assert!(deny_prompt_window(&window_label("restart:42")).is_err());
        assert!(deny_prompt_window("main").is_ok());
        assert!(crate::ipc::message::deny_message_window(&window_label("restart:42")).is_err());
        assert!(crate::ipc::message::deny_message_window("main").is_ok());
    }

    #[test]
    fn bridge_sends_only_while_a_session_is_live() {
        let b = PromptBridge::default();
        {
            let mut t = b.tracker();
            *t = tracker();
            assert!(rendered(&t.on_show(NOW, &restart())));
        }
        assert_eq!(b.act(NOW, "restart:42", "postpone", ActionVia::Click), Err(NOT_CONNECTED.to_string()));
        // The failed send did not leave the action pending.
        assert_eq!(b.tracker().view("restart:42", NOW).unwrap().pending_action_id, None);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        assert_eq!(b.act(NOW, "restart:42", "postpone", ActionVia::Click), Ok(()));
        assert_eq!(rx.try_recv().unwrap().typ, TYPE_PROMPT_ACTION);
        b.clear_sender();
        assert!(b.act(NOW, "restart:42", "restart_now", ActionVia::Click).is_err());
    }

    fn bridge_with(show: &PromptShow) -> PromptBridge {
        let b = PromptBridge::with_tracker(tracker());
        assert!(rendered(&b.tracker().on_show(NOW, show)));
        b
    }

    /// The close box on a decision whose safe action cannot be sent (no live
    /// session, or an action already in flight) keeps the card and says why on
    /// it; the refusal is never silent.
    #[test]
    fn bridge_records_why_a_close_box_could_not_act() {
        let b = bridge_with(&restart());
        assert_eq!(b.dismiss(NOW, "restart:42", ActionVia::Click), Err(NOT_CONNECTED.to_string()));
        let v = b.tracker().view("restart:42", NOW).unwrap();
        assert_eq!(v.last_error.as_deref(), Some(NOT_CONNECTED));
        assert_eq!(v.pending_action_id, None);
        assert!(v.card, "a decision keeps its card");

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        assert_eq!(b.dismiss(NOW, "restart:42", ActionVia::Click), Ok(DismissEffect::ActionSent));
        let sent = rx.try_recv().unwrap();
        assert_eq!(sent.payload["actionId"], "postpone");
        assert_eq!(sent.payload["via"], "click");
        let v = b.tracker().view("restart:42", NOW).unwrap();
        assert_eq!(v.last_error, None, "a sent action clears the old notice");
        // Pressed again while that action is in flight: refused, recorded, nothing sent.
        assert_eq!(b.dismiss(NOW, "restart:42", ActionVia::Click), Err(ActionRefusal::Pending.message().to_string()));
        assert_eq!(b.tracker().view("restart:42", NOW).unwrap().last_error.as_deref(), Some(ActionRefusal::Pending.message()));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn bridge_window_gone_reports_a_lost_decision_once() {
        let b = bridge_with(&restart());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        b.window_gone("restart:42");
        let f = rx.try_recv().expect("a frame for the lost decision");
        assert_eq!(f.typ, TYPE_PROMPT_CLOSED);
        assert_eq!(f.payload["reason"], "render_failed");
        assert_eq!(f.payload["detail"], DETAIL_WINDOW_FAILED);
        assert_eq!(f.payload["promptId"], "restart:42");
        b.window_gone("restart:42");
        assert!(rx.try_recv().is_err(), "reported once");
        // A non-decision card that vanished is reported hidden.
        let b = bridge_with(&elevation());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        b.window_gone(&elevation().prompt_id);
        assert_eq!(rx.try_recv().unwrap().payload["reason"], "hidden");
    }

    /// A frame queued on one session's channel is never written to the next:
    /// each session has its own channel, and the pending action is dropped.
    #[test]
    fn bridge_never_hands_a_queued_action_to_the_next_session() {
        let b = bridge_with(&restart());
        let (tx1, mut rx1) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx1);
        assert_eq!(b.act(NOW, "restart:42", "postpone", ActionVia::Click), Ok(()));
        // Session 1 ends before writing it.
        b.clear_sender();
        b.tracker().on_disconnect();
        let (tx2, mut rx2) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx2);
        assert!(rx2.try_recv().is_err(), "nothing carried over to session 2");
        assert!(b.tracker().view("restart:42", NOW).is_none());
        // Session 1's channel still holds only its own frame, and it dies with it.
        assert_eq!(rx1.try_recv().unwrap().typ, TYPE_PROMPT_ACTION);
    }

    #[test]
    fn module_keeps_no_durable_state() {
        let prod = include_str!("prompt.rs").split("\nmod tests {").next().unwrap();
        assert!(!prod.contains("std::fs"));
        assert!(!prod.contains("File::"));
    }

    // ----- W03 review: identity wire, logo integrity, notifier -----

    /// The PNG in branding_sync.set.json, with a logo whose fields are edited.
    fn with_logo(edit: impl FnOnce(&mut PromptLogo)) -> PromptBrandingSync {
        let mut b: PromptBrandingSync = serde_json::from_str(BRANDING_SET).unwrap();
        edit(b.logo.as_mut().unwrap());
        b
    }

    #[test]
    fn branding_logo_must_match_its_declared_bytes_and_sha256() {
        let mut t = tracker();
        assert!(t.on_branding_sync(with_logo(|_| {})), "the fixture's logo is consistent");
        assert!(!t.on_branding_sync(with_logo(|l| l.bytes += 1)), "declared bytes != decoded length");
        assert!(!t.on_branding_sync(with_logo(|l| l.sha256 = "0".repeat(64))), "sha256 of the bytes differs");
        assert!(!t.on_branding_sync(with_logo(|l| l.data = "not base64!!".into())), "not base64");
        assert!(!t.on_branding_sync(with_logo(|l| l.data = "https://example.invalid/logo.png".into())));
        // The consistent identity is still the stored one.
        assert_eq!(t.identity().and_then(|b| b.logo.as_ref()).map(|l| l.bytes), Some(69));
    }

    #[test]
    fn identity_notice_carries_no_identity() {
        let notice = PromptIdentityNotice { version: 7 };
        assert_eq!(serde_json::to_value(notice).unwrap(), serde_json::json!({ "version": 7 }));
    }

    /// The keys of a TS `interface <name> { ... }` block (one `key:` per line).
    fn ts_interface_keys(src: &str, name: &str) -> std::collections::BTreeSet<String> {
        let start = src.find(&format!("export interface {name} {{")).unwrap_or_else(|| panic!("{name}"));
        let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
        body.lines()
            .skip(1)
            .map(str::trim)
            .filter(|l| !l.starts_with("/") && !l.starts_with("*"))
            .filter_map(|l| l.split_once(':').map(|(k, _)| k.trim_end_matches('?').to_string()))
            .filter(|k| k.chars().all(|c| c.is_ascii_alphanumeric()))
            .collect()
    }

    #[test]
    fn identity_view_wire_keys_match_the_ts_contract() {
        let mut t = tracker();
        assert!(t.on_branding_sync(serde_json::from_str(BRANDING_SET).unwrap()));
        let json = serde_json::to_value(t.identity_view()).unwrap();
        let keys: std::collections::BTreeSet<String> = json.as_object().unwrap().keys().cloned().collect();
        let ts = include_str!("../../../src/prompt/identity.ts");
        assert_eq!(keys, ts_interface_keys(ts, "PromptIdentityWire"), "PromptIdentityView vs identity.ts");
        let logo: std::collections::BTreeSet<String> = json["logo"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(logo, ts_interface_keys(ts, "PromptIdentityWireLogo"));
        assert_eq!(json["state"], "set");
        let notice: std::collections::BTreeSet<String> = serde_json::to_value(PromptIdentityNotice { version: 1 })
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(notice, ts_interface_keys(ts, "PromptIdentityNotice"));
    }

    #[test]
    fn bridge_notifies_identity_on_sync_and_on_disconnect_only_when_held() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let bridge = PromptBridge::default();
        let n = Arc::new(AtomicUsize::new(0));
        let c = n.clone();
        bridge.set_identity_notifier(move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        // Nothing held: a disconnect publishes nothing.
        bridge.disconnect();
        assert_eq!(n.load(Ordering::SeqCst), 0);
        // An invalid sync changes nothing and publishes nothing.
        let mut bad: PromptBrandingSync = serde_json::from_str(BRANDING_SET).unwrap();
        bad.scope_id = None;
        assert!(!bridge.branding_sync(bad));
        assert_eq!(n.load(Ordering::SeqCst), 0);
        assert!(bridge.branding_sync(serde_json::from_str(BRANDING_SET).unwrap()));
        assert_eq!(n.load(Ordering::SeqCst), 1);
        // The session ends: the held identity is dropped and the windows told.
        bridge.disconnect();
        assert_eq!(n.load(Ordering::SeqCst), 2);
        assert!(bridge.tracker().identity().is_none());
        // A cleared sync is a change too (the header falls back to generic).
        assert!(bridge.branding_sync(serde_json::from_str(BRANDING_CLEARED).unwrap()));
        assert_eq!(n.load(Ordering::SeqCst), 3);
    }
}
