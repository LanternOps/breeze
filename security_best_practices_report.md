# Security Best Practices Review Report

Date: 2026-03-30
Repository: /Users/toddhebebrand/breeze
Reviewer mode: `security-best-practices`

## Executive Summary

I reviewed the current Breeze codebase with a security focus on authentication, authorization, remote-control flows, token handling, and externally reachable endpoints in the Node/TypeScript API, Astro/React web app, and supporting Go agent paths that materially affect the web/API trust boundary.

The first remediation pass fixed the original four findings around `dev/push`, browser token persistence, desktop viewer token scoping, and MFA setup verification. Subsequent remediation passes also fixed the agent WebSocket orphaned-result trust issue, helper output sanitization/scope enforcement gaps, and several adjacent API authorization inconsistencies in deployment, software, script-library, sensitive-data, and monitoring routes.

Current unresolved high-confidence findings documented in this report: **0**

The remaining work is continued audit coverage, not a currently open known issue from the findings tracked below.

## Method

1. Mapped the active stack and loaded targeted guidance for Node/TypeScript backend, React frontend, and Go components.
2. Reviewed bootstrap middleware, auth/session flows, CORS/CSRF handling, and token issuance.
3. Traced high-risk routes including remote session flows, WebSocket ticketing, agent-control endpoints, and API-key-protected endpoints.
4. Reviewed browser token storage patterns and privileged deep-link flows.
5. Confirmed findings against current code and line references rather than relying on the older report already present in the repo.

## Historical Findings Already Remediated

### F-001: `dev/push` allows privileged agent updates without permission or MFA checks
Rule ID: EXPRESS-AUTHZ-001
Severity: High
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/devPush.ts:46](/Users/toddhebebrand/breeze/apps/api/src/routes/devPush.ts:46)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/devPush.ts:60](/Users/toddhebebrand/breeze/apps/api/src/routes/devPush.ts:60)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/devPush.ts:71](/Users/toddhebebrand/breeze/apps/api/src/routes/devPush.ts:71)

Evidence:
- The route is only gated by environment availability, not by RBAC or MFA.
- When `X-API-Key` is present, `devPushAuth` calls `apiKeyAuthMiddleware` directly and never applies `requireApiKeyScope(...)`.
- When JWT auth is used, `devPushAuth` only applies `requireScope('organization', 'partner', 'system')`; it does not apply `requirePermission(...)` or `requireMfa()`.

Impact:
- If `dev/push` is reachable in an environment, any authenticated org user or any active org API key can upload and trigger a custom agent binary on devices they can see in that org. That is effectively remote code execution on managed endpoints without a high-assurance authorization check.

Fix:
- Gate the route with `requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)` and `requireMfa()` for user auth.
- For API keys, require a dedicated scope such as `devices:execute` before allowing binary upload or agent update operations.
- Consider restricting the route to explicit admin-only environments, or disabling API-key access entirely for this endpoint.

Mitigation:
- Keep `DEV_PUSH_ENABLED` off outside tightly controlled developer environments.
- Audit existing API keys for broad deployment use if this route has ever been enabled in shared environments.

False positive notes:
- This issue is conditional on the route being enabled or running in a non-production environment. The authorization gap itself is real in code today.

### F-002: The web app persists bearer access tokens in browser storage
Rule ID: REACT-CONFIG-001
Severity: Medium
Location:
- [/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts:41](/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts:41)
- [/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts:85](/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts:85)
- [/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts:278](/Users/toddhebebrand/breeze/apps/web/src/stores/auth.ts:278)

Evidence:
- The Zustand `persist(...)` configuration stores `tokens` under the `breeze-auth` local-storage key.
- `fetchWithAuth()` then reads that access token and places it in the `Authorization` header for API requests.

Impact:
- Any XSS in the Breeze web origin, or a malicious browser extension with page access, can exfiltrate a live bearer token and replay API calls as the user. Because the app already uses an HttpOnly refresh-cookie flow, persisting the access token increases blast radius without being strictly necessary.

Fix:
- Keep access tokens in memory only and rely on the existing refresh-cookie flow to restore them after page reload.
- If persistence is required, reduce scope and lifetime aggressively and consider binding tokens to a narrower audience or interaction.

Mitigation:
- Maintain a strict CSP and continue avoiding dangerous DOM sinks, but do not treat CSP as a substitute for keeping bearer credentials out of script-readable storage.

False positive notes:
- This is a code-level storage design issue, not proof of a current XSS bug.

### F-003: Desktop deep-link exchange mints a normal user API token instead of a viewer-scoped token
Rule ID: EXPRESS-AUTH-002
Severity: Medium
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/remote/sessions.ts:574](/Users/toddhebebrand/breeze/apps/api/src/routes/remote/sessions.ts:574)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/remote/sessions.ts:577](/Users/toddhebebrand/breeze/apps/api/src/routes/remote/sessions.ts:577)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/desktopWs.ts:583](/Users/toddhebebrand/breeze/apps/api/src/routes/desktopWs.ts:583)

Evidence:
- `desktop-connect-code` stores the caller's full token claims (`sub`, `email`, `roleId`, `orgId`, `partnerId`, `scope`, `mfa`) inside the one-time code payload.
- `/desktop-ws/connect/exchange` converts that payload directly into a fresh access token via `createAccessToken(codeRecord.tokenPayload)`.

Impact:
- Any process that obtains a valid desktop connect code can exchange it for a general Breeze API bearer token with the user's normal scope, rather than a token restricted to the remote-viewer flow. That unnecessarily widens the consequences of deep-link interception or compromise of the local viewer app.

Fix:
- Mint a dedicated viewer/session token with a separate audience or token type, scoped to the specific remote session and limited to desktop-viewer endpoints only.
- Reject viewer tokens everywhere outside the viewer/session exchange path.

Mitigation:
- Keep connect-code TTLs short and one-time, but treat that as defense-in-depth rather than sufficient scoping.

False positive notes:
- The one-time code design is good; the issue is the breadth of the exchanged token after redemption.

### F-004: MFA setup confirmation bypasses standard auth middleware and does not enforce access-token type
Rule ID: EXPRESS-AUTH-003
Severity: Medium
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/auth/mfa.ts:219](/Users/toddhebebrand/breeze/apps/api/src/routes/auth/mfa.ts:219)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/auth/mfa.ts:225](/Users/toddhebebrand/breeze/apps/api/src/routes/auth/mfa.ts:225)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/auth/mfa.ts:231](/Users/toddhebebrand/breeze/apps/api/src/routes/auth/mfa.ts:231)

