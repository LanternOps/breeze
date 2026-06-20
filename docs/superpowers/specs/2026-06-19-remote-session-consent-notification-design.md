# Remote Session Consent & End-User Notification — Design

**Date:** 2026-06-19
**Status:** Design (pending review)
**Author:** Todd Hebebrand (with Claude)

## 1. Problem & motivation

When a technician starts a remote desktop session, the person sitting at the
managed device today gets **no indication whatsoever**. There is no "Technician
X connected" notice, no "X is viewing your screen" indicator, and no way for the
end user to consent to (or refuse) the connection. This is a privacy/consent gap
that most mature RMMs close, and several compliance regimes effectively require.

This design adds three end-user-facing surfaces, all policy-configurable:

1. A **start notification** ("Jordan Lee connected to your computer").
2. An optional **consent prompt** — the end user can Allow or Deny before the
   technician's view begins.
3. A **persistent active-session indicator** (a thin top-center pill) shown for
   the whole session, plus a **session-ended notice** when the technician
   disconnects.

## 2. Decisions (locked with product owner)

| Decision | Choice |
|---|---|
| Configurability | Per-policy, three modes: `off` / `notify` / `consent` |
| Default mode | **`notify`** (privacy-forward; on by default at the notice level) |
| Consent fallback (when the user can't be asked) | **Its own policy toggle** `consent_unavailable_behavior`: `proceed` (default) / `block` |
| v1 scope beyond start prompt | **Session-ended notice + persistent active indicator** |
| Active indicator form | **Thin top-center pill, indicator-only** (no end-user "End" button in v1) |
| Technician identity shown | **Per-policy** `technician_identity_level`: `name_email` (default) / `name` / `generic` |

## 3. Hard architectural constraints (from the code)

- **The agent cannot draw UI.** It runs as SYSTEM / session 0. Every end-user
  surface is rendered by the **Breeze Helper** (Tauri) over IPC
  (`agent/internal/heartbeat/handlers_user.go:24` — fails with "no user helper
  connected" when absent). There is **no native-OS fallback**. Consequence: both
  the notice and the consent prompt require the Helper installed and a user
  logged in. "No Helper / no logged-in user" is the `consent_unavailable_behavior`
  case.
- **Technician identity is not currently sent to the agent.** `start_desktop` and
  the agent→Helper `DesktopStartRequest` carry only `sessionId` + `offer`
  (`agent/internal/heartbeat/handlers_desktop.go:141`, `agent/internal/ipc/message.go:257`).
  Identity lives in the API (`remoteSessions.userId → users`). We extend the
  contract to carry a **server-resolved display string** — the agent/Helper never
  query `users` or the policy (keeps PII handling and tenant isolation on the API).
- **The `remote_access` config-policy feature type already exists**
  (`apps/api/src/db/schema/configurationPolicies.ts:43`) but has no settings
  table. We add one.
- **In service mode the Helper is already the capture host** for a desktop
  session (the agent routes `DesktopStartRequest` to it), so the Helper already
  knows precisely when a session starts and ends — the natural home for all three
  surfaces with no new lifecycle plumbing.

## 4. Authority model

The **API is authoritative**. At session-creation time it:

1. Resolves the effective `remote_access` policy for the target device.
2. Resolves the technician display string per `technician_identity_level`.
3. Stamps the resolved values directly into the `start_desktop` command payload.

The agent and Helper are "dumb renderers" — they display what they're given and
report the consent verdict back. This avoids races between config sync and
session start, keeps policy resolution in one place, and keeps PII redaction
server-side.

## 5. Policy model

New table `config_policy_remote_access_settings`, hung off the existing
`remote_access` feature link (mirrors `config_policy_monitoring_settings`):

```ts
export const configPolicyRemoteAccessSettings = pgTable(
  'config_policy_remote_access_settings',
  {
    featureLinkId: uuid('feature_link_id').notNull().unique()
      .references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
    sessionPromptMode: text('session_prompt_mode').notNull().default('notify'),
      // 'off' | 'notify' | 'consent'
    consentUnavailableBehavior: text('consent_unavailable_behavior')
      .notNull().default('proceed'),               // 'proceed' | 'block'
    notifyOnSessionEnd: boolean('notify_on_session_end').notNull().default(true),
    showActiveIndicator: boolean('show_active_indicator').notNull().default(true),
    technicianIdentityLevel: text('technician_identity_level')
      .notNull().default('name_email'),            // 'name_email' | 'name' | 'generic'
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
);
```

**Effective-config resolution:** when no `remote_access` policy applies to a
device, the system default is `sessionPromptMode = 'notify'` (per the locked
default). See the rollout note (§12) — this is an intentional behavior change on
upgrade.

**RLS (READ `CLAUDE.md` tenancy section first):** this table is tenant-scoped via
the feature-link → policy chain. It MUST follow `config_policy_monitoring_settings`'s
RLS shape **exactly**:
- Enable + force RLS and add policies **in the same migration** that creates the table.
- Add it to the matching allowlist in
  `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` in the same PR.
- Add a functional `breeze_app` forge test (cross-tenant insert must fail) — the
  coverage contract test alone does not prove a second-axis or join policy works
  (see the dual-axis / FK-child blindspots in project memory).
- Add to the org-cascade delete order in `tenantCascade.ts` if the shape requires it.

## 6. Contract changes

### 6.1 `start_desktop` heartbeat command (API → agent)
Add a resolved `prompt` object:
```jsonc
{
  "sessionId": "…",
  "offer": "…",
  "prompt": {
    "mode": "notify",                  // off | notify | consent
    "technicianDisplay": {
      "name": "Jordan Lee",            // null in generic mode
      "email": "jordan@acme-msp.com",  // null unless name_email
      "orgName": "Acme MSP"            // optional context line
    },
    "consentUnavailableBehavior": "proceed",
    "consentTimeoutMs": 30000,          // system constant (30s) in v1, not policy-configurable
    "notifyOnEnd": true,
    "showIndicator": true
  }
}
```

### 6.2 Agent → Helper `DesktopStartRequest` (`ipc/message.go`)
Carry the same `prompt` block through to the Helper. The Helper's desktop-start
**response** gains a consent verdict:
```jsonc
{ "consent": { "decision": "allow|deny|bypass", "reason": "user|timeout|no_user|helper_absent|policy_proceed" } }
```

### 6.3 New session terminal state `denied`
The API `remoteSessions` status gains `denied`. The web viewer handles it by
showing "The user denied the connection." (closes the technician's pending-answer
wait instead of timing out).

### 6.4 Audit events (API, on receiving the verdict)
Extends the existing `session_connected` audit log:
- `session_consent_granted` (reason `user`)
- `session_consent_denied` (reason `user` | `timeout`)
- `session_consent_bypassed` (reason `no_user` | `helper_absent` | `policy_proceed`)

## 7. Runtime flows

### Notify-only (`mode: notify`)
API stamps payload → agent starts session → Helper fires a fire-and-forget OS
notification and (if `showIndicator`) shows the pill → streaming proceeds
unconditionally → on end, Helper fires the ended notice (if `notifyOnEnd`) and
removes the pill.

### Consent (`mode: consent`)
Consent gate sits **before** the agent answers the WebRTC offer (ahead of
`startStreaming()` in `agent/internal/remote/desktop/session_stream.go`):
- **Helper present + user logged in:** Helper shows the Allow/Deny dialog.
  - **Allow** → agent proceeds normally.
  - **Deny** → agent never answers; reports `denied` → web viewer shows the deny
    message; audit `session_consent_denied`.
  - **Timeout (no response):** apply `consent_unavailable_behavior`
    (proceed → connect; block → deny). Explicit Deny always blocks; only
    no-response follows the fallback.
- **Cannot ask** (no logged-in user / Helper absent): apply
  `consent_unavailable_behavior`; audit `session_consent_bypassed` with reason.

### Decision matrix (consent mode)
| Situation | `proceed` fallback | `block` fallback |
|---|---|---|
| User allows | connect | connect |
| User denies | **block** | **block** |
| User doesn't respond (timeout) | connect | block |
| No logged-in user (unattended) | connect | block |
| Helper not installed/connected | connect | block |

## 8. Agent changes

- Thread the `prompt` block from `start_desktop` through to `DesktopStartRequest`.
- In `consent` mode, gate before `startStreaming()`:
  - Use the existing Helper request/response (`SendCommandAndWait`) to request the
    verdict with a timeout = `consentTimeoutMs` (+ small buffer).
  - On `deny`/`block`, tear down the nascent session and emit the `denied` status
    back to the API without answering the offer.
- In `notify` mode, send a fire-and-forget notify command at session start and an
  ended notice at teardown (gated by `notifyOnEnd`).
- Always send banner show/hide commands when `showIndicator` is set.
- **Unattended / login-screen:** no Helper user session → treat as "cannot ask";
  notify-only silently no-ops (nobody to notify).

## 9. Helper UI (impeccable design)

The Helper uses plain CSS variables on a dark-only theme
(`apps/helper/src/styles.css`). Both surfaces are **new dedicated always-on-top
Tauri windows** (created in Rust on demand, destroyed when done) — not overlays
in the hidden-to-tray main window. They reuse the Helper's existing tokens and
mirror `ToolApprovalPopup`.

### 9.1 Consent dialog — `consent` window (380×~300, centered, frameless, always-on-top, focused)

Re-themes the yellow tool-approval palette onto the blue `--accent` for a calmer
"request" tone. **Default focus = Deny, Esc = Deny** — a privacy prompt must never
let a stray Enter grant access. Countdown text is fallback-aware and turns warning
color in the final 5s. Identity level drives which lines render.

```tsx
// apps/helper/src/windows/ConsentDialog.tsx
import { useEffect, useRef, useState } from "react";

export interface ConsentRequest {
  sessionId: string;
  technicianName: string | null;   // null => "A technician"
  technicianEmail: string | null;  // null => omit line
  orgName: string | null;
  timeoutMs: number;
  onTimeout: "proceed" | "block";
}

export function ConsentDialog({
  req, onDecision,
}: { req: ConsentRequest; onDecision: (allow: boolean, reason: "user" | "timeout") => void }) {
  const [remainingMs, setRemainingMs] = useState(req.timeoutMs);
  const denyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => denyRef.current?.focus(), []);

  useEffect(() => {
    const started = performance.now();
    const id = window.setInterval(() => {
      const left = req.timeoutMs - (performance.now() - started);
      if (left <= 0) { window.clearInterval(id); setRemainingMs(0); onDecision(req.onTimeout === "proceed", "timeout"); }
      else setRemainingMs(left);
    }, 200);
    return () => window.clearInterval(id);
  }, [req, onDecision]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDecision(false, "user"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDecision]);

  const secs = Math.ceil(remainingMs / 1000);
  const countdown = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const urgent = secs <= 5;
  const label = req.onTimeout === "proceed"
    ? `Connecting automatically in ${countdown}`
    : `Declining automatically in ${countdown}`;
  const name = req.technicianName ?? "A technician";
  const initials = req.technicianName
    ? req.technicianName.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()
    : "◐";

  return (
    <div className="helper-consent-overlay" role="alertdialog"
         aria-labelledby="consent-title" aria-describedby="consent-body">
      <div className="helper-consent-card">
        <div className="helper-consent-header">
          <span className="helper-consent-icon" aria-hidden>▣</span>
          <span id="consent-title" className="helper-consent-title">Remote support request</span>
        </div>
        <div className="helper-consent-body">
          <div className="helper-consent-identity">
            <span className="helper-consent-avatar" aria-hidden>{initials}</span>
            <div className="helper-consent-who">
              <span className="helper-consent-name">{name}</span>
              {req.technicianEmail && <span className="helper-consent-email">{req.technicianEmail}</span>}
            </div>
          </div>
          <p id="consent-body" className="helper-consent-desc">
            wants to start a remote session on this computer.
          </p>
          {req.orgName && <div className="helper-consent-meta">{req.orgName} · requested just now</div>}
        </div>
        <div className="helper-consent-footer">
          <span className={`helper-consent-countdown${urgent ? " is-urgent" : ""}`}>{label}</span>
          <div className="helper-consent-actions">
            <button ref={denyRef} className="helper-btn helper-btn-deny"
                    onClick={() => onDecision(false, "user")}>Deny</button>
            <button className="helper-btn helper-btn-accept"
                    onClick={() => onDecision(true, "user")}>Allow</button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

```css
/* apps/helper/src/styles.css additions */
.helper-consent-overlay { position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; background: rgba(0,0,0,.55); animation: fadeIn 150ms ease-out; }
.helper-consent-card { width: calc(100% - 32px); max-width: 348px; display: flex; flex-direction: column;
  background: var(--bg-secondary); border: 1px solid rgba(76,154,255,.30); border-radius: var(--radius-md);
  box-shadow: 0 8px 32px rgba(0,0,0,.5); overflow: hidden; animation: slideUp 200ms ease-out; }
.helper-consent-header { display: flex; align-items: center; gap: 8px; padding: 12px 14px;
  background: rgba(76,154,255,.08); border-bottom: 1px solid rgba(76,154,255,.15); }
.helper-consent-icon { font-size: 16px; color: var(--accent); line-height: 1; }
.helper-consent-title { font-size: 13px; font-weight: 600; color: var(--accent); }
.helper-consent-body { padding: 16px 14px; display: flex; flex-direction: column; gap: 12px; }
.helper-consent-identity { display: flex; align-items: center; gap: 12px; }
.helper-consent-avatar { width: 40px; height: 40px; flex-shrink: 0; display: grid; place-items: center;
  border-radius: var(--radius-md); background: var(--accent-subtle); color: var(--accent);
  font-size: 14px; font-weight: 600; }
.helper-consent-who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.helper-consent-name { font-size: 15px; font-weight: 600; color: var(--text-primary); }
.helper-consent-email { font-size: 12px; color: var(--text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.helper-consent-desc { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-secondary); }
.helper-consent-meta { font-size: 11px; color: var(--text-muted); }
.helper-consent-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 12px 14px; border-top: 1px solid var(--border-light); }
.helper-consent-countdown { font-size: 11px; color: var(--text-muted); }
.helper-consent-countdown.is-urgent { color: #ffbf00; }
.helper-consent-actions { display: flex; gap: 8px; }
.helper-btn-accept { padding: 5px 14px; border: 1px solid rgba(76,154,255,.4); border-radius: var(--radius-sm);
  background: var(--accent-subtle); color: var(--accent); font-size: 12px; font-weight: 600; cursor: pointer;
  transition: background var(--transition-fast); }
.helper-btn-accept:hover { background: rgba(76,154,255,.25); }
@media (prefers-reduced-motion: reduce) {
  .helper-consent-overlay, .helper-consent-card { animation: none; }
}
```

### 9.2 Active-session banner — `session-banner` window (top-center pill, ~360×52, always-on-top, `skip_taskbar`, transparent, non-focusing)

Docked top-center pill — the macOS-screen-share / "you're presenting" convention.
Pulsing red live dot (`#ff5f57`) used as **status** (not error). Generic mode label:
"Remote session active". Indicator-only (no End button in v1).

```tsx
// apps/helper/src/windows/SessionBanner.tsx
import { useEffect, useState } from "react";

export function SessionBanner({ label, startedAt }: { label: string; startedAt: number }) {
  const [elapsed, setElapsed] = useState("0:00");
  useEffect(() => {
    const tick = () => {
      const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      setElapsed(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return (
    <div className="helper-sessionbanner" role="status" aria-live="polite">
      <span className="helper-sessionbanner-dot" aria-hidden />
      <span className="helper-sessionbanner-label">{label}</span>
      <span className="helper-sessionbanner-sep" aria-hidden>·</span>
      <span className="helper-sessionbanner-time">{elapsed}</span>
    </div>
  );
}
```

```css
/* banner window only: transparent so just the pill shows */
.banner-root, .banner-root body { background: transparent; }
.helper-sessionbanner { display: inline-flex; align-items: center; gap: 8px; margin: 8px auto 0;
  padding: 7px 14px; background: var(--bg-secondary); border: 1px solid var(--border);
  border-radius: var(--radius-lg); box-shadow: 0 4px 16px rgba(0,0,0,.45); font-size: 12px;
  color: var(--text-primary); user-select: none; animation: slideDown 220ms cubic-bezier(.22,1,.36,1); }
.helper-sessionbanner-dot { width: 8px; height: 8px; border-radius: 999px; background: #ff5f57;
  animation: livePulse 2s ease-out infinite; }
.helper-sessionbanner-label { font-weight: 500; }
.helper-sessionbanner-sep { color: var(--text-muted); }
.helper-sessionbanner-time { font-family: var(--font-mono); color: var(--text-muted);
  font-variant-numeric: tabular-nums; }
@keyframes livePulse {
  0% { box-shadow: 0 0 0 0 rgba(255,95,87,.5); }
  70% { box-shadow: 0 0 0 6px rgba(255,95,87,0); }
  100% { box-shadow: 0 0 0 0 rgba(255,95,87,0); }
}
@keyframes slideDown { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) {
  .helper-sessionbanner { animation: none; }
  .helper-sessionbanner-dot { animation: none; }
}
```

### 9.3 Rust window creation (Tauri v2)
- `consent`: `inner_size(380, 300)`, `center()`, `decorations(false)`,
  `always_on_top(true)`, `focused(true)`, `skip_taskbar(true)`.
- `session-banner`: `inner_size(360, 52)`, positioned top-center, `transparent(true)`,
  `decorations(false)`, `always_on_top(true)`, `skip_taskbar(true)`, `focused(false)`,
  `shadow(false)`. Both created on demand and destroyed when the session/decision ends.

## 10. Edge cases

- **Helper crashes mid-session:** banner dies with it; agent treats the lost IPC
  channel as it already does for capture. No security impact (notice/consent are
  best-effort; consent gate already resolved before streaming).
- **Multiple logged-in users (RDP / fast user switching):** target the session
  the desktop capture is bound to; surface only there.
- **Multi-monitor:** consent dialog centers on primary; banner docks top-center of
  primary.
- **Reconnect / ICE restart within a session:** don't re-prompt; consent is
  per-session, not per-transport.
- **`mode: off`:** no surfaces; behavior identical to today.

## 11. Testing

- **Go (agent):** table tests for the consent gate — allow / deny / timeout /
  no-helper / no-user × `proceed` / `block`; assert streaming starts only on a
  positive verdict; assert `denied` status emitted on block.
- **API:** policy CRUD; **RLS forge test** (cross-tenant insert fails as
  `breeze_app`); rls-coverage allowlist entry; the resolved-payload builder
  (identity-level redaction: `generic` omits name+email, `name` omits email);
  audit events emitted with correct reasons; integration test for the
  deny→teardown→`denied` path.
- **Web:** viewer handling of the `denied` terminal state.
- **Helper:** component tests for `ConsentDialog` (default focus is Deny, Esc
  denies, countdown label respects fallback, identity-level rendering) and
  `SessionBanner` (elapsed tick, generic label, reduced-motion).

## 12. Rollout

- **Behavior change on upgrade:** default `sessionPromptMode = 'notify'` means
  every device with the Helper installed will begin showing a start notice for
  remote sessions immediately. This is intentional (privacy-forward default) but
  must be called out in release notes. Operators who want the old silent behavior
  set a `remote_access` policy with `mode: off`.
- `consent` mode is opt-in per policy; `proceed` fallback ensures it never locks
  techs out of unattended/headless machines unless an operator explicitly chooses
  `block`.
- New IPC fields are additive and optional; older agents/Helpers ignore the
  `prompt` block and behave as today (degraded = silent), so mixed-version fleets
  are safe.

## 13. Out of scope / follow-ups

- View-only vs input-control wording in the prompt/banner.
- End-user "End session" control from the banner.
- Native-OS notification fallback when the Helper is absent.
- Mobile / Breeze Authenticator integration for remote-session consent.

## 14. Implementation notes (deviations discovered during build)

### 14.1 Helper topology / routing

The spec described a single "Breeze Helper" surface. During build, the helper
layer splits into two distinct processes with separate IPC scopes:

- **Go user-helper** (`notify` scope) — handles native OS notifications.
  Connected-notice and session-ended notice are delivered here via the existing
  `PreferredSessionWithScope("notify")` call.
- **Tauri assist helper** (`assist` scope + new `consent_ui` scope) — renders
  React UI. The rich consent dialog and the active-session banner route to this
  process via `PreferredSessionWithScope("consent_ui")`. A narrow `consent_ui`
  scope was added and granted to the assist role so that the agent can target the
  Tauri helper specifically without conflating it with the notify channel.

### 14.2 Verdict transport

The spec left the deny-verdict transport open. During build, the consent verdict
is reported over the **desk-start COMMAND-RESULT channel** already used to relay
the WebRTC answer in `agentWs.ts`:

- **Denied:** the agent emits a COMPLETED result carrying
  `{event: "consent_denied", reason}` as a marker. `agentWs.ts` detects this
  marker and triggers the denied→teardown→`denied` status path.
- **Granted:** the agent emits a success result with `consentReason: "user"` so
  the audit log can record that the user explicitly allowed the session.

The JWT-authenticated `/answer` and `/deny` HTTP routes considered in the spec
are NOT used for the agent consent path. `POST /sessions/:id/deny` exists and is
used for the operator/web deny path (e.g. the RMM technician or an admin
revoking an in-flight session).

### 14.3 macOS banner transparency

The active-session banner requires a transparent window so only the pill is
visible (no opaque background frame). On macOS this requires Tauri's
`macos-private-api` feature:

- Enabled in `src-tauri/Cargo.toml` under `[features]`.
- `macOSPrivateApi: true` in `tauri.conf.json`.

This is safe because the Breeze Helper is self-distributed (not App Store), so
the App Store prohibition on private API usage does not apply.

### 14.4 Helper component unit tests

The spec's §11 testing plan included component tests for `ConsentDialog` and
`SessionBanner`. These are deferred: `apps/helper` has no test runner configured
(no Vitest, no Jest). The components were verified via:

1. `tsc --noEmit` (zero type errors).
2. Design review against the spec UI spec.
3. The manual in-Helper gate (Tauri `dev` mode, local agent IPC).

Component tests will be added when a test runner is wired to `apps/helper`.
- Light theme for the Helper surfaces (Helper is dark-only today).
