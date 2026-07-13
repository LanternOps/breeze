import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq, sql } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users, partners, partnerUsers } from '../../db/schema';
import {
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceCapabilityError,
  AuthIssuanceConflictError,
  beginAuthIssuance,
  bindIssuedUserSession,
  cancelAuthIssuance,
  finishAuthIssuance,
  hashPassword,
  isPasswordStrong,
  issueUserSession,
  rateLimiter,
  getRedis
} from '../../services';
import { CSRF_COOKIE_NAME, ENABLE_REGISTRATION, registerSchema, registerPartnerSchema } from './schemas';
import { isHosted } from '../../config/env';
import type { PartnerStatus } from '../../db/schema/orgs';
import { dispatchHook } from '../../services/partnerHooks';
import { createPartner } from '../../services/partnerCreate';
import { writeAuditEvent, ANONYMOUS_ACTOR_ID } from '../../services/auditEvents';
import { createAuditLog } from '../../services/auditService';
import { captureException } from '../../services/sentry';
import { generateVerificationToken } from '../../services/emailVerification';
import { getEmailService } from '../../services/email';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { activatePendingPartnerAndInvalidateSessions } from '../../services/partnerActivation';
import type { AuthIssuanceCapability } from '../../services/authBrowserTransition';
import type { AuthLifecycleTransaction } from '../../services/authLifecycle';
import {
  getCookieValue,
  getClientRateLimitKey,
  rotateCsrfBindingCookie,
  setRefreshTokenCookie,
  toPublicTokens,
  registrationDisabledResponse
} from './helpers';

const { db, withSystemDbAccessContext } = dbModule;

export const registerRoutes = new Hono();

export async function createRegisteredPartnerSession(input: {
  tx: AuthLifecycleTransaction;
  capability: AuthIssuanceCapability;
  companyName: string;
  email: string;
  name: string;
  passwordHash: string;
  status: PartnerStatus;
}) {
  const result = await createPartner({
    orgName: input.companyName,
    adminEmail: input.email,
    adminName: input.name,
    passwordHash: input.passwordHash,
    origin: { mcp: false },
    status: input.status,
  }, { tx: input.tx });

  const [newPartner] = await input.tx
    .select({
      id: partners.id,
      name: partners.name,
      slug: partners.slug,
      plan: partners.plan,
      status: partners.status,
    })
    .from(partners)
    .where(eq(partners.id, result.partnerId))
    .limit(1);
  const [newUser] = await input.tx
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      mfaEnabled: users.mfaEnabled,
    })
    .from(users)
    .where(eq(users.id, result.adminUserId))
    .limit(1);
  if (!newPartner || !newUser) {
    throw new Error('Partner or user row missing after createPartner');
  }

  const sessionIdentity = {
    userId: newUser.id,
    email: newUser.email,
    roleId: result.adminRoleId,
    orgId: result.orgId,
    partnerId: newPartner.id,
    scope: 'partner',
    mfa: false,
    amr: ['password'],
  } as const;
  const tokens = await issueUserSession(
    { ...sessionIdentity },
    { tx: input.tx, capability: input.capability });
  return { result, newPartner, newUser, sessionIdentity, tokens };
}

function registrationTransitionErrorResponse(c: Parameters<typeof rotateCsrfBindingCookie>[0], error: unknown) {
  if (error instanceof AuthBindingRotationRequiredError) {
    rotateCsrfBindingCookie(c, error.replacement.value);
    return c.json({ error: 'Authentication binding refresh required', reason: 'binding_refresh' }, 428);
  }
  if (error instanceof AuthBindingUnavailableError
    || error instanceof AuthIssuanceConflictError
    || error instanceof AuthIssuanceCapabilityError) {
    return c.json({ error: 'Authentication temporarily unavailable' }, 409);
  }
  return null;
}