Evidence:
- The setup-confirmation branch of `/auth/mfa/verify` manually reads the `Authorization` header and calls `verifyToken(token)` instead of using `authMiddleware`.
- That branch checks revocation, but it never enforces `payload.type === 'access'` and never re-validates user status through the standard middleware path.

Impact:
- This creates a privileged endpoint with weaker token semantics than the rest of the app. If a refresh token or other signed JWT for the same user is disclosed outside the intended cookie path, it could be accepted here even though the route is conceptually an authenticated user action.

Fix:
- Replace the bespoke header parsing with `authMiddleware` for the authenticated setup-confirmation path.
- If the route must stay split between login-time MFA verification and authenticated MFA setup, explicitly require `payload.type === 'access'` and an active user record in the setup-confirmation branch.

Mitigation:
- Keep refresh tokens HttpOnly and out of application logs, but still normalize this route to the same auth contract as the rest of the API.

False positive notes:
- Exploitability depends on obtaining a signed JWT outside the normal access-token path. The route inconsistency is still real and worth fixing.

## Residual Risks And Gaps

- I did not complete a dependency-vulnerability sweep in this pass. The workspace `pnpm audit` command did not accept the recursive invocation I expected, so this report is grounded in code review rather than package-advisory output.
- I did not validate edge/CDN/runtime headers outside the app code. CSP, TLS termination, WAF, and ingress controls should still be verified in deployed environments.
- I did not perform dynamic testing against a running instance, so any runtime-only controls or regressions were not exercised.

## Follow-up Findings (Remediated)

### F-005: Agent WebSocket orphaned result handling trusts agent-supplied target IDs without rebinding them to the authenticated device
Rule ID: GO-AUTHZ-001
Severity: High
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts:190](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts:190)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts:204](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts:204)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts:233](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts:233)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts:445](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts:445)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts:496](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts:496)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts:1077](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts:1077)

Evidence:
- For non-UUID `command_result` messages, `processCommandResult()` calls `processOrphanedCommandResult()` directly instead of rebinding the result to `authenticatedAgent.deviceId`.
- The SNMP orphan path accepts `result.result.deviceId` and enqueues metric processing for that supplied device ID.
- The monitor orphan path accepts `result.result.monitorId` and records status for that supplied monitor ID.
- UUID-backed orphan flows for discovery, backup, and restore jobs also resolve by job ID alone and do not check that the submitting agent was the agent originally selected for the work.
- In the same file, `ipHistoryUpdate.deviceId` is explicitly rejected when it does not match the authenticated device, which shows the safer binding pattern is already understood elsewhere in this code.

Impact:
- Any authenticated agent connection can inject or overwrite monitor, SNMP, discovery, backup, or restore state outside its own device boundary if it can submit crafted orphaned results. For non-UUID monitor and SNMP results, this does not require guessing a stored command row at all because the API trusts the target identifiers embedded in the payload.

Fix:
- Bind every result path to the authenticated device or an expected pending command/job record before mutating any downstream state.
- For non-persistent commands, persist a short-lived server-side dispatch record keyed by `commandId`, expected agent/device, and allowed target IDs, then reject result submissions that do not match that record.
- For discovery, backup, and restore jobs, record the dispatched `agentId` and require it to match on result submission.

Mitigation:
- Treat agent WebSocket connections as untrusted clients even after authentication and reject any result payload fields that attempt to select a different device or monitor than the one already bound server-side.

False positive notes:
- This finding assumes an authenticated agent can send arbitrary `command_result` messages over its WebSocket, which is exactly what the current message handler accepts.

### F-006: `runAs` helper execution returns unsanitized stdout/stderr, bypassing the normal secret-redaction path
Rule ID: GO-CONFIG-001
Severity: Medium
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_script.go:75](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_script.go:75)
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_script.go:241](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_script.go:241)
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go:530](/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go:530)
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go:597](/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go:597)
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/heartbeat.go:2628](/Users/toddhebebrand/breeze/agent/internal/heartbeat/heartbeat.go:2628)

Evidence:
- Local script execution sanitizes output before returning it: `executor.SanitizeOutput(scriptResult.Stdout/Stderr)`.
- The `runAs` helper path unmarshals nested helper results and assigns raw `stdout` and `stderr` directly to `cmdResult`.
- The helper itself serializes raw `result.Stdout` / `result.Stderr` for scripts and raw `stdout.String()` / `stderr.String()` for direct `"exec"` commands.
- The patching `makeUserExecFunc()` path also reads those helper fields back without any redaction.

Impact:
- Secrets echoed by helper-executed scripts or direct user-context commands can leak back into API responses, audit/result storage, worker jobs, or logs even though the direct execution path already attempts to redact common credential patterns.

Fix:
- Apply the same output sanitation to helper-returned script and exec results before they leave the helper, or sanitize again at the broker boundary before storing or returning them.
- Keep the redaction behavior centralized so direct and helper-mediated execution cannot drift again.

Mitigation:
- Avoid printing secrets from scripts, but do not rely on script hygiene alone because the direct executor already assumes redaction is necessary.

False positive notes:
- This is an output-handling inconsistency, not proof that a specific secret has already leaked.

### F-007: User-helper scopes are assigned during IPC auth but never enforced inside command dispatch
Rule ID: GO-AUTHZ-002
Severity: Low
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go:192](/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go:192)
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go:357](/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go:357)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go:40](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go:40)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go:630](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go:630)

Evidence:
- The helper stores `authResp.AllowedScopes` in `c.scopes`.
- `c.scopes` is not referenced anywhere else in the helper.
- `handleCommand()` dispatches screenshot/computer-action, direct `"exec"`, and default script execution for any authenticated `ipc.TypeCommand` without checking whether the current helper role or scope permits that specific command.
- The broker does assign different scope sets for system helpers and user helpers, but the callee trusts the broker to always route correctly.

Impact:
- This weakens privilege separation between helper roles. A routing bug, future call-site mistake, or compromised broker-side caller can make a helper execute commands outside the role boundaries the auth handshake appears to establish.

Fix:
- Enforce command-to-scope mapping inside the helper before dispatch, for example requiring `run_as_user` for script/exec, `notify` for user notifications, and explicit desktop/capture scopes for screenshot or computer-action operations.
- Fail closed for unknown command types instead of treating the helper as implicitly authorized for every `ipc.TypeCommand`.

Mitigation:
- Keep broker-side scope filtering, but treat helper-side checks as a required second boundary rather than optional defense-in-depth.

