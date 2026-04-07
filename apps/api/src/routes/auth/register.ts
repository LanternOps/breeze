import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and, isNull } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users, partners, partnerUsers, roles, rolePermissions, organizations, sites } from '../../db/schema';
import {
  hashPassword,
  isPasswordStrong,
  createTokenPair,
  rateLimiter,
  getRedis
} from '../../services';
import { ENABLE_REGISTRATION, ENABLE_2FA, registerSchema, registerPartnerSchema } from './schemas';
import { dispatchHook } from '../../services/partnerHooks';
import {
  runWithSystemDbAccess,
  getClientRateLimitKey,
  setRefreshTokenCookie,
  toPublicTokens,
  resolveCurrentUserTokenContext,
  registrationDisabledResponse
} from './helpers';

const { db } = dbModule;

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

  const existingUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (existingUsers.length > 0) {
    // Security: use a generic success response to prevent email enumeration.
    return c.json({
      success: true,
      message: 'If registration can proceed, you will receive next steps shortly.'
    });
  }

  const passwordHash = await hashPassword(password);
  const [newUser] = await db
    .insert(users)
    .values({
      email: normalizedEmail,
      name,
      passwordHash,
      status: 'active'
    })
    .returning();

  if (!newUser) {
    return c.json({ error: 'Failed to create account' }, 500);
  }

  const context = await resolveCurrentUserTokenContext(newUser.id);
  // MFA is vacuously satisfied when the user hasn't enrolled in MFA
  const mfaSatisfied = !(ENABLE_2FA && newUser.mfaEnabled);
  const tokens = await createTokenPair({
    sub: newUser.id,
    email: newUser.email,
    roleId: context.roleId,
    orgId: context.orgId,
    partnerId: context.partnerId,
    scope: context.scope,
    mfa: mfaSatisfied
  });

  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, newUser.id));

  setRefreshTokenCookie(c, tokens.refreshToken);

  return c.json({
    user: {
      id: newUser.id,
      email: newUser.email,
      name: newUser.name,
      mfaEnabled: false
    },
    tokens: toPublicTokens(tokens),
    mfaRequired: false
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

    // Block registration until the system admin has completed initial setup
    const [adminUser] = await db
      .select({ setupCompletedAt: users.setupCompletedAt })
      .from(users)
      .where(eq(users.email, 'admin@breeze.local'))
      .limit(1);

    if (!adminUser || !adminUser.setupCompletedAt) {
      return c.json({ error: 'System setup is not yet complete. Contact your administrator.' }, 403);
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

    // Generate slug from company name
    const baseSlug = companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

    // Check if slug exists and make unique if needed
    let slug = baseSlug;
    let suffix = 1;
    while (true) {
      const existingPartner = await db
        .select({ id: partners.id })
        .from(partners)
        .where(eq(partners.slug, slug))
        .limit(1);

      if (existingPartner.length === 0) break;
      slug = `${baseSlug}-${suffix}`;
      suffix++;
      if (suffix > 100) {
        return c.json({ error: 'Unable to generate unique company identifier' }, 500);
      }
    }

    // Hash password before transaction (CPU-intensive, don't hold tx open)
    const passwordHash = await hashPassword(password);

    // Atomic transaction — all-or-nothing creation of partner, role, user, association
    try {
      const result = await db.transaction(async (tx) => {
        const [newPartner] = await tx
          .insert(partners)
          .values({
            name: companyName,
            slug,
            type: 'msp',
            plan: 'free',
            status: 'active',
            billingEmail: email.toLowerCase(),
          })
          .returning();

        if (!newPartner) {
          throw new Error('Failed to create company');
        }

        const [adminRole] = await tx
          .insert(roles)
          .values({
            partnerId: newPartner.id,
            scope: 'partner',
            name: 'Partner Admin',
            description: 'Full access to partner and all organizations',
            isSystem: true
          })
          .returning();

        if (!adminRole) {
          throw new Error('Failed to create admin role');
        }

        const [newUser] = await tx
          .insert(users)
          .values({
            email: email.toLowerCase(),
            name,
            passwordHash,
            status: 'active'
          })
          .returning();

        if (!newUser) {
          throw new Error('Failed to create user');
        }

        await tx.insert(partnerUsers).values({
          partnerId: newPartner.id,
          userId: newUser.id,
          roleId: adminRole.id,
          orgAccess: 'all'
        });

        // Copy permissions from the seeded system Partner Admin role
        const [systemPartnerAdmin] = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(
            and(
              eq(roles.name, 'Partner Admin'),
              eq(roles.isSystem, true),
              isNull(roles.partnerId)
            )
          )
          .limit(1);

        if (!systemPartnerAdmin) {
          throw new Error('System Partner Admin role not found — run seed first');
        }

        const systemPerms = await tx
          .select({ permissionId: rolePermissions.permissionId })
          .from(rolePermissions)
          .where(eq(rolePermissions.roleId, systemPartnerAdmin.id));

        for (const perm of systemPerms) {
          await tx.insert(rolePermissions).values({
            roleId: adminRole.id,
            permissionId: perm.permissionId
          });
        }

        // Create default organization
        const orgSlug = slug + '-org';
        const [newOrg] = await tx
          .insert(organizations)
          .values({
            partnerId: newPartner.id,
            name: companyName,
            slug: orgSlug,
            type: 'customer',
            status: 'active'
          })
          .returning();

        if (!newOrg) {
          throw new Error('Failed to create default organization');
        }

        // Create default site
        const [newSite] = await tx
          .insert(sites)
          .values({
            orgId: newOrg.id,
            name: 'Main Office',
            timezone: 'UTC'
          })
          .returning();

        if (!newSite) {
          throw new Error('Failed to create default site');
        }

        // Mark setup as complete — new partners don't need the wizard
        await tx
          .update(users)
          .set({ lastLoginAt: new Date(), setupCompletedAt: new Date() })
          .where(eq(users.id, newUser.id));

        return { newPartner, adminRole, newUser, newOrg, newSite };
      });

      // Token creation outside tx (doesn't need rollback)
      // MFA is vacuously satisfied when the user hasn't enrolled in MFA
      const mfaSatisfied = !(ENABLE_2FA && result.newUser.mfaEnabled);
      const tokens = await createTokenPair({
        sub: result.newUser.id,
        email: result.newUser.email,
        roleId: result.adminRole.id,
        orgId: result.newOrg?.id ?? null,
        partnerId: result.newPartner.id,
        scope: 'partner',
        mfa: mfaSatisfied
      });

      setRefreshTokenCookie(c, tokens.refreshToken);

      // Dispatch post-registration hook (external services can override status/redirect)
      const hookResponse = await dispatchHook('registration', result.newPartner.id, {
        email: result.newUser.email,
        partnerName: result.newPartner.name,
        plan: result.newPartner.plan,
      });

      // If hook overrides the partner status (e.g. to 'pending'), apply it
      const VALID_STATUSES = ['pending', 'active', 'suspended', 'churned'] as const;
      let effectiveStatus: string = result.newPartner.status;

      if (hookResponse?.status && hookResponse.status !== result.newPartner.status) {
        if (!VALID_STATUSES.includes(hookResponse.status as any)) {
          console.error(`[Registration] Hook returned invalid status '${hookResponse.status}' for partner ${result.newPartner.id}; ignoring`);
        } else {
          try {
            await db
              .update(partners)
              .set({ status: hookResponse.status as typeof result.newPartner.status })
              .where(eq(partners.id, result.newPartner.id));
            effectiveStatus = hookResponse.status;
          } catch (statusErr) {
            console.error(`[Registration] Failed to update partner ${result.newPartner.id} status to '${hookResponse.status}':`, statusErr instanceof Error ? statusErr.message : String(statusErr));
            // Keep effectiveStatus at original value since DB update failed
          }
        }
      }

      // Only allow relative redirects from hooks to prevent open redirect
      const redirectUrl = hookResponse?.redirectUrl?.startsWith('/') ? hookResponse.redirectUrl : undefined;

      return c.json({
        user: {
          id: result.newUser.id,
          email: result.newUser.email,
          name: result.newUser.name,
          mfaEnabled: false
        },
        partner: {
          id: result.newPartner.id,
          name: result.newPartner.name,
          slug: result.newPartner.slug,
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
