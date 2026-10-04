/**
 * CONTRACT TEST — every state-changing route declares a permission gate.
 *
 * Authentication alone is not authorisation. A POST/PUT/PATCH/DELETE route
 * whose only middleware is `authMiddleware` + `requireScope(...)` admits every
 * signed-in user of the right scope, whatever role they hold. The route looks
 * guarded, so review misses it; this test makes it mechanical.
 *
 * How it works (runtime, not a source grep):
 *   1. Load every router `index.ts` mounts (same discovery as
 *      `routerAuthGate.contract.test.ts`) and compose them on one app in mount
 *      order, so a `.use()` on one router reaches whatever routes really share
 *      its prefix.
 *   2. For each write endpoint, ask Hono's own router which handlers run for a
 *      request to it, up to and including the endpoint — the chain production
 *      executes.
 *   3. Require a handler in that chain to carry the `PERMISSION_GATE` marker
 *      (middleware/permissionGate.ts). `requirePermission()` sets it, as do the
 *      equivalent gates: `platformAdminMiddleware`,
 *      `requireTopologySiteCapability`, `requirePartnerApiScope`,
 *      `requireAddinCapability`, and compositions that wrap
 *      `requirePermission`. A wrapper that returns `requirePermission(...)`
 *      inherits it.
 *
 * Routes legitimately without such a gate — public/pre-login auth, provider
 * webhooks, agent/helper/viewer/portal credentials, the caller's own account,
 * or an equivalent check inside the handler — are listed in
 * WRITE_ROUTES_WITHOUT_PERMISSION_GATE with a one-line reason. A new route
 * cannot join silently, and an entry whose route gains a gate (or disappears)
 * must be removed, so the list only shrinks. Before adding an entry, prefer
 * adding `requirePermission(...)` to the route.
 *
 * Out of scope: `.all()` endpoints (Hono records them exactly like `.use()`
 * middleware). The `ee/workspace` routers have their own copy of this
 * contract (`ee/workspace/src/routes/writeRouteGate.contract.test.ts`).
 *
 * Plain unit test: no database. Route modules are imported, not served.
 */
import { Hono } from 'hono';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { permissionGateLabel } from '../middleware/permissionGate';
import {
  chargingMounts,
  indexCallsChargingMount,
  indexMounts,
  indexRouteCallCount,
  loadMountedRouter,
} from './helpers/indexMounts';

// Opt-in routers register their real routes only when enabled, and some read
// the flag at import time, so set it before any route module loads.
// Vitest isolates each test file, so this does not reach other suites.
vi.hoisted(() => {
  process.env.MCP_OAUTH_ENABLED = 'true';
  process.env.SYNTHETIC_TEST_TOKEN ??= 'write-route-permission-contract-token';
});

/**
 * `METHOD /full/path` → why the route has no permission-gate middleware.
 * Grouped by the file that defines the route. Prefix says which kind:
 *   public / webhook / device credential / portal session — not a staff JWT;
 *   own account — acts only on the caller's own user, session or devices;
 *   equivalent check — authorised by a named check the marker cannot see;
 *   no state change — writes nothing despite the method.
 */