False positive notes:
- The current broker generally routes commands by role already. The issue is that the helper does not independently enforce the contract it just authenticated.

## Additional Authorization Hardening Completed After The Initial Report

### R-001: Deployment routes now enforce RBAC and MFA based on action type
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/deployments.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/deployments.ts)

Summary:
- Read endpoints now require `devices:read`.
- Draft create/update/delete operations now require `devices:write`.
- Initialize/start/pause/resume/cancel/retry operations now require `devices:execute` plus MFA.

### R-002: Software catalog and software deployment routes now enforce RBAC and MFA
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/software.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/software.ts)

Summary:
- Catalog, version, deployment, and inventory reads now require `devices:read`.
- Catalog/version creation, mutation, deletion, and package upload now require `devices:write` plus MFA.
- Software deployment creation/cancellation now require `devices:execute` plus MFA.

### R-003: Script library routes now align with the existing scripts permission model
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/scriptLibrary.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/scriptLibrary.ts)

Summary:
- Read routes now require `scripts:read`.
- Category/tag/script-library mutation routes now require `scripts:write` plus MFA.

### R-004: Sensitive-data scan, remediation, and policy routes now require explicit permissions
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/sensitiveData.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/sensitiveData.ts)

Summary:
- Findings/reporting/policy-read routes now require `devices:read`.
- Policy writes now require `devices:write` plus MFA.
- Scan dispatch and remediation actions now require `devices:execute` plus MFA.

### R-005: Monitoring routes now protect SNMP credential management behind RBAC and MFA
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/monitoring.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/monitoring.ts)

Summary:
- Monitoring read routes now require `devices:read`.
- SNMP configuration and monitoring-disable routes now require `devices:write` plus MFA.

### R-006: Update-ring policy routes now require explicit RBAC and MFA
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/updateRings.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/updateRings.ts)

Summary:
- Ring list/detail/patch/compliance reads now require `devices:read`.
- Ring create/update/delete operations now require `devices:write` plus MFA.

### R-007: Incident lifecycle routes now require explicit alert permissions, with MFA on mutation
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/incidents.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/incidents.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/incidentActions.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/incidentActions.ts)

Summary:
- Incident list/detail/report reads now require `alerts:read`.
- Incident create/close, containment recording, and evidence attachment now require `alerts:write` plus MFA.

### R-008: Maintenance window routes now require explicit device permissions, with MFA on mutation
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/maintenance.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/maintenance.ts)

Summary:
- Maintenance status/list/detail/calendar reads now require `devices:read`.
- Window and occurrence create/update/delete/cancel/start/end routes now require `devices:write` plus MFA.

### R-009: Mobile alert/device routes now enforce RBAC on the high-value paths
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/mobile.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/mobile.ts)

Summary:
- Alert inbox now requires `alerts:read`.
- Mobile acknowledge/resolve actions now require explicit alert permissions.
- Mobile device list/summary now require `devices:read`.
- Mobile device quick actions now require `devices:execute` plus MFA.

### R-010: Organization, partner, and site admin routes now require explicit RBAC
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/orgs.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/orgs.ts)

Summary:
- Partner and organization reads now require `organizations:read`.
- Partner and organization writes now require `organizations:write` plus MFA.
- Site reads now require `sites:read`.
- Site writes now require `sites:write` plus MFA.

### R-011: Legacy patch-policy read routes now require organization read permission
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/patchPolicies.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/patchPolicies.ts)

Summary:
- The remaining read-only legacy patch-policy endpoints now require `organizations:read`.

### R-012: Integration settings routes now require org-scoped RBAC, with MFA on save/test operations
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/integrations.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/integrations.ts)

Summary:
- Integration settings reads now require `organizations:read`.
- Saving or testing communication, monitoring, ticketing, and PSA integrations now requires `organizations:write` plus MFA.

### R-013: Partner dashboard routes now require explicit organization and device read permissions
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/partner.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/partner.ts)

Summary:
- The partner dashboard route now requires both `organizations:read` and `devices:read` before returning fleet-wide org and device rollups.

### R-014: Tag inventory routes now require device read permission
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/tags.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/tags.ts)

Summary:
- Tag listing and tagged-device lookup now require `devices:read`.

### R-015: Custom-field definition routes now require explicit device permissions, with MFA on mutation
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/customFields.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/customFields.ts)

Summary:
- Custom-field reads now require `devices:read`.
- Custom-field create/update/delete now require `devices:write` plus MFA.

### R-016: Device metrics summary routes now require device read permission
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/metrics.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/metrics.ts)

Summary:
- The organization/partner metrics summary and trends endpoints now require `devices:read`.

### R-017: Saved-filter routes now require explicit device permissions, with MFA on mutation
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/filters.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/filters.ts)

Summary:
- Filter listing, retrieval, and preview routes now require `devices:read`.
- Filter create/update/delete routes now require `devices:write` plus MFA.

### R-018: Reliability scoring routes now require device read permission
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/reliability.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/reliability.ts)

Summary:
- Reliability list, org summary, device detail, and device history routes now require `devices:read`.

### R-019: Known-guest partner routes now require org RBAC, with MFA on mutation
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/networkKnownGuests.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/networkKnownGuests.ts)

Summary:
- Known-guest reads now require `organizations:read`.
- Known-guest add/delete operations now require `organizations:write` plus MFA.

### R-020: Playbook and playbook-execution routes now enforce device RBAC, with MFA on execution changes
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/playbooks.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/playbooks.ts)

Summary:
- Playbook and playbook-execution reads now require `devices:read`.
- Playbook execution creation and execution-state mutation now require `devices:execute` plus MFA, in addition to per-playbook required-permission checks.

### R-021: Device-group routes now require explicit device permissions, with MFA on group and membership mutation
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/groups.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/groups.ts)

Summary:
- Group list/detail, device membership listing, preview, and membership-log reads now require `devices:read`.
- Group CRUD, membership add/remove, and pin/unpin operations now require `devices:write` plus MFA.

### R-022: Fleet log routes now enforce device RBAC, with MFA on correlation execution and saved-query mutation
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/logs.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/logs.ts)

Summary:
- Log search, aggregation, trends, correlation listing, detection-job status, and saved-query reads now require `devices:read`.
- Correlation detection now requires `devices:execute` plus MFA.
- Saved-query create/delete operations now require `devices:write` plus MFA.

### R-023: Plugin catalog and installation routes now require org RBAC, with MFA on installation changes
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/plugins.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/plugins.ts)

