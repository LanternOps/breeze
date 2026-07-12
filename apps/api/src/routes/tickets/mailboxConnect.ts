import { createHmac, timingSafeEqual } from 'crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
  type AuthContext,
} from '../../middleware/auth';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { buildAdminConsentUrl, isM365TenantId } from '../../services/c2cM365';
import { writeAuditEvent, writeRouteAudit } from '../../services/auditEvents';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';
import { PERMISSIONS } from '../../services/permissions';
import { captureException } from '../../services/sentry';
import {
  createAdminConsentSession,
  createIdentityVerificationSession,
  consumeConsentSession,
  hashTenantHint,
  type ConsentSession,
} from '../../services/ticketMailbox/consentSessionService';
import {
  bindVerifiedTenant,
  createPendingConnection,
  disableConnection,
  getMailboxConnection,
  isMailboxConnectionSnapshotCurrent,
  listMailboxConnections,
  markPendingConsentFailed,
  probeMailbox,
  restoreVerifiedConnection,
  setConnectedMailboxStatus,
  type MailboxConnection,
} from '../../services/ticketMailbox/connectionService';
import {
  buildMicrosoftAuthorizationUrl,
  exchangeMicrosoftAuthorizationCode,
  hasMailboxConsentAdminRole,
  verifyMicrosoftAdminIdToken,
} from '../../services/ticketMailbox/microsoftIdentity';
import {
  getMailboxCallbackUri,
  getMailboxPlatformConfig,
} from '../../services/ticketMailbox/mailboxToken';

const partnerScopes = requireScope('partner', 'system');
const requireMailboxRead = requirePermission(
  PERMISSIONS.TICKET_MAILBOX_READ.resource,
  PERMISSIONS.TICKET_MAILBOX_READ.action,
);
const requireMailboxAdmin = requirePermission(
  PERMISSIONS.TICKET_MAILBOX_ADMIN.resource,
  PERMISSIONS.TICKET_MAILBOX_ADMIN.action,
);

const STATE_COOKIE = 'ticket_mailbox_oauth_state';
const STATE_TTL_SECONDS = 10 * 60;
const LABEL = 'ticket-mailbox-oauth';
type CallbackPhase = ConsentSession['phase'];
type BrowserBinding = { phase: CallbackPhase; tenantHint: string | null };

const connectBody = z.object({
  mailboxAddress: z.string().email(),
  displayName: z.string().max(120).optional(),
});
const callbackQuery = z.object({
  state: z.string().min(1),
  tenant: z.string().optional(),
  admin_consent: z.string().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});
const idParam = z.object({ id: z.string().uuid() });

type CallbackQuery = z.infer<typeof callbackQuery>;
type CallbackIntent =
  | { kind: 'admin_success'; tenantHint: string }
  | { kind: 'identity_success'; code: string }
  | { kind: 'provider_error' };

function resolvePartnerId(
  auth: Pick<AuthContext, 'scope' | 'partnerId'>,
): { partnerId: string } | { error: string; status: 403 } {
  if ((auth.scope === 'partner' || auth.scope === 'system') && auth.partnerId) {
    return { partnerId: auth.partnerId };
  }
  return {
    error: 'Partner context required to manage ticket mailbox connections',
    status: 403,
  };
}

function signingSecret(): string | null {
  return process.env.APP_ENCRYPTION_KEY?.trim()
    || process.env.SECRET_ENCRYPTION_KEY?.trim()
    || process.env.SESSION_SECRET?.trim()
    || process.env.JWT_SECRET?.trim()
    || (process.env.NODE_ENV === 'production'
      ? null
      : 'test-only-ticket-mailbox-oauth-state-secret');
}

function hmac(value: string): string | null {
  const secret = signingSecret();
  return secret
    ? createHmac('sha256', secret).update(`${LABEL}-cookie:${value}`).digest('base64url')
    : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function bindingCookieValue(
  phase: CallbackPhase,
  state: string,
  tenantHint: string | null = null,
): string | null {
  if (phase === 'identity_verification' && !tenantHint) return null;
  const normalizedTenant = tenantHint?.trim().toLowerCase() ?? null;
  if (normalizedTenant && !isM365TenantId(normalizedTenant)) return null;
  const signedPayload = normalizedTenant
    ? `${phase}:${state}:${normalizedTenant}`
    : `${phase}:${state}`;
  const signature = hmac(signedPayload);
  if (!signature) return null;
  return normalizedTenant
    ? `${phase}.${normalizedTenant}.${signature}`
    : `${phase}.${signature}`;
}

function readBrowserBinding(c: Context, state: string): BrowserBinding | null {
  const presented = getCookie(c, STATE_COOKIE);
  if (!presented) return null;
  const parts = presented.split('.');
  if (parts[0] === 'admin_consent' && parts.length === 2) {
    const expected = bindingCookieValue('admin_consent', state);
    if (expected && constantTimeEqual(presented, expected)) {
      return { phase: 'admin_consent', tenantHint: null };
    }
  }
  if (parts[0] === 'identity_verification' && parts.length === 3) {
    const tenantHint = parts[1]?.toLowerCase() ?? '';
    const expected = bindingCookieValue('identity_verification', state, tenantHint);
    if (expected && constantTimeEqual(presented, expected)) {
      return { phase: 'identity_verification', tenantHint };
    }
  }
  return null;
}

function setBindingCookie(
  c: Context,
  phase: CallbackPhase,
  state: string,
  tenantHint: string | null = null,
): boolean {
  const value = bindingCookieValue(phase, state, tenantHint);
  if (!value) return false;
  setCookie(c, STATE_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: STATE_TTL_SECONDS,
  });
  return true;
}