const WRITE_ROUTES_WITHOUT_PERMISSION_GATE: Record<string, string> = {
  // routes/accounting/connectionSetupRoutes.ts
  'POST /api/v1/accounting/:provider/tenants/select': 'equivalent check: guard chain: requireAccountingManage (accounting:manage) + partner authority + MFA',
  'POST /api/v1/accounting/:provider/tenants/cancel': 'equivalent check: guard chain: requireAccountingManage (accounting:manage) + partner authority + MFA',
  // routes/actionIntents.ts
  'POST /api/v1/action-intents/:id/reveal-secret': 'equivalent check: Requester-only, else getUserPermissions+userCanDecideApprovals',
  // routes/agents/bootPerformance.ts
  'POST /api/v1/agents/:id/boot-performance': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/changes.ts
  'PUT /api/v1/agents/:id/changes': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/commands.ts
  'POST /api/v1/agents/:id/commands/:commandId/result': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/connections.ts
  'PUT /api/v1/agents/:id/connections': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/elevationRequests.ts
  'POST /api/v1/agents/:id/elevation-requests': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/enrollment.ts
  'POST /api/v1/agents/enroll': 'device credential: Agent enrollment; one-time enrollment secret checked in handler, IP rate limited',
  // routes/agents/eventlogs.ts
  'PUT /api/v1/agents/:id/eventlogs': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/hardwareHealth.ts
  'PUT /api/v1/agents/:id/hardware-health': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/heartbeat.ts
  'POST /api/v1/agents/:id/heartbeat': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  'PUT /api/v1/agents/:id/monitoring-results': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/inventory.ts
  'PUT /api/v1/agents/:id/hardware': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  'PUT /api/v1/agents/:id/software': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  'PUT /api/v1/agents/:id/disks': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  'PUT /api/v1/agents/:id/network': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  'PUT /api/v1/agents/:id/warranty-info': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/logs.ts
  'POST /api/v1/agents/:id/logs': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/mtls.ts
  'POST /api/v1/agents/renew-cert/challenge': 'device credential: agentBearerAuthMiddleware: agent bearer token + mTLS device identity',
  'POST /api/v1/agents/renew-cert': 'device credential: agentBearerAuthMiddleware: agent bearer token + mTLS device identity',
  'POST /api/v1/agents/renew-cert/confirm': 'device credential: agentBearerAuthMiddleware: agent bearer token + mTLS device identity',
  // routes/agents/pamObservations.ts
  'POST /api/v1/agents/:id/commands/:commandId/pam-observations': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/pamReconciliation.ts
  'POST /api/v1/agents/:id/pam/reconciliation-bindings': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/patches.ts
  'PUT /api/v1/agents/:id/patches/pending': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  'PUT /api/v1/agents/:id/patches/installed': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  'PUT /api/v1/agents/:id/patches': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/peripherals.ts
  'PUT /api/v1/agents/:id/peripherals/events': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/processSample.ts
  'POST /api/v1/agents/:id/process-sample': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/recoveryKeys.ts
  'PUT /api/v1/agents/:id/security/recovery-keys': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/reliability.ts
  'POST /api/v1/agents/:id/reliability': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/security.ts
  'PUT /api/v1/agents/:id/security/status': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  'PUT /api/v1/agents/:id/management/posture': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/sessions.ts
  'PUT /api/v1/agents/:id/sessions': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/state.ts
  'PUT /api/v1/agents/:id/registry-state': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  'PUT /api/v1/agents/:id/config-state': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/storageSessions.ts
  'POST /api/v1/agents/:id/storage-sessions/:sessionId/:op': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/timeStatus.ts
  'PUT /api/v1/agents/:id/time-status': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/token.ts
  'POST /api/v1/agents/:id/rotate-token': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  'POST /api/v1/agents/:id/rotate-token/confirm': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/topologyAdjacency.ts
  'POST /api/v1/agents/:id/topology/adjacency': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/unifiTelemetry.ts
  'POST /api/v1/agents/:id/unifi-telemetry': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/agents/uninstallIntent.ts
  'POST /api/v1/agents/:id/uninstall-intent': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
  // routes/ai/scriptProposals.ts
  'POST /api/v1/ai/script-proposals/:id/request-changes': 'equivalent check: loadScriptProposalDetail viewer.canDecide (userCanDecideApprovals)',
  // routes/alerts/alerts.ts
  'POST /api/v1/alerts/bulk': 'equivalent check: Handler getUserPermissions + hasPermission(alerts:write / alerts:acknowledge)',
  // routes/approvals.ts
  'POST /api/v1/approvals/dev/seed': 'own account: dev/test-only; creates caller\'s own approval row, 404 elsewhere',
  'POST /api/v1/mobile/approvals/dev/seed': 'own account: dev/test-only; creates caller\'s own approval row, 404 elsewhere',
  'POST /api/v1/approvals/batch/assertion-challenge': 'own account: own pending rows; live approver authorization checked before nonce',
  'POST /api/v1/mobile/approvals/batch/assertion-challenge': 'own account: own pending rows; live approver authorization checked before nonce',
  'POST /api/v1/approvals/batch/decide': 'equivalent check: decideApprovalBatch: isAgentIntentDecideAuthorized per row + interactive session',
  'POST /api/v1/mobile/approvals/batch/decide': 'equivalent check: decideApprovalBatch: isAgentIntentDecideAuthorized per row + interactive session',
  'POST /api/v1/approvals/:id/assertion-challenge': 'own account: own pending row; resolveRowLiveAuthorization before minting challenge',
  'POST /api/v1/mobile/approvals/:id/assertion-challenge': 'own account: own pending row; resolveRowLiveAuthorization before minting challenge',
  'POST /api/v1/approvals/:id/approve': 'equivalent check: decideApprovalRequest: canAccessOrg + userCanDecideApprovals',
  'POST /api/v1/mobile/approvals/:id/approve': 'equivalent check: decideApprovalRequest: canAccessOrg + userCanDecideApprovals',
  'POST /api/v1/approvals/:id/deny': 'own account: caller denies approval request addressed to themselves',
  'POST /api/v1/mobile/approvals/:id/deny': 'own account: caller denies approval request addressed to themselves',
  'POST /api/v1/approvals/:id/report-suspicious': 'own account: caller flags own approval request',
  'POST /api/v1/mobile/approvals/:id/report-suspicious': 'own account: caller flags own approval request',
  // routes/auth/accountDeletion.ts
  'POST /api/v1/auth/account-deletion-request': 'own account: Caller\'s own deletion request; MFA and password required',
  'PATCH /api/v1/auth/account-deletion-request/:id': 'own account: Cancels caller\'s own deletion request (userId filter)',
  // routes/auth/authTransitionTestControl.ts
  'POST /api/v1/auth/__test/auth-transition/barriers/:barrierId/release': 'public: Test-only hook gated by shared secret header',
  // routes/auth/binding.ts
  'POST /api/v1/auth/browser-binding/bootstrap': 'public: Pre-login browser binding cookie bootstrap',
  // routes/auth/cfAccessRedirectLogin.ts
  'POST /api/v1/auth/cf-access-logout/prepare': 'own account: Prepares caller\'s own terminal logout',
  // routes/auth/invite.ts
  'POST /api/v1/auth/invite/preview': 'no state change: Public invite-token preview, no writes',
  'POST /api/v1/auth/accept-invite': 'public: Pre-login invite acceptance via invite token',
  // routes/auth/login.ts
  'POST /api/v1/auth/login': 'public: Credential login; pre-auth',
  'POST /api/v1/auth/logout': 'own account: Ends the caller\'s own session',
  'POST /api/v1/auth/refresh': 'public: Refresh-token cookie exchange; CSRF checked, no user JWT',
  // routes/auth/mfa.ts
  'POST /api/v1/auth/mfa/setup': 'own account: Caller\'s own TOTP enrollment, re-verified by password or SSO grant',
  'POST /api/v1/auth/mfa/verify': 'public: Login MFA completion via temp token; setup confirm authenticates inline',
  'POST /api/v1/auth/mfa/disable': 'own account: Caller\'s own MFA factor, password re-verified',
  'POST /api/v1/auth/mfa/enable': 'own account: Caller\'s own MFA factor enrollment with step-up',
  'POST /api/v1/auth/mfa/step-up': 'own account: Mints caller\'s own step-up grant; target routes authorize separately',
  'POST /api/v1/auth/mfa/recovery-codes': 'own account: Rotates caller\'s own recovery codes',
  // routes/auth/passkeys.ts
  'POST /api/v1/auth/passkeys/register/options': 'own account: Caller\'s own passkey registration challenge',
  'POST /api/v1/auth/passkeys/register/verify': 'own account: Caller\'s own passkey registration',
  'POST /api/v1/auth/mfa/step-up/options': 'own account: Caller\'s own passkey challenge; no state change',
  'POST /api/v1/auth/mfa/passkey/options': 'public: Login passkey MFA challenge via temp token',
  'POST /api/v1/auth/mfa/passkey/verify': 'public: Login passkey MFA completion via temp token',
  'PATCH /api/v1/auth/passkeys/:id': 'own account: Renames caller\'s own passkey',
  'DELETE /api/v1/auth/passkeys/:id': 'own account: Removes caller\'s own passkey with step-up',
  // routes/auth/password.ts
  'POST /api/v1/auth/forgot-password': 'public: Pre-login password reset request',
  'POST /api/v1/auth/reset-password': 'public: Reset via emailed single-use token',
  'POST /api/v1/auth/change-password': 'own account: Caller\'s own password, current password verified',
  // routes/auth/phone.ts
  'POST /api/v1/auth/mfa/step-up/sms/send': 'own account: Sends SMS code to caller\'s own phone',
  'POST /api/v1/auth/phone/verify': 'own account: Caller\'s own phone verification code',
  'POST /api/v1/auth/phone/confirm': 'own account: Confirms caller\'s own phone number',
  'POST /api/v1/auth/mfa/sms/enable': 'own account: Enables SMS MFA for caller\'s own account',
  'POST /api/v1/auth/mfa/sms/send': 'public: Login SMS code via temp token',
  // routes/auth/register.ts
  'POST /api/v1/auth/register': 'public: Legacy self-signup endpoint; pre-login, rate limited',
  'POST /api/v1/auth/register-partner': 'public: Pre-login partner signup, rate limited and gated',
  // routes/auth/ssoDiscovery.ts
  'POST /api/v1/auth/sso-discovery': 'no state change: Public SSO provider lookup by email domain',
  // routes/auth/testApproval.ts
  'POST /api/v1/auth/me/test-approval': 'own account: Self-addressed sandbox approval push',
  // routes/auth/verifyEmail.ts
  'POST /api/v1/auth/verify-email': 'public: Email verification via emailed token',
  'POST /api/v1/auth/resend-verification': 'own account: Resends caller\'s own verification email',
  // routes/authenticator.ts
  'POST /api/v1/authenticator/register-grant': 'own account: own approver device registration, gated by step-up register grant',
  'POST /api/v1/authenticator/devices/webauthn/options': 'own account: own approver device registration, gated by step-up register grant',
  'POST /api/v1/authenticator/devices/webauthn/verify': 'own account: own approver device registration, gated by step-up register grant',
  'POST /api/v1/authenticator/devices': 'own account: own approver device registration, gated by step-up register grant',
  'POST /api/v1/authenticator/devices/mobile/challenge': 'own account: own approver device registration, gated by step-up register grant',
  'POST /api/v1/authenticator/devices/mobile/verify': 'own account: own approver device registration, gated by step-up register grant',
  'POST /api/v1/me/approver-devices/:id/revoke': 'own account: revokes caller-owned approver device (findOwnedDevice)',
  'PATCH /api/v1/me/approver-devices/:id': 'own account: renames caller-owned approver device',
  // routes/automations.ts
  'POST /api/v1/automations/webhooks/:id': 'webhook: automation webhook secret-verified trigger',
  // routes/autopay/public.ts
  'POST /api/v1/autopay/public/setup-return': 'public: Customer link token resolved by boundary(); no user session',
  'POST /api/v1/autopay/public/:token/setup-session': 'public: Customer link token resolved by boundary(); no user session',
  'POST /api/v1/autopay/public/:token/stop': 'public: Customer link token resolved by boundary(); no user session',
  'POST /api/v1/autopay/public/:token/skip': 'public: Customer link token resolved by boundary(); no user session',
  'POST /api/v1/autopay/public/:token/confirm': 'public: Customer link token resolved by boundary(); no user session',
  // routes/backup/bmr.ts
  'POST /api/v1/backup/bmr/recover/authenticate': 'device credential: bare-metal recovery token/code auth, rate limited, no user JWT',
  'POST /api/v1/backup/bmr/recover/binary-signature': 'device credential: bare-metal recovery token/code auth, rate limited, no user JWT',
  'POST /api/v1/backup/bmr/recover/complete': 'device credential: bare-metal recovery token/code auth, rate limited, no user JWT',
  // routes/backup/bmrRecoveries.ts
  'POST /api/v1/backup/bmr/recover/exchange': 'device credential: bare-metal recovery token/code auth, rate limited, no user JWT',
  'POST /api/v1/backup/bmr/recover/progress': 'device credential: bare-metal recovery token/code auth, rate limited, no user JWT',
  // routes/catalog/enrich.ts
  'POST /api/v1/catalog/polish': 'no state change: Returns AI text suggestion; persists nothing (rate/budget limited)',
  // routes/clientAi/auth.ts
  'POST /api/v1/client-ai/auth/exchange': 'portal session: Pre-auth Entra token exchange for portal end users',
  // routes/clientAi/sessions.ts
  'POST /api/v1/client-ai/sessions': 'portal session: clientAiAuthMiddleware portal-user session',
  'POST /api/v1/client-ai/sessions/:id/close': 'portal session: clientAiAuthMiddleware portal-user session',
  'POST /api/v1/client-ai/sessions/:id/flag': 'portal session: clientAiAuthMiddleware portal-user session',
  'POST /api/v1/client-ai/sessions/:id/messages': 'portal session: clientAiAuthMiddleware portal-user session',
  'POST /api/v1/client-ai/sessions/:id/tool-results': 'portal session: clientAiAuthMiddleware portal-user session',
  // routes/desktopWs.ts
  'POST /api/v1/desktop-ws/connect/exchange': 'device credential: one-time connect code exchange, live access re-authorized',
  'POST /api/v1/desktop-ws/:id/viewer/ws-ticket': 'device credential: viewer access token + session access validation',
  'POST /api/v1/desktop-ws/:id/viewer/offer': 'device credential: viewer access token + session access validation',
  'POST /api/v1/desktop-ws/:id/viewer/lease/renew': 'device credential: viewer access token bound to session owner',
  // routes/devPush.ts
  'POST /api/v1/dev/push': 'equivalent check: devPushAuth wraps requirePermission(DEVICES_EXECUTE)+requireMfa for API key',
  // routes/devices/customFieldValues.ts
  'PATCH /api/v1/devices/:id/custom-fields': 'equivalent check: dualAuth with devices:write permission (+MFA) in-route',
  // routes/eventWs.ts
  'POST /api/v1/events/ws-ticket': 'own account: Mints caller own read-only event-stream ticket; scoped to caller orgs/sites',
  // routes/externalServices.ts
  'POST /api/v1/support': 'own account: emails support as caller; rate limited, no tenant data written',
  // routes/helper/index.ts
  'POST /api/v1/helper/chat/sessions': 'device credential: helperAuth device credential',
  'POST /api/v1/helper/chat/sessions/:id/messages': 'device credential: helperAuth device credential',
  'POST /api/v1/helper/chat/sessions/:id/tool-results': 'device credential: helperAuth device credential',
  'POST /api/v1/helper/screenshots': 'device credential: helperAuth device credential',
  'DELETE /api/v1/helper/chat/sessions/:id': 'device credential: helperAuth device credential',
  'POST /api/v1/helper/chat/sessions/:id/flag': 'device credential: helperAuth device credential',
  // routes/huntress.ts
  'POST /api/v1/huntress/webhook': 'webhook: Huntress webhook; integration lookup + secret/signature verification in handler',
  // routes/installer.ts
  'POST /api/v1/installer/bootstrap': 'device credential: One-time installer bootstrap token',
  'POST /api/v1/installer/bootstrap/cancel': 'device credential: Authenticated by enrollment secret',
  // routes/internal/synthetic.ts
  'POST /api/v1/internal/synthetic/simulate-payment': 'webhook: Bearer secret plus IP allowlist; canary partners only',
  'POST /api/v1/internal/synthetic/purge-partner': 'webhook: Bearer secret plus IP allowlist; canary partners only',
  'POST /api/v1/internal/synthetic/purge-stale-canaries': 'webhook: Bearer secret plus IP allowlist; canary partners only',
  // routes/invoicesPublic.ts
  'POST /api/v1/invoices/public/:token/pay': 'public: public invoice token link / Stripe session id',
  'POST /api/v1/invoices/public/settle-return': 'public: public invoice token link / Stripe session id',
  // routes/lifecycle.ts
  'POST /api/v1/me/mobile-devices/:id/block': 'own account: own mobile device / OAuth grant revoke',
  'POST /api/v1/me/oauth-clients/:clientId/revoke': 'own account: own mobile device / OAuth grant revoke',
  // routes/mcpServer.ts
  'POST /api/v1/mcp/message': 'equivalent check: API-key ai:read preflight + per-tool ai:write/execute scope gates',
  'POST /api/v1/mcp/sse': 'equivalent check: API-key ai:read preflight + per-tool ai:write/execute scope gates',
  'DELETE /api/v1/mcp/sse': 'no state change: session close returns 204, writes nothing',
  // routes/mobile.ts
  'POST /api/v1/mobile/notifications/register': 'own account: Caller\'s own push token registration',
  'POST /api/v1/mobile/notifications/unregister': 'own account: Removes caller\'s own push token (userId filter)',
  'POST /api/v1/mobile/devices': 'own account: Registers caller\'s own mobile device',
  'PATCH /api/v1/mobile/devices/:id/settings': 'own account: Caller\'s own device settings (userId filter)',
  'DELETE /api/v1/mobile/devices/:id': 'own account: Removes caller\'s own mobile device (userId filter)',
  // routes/notifications.ts
  'PATCH /api/v1/notifications/read': 'own account: own notifications only (userId filter)',
  'DELETE /api/v1/notifications/:id': 'own account: own notifications only (userId filter)',
  'DELETE /api/v1/notifications': 'own account: own notifications only (userId filter)',
  // routes/oauthInteraction.ts
  'POST /api/v1/oauth/interaction/:uid/consent': 'own account: user approves an OAuth client for their own account; interaction bound to the submitter',
  // routes/officeAddin/auth.ts
  'POST /api/v1/office-addin/auth/exchange': 'public: Pre-auth Entra token exchange; binding and rate limit checked',
  'POST /api/v1/office-addin/auth/bind': 'public: Pre-auth bind; Entra token plus password and MFA proof',
  // routes/officeAddin/bindingsAdmin.ts
  'DELETE /api/v1/office-addin/bindings/:id': 'equivalent check: canManagePartnerWidePolicies + requireMfa + partner/system scope',
  // routes/partnerTrust.ts
  'POST /api/v1/partner/trust/request-review': 'equivalent check: canManagePartnerWidePolicies + requireScope(partner)',
  // routes/portal/assets.ts
  'POST /api/v1/portal/assets/:id/checkout': 'portal session: portal session auth (portalAuthMiddleware)',
  'POST /api/v1/portal/assets/:id/checkin': 'portal session: portal session auth (portalAuthMiddleware)',
  // routes/portal/auth.ts
  'POST /api/v1/portal/auth/login': 'public: pre-login portal auth endpoint',
  'POST /api/v1/portal/auth/forgot-password': 'public: pre-login portal auth endpoint',
  'POST /api/v1/portal/auth/reset-password': 'public: pre-login portal auth endpoint',
  'POST /api/v1/portal/auth/accept-invite': 'public: pre-login portal auth endpoint',
  'POST /api/v1/portal/auth/logout': 'portal session: portal session auth (portalAuthMiddleware)',
  // routes/portal/invoices.ts
  'POST /api/v1/portal/invoices/:id/pay': 'portal session: portal session auth (portalAuthMiddleware)',
  'POST /api/v1/portal/invoices/:id/settle': 'portal session: portal session auth (portalAuthMiddleware)',
  // routes/portal/paymentMethods.ts
  'POST /api/v1/portal/payment-methods/setup-session': 'portal session: portal session auth + portalFinancialMutationGuard',
  'POST /api/v1/portal/payment-methods/setup-return': 'portal session: portal session auth + portalFinancialMutationGuard',
  'POST /api/v1/portal/autopay/stop': 'portal session: portal session auth + portalFinancialMutationGuard',
  // routes/portal/profile.ts
  'PATCH /api/v1/portal/profile': 'portal session: portal session auth (portalAuthMiddleware)',
  'POST /api/v1/portal/profile/password': 'portal session: portal session auth (portalAuthMiddleware)',
  // routes/portal/quotes.ts
  'POST /api/v1/portal/quotes/:id/accept': 'portal session: portal session auth (portalAuthMiddleware)',
  'POST /api/v1/portal/quotes/:id/decline': 'portal session: portal session auth (portalAuthMiddleware)',
  'POST /api/v1/portal/quotes/:id/pay': 'portal session: portal session auth (portalAuthMiddleware)',
  // routes/portal/reports.ts
  'POST /api/v1/portal/reports/generate': 'portal session: portal session auth (portalAuthMiddleware)',
  // routes/portal/tickets.ts
  'POST /api/v1/portal/tickets': 'portal session: portal session auth (portalAuthMiddleware)',
  'POST /api/v1/portal/tickets/:id/comments': 'portal session: portal session auth (portalAuthMiddleware)',
  'PATCH /api/v1/portal/tickets/:id/comments/:commentId': 'portal session: portal session auth (portalAuthMiddleware)',
  'DELETE /api/v1/portal/tickets/:id/comments/:commentId': 'portal session: portal session auth (portalAuthMiddleware)',
  // routes/quotesPublic.ts
  'POST /api/v1/quotes/public/:token/accept': 'public: Signed public quote link token; single-use claims checked in resolve()',
  'POST /api/v1/quotes/public/:token/decline': 'public: Signed public quote link token; single-use claims checked in resolve()',
  // routes/sso.ts
  'POST /api/v1/sso/link/start/:providerId': 'own account: Starts linking caller\'s own SSO identity; MFA required',
  'POST /api/v1/sso/reauth/start': 'own account: Caller\'s own IdP re-authentication start',
  'POST /api/v1/sso/exchange': 'public: SSO login code exchange; single-use grant',
  'POST /api/v1/sso/link/confirm': 'public: Link confirm via pending-link cookie and password',
  // routes/supportPublic.ts
  'POST /api/v1/support/redeem': 'public: one-time support code redemption, rate limited',
  // routes/system.ts
  'POST /api/v1/system/setup-complete': 'own account: sets caller\'s own setupCompletedAt',
  // routes/tickets/emailWebhook.ts
  'POST /api/v1/webhooks/tickets/email-inbound': 'webhook: Inbound email provider HMAC verified via provider.verify',
  // routes/topology/templateApplications.ts
  'POST /api/v1/topology/template-applications/preview': 'equivalent check: requireTopologySiteAccess(write) per site in service; writes preview journal',
  'POST /api/v1/topology/template-applications': 'equivalent check: requireTopologySiteAccess(write) re-checked per site at apply',
  // routes/topology/templates.ts
  'POST /api/v1/topology/templates': 'equivalent check: hasPermission(topology+devices write)+canManagePartnerWidePolicies in templateLibrary',
  'PATCH /api/v1/topology/templates/:templateId': 'equivalent check: hasPermission(topology+devices write) in templateLibrary service',
  'POST /api/v1/topology/templates/:templateId/versions': 'equivalent check: hasPermission(topology+devices write) in templateLibrary service',
  'POST /api/v1/topology/templates/:templateId/versions/:versionId/publish': 'equivalent check: hasPermission(topology+devices write) in templateLibrary service',
  // routes/tunnels.ts
  'POST /api/v1/tunnels/:id/ws-ticket': 'equivalent check: requireMfa + owner check + authorizeRemoteSessionContinuation (REMOTE_ACCESS/DEVICES_EXECUTE)',
  'POST /api/v1/tunnels/:id/http-ticket': 'equivalent check: requireMfa + owner check + authorizeRemoteSessionContinuation (REMOTE_ACCESS/DEVICES_EXECUTE)',
  'POST /api/v1/tunnels/:id/connect-code': 'equivalent check: requireMfa + owner check + authorizeRemoteSessionContinuation (REMOTE_ACCESS/DEVICES_EXECUTE)',
  'POST /api/v1/vnc-exchange/:code': 'device credential: one-time VNC connect code is the credential; rate limited',
  'POST /api/v1/vnc-viewer/upgrade-to-webrtc': 'device credential: Viewer token (requireViewerToken) plus live session authority re-check',
  'POST /api/v1/vnc-viewer/downgrade-to-vnc': 'device credential: Viewer token (requireViewerToken) plus live session authority re-check',
  // routes/users.ts
  'PATCH /api/v1/users/me/ticket-push-preferences': 'own account: Caller edits own profile/preferences/avatar only (auth.user.id)',
  'PATCH /api/v1/users/me': 'own account: Caller edits own profile/preferences/avatar only (auth.user.id)',
  'POST /api/v1/users/me/avatar': 'own account: Caller edits own profile/preferences/avatar only (auth.user.id)',
  'DELETE /api/v1/users/me/avatar': 'own account: Caller edits own profile/preferences/avatar only (auth.user.id)',
  // routes/webhooks/emailProvider.ts
  'POST /api/v1/webhooks/email-provider/resend': 'webhook: Svix signature verified with configured webhook secret',
  // routes/webhooks/quickbooks.ts
  'POST /api/v1/webhooks/quickbooks': 'webhook: HMAC signature verified against QBO verifier token',
  // routes/webhooks/stripe.ts
  'POST /api/v1/webhooks/stripe/connect': 'webhook: Stripe signature verified',
  // routes/webhooks/xero.ts
  'POST /api/v1/webhooks/xero': 'webhook: Xero HMAC signature verified',
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Hono wraps a sub-app's handlers when that sub-app has its own onError and
// keeps the original under this key (hono/utils/constants COMPOSED_HANDLER).
const COMPOSED_HANDLER = '__COMPOSED_HANDLER';
const SAMPLE_SEGMENTS = ['11111111-1111-4111-8111-111111111111', '1', 'probe'];

type RouterRoute = Hono['routes'][number];
type Handler = RouterRoute['handler'];
type MatchEntry = [[Handler, RouterRoute], unknown];

function unwrap(handler: Handler): Handler {
  let current = handler as Handler & Record<string, Handler | undefined>;
  while (current[COMPOSED_HANDLER]) current = current[COMPOSED_HANDLER] as typeof current;
  return current;
}

/**
 * One `.post(path, a, b, handler)` call registers one route entry per handler,
 * consecutively. Group them back into registrations.
 */
interface Registration {
  key: string;
  entries: Set<RouterRoute>;
  last: RouterRoute;
}

function writeRegistrations(routes: RouterRoute[]): Registration[] {
  const out: Registration[] = [];
  routes.forEach((route, i) => {
    if (!WRITE_METHODS.has(route.method)) return;
    const previous = routes[i - 1];
    const current = out.at(-1);
    if (current && previous === current.last && previous.method === route.method && previous.path === route.path) {
      current.entries.add(route);
      current.last = route;
    } else {
      out.push({ key: `${route.method} ${route.path}`, entries: new Set([route]), last: route });
    }
  });
  return out;
}

/**
 * Handlers that run before the endpoint responds: middleware (`.use()`, i.e.
 * ALL entries) matching the path, plus the registration's own handlers —
 * never another endpoint's handlers, so a gate on a different route that
 * happens to match the sample path is not credited. Null if no sample path
 * reaches the endpoint.
 */
function resolveChain(app: Hono, registration: Registration): Handler[] | null {
  const endpoint = registration.last;
  for (const sample of SAMPLE_SEGMENTS) {
    const path = endpoint.path.replace(/:[A-Za-z_]\w*(?:\{[^}]*\})?\??/g, sample).replace(/\*/g, 'probe') || '/';
    const [matches] = app.router.match(endpoint.method, path) as unknown as [MatchEntry[]];
    const index = matches.findIndex(([[, route]]) => route === endpoint);
    if (index < 0) continue;
    return matches
      .slice(0, index + 1)
      .filter(([[, route]]) => route.method === 'ALL' || registration.entries.has(route))
      .map(([[handler]]) => handler);
  }
  return null;
}