// Register user (compatibility for legacy signup path)
registerRoutes.post('/register', zValidator('json', registerSchema), async (c) => {
  if (!ENABLE_REGISTRATION) {
    return registrationDisabledResponse(c);
  }

  const { email, password, name } = c.req.valid('json');
  const rateLimitClient = getClientRateLimitKey(c);
  const normalizedEmail = email.toLowerCase();

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const rateCheck = await rateLimiter(redis, `register:${rateLimitClient}`, 5, 3600);
  if (!rateCheck.allowed) {
    return c.json({ error: 'Too many registration attempts. Try again later.' }, 429);
  }

  const passwordCheck = isPasswordStrong(password);
  if (!passwordCheck.valid) {
    return c.json({ error: passwordCheck.errors[0] }, 400);
  }

  // Pre-auth lookup — wrap in system scope so the `users` RLS policy
  // doesn't deny the read before the real request scope is applied.
  const existingUsers = await withSystemDbAccessContext(async () =>
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1)
  );

  // Legacy /register is a no-op: it used to create a partnerless orphan
  // user, which is incompatible with the users.partner_id NOT NULL
  // constraint and the users RLS policy. New signups must go through
  // /register-partner which creates the partner + user + first org
  // together. Return the same generic success response the existing-user
  // branch returns so legacy clients don't observe a breaking change.
  void existingUsers;
  return c.json({
    success: true,
    message: 'If registration can proceed, you will receive next steps shortly.'
  });
});

