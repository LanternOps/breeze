# Offboarding drain state — deliverable `self_uninstall` for churning tenants (#2774)

**Status:** implemented alongside this doc.
**Issue:** #2774 — 78 of 80 remote uninstalls all-time expired undelivered because tenant
offboarding severs the agent auth channel before the command can be collected.

## Problem

Two independent gates lock an agent out the instant a tenant is offboarded:

1. `devices.agent_token_suspended_at` — set by `severAgentCredentialsForOrgIds`
   (`services/tenantLifecycle.ts`).
2. `isAgentTenantActive(orgId)` → org status ∈ {`active`,`trial`} AND partner strictly
   `active` (`services/tenantStatus.ts`), checked in `agentAuth.ts`, `agentWs.ts`, `mtls.ts`.

Any `self_uninstall` queued after either gate closes sits `pending` until the stale-command
reaper fails it 30 minutes later ("Command expired: agent never received the command").
Nothing surfaces the failure; operators believe the fleet was cleaned.

## Design

A terminal-intent drain state, `offboarding`, on **both** the org and partner status enums.

### Semantics

| Surface | During `offboarding` |
|---|---|
| User sessions / JWT | rejected (all user gates are explicit allowlists that don't include the new value) — plus proactive revocation on entry |
| API keys / OAuth / partner API | rejected (same allowlist property) + revoked on entry |
| Agent REST auth | **allowed, narrowed** — route allowlist only (see below) |
| Agent WS upgrade | **refused** — ~20 call sites push desktop/terminal/tunnel/software commands over WS without `device_commands` rows; refusing the socket closes that whole class. Agents fall back to heartbeat polling (60s) |
| Command claim (heartbeat piggyback + poll) | filtered to `type = 'self_uninstall'` only |
| Enrollment | rejected (`getActiveOrgTenant` unchanged) + enrollment keys expired on entry |
| mTLS cert renewal | allowed (auth maintenance, like token rotation — an agent quarantined mid-drain could never collect its uninstall) |

**Drain-mode route allowlist** (everything else 403 `tenant_offboarding`):
heartbeat (command carrier + liveness), commands poll, command result, token
rotate/confirm (blocking rotation mid-stage could strand the credential), logs ship
(post-mortem evidence for never-drained devices).

### Transitions

**Entry** (`PATCH` org/partner status → `offboarding`, MFA-gated routes as today):
1. Set status + `offboarding_started_at = now()`.
2. Revoke users, sessions, API keys, OAuth artifacts (exactly the existing revocation
   minus `severAgentCredentialsForOrgIds`), expire enrollment keys.
3. Cancel all other pending/sent commands, then queue `self_uninstall`
   (`{removeConfig: true}`) to every non-decommissioned device — the abuse-route shape.
4. Invalidate the agent tenant cache so the 60s positive cache re-reads the new state.

**Drain sweep** (`jobs/offboardingDrainReaper.ts`, BullMQ repeatable, 5 min): an org/partner
finishes when its offboarding `self_uninstall` commands are all terminal **or**
`offboarding_started_at + OFFBOARDING_DRAIN_WINDOW_HOURS` (default 72) has passed. On
finish:
1. Cancel remaining pending uninstalls with an explicit result
   (`offboarding window closed: agent never received the command`).
2. Write the **never-drained report**: audit log `org.offboarding_completed` /
   `partner.offboarding_completed` with drained/stranded counts and the stranded device list.
3. `severAgentCredentialsForOrgIds` (now exported) and flip status → `churned`.

**Abort** (status `offboarding` → `active`/`trial`): cancel pending uninstalls, clear
`offboarding_started_at`, restore agent credentials, invalidate cache. Devices that already
uninstalled stay gone — abort is best-effort, documented as such. Forcing
`suspended`/`churned` mid-drain takes the existing immediate-sever path.

Abort keys on the *own-axis* stamp. Reactivating one org under a still-offboarding partner
is therefore a no-op: that org is still `draining` via the partner axis, so its uninstalls
stay deliverable. Aborting a partner-level drain means reactivating the partner.

**Entry repair.** The route commits the status before running the drain work, so a failure
in between would leave a tenant with no queued uninstalls whose next sweep would finalize
instantly on a zero-outstanding count — an empty report indistinguishable from a clean
drain. The sweep detects the missing stamp, completes the entry (queue + narrow), audits
`*.offboarding_entry_repaired`, and only then lets the window run.

**Stale-reaper exemption:** `staleCommandReaper` skips `self_uninstall` rows whose device's
org (or org's partner) is currently `offboarding`. Deliberately **not** a blanket
`self_uninstall` exemption: abuse-queued uninstalls must keep expiring, otherwise an abuse
suspension reversed days later would deliver stale uninstalls to a reinstated fleet.

### What deliberately does NOT change

- **Abuse suspension** (`/admin/partners/:id/suspend-for-abuse`) keeps immediate lockout.
  A drain window there would leave an abuser's command channel open on victim endpoints.
- `isUsableOrgStatus`, `getActivePartner`, `getSessionAllowedPartner`, `partnerGuard`,
  `partnerApiAuth`, password-reset eligibility: untouched — `offboarding` is denied by
  every user-facing gate by construction.
- The AI org-update tool cannot set `offboarding` (kept out of its schema): initiating an
  irreversible fleet uninstall stays a human, MFA-gated action.
- Go agent: no changes. Heartbeat keeps working during drain; the existing
  `self_uninstall` handler acks then tears down.

### Gate implementation

`getAgentTenantState(orgId): 'active' | 'draining' | null` replaces the boolean internals of
`isAgentTenantActive` (which remains as a truthy wrapper for mtls). Draining when:
org `offboarding` + partner ∈ {`active`,`offboarding`}, or org ∈ {`active`,`trial`} +
partner `offboarding`. Cache keeps the same key/TTL with value `'1'` | `'drain'`;
negatives still never cached.

### Known limits (from the issue, still true)

- A drain window only rescues devices that come online during it. Machines offline for the
  whole window land in the never-drained report — that report is the product, not polish.
- Portal sessions don't check org/partner status at all today (pre-existing gap, applies
  to `churned` equally); out of scope here.
- The `DELETE /devices/:id/permanent` WS-only best-effort uninstall path is unchanged
  (separate issue territory).