let writeKeys: string[] = [];
let duplicates: string[] = [];
let ungated: string[] = [];
let unresolved: string[] = [];

beforeAll(async () => {
  // Compose exactly as index.ts does: api routers under /api/v1, the rest at
  // the root, in mount order. Hono copies routes at .route() time, so `api`
  // is fully populated before it is mounted.
  const api = new Hono();
  const app = new Hono();
  for (const mount of indexMounts.filter((m) => m.owner === 'api')) {
    api.route(mount.path, await loadMountedRouter(mount.expression, { allowUpgradeWebSocketFactories: true }));
  }
  for (const mount of indexMounts.filter((m) => m.owner === 'app')) {
    const router = mount.expression === 'api'
      ? api
      : await loadMountedRouter(mount.expression, { allowUpgradeWebSocketFactories: true });
    app.route(mount.path, router);
  }

  const registrations = writeRegistrations(app.routes);
  const seen = new Set<string>();
  for (const registration of registrations) {
    if (seen.has(registration.key)) duplicates.push(registration.key);
    seen.add(registration.key);
  }
  writeKeys = [...seen].sort();
  for (const registration of registrations) {
    const chain = resolveChain(app, registration);
    if (!chain) unresolved.push(registration.key);
    else if (!chain.some((handler) => permissionGateLabel(unwrap(handler)) !== undefined)) ungated.push(registration.key);
  }
  ungated.sort();
  unresolved.sort();
}, 300_000); // Cold imports of every route module traverse the whole service graph.