Summary:
- Plugin catalog, installation list/detail, and plugin-log reads now require `organizations:read`.
- Install, update, uninstall, enable, and disable operations now require `organizations:write` plus MFA.

### R-024: Remaining SNMP routes now require explicit device RBAC, with MFA on mutation paths
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/snmp.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/snmp.ts)

Summary:
- SNMP template, OID-browser, dashboard, and deprecated GET compatibility routes now require `devices:read`.
- SNMP template mutation and deprecated non-GET compatibility routes now require `devices:write` plus MFA.

### R-025: Automation routes now require explicit automation RBAC, with MFA on mutation and manual trigger
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/automations.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/automations.ts)

Summary:
- Automation list/detail/run-history reads now require `automations:read`.
- Legacy automation create/update/delete and manual trigger routes now require `automations:write` plus MFA.

### R-026: AI assistant session routes now require org-scoped RBAC, with MFA on write and approval actions
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/ai.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/ai.ts)

Summary:
- AI session listing, history, usage, admin-read, and search routes now require `organizations:read`.
- AI session creation, mutation, flagging, messaging, interrupt, approval, planning, and budget updates now require `organizations:write` plus MFA.

### R-027: Script-builder AI routes now require script RBAC, with MFA on write and approval actions
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/scriptAi.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/scriptAi.ts)

Summary:
- Script-builder session reads now require `scripts:read`.
- Script-builder session creation, close, messaging, interrupt, and approval routes now require `scripts:write` plus MFA.

### R-028: Agent-version admin routes now require explicit admin RBAC plus MFA
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentVersions.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/agentVersions.ts)

Summary:
- System-scoped agent-version creation and GitHub sync now additionally require `organizations:write` plus MFA.
- Public version lookup and download routes remain unauthenticated for agent update delivery.

### R-029: Device-change history routes now require device read permission
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/changes.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/changes.ts)

Summary:
- Change-log listing now requires `devices:read` in addition to org scoping.

### R-030: Software inventory routes now require explicit device RBAC, with MFA on allow/deny/clear mutation
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/softwareInventory.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/softwareInventory.ts)

Summary:
- Inventory listing and per-software device drill-down now require `devices:read`.
- Quick allow, deny, and clear operations now require `devices:write` plus MFA because they mutate policy state.

### R-031: Software policy routes now require explicit device RBAC, with MFA on policy changes and execution
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/softwarePolicies.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/softwarePolicies.ts)

Summary:
- Policy listing, detail, violations, and compliance overview now require `devices:read`.
- Policy create, update, and delete now require `devices:write` plus MFA.
- Compliance check and remediation triggers now require `devices:execute` plus MFA.

### R-032: Analytics routes now enforce explicit read/write separation, with MFA on dashboard and SLA mutation
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/analytics.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/analytics.ts)

Summary:
- Analytics queries, dashboards reads, capacity, SLA reads, executive summary, and OS distribution now require `devices:read`.
- Dashboard, widget, and SLA creation/update/delete now require `organizations:write` plus MFA.

### R-033: Discovery routes now require explicit device RBAC, with MFA on asset/profile mutation and scan control
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/discovery.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/discovery.ts)

Summary:
- Discovery profile, job, asset, and topology reads now require `devices:read`.
- Profile and asset mutation routes now require `devices:write` plus MFA.
- Scan scheduling and job cancellation now require `devices:execute` plus MFA.

### R-034: Network-monitor routes now require explicit device RBAC, with MFA on mutation and active checks
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/monitors.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/monitors.ts)

Summary:
- Monitor listing, dashboard, detail, results, and alert-rule reads now require `devices:read`.
- Monitor and alert-rule create/update/delete now require `devices:write` plus MFA.
- Active check and test routes now require `devices:execute` plus MFA.

### R-035: Audit-log routes now require dedicated audit permissions, with MFA on export
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/auditLogs.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/auditLogs.ts)

Summary:
- Audit-log list, detail, search, report, and stats routes now require `audit:read`.
- Audit-log export routes now require `audit:export` plus MFA.

### R-036: DR plan and execution routes now require explicit device RBAC, with MFA on mutation and execution control
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/dr.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/dr.ts)

Summary:
- DR plan and execution reads now require `devices:read`.
- DR plan and group mutation now require `devices:write` plus MFA.
- DR execution start and abort now require `devices:execute` plus MFA.

### R-037: Global search now filters results by the caller's per-resource permissions
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/search.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/search.ts)

Summary:
- Device, script, and alert search queries now run only when the caller holds the corresponding `devices:read`, `scripts:read`, or `alerts:read` permission.
- The user-management settings entry is now hidden unless the caller has `users:read`.

### R-038: System config-status now requires explicit org read permission
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/system.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/system.ts)

Summary:
- The partner/system-only config-status route now additionally requires `organizations:read`.
- The harmless version route and the self-service setup-complete route remain authenticated but intentionally self-scoped.

### R-039: Agent WebSocket result routing now binds persistent results to the dispatched agent and expected target
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts)

Summary:
- SNMP and monitor orphaned results now require a cached server-side expectation bound to the dispatching agent and target resource before downstream state is updated.
- Discovery UUID job results now reject submissions from agents other than the agent assigned to the discovery job.

### R-040: Remote desktop file-drop now uses a private receive directory and fail-closed file creation semantics
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/filedrop/handler.go](/Users/toddhebebrand/breeze/agent/internal/remote/filedrop/handler.go)

Summary:
- Viewer-uploaded files now land in a dedicated private receive directory instead of the global temp directory.
- Incoming files are created with exclusive `0600` permissions, duplicate transfer IDs are rejected, chunk payloads are size-limited, incomplete transfers are discarded, and in-progress partial files are removed on session cleanup.

### R-041: Remote desktop clipboard sync now enforces payload size bounds before decode and apply
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/clipboard/sync.go](/Users/toddhebebrand/breeze/agent/internal/remote/clipboard/sync.go)

Summary:
- Clipboard messages are now rejected when the JSON envelope or decoded text/RTF/image content exceeds explicit size limits.
- The same size limits also apply on send, which prevents large local clipboard content from being mirrored into the remote session without bounds.

### R-042: Remote desktop input and control channels now reject oversized viewer messages
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/desktop/session_control.go](/Users/toddhebebrand/breeze/agent/internal/remote/desktop/session_control.go)

Summary:
- Input-event messages and control-channel messages now fail closed when the JSON payload exceeds small protocol-appropriate limits.
- This removes an easy memory and log-amplification DoS path from the viewer-to-agent WebRTC control plane.

