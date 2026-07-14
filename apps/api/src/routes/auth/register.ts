import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq, sql } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users, partnerUsers } from '../../db/schema';
import {
  hashPassword,
  isPasswordStrong,
  rateLimiter,
  getRedis,
} from '../../services';
import { ENABLE_REGISTRATION, TERMS_VERSION, registerSchema, registerPartnerSchema } from './schemas';
import { isHosted } from '../../config/env';
import { ANONYMOUS_ACTOR_ID } from '../../services/auditEvents';
import { createAuditLog } from '../../services/auditService';
import { captureException } from '../../services/sentry';
import { createPendingRegistration } from '../../services/pendingRegistration';
import { enqueueRegistrationVerification } from '../../services/authEmailQueue';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import {
  runWithSystemDbAccess,
  getClientRateLimitKey,
  authResponseFloorPromise,
  registrationDisabledResponse
} from './helpers';

const { db, withSystemDbAccessContext } = dbModule;

export const registerRoutes = new Hono();

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

// Register Partner (self-service MSP/company signup) — SR2-21: email-first.
//
// Step 1 records a PENDING registration and returns a fixed generic body. It
// creates NO user, NO partner, NO tokens, and — the whole point — performs NO
// user-existence lookup. That lookup was the enumeration oracle: the old handler
// branched on `existingUser.length > 0` (early generic 200) and that branch was
// ~1 DB round-trip cheaper than the createPartner branch, so the response TIME
// disclosed whether the address had an account even though the response BODY did
// not. The account is created only after the verification link is clicked
// (routes/auth/verifyEmail.ts), and the WORKER — which the requester cannot
// observe — decides which email to send. See services/authEmailQueue.ts.
//
// Enumeration defense (overseer binding decision): structurally branch-free AND
// an explicit timing floor. The handler does the IDENTICAL sequence for every
// accepted input — isPasswordStrong → hashPassword (argon2, the dominant cost)
// → one Redis SETEX → one queue add → the same 200 body — with no branch on the
// email and no DB read (hosted mode). We additionally share /login's floor
// equalizer so a future regression reintroducing existence-dependent work still
// cannot leak a latency delta. The floor is kicked off first and awaited before
// EVERY return.
registerRoutes.post('/register-partner', zValidator('json', registerPartnerSchema), async (c) => {
  const floorPromise = authResponseFloorPromise();

  if (!ENABLE_REGISTRATION) {
    await floorPromise;
    return registrationDisabledResponse(c);
  }

  const { companyName, email, password, name, acceptTerms } = c.req.valid('json');
  const rateLimitClient = getClientRateLimitKey(c);

  // Self-hosted single-tenant installs need the seeded admin to finish setup
  // before strangers can create partners. SaaS deployments (IS_HOSTED=true) skip
  // the gate entirely — no DB read at all, which is why hosted mode issues ZERO
  // db.select() calls. The gate's DB read (self-hosted) and the hosted bypass
  // audit both need a system DB context, so that — and ONLY that — is wrapped.
  const gateDenial = await runWithSystemDbAccess(async (): Promise<Response | null> => {
    if (isHosted()) {
      // Best-effort bypass audit. Signup still proceeds on failure — these
      // events are low-volume and gating signup on audit-table availability
      // would be heavy.
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
      return null;
    }

    const [setupAdmin] = await db
      .select({ setupCompletedAt: users.setupCompletedAt })
      .from(users)
      .innerJoin(partnerUsers, eq(partnerUsers.userId, users.id))
      .where(sql`${users.setupCompletedAt} IS NOT NULL`)
      .limit(1);

    if (!setupAdmin) {
      return c.json({ error: 'System setup is not yet complete. Contact your administrator.' }, 403);
    }
    return null;
  });
  if (gateDenial) {
    await floorPromise;
    return gateDenial;
  }

  // Rate limit registration — stricter for partner registration. Keyed on the
  // CLIENT, never the email; the exceeded branch returns its own status.
  const redis = getRedis();
  if (!redis) {
    await floorPromise;
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }
  const rateCheck = await rateLimiter(redis, `register-partner:${rateLimitClient}`, 3, 3600);
  if (!rateCheck.allowed) {
    await floorPromise;
    return c.json({ error: 'Too many registration attempts. Try again later.' }, 429);
  }

  // Password strength is input-dependent, not account-dependent — a 400 here
  // discloses nothing about whether the address exists.
  const passwordCheck = isPasswordStrong(password);
  if (!passwordCheck.valid) {
    await floorPromise;
    return c.json({ error: passwordCheck.errors[0] }, 400);
  }

  // Hash BEFORE parking — a plaintext password is NEVER stored in the pending
  // record. argon2 is also the dominant, input-independent cost that makes the
  // handler's latency uniform regardless of whether the address has an account.
  const passwordHash = await hashPassword(password);

  // SR2-21: no user-existence lookup. Park the pending registration and let the
  // worker (which the requester cannot observe) decide what to send. The record
  // carries the step-1 abuse attribution (#2343): the LIVE step-1 request's
  // trusted IP + user-agent. Step 2 threads THESE into createPartner — never the
  // verification click's IP/UA, which is routinely a mail client or a link
  // scanner in another country and would poison the signup-abuse corpus.
  let tokenHash: string;
  try {
    const created = await createPendingRegistration({
      email: email.toLowerCase().trim(),
      companyName,
      name,
      passwordHash,
      acceptTerms,
      termsVersion: TERMS_VERSION,
      hostedExpectation: isHosted(),
      signupIp: getTrustedClientIpOrUndefined(c),
      signupUserAgent: c.req.header('user-agent'),
    });
    tokenHash = created.tokenHash;
    // The raw token never leaves createPendingRegistration except inside the
    // verification EMAIL (built by the worker). It is not returned to the
    // client, not logged, and not audited.
  } catch (err) {
    console.error('[register-partner] pending-registration write failed', err);
    captureException(err, c);
    await floorPromise;
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  // The queue job carries ONLY the token hash — never the raw token, the email,
  // or the password hash. The worker reads the Redis record.
  await enqueueRegistrationVerification(tokenHash);

  await floorPromise;
  return c.json({
    success: true,
    message: 'If registration can proceed, you will receive next steps shortly.',
  });
});
