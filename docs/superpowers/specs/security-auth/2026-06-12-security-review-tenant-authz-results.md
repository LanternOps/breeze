# Security Review — Multi-Tenant Isolation + AuthZ (All API Routes)

**Date:** 2026-06-12
**Scope:** Multi-tenant isolation + authorization across all `apps/api/src/routes/` (and parallel `services/aiTools*.ts` paths). Two-pass fan-out: 15 resource-group finder agents → one adversarial read-only verifier per candidate → drop < 8/10.
**Coverage:** 795 endpoints audited, 15 groups, 34 candidates generated, 11 confirmed, 23 dropped.

## Headline

**No cross-tenant (cross-org / cross-partner) read, write, or privilege-escalation hole was found.** Org-axis RLS (`breeze_has_org_access` / `breeze_has_partner_access`, ENABLE+FORCE) holds on every tenant table touched, and forged cross-org ids are rejected at the database independent of the app-layer WHERE. The previously-fixed nested-EXISTS bug class (`script_execution_batches`) and the dual-axis blindspot (`custom_field_definitions`, fixed 2026-06-11-i) are both confirmed remediated.

**Every confirmed finding is one of three intra-tenant classes:**
1. **Site sub-axis bypass** — RLS deliberately does not model `site`; several routes omit the app-layer `allowedSiteIds` check their siblings enforce. (6 findings)
2. **Intra-tenant RBAC gap** — mutating routes gate on `requireScope` (tier) only, missing `requirePermission`/`requireMfa`. (3 findings)
3. **Missing audit trail** — mutating actions not written to the tamper-evident `audit_logs` hash chain. (2 findings)

## Confirmed Findings