describe('write route permission gate contract', () => {
  it('discovers every index.ts mount and a realistic number of write routes', () => {
    expect(indexCallsChargingMount).toBe(true);
    expect(indexMounts).toHaveLength(indexRouteCallCount + chargingMounts.length);
    // Guards against a vacuous pass if discovery or composition breaks.
    expect(writeKeys.length).toBeGreaterThan(1000);
  });

  it('registers each write method+path once', () => {
    // A second registration of the same method+path is shadowed by the first
    // in production, so it must not be able to lend the first one its gate.
    expect(duplicates, 'remove or rename the duplicate registration').toEqual([]);
  });

  it('resolves the handler chain of every write route', () => {
    expect(unresolved, 'extend SAMPLE_SEGMENTS so a sample path reaches these routes').toEqual([]);
  });

  it('gates every write route with a permission check, or lists it with a reason', () => {
    const unexpected = ungated.filter((key) => !Object.hasOwn(WRITE_ROUTES_WITHOUT_PERMISSION_GATE, key));
    expect(
      unexpected,
      'these write routes run with no permission gate: add requirePermission(...) (preferred) '
        + 'or a reviewed WRITE_ROUTES_WITHOUT_PERMISSION_GATE entry',
    ).toEqual([]);
  });

  it('keeps WRITE_ROUTES_WITHOUT_PERMISSION_GATE current', () => {
    const ungatedSet = new Set(ungated);
    const stale = Object.keys(WRITE_ROUTES_WITHOUT_PERMISSION_GATE).filter((key) => !ungatedSet.has(key));
    expect(stale, 'these routes are now gated or gone: remove their entries').toEqual([]);
    for (const [key, reason] of Object.entries(WRITE_ROUTES_WITHOUT_PERMISSION_GATE)) {
      expect(reason.trim().length, key).toBeGreaterThan(0);
    }
  });
});