// Register Partner (self-service MSP/company signup)
registerRoutes.post('/register-partner', zValidator('json', registerPartnerSchema), async (c) => {
  if (!ENABLE_REGISTRATION) {
    return registrationDisabledResponse(c);
  }

  const { companyName, email, password, name, acceptTerms } = c.req.valid('json');
  const rateLimitClient = getClientRateLimitKey(c);

  {
    // Self-hosted single-tenant installs need the seeded admin to finish
    // setup before strangers can create partners. SaaS deployments
    // (IS_HOSTED=true) skip the gate so the partner table can
    // bootstrap from an empty state.
    const hosted = isHosted();
    if (!hosted) {
      const [setupAdmin] = await withSystemDbAccessContext(async () =>
        db
          .select({ setupCompletedAt: users.setupCompletedAt })
          .from(users)
          .innerJoin(partnerUsers, eq(partnerUsers.userId, users.id))
          .where(sql`${users.setupCompletedAt} IS NOT NULL`)
          .limit(1));

      if (!setupAdmin) {
        return c.json({ error: 'System setup is not yet complete. Contact your administrator.' }, 403);
      }
    }

    // Rate limit registration - stricter for partner registration
    const redis = getRedis();
    if (!redis) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }
    const rateCheck = await rateLimiter(redis, `register-partner:${rateLimitClient}`, 3, 3600);
    if (!rateCheck.allowed) {
      return c.json({ error: 'Too many registration attempts. Try again later.' }, 429);
    }

    // Validate password strength
    const passwordCheck = isPasswordStrong(password);
    if (!passwordCheck.valid) {
      return c.json({ error: passwordCheck.errors[0] }, 400);
    }

    // Check if user exists
    const existingUser = await withSystemDbAccessContext(async () =>
      db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1));

    if (existingUser.length > 0) {
      return c.json({ success: true, message: 'If registration can proceed, you will receive next steps shortly.' });
    }

    // Hash password before transaction (CPU-intensive, don't hold tx open)
    const passwordHash = await hashPassword(password);

    type RegisterPhase = 'admission' | 'authority-transaction' | 'post-commit' | 'hook-status' | 'response-build';
    let phase: RegisterPhase = 'admission';
    let partnerIdForLog: string | undefined;
    let capability: Awaited<ReturnType<typeof beginAuthIssuance>> | undefined;

    try {
      const admission = await beginAuthIssuance({
        kind: 'browser',
        value: getCookieValue(c.req.header('cookie'), CSRF_COOKIE_NAME) ?? '',
      });
      capability = admission;
      phase = 'authority-transaction';

      const committed = await finishAuthIssuance(admission, (tx) =>
        createRegisteredPartnerSession({
          tx,
          capability: admission,
          companyName,
          email,
          name,
          passwordHash,
          status: hosted ? 'pending' : 'active',
        }));
      partnerIdForLog = committed.result.partnerId;
      let { tokens } = committed;
      let effectiveStatus: PartnerStatus = committed.newPartner.status;

      phase = 'post-commit';
      try {
        await bindIssuedUserSession(tokens);
      } catch (cacheErr) {
        console.warn('[register-partner] post-commit session cache binding failed', cacheErr);
        captureException(cacheErr, c);
      }

      if (hosted) {
        const bypassDetails = {
          email: email.toLowerCase(),
          companyName,
          reason: 'mcp-bootstrap-enabled',
        };
        try {
          await createAuditLog({
            orgId: null,
            actorType: 'system',
            actorId: ANONYMOUS_ACTOR_ID,
            action: 'register-partner.setup-admin-gate-bypass',
            resourceType: 'partner',
            details: bypassDetails,
            ipAddress: getTrustedClientIpOrUndefined(c),
            userAgent: c.req.header('user-agent'),
            result: 'success',
          });
        } catch (auditErr) {
          console.error('[register-partner] bypass audit-log write failed', {
            error: auditErr instanceof Error ? auditErr.message : String(auditErr),
            stack: auditErr instanceof Error ? auditErr.stack : undefined,
            ...bypassDetails,
            ip: getTrustedClientIpOrUndefined(c),
          });
          captureException(auditErr, c);
        }
        // eslint-disable-next-line no-console
        console.warn('[register-partner] setup-admin gate bypassed (saas mode)');
      }

      // Email verification — best-effort send. Failures must not fail the
      // signup, but the result needs to be surfaced to the client so the
      // UI can show a "we couldn't send the verification email — click to
      // resend" banner instead of leaving the user waiting silently.
      let verificationEmailSent = false;
      try {
        const rawToken = await generateVerificationToken({
          partnerId: committed.newPartner.id,
          userId: committed.newUser.id,
          email: committed.newUser.email,
        });
        const appBaseUrl = (
          process.env.DASHBOARD_URL ||
          process.env.PUBLIC_APP_URL ||
          'http://localhost:4321'
        ).replace(/\/$/, '');
        const verificationUrl = `${appBaseUrl}/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
        const emailService = getEmailService();
        if (emailService) {
          await emailService.sendVerificationEmail({
            to: committed.newUser.email,
            name: committed.newUser.name,
            verificationUrl,
          });
          verificationEmailSent = true;
        } else {
          // No email provider in production is a misconfiguration, not
          // graceful degradation — capture so it's observable.
          const err = new Error(
            '[register-partner] Email service not configured; verification email skipped',
          );
          console.warn(err.message);
          captureException(err, c);
        }
      } catch (verifyErr) {
        console.error('[register-partner] verification email send failed', {
          partnerId: committed.newPartner.id,
          userId: committed.newUser.id,
          error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
        });
        captureException(verifyErr, c);
      }


      // Dispatch post-registration hook (external services can override status/redirect)
      const hookResponse = await dispatchHook('registration', committed.newPartner.id, {
        email: committed.newUser.email,
        partnerName: committed.newPartner.name,
        plan: committed.newPartner.plan,
      });

      // If hook overrides the partner status (e.g. to 'pending'), apply it
      const VALID_STATUSES = ['pending', 'active', 'suspended', 'churned'] as const;
      if (hookResponse?.status && hookResponse.status !== committed.newPartner.status) {
        if (!VALID_STATUSES.includes(hookResponse.status as any)) {
          console.error(`[Registration] Hook returned invalid status '${hookResponse.status}' for partner ${committed.newPartner.id}; ignoring`);
        } else {
          const isPendingActivation =
            committed.newPartner.status === 'pending' && hookResponse.status === 'active';
          let hookCapability: Awaited<ReturnType<typeof beginAuthIssuance>> | undefined;
          try {
            phase = 'hook-status';
            const hookAdmission = await beginAuthIssuance({
              kind: 'browser',
              value: getCookieValue(c.req.header('cookie'), CSRF_COOKIE_NAME) ?? '',
            });
            hookCapability = hookAdmission;
            const hookResult = await finishAuthIssuance(hookAdmission, async (tx) => {
              if (isPendingActivation) {
                const statusMetadata = {
                  ...(hookResponse.message ? { message: hookResponse.message } : {}),
                  ...(hookResponse.actionUrl ? { actionUrl: hookResponse.actionUrl } : {}),
                  ...(hookResponse.actionLabel ? { actionLabel: hookResponse.actionLabel } : {}),
                };
                const activation = await activatePendingPartnerAndInvalidateSessions(
                  tx,
                  committed.newPartner.id,
                  new Date(),
                  statusMetadata,
                );
                if (!activation.activated) {
                  throw new Error('Pending partner activation did not update the partner row');
                }
                const replacement = await issueUserSession(
                  { ...committed.sessionIdentity },
                  { tx, capability: hookAdmission });
                return { status: 'active' as PartnerStatus, replacement };
              }
              const updateSet: Record<string, unknown> = {
                status: hookResponse.status as typeof committed.newPartner.status,
              };

              // Apply optional status message fields from hook response
              if (hookResponse.message || hookResponse.actionUrl || hookResponse.actionLabel) {
                const msgSettings: Record<string, string | null> = {};
                if (hookResponse.message) msgSettings.statusMessage = hookResponse.message;
                if (hookResponse.actionUrl) msgSettings.statusActionUrl = hookResponse.actionUrl;
                if (hookResponse.actionLabel) msgSettings.statusActionLabel = hookResponse.actionLabel;
                updateSet.settings = sql`COALESCE(${partners.settings}, '{}'::jsonb) || ${JSON.stringify(msgSettings)}::jsonb`;
              }
              await tx
                .update(partners)
                .set(updateSet)
                .where(eq(partners.id, committed.newPartner.id));
              return { status: hookResponse.status as PartnerStatus };
            });
            effectiveStatus = hookResult.status;
            if (hookResult.replacement) {
              tokens = hookResult.replacement;
              try {
                await bindIssuedUserSession(tokens);
              } catch (cacheErr) {
                console.warn('[register-partner] post-activation cache binding failed', cacheErr);
                captureException(cacheErr, c);
              }
            }
          } catch (statusErr) {
            if (hookCapability) {
              await cancelAuthIssuance(hookCapability).catch(() => false);
            }
            console.error('[register-partner] hook-status update failed', {
              partnerId: committed.newPartner.id,
              fromStatus: committed.newPartner.status,
              toStatus: hookResponse.status,
              error: statusErr instanceof Error ? statusErr.message : String(statusErr),
              stack: statusErr instanceof Error ? statusErr.stack : undefined,
            });
            // Returning the unchanged status to the client is a deliberate
            // trade-off: surfacing a 500 here would partially undo a successful
            // partner+user creation. The audit row below lets triage find
            // partners whose effective status diverged from hook intent.
            writeAuditEvent(c, {
              orgId: null,
              actorType: 'system',
              action: 'register-partner.hook-status-update-failed',
              resourceType: 'partner',
              resourceId: committed.newPartner.id,
              resourceName: committed.newPartner.name,
              details: {
                fromStatus: committed.newPartner.status,
                toStatus: hookResponse.status,
              },
              result: 'failure',
              errorMessage: statusErr instanceof Error ? statusErr.message : String(statusErr),
            });
            if (isPendingActivation) {
              throw statusErr;
            }
          }
        }
      }

      phase = 'response-build';

      // Only allow relative redirects from hooks to prevent open redirect
      const redirectUrl = hookResponse?.redirectUrl?.startsWith('/') ? hookResponse.redirectUrl : undefined;

      setRefreshTokenCookie(c, tokens.refreshToken);

      return c.json({
        user: {
          id: committed.newUser.id,
          email: committed.newUser.email,
          name: committed.newUser.name,
          mfaEnabled: false
        },
        partner: {
          id: committed.newPartner.id,
          name: committed.newPartner.name,
          slug: committed.newPartner.slug,
          status: effectiveStatus,
        },
        tokens: toPublicTokens(tokens),
        mfaRequired: false,
        verificationEmailSent,
        ...(redirectUrl ? { redirectUrl } : {}),
      });
    } catch (err) {
      if (capability) {
        await cancelAuthIssuance(capability).catch(() => false);
      }
      const transitionResponse = registrationTransitionErrorResponse(c, err);
      if (transitionResponse) return transitionResponse;
      console.error('[register-partner] failed', {
        phase,
        partnerId: partnerIdForLog,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return c.json({ error: 'Registration failed. Please try again.' }, 500);
    }
  }
});