### R-043: Clipboard size limits now apply consistently across WebRTC sync, service proxying, and helper IPC
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/clipboard/clipboard.go](/Users/toddhebebrand/breeze/agent/internal/remote/clipboard/clipboard.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/clipboard/clipboard_proxy.go](/Users/toddhebebrand/breeze/agent/internal/remote/clipboard/clipboard_proxy.go)
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go)

Summary:
- The clipboard size policy is now centralized and enforced before oversized clipboard content crosses the service/helper IPC boundary in either direction.
- This closes the gap where the WebRTC clipboard path was bounded but helper-mediated clipboard reads and writes were still trusting larger payloads.

### R-044: Desktop capture proxy now validates helper-reported frame dimensions with overflow-safe arithmetic
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/desktop/capture_proxy.go](/Users/toddhebebrand/breeze/agent/internal/remote/desktop/capture_proxy.go)

Summary:
- Helper-reported capture dimensions are now validated using pre-multiplication overflow checks before computing expected RGBA buffer size.
- This removes reliance on platform integer-overflow behavior when rejecting malformed or corrupted helper capture responses.

### R-045: File listing now streams directory entries with an explicit cap instead of materializing entire directories
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go)

Summary:
- `file_list` now reads directory entries incrementally and caps the returned entry count, marking responses as truncated when the directory exceeds the limit.
- This removes an easy memory and latency DoS path where a caller could force the agent to fully enumerate and allocate very large directories in one response.

### R-046: Terminal write operations now reject oversized input payloads
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/terminal.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/terminal.go)

Summary:
- `terminal_data` now enforces a maximum input size before writing to the PTY/session.
- This reduces the risk of oversized IPC/UI payloads being used to flood terminal sessions or force large transient allocations in the terminal tool wrapper.

### R-047: Terminal size handling now clamps caller-supplied dimensions before PTY operations
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/terminal.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/terminal.go)

Summary:
- `terminal_start` and `terminal_resize` now normalize `cols` and `rows` into sensible bounds before converting them to `uint16`.
- This removes wraparound behavior where negative or extreme caller input could turn into nonsensical PTY sizes after integer conversion.

### R-048: File writes now enforce an explicit payload-size limit, including base64 pre-decode checks
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go)

Summary:
- `file_write` now rejects oversized text and base64 payloads before decoding or writing them to disk.
- This aligns write behavior with the existing read-size discipline and reduces the risk of using the file-write tool as a large-payload memory or disk-pressure primitive.

### R-049: Filesystem-analysis resume state now caps checkpoint and target-directory fan-out
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/filesystem_analysis.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/filesystem_analysis.go)

Summary:
- Filesystem-analysis checkpoint output is now capped to a bounded number of pending directories, and checkpoint/target-directory input is similarly capped on ingest.
- This reduces the chance that resume-state bookkeeping dominates the IPC payload or becomes a caller-controlled amplification vector during partial scans.

### R-050: Sessionbroker now enforces expected response types for pending helper commands
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/session.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/session.go)

Summary:
- Pending helper commands now track the response type they expect, and mismatched response types are dropped instead of satisfying the request by command ID alone.
- This tightens the helper IPC trust boundary so an unexpected helper message cannot complete the wrong pending operation just by reusing the same ID.

### R-051: Sensitive-data scan now caps include/exclude/suppress path fan-out in caller-provided scope
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/sensitive_data_scan.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/sensitive_data_scan.go)

Summary:
- Caller-provided include, exclude, and suppress path lists are now bounded before they are normalized into scan scope.
- This reduces payload amplification and keeps path-heavy scope configuration from dominating scan setup work.

### R-052: Sensitive-data scan now caps caller-controlled file-type, rule-toggle, and pattern-suppression sets
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/sensitive_data_scan.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/sensitive_data_scan.go)

Summary:
- File-type filters, rule toggles, and explicit pattern suppressions are now bounded when building the effective scan configuration.
- This keeps the user-controlled configuration surface proportional to the small fixed pattern catalog the scanner actually supports.

### R-053: Sensitive-data scan now bounds suppression regex compilation by count and pattern length
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/sensitive_data_scan.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/sensitive_data_scan.go)

Summary:
- Suppression regex lists are now capped, and oversized regex patterns are ignored before compilation.
- This reduces the risk of handing the scanner an arbitrarily large regex-compilation workload through scope configuration alone.

### R-054: Screenshot responses now fail closed when encoded output still exceeds the intended size budget
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/screenshot.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/screenshot.go)

Summary:
- After re-encoding at lower quality, screenshots are now rejected if the base64 payload still exceeds the response budget instead of silently returning an oversized payload.
- This keeps screenshot transport behavior aligned with the rest of the tool-layer result-size hardening.

### R-055: Event-log PowerShell filters now escape caller-controlled strings before command construction
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/eventlogs_windows.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/eventlogs_windows.go)

Summary:
- Event-log queries and entry lookups now escape caller-controlled log names and provider names before embedding them into single-quoted PowerShell filter strings.
- This removes a straightforward PowerShell command-injection path where an attacker-controlled quote could break out of the intended filter expression.

### R-056: Event-log queries now cap caller-controlled pagination and truncate oversized event fields
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/eventlogs.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/eventlogs.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/eventlogs_windows.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/eventlogs_windows.go)

Summary:
- Event-log query page depth is now capped before it can inflate the `page * limit` PowerShell fetch window.
- Event-log list/query responses now also truncate oversized log names, sources, and message bodies and surface a `truncated` flag in the response payload.

### R-057: Registry enumeration now caps subkey and value counts per response
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/registry_windows.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/registry_windows.go)

Summary:
- Registry key and value listing now uses bounded enumeration calls instead of unbounded `ReadSubKeyNames(-1)` and `ReadValueNames(-1)`.
- Responses now expose truncation explicitly, which prevents registry-heavy paths from using unbounded enumeration as a memory and JSON amplification primitive.

### R-058: Registry value reads now fail closed on oversized raw values and omit oversized entries from list payloads
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/registry_windows.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/registry_windows.go)

Summary:
- Single-value reads now reject registry blobs above the configured size budget instead of allocating arbitrarily large buffers.
- Value listings now replace oversized data with a bounded placeholder and truncate long rendered string payloads before marshalling them into tool output.

### R-059: Scheduled-task list, detail, and history responses now enforce count and field-size bounds
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/tasks_windows.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/tasks_windows.go)

