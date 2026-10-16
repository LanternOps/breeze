---
tracking_issue: LanternOps/breeze#8844
---

# Connection Health Notifications — Feature Plan (all waves)

> **For agentic workers:** This is the feature-level plan. Each wave has, or gets, its own task-level plan. Execute the wave plan, not this file. REQUIRED SUB-SKILL for wave plans: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Goal:** Admins learn within a day that a connection broke: an integration, an OAuth grant, a webhook, or a sync. They get an in-app notice and a daily digest with a fix link. The notice clears itself when the connection is fixed.

**Architecture:** Each kind of connection gets a `HealthSource` adapter. A reconciler runs every 15 minutes and calls each adapter's `observe()`, which reads only broken connections and the ids already tracked. It then applies the incident state machine to `connection_health_incidents`. In-app notices come from incident transitions. The daily digest reads incidents and records each send in a ledger.

**Spec:** `docs/superpowers/specs/integrations/2026-10-15-connection-health-notifications-design.md`

## Waves

Every wave ships on its own, and each one is useful before the next exists. Branch per wave: `feature/8844-connection-health/wave-<subissue#>`. PR bodies carry `Closes #<sub-issue>`.

| Wave | Scope (spec §) | Depends on | Wave plan |
|---|---|---|---|
| **W1 (#8845): Incident core and OAuth** | §1.1–1.3 contract, registry and reconciler; §2.1 table, RLS and registrations; §2.4 `integration` notification type; §3 `oauth_grant` source; §4 in-app notices; §8 observability; read API | — | `2026-10-15-connection-health-w1-core-oauth.md` |
| **W2 (#8846): Existing integration sources and panel** | §3 adapters for Huntress, SentinelOne, Pax8, UniFi, backup, EDR, accounting, DNS, M365 connection and sync, and ticket mailbox; extract the readiness state functions; partial indexes plus the EXPLAIN test (§1.3); fix-link route test; Connection Health panel on `/integrations`; delete the mock `ConnectorStatusPanel.tsx`; source-coverage contract test | W1 | written at wave start |
| **W3 (#8847): Daily digest** | §2.2 `user_email_optouts`; §2.3 delivery ledger; §4 digest job at 08:00 partner-local, with decay and auth recheck; §5 RFC 8058 endpoint and headers; §6 My Account → Notifications toggle; mail purpose `staff.connection_health_digest` | W1 (W2 for useful content) | written at wave start |
| **W4 (#8848): Missing signals and nudges** | §3 webhook terminal-failure source (excluding superseded deliveries); sync staleness; Google verification probe; OAuth "still retrying" counter; §1.3 debounced nudges from `oauth/grantStatus.ts` and `jobs/syncAttempt.ts` | W1, W2 | written at wave start |
| **W5 (#8849): Customer delivery and events** | §6 `customerAdminsNotified` setting (partner default → org override); §2.4 events `integration.health_opened` / `integration.health_resolved` (no `detail` in the payload); webhook self-delivery exclusion | W1, W3 | written at wave start |

## Decisions carried from the spec (§12, settled 2026-10-15)

- Customer org admins get no notices by default. W5 adds a partner setting to turn this on.
- Partner-wide incidents go to partner-scope users with `orgAccess = all` who hold the source's `repairPermission`.
- The digest goes out at 08:00 in `partners.timezone`.
- An OAuth grant incident retires after 30 days with no re-consent.

## Cross-wave rules

- **Tenancy:** any wave that adds a table runs the RLS-coverage, org-cascade and export-policy contract suites locally before its PR (`docs/agents/tenancy-rls.md`).
- **Migrations:** each migration is named to sort after the newest committed migration at the time of the PR. Re-check this at rebase.
- **Sources:** every new source ships with fixture tests, an index-backed broken predicate (W2 onwards), and a registry entry.
- **Sanitization:** any provider text goes through `sanitizeHealthDetail()` (W2 introduces it; W1's OAuth source has no provider text).