| # | Sev | Group | File:Line | Endpoint | Finding |
|---|-----|-------|-----------|----------|---------|
| 1 | **HIGH** | security-compliance | `routes/sensitiveData.ts:704` | POST `/sensitive-data/remediate` | Destructive remediation (encrypt/quarantine/secure_delete) matches findings on org only — site-restricted insider can destroy files on out-of-site devices |
| 2 | MEDIUM | devices | `routes/tags.ts:65` | GET `/tags`, GET `/tags/devices` | Omits `allowedSiteIds` — site-restricted user reads device id/hostname/OS/status/tags across all sites in the org |
| 3 | MEDIUM | patching | `routes/patches/approvals.ts:66` | POST `/patches/bulk-approve`,`/:id/approve`,`/decline`,`/defer` | No `requirePermission`/`requireMfa`; read-only org role can approve/decline/defer patch deployment |
| 4 | MEDIUM | ai-mcp | `services/aiToolsTicketing.ts:36` | `manage_tickets` (MCP + SDK) get/comment/assign/update_status | Parallel-path site-axis gap — site-restricted caller reads/mutates tickets bound to out-of-site devices (#1047 class) |
| 5 | MEDIUM | software | `routes/softwareInventory.ts:305` | POST `/software-inventory/approve`,`/deny`,`/clear` | Allow/blocklist policy mutations write no audit log (sibling `softwarePolicies.ts` does) |
| 6 | MEDIUM | alerts | `routes/alerts/rules.ts:130` | POST/PUT/DELETE alert rules, policies, routing-rules, templates | Gate `requireScope` only, not `ALERTS_WRITE`; read-only org user can edit/delete alerting (channels.ts gates correctly) |
| 7 | MEDIUM | remote-access | `routes/tunnels.ts:436` | POST/PUT/DELETE `/tunnels/allowlist(/:id)` | Allowlist mutation needs no RBAC permission/MFA; any org member can widen the tunnel-target allowlist to RFC1918 /8 |
| 8 | MEDIUM | remote-access | `routes/eventWs.ts:202` | POST `/events/ws-ticket` + GET `/events/ws` | Event stream scoped to org only (Redis pub/sub); site-restricted user receives live device/alert/session events for other sites |
| 9 | MEDIUM | tickets-incidents | `services/ticketService.ts:543` | POST `/tickets/:id/assign`,`/comments`,`/alerts`; DELETE `/alerts/:alertId` | Assign/comment/alert-link write no `audit_logs` entry (create/status/field-update do) |
| 10 | MEDIUM | security-compliance | `routes/sensitiveData.ts:617` | GET `/sensitive-data/dashboard` | Aggregates PII/PCI/PHI counts across all sites for site-restricted users (intra-org count leak) |
| 11 | MEDIUM | security-compliance | `routes/cisHardening.ts:787` | POST `/cis/remediate/approve` | Approval dispatches agent remediation without re-checking device site scope |

### Statistics
- **CRITICAL: 0**
- **HIGH: 1** (#1)
- **MEDIUM: 10**
- **LOW: 0** (confirmed; several LOWs dropped < 8)
- **PASS:** org/partner cross-tenant isolation across all 15 groups; agent/WS ticket ownership; SSO callback; admin/system scope gating; secret encryption-at-rest; the two known historical RLS bug classes.

## Top Priority Actions

1. **#1 (HIGH) — sensitive-data remediate site scope.** This is the only finding with a *destructive* + *cross-site* combination. Add device→site gating before queuing `ENCRYPT_FILE`/`QUARANTINE_FILE`/`SECURE_DELETE_FILE`, mirroring the `POST /scan` handler (sensitiveData.ts:312-318). Same-PR companions: #10 (dashboard) and #11 (CIS approve) are the same site-axis omission in the security-compliance group.
2. **Site-axis sweep.** Findings #1, #2, #4, #8, #10, #11 are all the same root cause — a route reads/acts on `org` alone where a sibling enforces `allowedSiteIds`. Worth a single sweep (extend the route/aiTools scanner to flag device-touching handlers that don't call `canAccessSite`/`deviceInSiteScope`), because RLS provides *no* backstop on this axis. This is the recurring #864/#868 + #1047 class.
3. **RBAC permission gates on mutating routes.** Findings #3, #6, #7 each gate on `requireScope` tier instead of `requirePermission`. A read-only org role should not approve patches, edit alert rules, or widen tunnel allowlists. Add the missing `requirePermission(...)` (+ `requireMfa()` where siblings have it).
4. **Audit-log gaps.** #5 (software policy) and #9 (ticket assign/comment/link) bypass the tamper-evident chain. Add `writeRouteAudit`/`createAuditLogAsync` mirroring the audited sibling mutations.

## Dropped (< 8) — human-review triggers, not dismissals

The methodology treats dismissals as review triggers. Of the 23 dropped, one coherent class is worth a tracking ticket even though each scored 4-7 (currently guarded app-layer, so not independently exploitable today): **tenant child tables with NO RLS at all, invisible to the rls-coverage contract test** (app-layer-only isolation, defense-in-depth gap):

- `maintenance_occurrences` (`0001-baseline.sql:3928`)
- `network_monitor_results`, `network_monitor_alert_rules` (`0001-baseline.sql:4092`)
- `webhook_deliveries` (`0001-baseline.sql:6034`)
- `role_permissions` (RBAC join table)
- `dashboard_widgets` (`analytics.ts:748`)

Each should either get RLS in the right tenancy shape or be explicitly added to `INTENTIONAL_UNSCOPED` with justification, and the contract test extended to catch un-RLS'd FK-child tables.

Other dropped items (all MEDIUM/LOW, verifier conf 2-7): script execution-list relying solely on RLS (holds today), in-memory script-library mock (no persistence), `network_known_guests` org-tree EXISTS vs flat partner helper (latent), DNS read endpoints lacking `requirePermission`, access-review/incident-AI MFA step-up inconsistencies, portal asset cross-checkin, `POST /support` external forward without audit. Full per-finding verdicts in the workflow result.

## Method note

Verification was read-only (no DB connection) per methodology. Several findings include a reasoned `proofStatement` — the exact SQL the RLS policy would *permit* for the attacker's own org — demonstrating that on the site axis the database has no predicate to reason against. These were not executed. For the HIGH (#1) and the RBAC findings, confirm with a live `breeze_app` repro before/after the fix.