Summary:
- Scheduled-task listing now limits the PowerShell task enumeration itself before the agent parses the output, instead of always materializing the full task set.
- Task detail/history responses now truncate oversized names, descriptions, action paths/arguments, trigger schedules, and history messages, and list responses expose a `truncated` flag.

### R-060: Process list and detail responses now truncate oversized command lines and other caller-visible fields
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/processes.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/processes.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/result_limits.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/result_limits.go)

Summary:
- Process list responses now sanitize process names, users, statuses, and command lines before marshalling them into tool output.
- Single-process detail responses now apply the same bounds, which prevents unusually large command lines from becoming an unbounded response payload.

### R-061: Service list and detail responses now enforce count and field-size bounds
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/services.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/services.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/result_limits.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/result_limits.go)

Summary:
- Service lists are now capped to a bounded number of entries and expose a `truncated` flag when the result set exceeds that cap.
- Service names, accounts, executable paths, and descriptions are now truncated before being serialized, reducing the chance that a pathological service definition dominates the response payload.

### R-062: Service search and action routes now bound caller-controlled identifier strings before use
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/services.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/services.go)

Summary:
- Caller-controlled `search`, `status`, and `name` values are now truncated to a small bounded size before they are used for filtering or passed to OS-specific service handlers.
- This keeps service-management request costs proportional and avoids handing very large opaque identifiers down into platform-specific process invocation paths.

### R-063: Computer-action input now rejects oversized typed text, key names, and modifier lists
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/computer_action.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/computer_action.go)

Summary:
- `computer_action` now validates the size of `text`, `key`, and `modifiers` before replaying input events on the endpoint.
- This removes an easy way to turn the tool into a very large keystroke-replay and allocation primitive by submitting oversized strings or modifier arrays.

### R-064: Software install now requires HTTPS and bounds installer inputs and output logs
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/result_limits.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/result_limits.go)

Summary:
- Software install downloads now require HTTPS rather than allowing cleartext HTTP transport for installer binaries.
- Installer metadata, silent-install arguments, and captured installer output are now bounded before execution and response serialization, with oversized logs truncated and flagged.

### R-065: Software install now validates redirect targets instead of trusting the default HTTP redirect chain
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go)

Summary:
- The installer download path now uses an explicit redirect policy that revalidates every redirect target and blocks downgrades away from HTTPS.
- This closes the gap where an initially valid HTTPS URL could still redirect the agent onto an insecure or malformed final download URL.

### R-066: Software install now rejects unsupported file types before downloading arbitrary files to disk
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go)

Summary:
- The install path now allowlists the supported installer types (`exe`, `msi`, `deb`, `pkg`, `dmg`) during input validation.
- This prevents the agent from downloading arbitrary unsupported payloads only to reject them later at execution time.

### R-067: Software install now validates checksum format before using it as an integrity control
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go)

Summary:
- Caller-provided checksums must now be valid 64-character SHA-256 hex strings before the agent accepts them as an integrity assertion.
- This tightens the install contract and avoids treating malformed checksum input as if it were a meaningful verification value.

### R-068: Software uninstall now rejects option-like package names and versions before invoking native package managers
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/software.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/software.go)

Summary:
- Software uninstall now rejects names and versions that begin with `-`, in addition to the earlier unsafe-character checks.
- This closes an argument-injection path where option-like values could be forwarded into `apt-get`, `pacman`, `brew`, or similar native uninstall commands as unintended flags.

### R-069: Software uninstall now truncates command output and caps the aggregated error summary
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/software.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/software.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/result_limits.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/result_limits.go)

Summary:
- Uninstall attempts now truncate large package-manager output before it is reflected back into the tool error path, and the final joined error summary is also bounded.
- This prevents uninstall failures from becoming another unbounded stdout/stderr amplification surface when package managers emit very large error text.

### R-070: Software install now requires the declared file type to match the provided filename extension
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go)

Summary:
- Install requests now validate that `fileName` ends in the extension implied by `fileType` before downloading or executing the payload.
- This tightens the install contract and prevents mismatched metadata from steering the execution path in surprising ways.

### R-071: Software install now rejects malformed silent-install argument strings before execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go)

Summary:
- `silentInstallArgs` now rejects control characters and unmatched quotes before it reaches the simplistic local argument splitter.
- This reduces the risk of malformed argument strings being interpreted unpredictably by the installer wrapper.

### R-072: MSI installation now always executes `msiexec` directly instead of letting arguments choose the binary
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go)

Summary:
- The MSI code path now always launches `msiexec` and builds its argument list separately, even if the caller supplied a string starting with `msiexec`.
- This closes a command-selection gap where the caller-controlled argument string could previously influence which executable the agent launched on the endpoint.

### R-073: Linux delayed agent restart no longer relies on a shell wrapper
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/agent_restart_linux.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/agent_restart_linux.go)

Summary:
- The Linux delayed restart helper now uses `systemd-run --on-active=3 -- systemctl restart ...` directly instead of spawning `bash -c`.
- This removes unnecessary shell indirection from the agent-restart path and narrows the execution surface to explicit command arguments.

### R-074: Windows delayed agent restart now uses a more constrained PowerShell invocation
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/agent_restart_windows.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/agent_restart_windows.go)

Summary:
- The Windows delayed restart helper now runs PowerShell in `-NonInteractive` mode and targets the service explicitly with `Restart-Service -Name`.
- This keeps the remaining scripted restart helper tighter and less dependent on interactive shell behavior.

### R-075: Drive-list responses now enforce entry and field-size bounds
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/result_limits.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/result_limits.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/drives_other.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/drives_other.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/drives_darwin.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/drives_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/drives_windows.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/drives_windows.go)

Summary:
- Drive enumeration responses now cap the number of reported drives and truncate oversized mount points, labels, filesystem names, and drive-type strings.
- This keeps pathological mount metadata from turning the drive-list tool into another oversized JSON response surface.

### R-076: Linux service-list parsing now uses bounded scanners and fails closed on parse errors
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/services_linux.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/services_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/result_limits.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/result_limits.go)

Summary:
- The Linux `systemctl list-units` parser now uses an explicit scanner buffer budget and returns an error if parsing fails instead of silently truncating the result set.
- This removes a parser-failure blind spot where one oversized line could stop scanning without the caller learning that the list was incomplete.

### R-077: Linux `systemctl show` property parsing now reports scanner failures instead of silently dropping fields
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/services_linux.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/services_linux.go)

Summary:
- `parseSystemctlProperties` now returns an error on scanner failure, and `getServiceOS` propagates that failure to the caller.
- This makes the service-detail path fail closed when unexpectedly large or malformed `systemctl` output breaks parsing.