function parseCallbackIntent(phase: CallbackPhase, query: CallbackQuery): CallbackIntent | null {
  const has = (field: keyof CallbackQuery): boolean => Object.prototype.hasOwnProperty.call(query, field);
  const hasError = has('error');
  const hasCode = has('code');
  const hasTenant = has('tenant');
  const hasAdminConsent = has('admin_consent');
  const hasErrorDescription = has('error_description');
  const hasNonEmptyError = hasError && Boolean(query.error?.length);

  if (hasErrorDescription && !hasNonEmptyError) return null;

  if (phase === 'admin_consent') {
    if (hasNonEmptyError) {
      return !hasCode && !hasTenant && !hasAdminConsent ? { kind: 'provider_error' } : null;
    }
    if (
      !hasCode
      && !hasError
      && !hasErrorDescription
      && hasTenant
      && query.tenant
      && isM365TenantId(query.tenant)
      && hasAdminConsent
      && query.admin_consent?.toLowerCase() === 'true'
    ) {
      return { kind: 'admin_success', tenantHint: query.tenant.toLowerCase() };
    }
    return null;
  }

  if (hasNonEmptyError) {
    return !hasCode && !hasTenant && !hasAdminConsent ? { kind: 'provider_error' } : null;
  }
  if (hasCode && query.code && !hasError && !hasErrorDescription && !hasTenant && !hasAdminConsent) {
    return { kind: 'identity_success', code: query.code };
  }
  return null;
}

function isOwnershipConflict(error: unknown): boolean {
  return error instanceof Error && /already owned by another partner/i.test(error.message);
}

function callbackDb<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

function auditDetails(
  session: Pick<ConsentSession, 'partnerId' | 'connectionId'>,
  connection: Pick<MailboxConnection, 'mailboxAddress'> | null,
  outcome: string,
  verifiedTenantId?: string,
): Record<string, unknown> {
  return {
    partnerId: session.partnerId,
    connectionId: session.connectionId,
    ...(connection ? { mailboxAddress: connection.mailboxAddress } : {}),
    ...(verifiedTenantId ? { verifiedTenantId } : {}),
    outcome,
  };
}

function writeCallbackAudit(
  c: Context,
  session: ConsentSession,
  action: 'ticket_mailbox.tenant_binding_verified' | 'ticket_mailbox.verification_failed',
  details: Record<string, unknown>,
): void {
  writeAuditEvent(c, {
    orgId: null,
    action,
    resourceType: 'ticket_mailbox_connection',
    resourceId: session.connectionId,
    details,
    actorId: session.userId,
    actorType: 'user',
    result: action === 'ticket_mailbox.verification_failed' ? 'failure' : 'success',
  });
}

async function loadCallbackConnection(session: ConsentSession): Promise<MailboxConnection | null> {
  return callbackDb(() => getMailboxConnection(session.connectionId, session.partnerId));
}

async function markCallbackFailed(session: ConsentSession): Promise<boolean> {
  return callbackDb(() => markPendingConsentFailed(
    session.connectionId,
    session.partnerId,
    session.consentAttemptId,
    'Mailbox verification failed',
  ));
}

export const mailboxRoutes = new Hono();

mailboxRoutes.get(
  '/connections',
  authMiddleware,
  partnerScopes,
  requireMailboxRead,
  async (c) => {
    const resolved = resolvePartnerId(c.get('auth'));
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const list = await listMailboxConnections(resolved.partnerId);
    return c.json({ connections: list });
  },
);

