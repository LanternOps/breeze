import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users, partners, partnerUsers, roles } from '../../db/schema';
import {
  hashPassword,
  isPasswordStrong,
  createTokenPair,
  rateLimiter,
  getRedis
} from '../../services';
import { ENABLE_REGISTRATION, registerSchema, registerPartnerSchema } from './schemas';
import {
  runWithSystemDbAccess,
  getClientIP,
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
  const ip = getClientIP(c);
  const normalizedEmail = email.toLowerCase();

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const rateCheck = await rateLimiter(redis, `register:${ip}`, 5, 3600);
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
  const tokens = await createTokenPair({
    sub: newUser.id,
    email: newUser.email,
    roleId: context.roleId,
    orgId: context.orgId,
    partnerId: context.partnerId,
    scope: context.scope,
    mfa: false
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
  const ip = getClientIP(c);

  return runWithSystemDbAccess(async () => {

    // Rate limit registration - stricter for partner registration
    const redis = getRedis();
    if (!redis) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }
    const rateCheck = await rateLimiter(redis, `register-partner:${ip}`, 3, 3600);
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

    // Start transaction - create partner, role, user, and association
    try {
      // Create partner
      const [newPartner] = await db
        .insert(partners)
        .values({
          name: companyName,
          slug,
          type: 'msp',
          plan: 'free'
        })
        .returning();

      if (!newPartner) {
        return c.json({ error: 'Failed to create company' }, 500);
      }

      // Create Partner Admin role for this partner
      const [adminRole] = await db
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
        // Cleanup partner
        await db.delete(partners).where(eq(partners.id, newPartner.id));
        return c.json({ error: 'Failed to create admin role' }, 500);
      }

      // Create user
      const passwordHash = await hashPassword(password);
      const [newUser] = await db
        .insert(users)
        .values({
          email: email.toLowerCase(),
          name,
          passwordHash,
          status: 'active'
        })
        .returning();

      if (!newUser) {
        // Cleanup
        await db.delete(roles).where(eq(roles.id, adminRole.id));
        await db.delete(partners).where(eq(partners.id, newPartner.id));
        return c.json({ error: 'Failed to create user' }, 500);
      }

      // Associate user with partner
      await db.insert(partnerUsers).values({
        partnerId: newPartner.id,
        userId: newUser.id,
        roleId: adminRole.id,
        orgAccess: 'all'
      });

      // Create tokens with partner scope
      const tokens = await createTokenPair({
        sub: newUser.id,
        email: newUser.email,
        roleId: adminRole.id,
        orgId: null,
        partnerId: newPartner.id,
        scope: 'partner',
        mfa: false
      });

      // Update last login
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
        partner: {
          id: newPartner.id,
          name: newPartner.name,
          slug: newPartner.slug
        },
        tokens: toPublicTokens(tokens),
        mfaRequired: false
      });
    } catch (err) {
      console.error('Partner registration error:', err);
      return c.json({ error: 'Registration failed. Please try again.' }, 500);
    }
  });
});