### R-078: macOS `launchctl list` parsing now uses bounded scanners and reports parse failures
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/services_darwin.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/services_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/result_limits.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/result_limits.go)

Summary:
- The macOS service-list parser now uses the same bounded scanner policy and returns an explicit parse error instead of silently returning a partial list.
- This closes the same scanner-limit blind spot on the `launchctl` path.

### R-079: MSI install arguments now reject uninstall, repair, and administrative-action switches
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/software_install.go)

Summary:
- MSI install requests now reject action switches such as `/x`, `/uninstall`, `/a`, and `/f` in `silentInstallArgs`.
- This prevents the install endpoint from being repurposed into an MSI uninstall, repair, or administrative-image action by caller-controlled arguments.

### R-080: macOS delayed agent restart no longer depends on a shell wrapper
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/agent_restart.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/agent_restart.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/agent_restart_darwin.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/agent_restart_darwin.go)
- [/Users/toddhebebrand/breeze/agent/cmd/breeze-agent/internal_restart_cmd.go](/Users/toddhebebrand/breeze/agent/cmd/breeze-agent/internal_restart_cmd.go)

Summary:
- The macOS delayed restart path now spawns a detached hidden helper subcommand from the current binary instead of using `bash -c "sleep ... && launchctl ..."`.
- This removes the last shell wrapper from the agent-restart path while preserving the delayed restart behavior needed to flush the command response before the service restarts.

### R-081: helper notifications now bound title, body, and icon sizes before invoking OS-specific notifiers
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_common.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_common.go)
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_linux.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_darwin.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_windows.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_windows.go)

Summary:
- Notification requests are now normalized through a shared sanitizer that trims and caps the title, body, and icon fields before they are passed to `notify-send`, `osascript`, or PowerShell.
- This reduces argv and script-injection pressure from oversized caller-controlled notification payloads.

### R-082: helper notifications now cap action counts and normalize urgency values
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_common.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_common.go)

Summary:
- Notification actions are now capped to a small fixed count, and urgency is normalized to an allowlist of `low`, `normal`, or `critical`.
- This prevents unsupported or attacker-influenced notification metadata from becoming another loosely validated execution surface inside helper-side OS integrations.

### R-083: Windows toast notifications now run PowerShell in non-interactive mode
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_windows.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_windows.go)

Summary:
- The Windows notification helper now invokes PowerShell with `-NonInteractive` in addition to `-NoProfile`.
- This keeps the toast path more constrained and avoids depending on interactive shell behavior for a background helper operation.

### R-084: service-control commands now reject malformed service identifiers before invoking native service managers
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/services.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/services.go)

Summary:
- `get/start/stop/restart service` now reject identifiers with traversal markers, path separators, whitespace-padding, or control characters instead of truncating and forwarding them into `systemctl` or `launchctl`.
- This tightens the service-control surface and prevents malformed names from steering service-manager lookups in surprising ways.

### R-085: scheduled-task operations now validate task folders and task paths before use
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/tasks.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/tasks.go)

Summary:
- Scheduled-task commands now require canonical `\\...` task paths/folders and reject traversal markers and control characters before they reach the Windows task wrappers.
- This narrows the task-control input boundary instead of trusting raw caller-provided identifiers throughout the task toolchain.

### R-086: trash listings now cap the number of returned items and expose truncation explicitly
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/types.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/types.go)

Summary:
- `file_trash_list` now caps the number of returned items and marks the response as `truncated` when the trash contains more entries than the transport budget should return.
- This prevents a large trash directory from turning the file-ops response into another unbounded JSON amplification surface.

### R-087: trash metadata reads now enforce a size budget before list, restore, or lazy-purge parsing
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go)

Summary:
- Trash metadata files are now size-checked before `json.Unmarshal` in list, restore, and lazy-purge flows.
- This closes a remaining local DoS path where a corrupted or oversized metadata file could force unnecessary memory allocation during routine trash operations.

### R-088: trash purge now caps the number of returned per-item error strings
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go)

Summary:
- `file_trash_purge` now limits how many per-item error strings are accumulated into the response payload.
- This keeps purge failures from reflecting unbounded error arrays back through the remote tool channel when the trash contains many failing entries.

### R-089: broker self-hash computation now streams the agent binary instead of reading it fully into memory
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go)

Summary:
- The session broker now hashes its own executable through a streaming SHA-256 helper after verifying that the path is a regular file.
- This removes an avoidable whole-file memory read from the helper-integrity path and makes the broker more resilient to unexpectedly large binaries.

### R-090: Linux session detection now runs `loginctl` enumeration under explicit command timeouts
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_linux.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)

Summary:
- The Linux detector now executes both `loginctl list-sessions` and per-session `loginctl show-session` calls through bounded `CommandContext` timeouts.
- This prevents a hung session-enumeration subprocess from stalling the detector loop indefinitely.

### R-091: Linux session detection now uses bounded scanners and reports parser failures instead of silently truncating state
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_linux.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)

Summary:
- The Linux detector now parses `loginctl` output with an explicit scanner buffer budget and returns errors on scanner failure instead of silently accepting partial output.
- This removes another oversized-output blind spot from a trust boundary that feeds helper-spawning and session-targeting logic.

### R-092: detected-session snapshots now validate field contents and cap total session fan-out
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_linux.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_linux.go)

Summary:
- Detected session usernames, session IDs, display names, seat names, and state/type fields now pass through a shared validator, and the detector caps the number of returned sessions.
- This prevents malformed or oversized session metadata from flowing unchecked into the broker’s session-selection logic.

### R-093: macOS no-CGO session detection now uses timed subprocesses for console user and UID lookup
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin_nocgo.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin_nocgo.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)

Summary:
- The macOS fallback detector now runs `stat` and `id -u` with explicit timeouts instead of untimed child processes.
- This keeps the no-CGO detector from hanging indefinitely when the local command path misbehaves.

### R-094: macOS no-CGO session detection now validates the console username and normalizes the returned session shape
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin_nocgo.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin_nocgo.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)

Summary:
- The fallback detector now validates the console username, parses the UID with `strconv`, and returns a sanitized `DetectedSession` with an explicit `console` type.
- This tightens the contract on the darwin no-CGO path instead of trusting raw command output as already well-formed.

### R-095: the broker now drops unmatched response-only helper messages instead of forwarding them into higher layers
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go)