mailboxRoutes.post(
  '/connect',
  authMiddleware,
  partnerScopes,
  requireMailboxAdmin,
  requireMfa(),
  zValidator('json', connectBody),
  async (c) => {
    const auth = c.get('auth');
    if (!canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }
    const resolved = resolvePartnerId(auth);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const platform = getMailboxPlatformConfig();
    if (!platform) return c.json({ error: 'M365 ticket mailbox app is not configured' }, 400);

    const { mailboxAddress, displayName } = c.req.valid('json');
    const connection = await createPendingConnection({
      partnerId: resolved.partnerId,
      mailboxAddress,
      displayName: displayName ?? null,
      createdBy: auth.user.id,
    });
    const session = await createAdminConsentSession({
      partnerId: resolved.partnerId,
      connectionId: connection.id,
      consentAttemptId: connection.consentAttemptId,
      userId: auth.user.id,
    });
    if (!setBindingCookie(c, session.phase, session.state)) {
      return c.json({ error: 'OAuth state signing secret is not configured' }, 500);
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_mailbox.consent_initiated',
      resourceType: 'ticket_mailbox_connection',
      resourceId: connection.id,
      resourceName: connection.mailboxAddress,
      details: auditDetails(session, connection, 'initiated'),
    });

    return c.json({
      authUrl: buildAdminConsentUrl({
        clientId: platform.clientId,
        state: session.state,
        redirectUri: getMailboxCallbackUri(),
      }),
      connectionId: connection.id,
    });
  },
);

// Microsoft redirect target. The single-use DB session plus HttpOnly browser
// binding authenticates this public callback; browser query tenant values are
// never treated as verified ownership evidence.
mailboxRoutes.get('/callback', zValidator('query', callbackQuery), async (c) => {
  const query = c.req.valid('query');
  const binding = readBrowserBinding(c, query.state);
  if (!binding) return c.json({ error: 'OAuth state binding mismatch' }, 400);
  const { phase } = binding;
  const intent = parseCallbackIntent(phase, query);
  if (!intent) return c.json({ error: 'Invalid OAuth callback parameters' }, 400);

  const session = await consumeConsentSession(query.state, phase);
  if (!session) return c.json({ error: 'Invalid or expired OAuth state' }, 400);
  deleteCookie(c, STATE_COOKIE, { path: '/' });

  if (phase === 'identity_verification') {
    const presentedHash = binding.tenantHint ? hashTenantHint(binding.tenantHint) : null;
    if (
      !presentedHash
      || !session.tenantHintHash
      || !constantTimeEqual(presentedHash, session.tenantHintHash)
    ) {
      return c.json({ error: 'OAuth state binding mismatch' }, 400);
    }
  }

  let connection: MailboxConnection | null = null;
  const fail = async (
    outcome: 'invalid_identity' | 'insufficient_role' | 'probe_failed' | 'ownership_conflict' | 'stale_attempt',
    redirect: 'error' | 'needs_policy' | 'stale' = 'error',
    verifiedTenantId?: string,
  ): Promise<Response> => {
    try {
      connection ??= await loadCallbackConnection(session);
    } catch (error) {
      captureException(error instanceof Error ? error : new Error('Mailbox connection lookup failed'), c);
    }
    try {
      const changed = await markCallbackFailed(session);
      if (!changed) {
        outcome = 'stale_attempt';
        redirect = 'stale';
      }
    } catch (error) {
      captureException(error instanceof Error ? error : new Error('Mailbox status update failed'), c);
    }
    writeCallbackAudit(
      c,
      session,
      'ticket_mailbox.verification_failed',
      auditDetails(session, connection, outcome, verifiedTenantId),
    );
    return c.redirect(`/settings/partner?ticketMailbox=${redirect}#ticketing`);
  };

  if (intent.kind === 'provider_error') return fail('invalid_identity');

  const platform = getMailboxPlatformConfig();
  if (!platform) return fail('invalid_identity');

  try {
    connection = await loadCallbackConnection(session);
  } catch (error) {
    captureException(error instanceof Error ? error : new Error('Mailbox connection lookup failed'), c);
    return fail('invalid_identity');
  }
  if (
    !connection
    || connection.consentAttemptId !== session.consentAttemptId
  ) {
    return fail('stale_attempt', 'stale');
  }

  if (intent.kind === 'admin_success') {
    try {
      const next = await createIdentityVerificationSession({
        partnerId: session.partnerId,
        connectionId: session.connectionId,
        consentAttemptId: session.consentAttemptId,
        userId: session.userId,
        tenantHint: intent.tenantHint,
      });
      if (
        !next.session.nonce
        || !setBindingCookie(c, next.session.phase, next.session.state, intent.tenantHint)
      ) {
        return fail('invalid_identity');
      }
      return c.redirect(buildMicrosoftAuthorizationUrl({
        tenantHint: intent.tenantHint,
        clientId: platform.clientId,
        redirectUri: getMailboxCallbackUri(),
        state: next.session.state,
        nonce: next.session.nonce,
        codeChallenge: next.codeChallenge,
      }));
    } catch {
      captureException(new Error('Mailbox identity setup failed'), c);
      return fail('invalid_identity');
    }
  }

  const tenantHint = binding.tenantHint;
  if (!tenantHint || !session.tenantHintHash || !session.nonce || !session.codeVerifier) {
    return fail('invalid_identity');
  }

  try {
    const exchanged = await exchangeMicrosoftAuthorizationCode({
      tenantHint,
      clientId: platform.clientId,
      clientSecret: platform.clientSecret,
      redirectUri: getMailboxCallbackUri(),
      code: intent.code,
      codeVerifier: session.codeVerifier,
    });
    const claims = await verifyMicrosoftAdminIdToken(exchanged.idToken, {
      tenantHint,
      clientId: platform.clientId,
      nonce: session.nonce,
    });
    if (!hasMailboxConsentAdminRole(claims.wids)) return fail('insufficient_role');

    const probe = await probeMailbox(claims.tid, connection.mailboxAddress);
    if (!probe.ok) return fail('probe_failed', 'needs_policy', claims.tid);

    try {
      await callbackDb(() => bindVerifiedTenant(
        session.connectionId,
        session.partnerId,
        session.consentAttemptId,
        claims.tid,
        { microsoftOid: claims.oid, breezeUserId: session.userId },
      ));
    } catch (error) {
      captureException(error instanceof Error ? error : new Error('Mailbox tenant binding failed'), c);
      return fail(isOwnershipConflict(error) ? 'ownership_conflict' : 'invalid_identity', 'error', claims.tid);
    }

    writeCallbackAudit(
      c,
      session,
      'ticket_mailbox.tenant_binding_verified',
      auditDetails(session, connection, 'verified', claims.tid),
    );
    return c.redirect('/settings/partner?ticketMailbox=connected#ticketing');
  } catch (error) {
    captureException(error instanceof Error ? error : new Error('Mailbox identity verification failed'), c);
    return fail('invalid_identity');
  }
});

