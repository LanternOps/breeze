import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users, partners, partnerUsers } from '../../db/schema';
import {
  hashPassword,
  isPasswordStrong,
  createTokenPair,
  rateLimiter,
  getRedis
} from '../../services';
import { ENABLE_REGISTRATION, ENABLE_2FA, registerSchema, registerPartnerSchema } from './schemas';
import { dispatchHook } from '../../services/partnerHooks';
import { createPartner } from '../../services/partnerCreate';
import {
  runWithSystemDbAccess,
  getClientRateLimitKey,
  setRefreshTokenCookie,
  toPublicTokens,
  resolveCurrentUserTokenContext,
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

// Register Partner (self-service MSP/company signup)
registerRoutes.post('/register-partner', zValidator('json', registerPartnerSchema), async (c) => {
  if (!ENABLE_REGISTRATION) {
    return registrationDisabledResponse(c);
  }

  const { companyName, email, password, name, acceptTerms } = c.req.valid('json');
  const rateLimitClient = getClientRateLimitKey(c);

  return runWithSystemDbAccess(async () => {

    // Block registration until any partner admin has completed initial setup.
    // Self-hosted only: SaaS deployments (MCP_BOOTSTRAP_ENABLED=true) accept
    // public self-service signups before any admin exists, so OAuth flows
    // initiated by external clients (e.g. Claude.ai) can land brand-new users
    // on /auth and let them register. The self-hosted gate exists because
    // single-tenant installs need the seeded admin to finish setup before
    // strangers can create partners.
    if (process.env.MCP_BOOTSTRAP_ENABLED !== 'true') {
      const [setupAdmin] = await db
        .select({ setupCompletedAt: users.setupCompletedAt })
        .from(users)
        .innerJoin(partnerUsers, eq(partnerUsers.userId, users.id))
        .where(sql`${users.setupCompletedAt} IS NOT NULL`)
        .limit(1);

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
    const existingUser = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (existingUser.length > 0) {
      return c.json({ success: true, message: 'If registration can proceed, you will receive next steps shortly.' });
    }

    // Hash password before transaction (CPU-intensive, don't hold tx open)
    const passwordHash = await hashPassword(password);

    try {
      // Atomic creation of partner, role, user, partner-user link, org, site.
      // Slug generation + uniqueness loop now live inside the service so the
      // MCP bootstrap tool can reuse them.
      const result = await createPartner({
        orgName: companyName,
        adminEmail: email,
        adminName: name,
        passwordHash,
        origin: { mcp: false },
      });

      // Fetch the partner + user rows we need downstream (slug, plan, status,
      // billingEmail, mfa state). Kept outside the service so the service's
      // return contract stays minimal / stable across callers.
      const [newPartner] = await db
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

      const [newUser] = await db
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

      // Token creation outside tx (doesn't need rollback)
      // MFA is vacuously satisfied when the user hasn't enrolled in MFA
      const mfaSatisfied = !(ENABLE_2FA && newUser.mfaEnabled);
      const tokens = await createTokenPair({
        sub: newUser.id,
        email: newUser.email,
        roleId: result.adminRoleId,
        orgId: result.orgId,
        partnerId: newPartner.id,
        scope: 'partner',
        mfa: mfaSatisfied
      });

      setRefreshTokenCookie(c, tokens.refreshToken);

      // Dispatch post-registration hook (external services can override status/redirect)
      const hookResponse = await dispatchHook('registration', newPartner.id, {
        email: newUser.email,
        partnerName: newPartner.name,
        plan: newPartner.plan,
      });

      // If hook overrides the partner status (e.g. to 'pending'), apply it
      const VALID_STATUSES = ['pending', 'active', 'suspended', 'churned'] as const;
      let effectiveStatus: string = newPartner.status;

      if (hookResponse?.status && hookResponse.status !== newPartner.status) {
        if (!VALID_STATUSES.includes(hookResponse.status as any)) {
          console.error(`[Registration] Hook returned invalid status '${hookResponse.status}' for partner ${newPartner.id}; ignoring`);
        } else {
          try {
            const updateSet: Record<string, unknown> = {
              status: hookResponse.status as typeof newPartner.status,
            };

            // Apply optional status message fields from hook response
            if (hookResponse.message || hookResponse.actionUrl || hookResponse.actionLabel) {
              const msgSettings: Record<string, string | null> = {};
              if (hookResponse.message) msgSettings.statusMessage = hookResponse.message;
              if (hookResponse.actionUrl) msgSettings.statusActionUrl = hookResponse.actionUrl;
              if (hookResponse.actionLabel) msgSettings.statusActionLabel = hookResponse.actionLabel;
              updateSet.settings = sql`COALESCE(${partners.settings}, '{}'::jsonb) || ${JSON.stringify(msgSettings)}::jsonb`;
            }

            await db
              .update(partners)
              .set(updateSet)
              .where(eq(partners.id, newPartner.id));
            effectiveStatus = hookResponse.status;
          } catch (statusErr) {
            console.error(`[Registration] Failed to update partner ${newPartner.id} status to '${hookResponse.status}':`, statusErr instanceof Error ? statusErr.message : String(statusErr));
            // Keep effectiveStatus at original value since DB update failed
          }
        }
      }

      // Only allow relative redirects from hooks to prevent open redirect
      const redirectUrl = hookResponse?.redirectUrl?.startsWith('/') ? hookResponse.redirectUrl : undefined;

      return c.json({
        user: {
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
          mfaEnabled: false
        },
        partner: {
          id: newPartner.id,
          name: newPartner.name,
          slug: newPartner.slug,
          status: effectiveStatus,
        },
        tokens: toPublicTokens(tokens),
        mfaRequired: false,
        ...(redirectUrl ? { redirectUrl } : {}),
      });
    } catch (err) {
      console.error('Partner registration error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Registration failed. Please try again.' }, 500);
    }
  });
});