Summary:
- Unmatched `command_result`, `notify_result`, and `clipboard_data` envelopes are now explicitly dropped rather than forwarded to the heartbeat as unsolicited helper messages.
- This narrows the broker’s message surface and removes a class of stray or spoofed response packets that had no legitimate unsolicited consumer.

### R-096: the broker now enforces scope checks on unsolicited tray, desktop, and backup helper messages
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go)

Summary:
- The broker now requires the relevant helper scope before forwarding unsolicited `tray_action`, `sas_request`, `desktop_peer_disconnected`, and backup progress/result messages.
- This makes the unsolicited IPC path fail closed if a helper tries to emit message families outside the role it authenticated for.

### R-097: the macOS TCC dialog path now uses escaped AppleScript strings and bounded command execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/tcc_darwin.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/tcc_darwin.go)

Summary:
- The TCC dialog path now feeds its message text through the existing AppleScript string escaper and runs `osascript` under an explicit timeout.
- This keeps the consent prompt path tighter and avoids indefinite blocking on a GUI scripting subprocess.

### R-098: the macOS TCC System Settings opener now uses an allowlisted permission-to-URL mapper and bounded `open` execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/tcc_common.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/tcc_common.go)
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/tcc_darwin.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/tcc_darwin.go)

Summary:
- Opening System Settings now goes through a small allowlisted permission-to-URL mapper and invokes `open` under a bounded timeout.
- This removes any chance of the TCC helper path turning arbitrary permission labels into unchecked URL launches.

### R-099: the user-helper self-integrity hash now streams executable bytes instead of reading the whole binary into memory
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go)

Summary:
- The user helper now computes its self-hash through a streaming SHA-256 helper instead of reading the full executable into memory before hashing.
- This aligns the helper-side integrity check with the broker-side hardening and removes another avoidable whole-file read from the auth path.

### R-100: the CGO macOS session detector now sanitizes the console snapshot before returning it
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)

Summary:
- The CGO-backed macOS detector now runs the console user snapshot through the same shared detected-session validator used by the hardened Linux and no-CGO darwin paths.
- This brings the last darwin detector variant up to the same field-validation standard before session metadata reaches helper lifecycle decisions.

### R-101: the CGO macOS session watch loop now normalizes console-user transitions instead of trusting raw C strings
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin.go)

Summary:
- The watch loop now sanitizes both initial and current console-user snapshots before emitting login/logout events.
- This keeps malformed or unexpected console-user values from bypassing the detected-session validation path during live transition handling.

### R-102: Windows session detection now caps the number of enumerated sessions returned to the broker
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_windows.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)

Summary:
- The Windows detector now stops after a bounded number of sanitized session entries instead of reflecting arbitrarily large WTS enumerations.
- This keeps the Windows session snapshot surface aligned with the same result-budget policy used on other detector implementations.

### R-103: Windows detected-session fields now pass through shared normalization before entering broker state
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_windows.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)

Summary:
- Windows session IDs, display names, states, types, and usernames are now validated and size-bounded before they are appended to the detected-session list.
- This closes the last cross-platform gap where detector output was still treated as implicitly trustworthy on one platform.

### R-104: Windows session IDs now use a strict shared parser instead of loose `%d` parsing
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go)

Summary:
- Windows session identifiers now have a dedicated parser that rejects whitespace, non-digits, negative values, and oversized inputs.
- This avoids the lenient `%d` parsing behavior that could previously accept malformed session strings in downstream Windows-session control paths.

### R-105: disconnect-state checks now fail closed on malformed Windows session IDs
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_windows.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go)

Summary:
- `IsSessionDisconnected` now uses the strict Windows session-ID parser before issuing the WTS query.
- This removes another loose parsing path from a helper-targeting decision that determines whether a session is safe to reuse for capture.

### R-106: `list_sessions` now skips malformed session identifiers instead of silently coercing them to session `0`
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go)

Summary:
- The heartbeat-side `list_sessions` response builder now parses session IDs strictly and drops malformed entries rather than letting `fmt.Sscanf` default them to zero.
- This prevents corrupted detector output from being misreported as the privileged services session in API-facing session listings.

### R-107: helper spawning now validates explicit target Windows session IDs before invoking the spawner
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop_helper.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop_helper.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go)

Summary:
- The desktop-helper spawn path now validates `targetSession` with the strict session-ID parser before converting it to the numeric session handle used by the Windows spawner.
- This narrows a remaining trust boundary where caller-influenced session strings still flowed into session-targeted helper creation.

### R-108: helper-originated desktop-disconnect notices now require a valid session ID format before they affect API state
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/heartbeat.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/heartbeat.go)

Summary:
- Desktop peer-disconnect notices are now checked against a bounded session-ID pattern before the heartbeat forwards them toward the API.
- This prevents malformed helper-originated session identifiers from mutating remote-session state or log streams.

### R-109: helper-originated desktop-disconnect notices are now bound to the recorded owning helper session
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/heartbeat.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/heartbeat.go)
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop_helper.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop_helper.go)

Summary:
- The heartbeat now verifies that a desktop peer-disconnect notice came from the helper session recorded as that desktop session’s owner before forwarding it.
- This closes a cross-session tampering path where one connected desktop-capable helper could previously try to mark another session’s viewer as disconnected.

### R-110: desktop-disconnect notifications sent upstream now refuse invalid session IDs, even if called internally
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/heartbeat.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/heartbeat.go)

Summary:
- The outbound `sendDesktopDisconnectNotification` helper now independently validates the session ID before constructing the WebSocket result.
- This adds a second fail-closed guard on the API-facing path rather than relying only on the caller to have validated the identifier already.

### R-111: macOS GUI-user discovery now uses bounded scanning and validates discovered UIDs before LaunchAgent restart attempts
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop_helper.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop_helper.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go)

Summary:
- The macOS `ps` output parser used for GUI-user discovery now uses a bounded scanner, de-duplicates results, caps the number of discovered UIDs, and rejects malformed numeric IDs.
- This hardens the LaunchAgent kickstart/bootstrap helper path against oversized process listings and malformed UID tokens.

## Suggested Next Audit Targets

1. Continue the heartbeat-side trust-boundary pass in [`/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go`](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go) and related desktop stream/input paths, where more identifier normalization and owner/session correlation may still be possible.
2. Revisit the remaining OS-wrapper and local command enumeration paths, especially any `exec.Command(...).Output()` readers that still parse large local command output without explicit timeouts or result budgeting.
3. If you want the audit to move back up-stack, the remaining natural target is another pass over API-to-agent correlation in [`/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts`](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts) to match the stronger local helper/session binding now in the agent.