mailboxRoutes.post(
  '/connections/:id/retest',
  authMiddleware,
  partnerScopes,
  requireMailboxAdmin,
  requireMfa(),
  zValidator('param', idParam),
  async (c) => {
    const auth = c.get('auth');
    if (!canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }
    const resolved = resolvePartnerId(auth);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const { id } = c.req.valid('param');
    const connection = await getMailboxConnection(id, resolved.partnerId);
    if (!connection) return c.json({ error: 'Connection not found' }, 404);
    if (!['connected', 'error'].includes(connection.status) || !connection.tenantId) {
      return c.json({ error: 'Mailbox re-consent required' }, 409);
    }
    const snapshot = {
      id: connection.id,
      partnerId: connection.partnerId,
      tenantId: connection.tenantId,
      consentAttemptId: connection.consentAttemptId,
    };

    const probe = await probeMailbox(connection.tenantId, connection.mailboxAddress);
    let changed = true;
    if (!probe.ok) {
      if (connection.status === 'connected') {
        changed = await setConnectedMailboxStatus(
          snapshot,
          'error',
          'Mailbox verification failed',
        );
      } else {
        changed = await isMailboxConnectionSnapshotCurrent(snapshot, 'error');
      }
    } else if (connection.status === 'error') {
      changed = await restoreVerifiedConnection(snapshot);
    } else {
      changed = await isMailboxConnectionSnapshotCurrent(snapshot, 'connected');
    }
    const outcome = changed ? (probe.ok ? 'verified' : 'probe_failed') : 'stale';
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_mailbox.retested',
      resourceType: 'ticket_mailbox_connection',
      resourceId: id,
      resourceName: connection.mailboxAddress,
      result: changed && probe.ok ? 'success' : 'failure',
      details: auditDetails(
        { partnerId: resolved.partnerId, connectionId: id },
        connection,
        outcome,
        connection.tenantId,
      ),
    });
    if (!changed) return c.json({ error: 'Mailbox connection changed during retest' }, 409);
    return c.json({ ok: probe.ok, ...(probe.ok ? {} : { error: 'Mailbox verification failed' }) });
  },
);

mailboxRoutes.delete(
  '/connections/:id',
  authMiddleware,
  partnerScopes,
  requireMailboxAdmin,
  requireMfa(),
  zValidator('param', idParam),
  async (c) => {
    const auth = c.get('auth');
    if (!canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }
    const resolved = resolvePartnerId(auth);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const id = c.req.valid('param').id;
    const connection = await getMailboxConnection(id, resolved.partnerId);
    if (!connection) return c.json({ error: 'Connection not found' }, 404);
    await disableConnection(id, resolved.partnerId);
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_mailbox.disabled',
      resourceType: 'ticket_mailbox_connection',
      resourceId: id,
      resourceName: connection.mailboxAddress,
      details: auditDetails(
        { partnerId: resolved.partnerId, connectionId: id },
        connection,
        'disabled',
        connection.tenantId ?? undefined,
      ),
    });
    return c.json({ ok: true });
  },
);
