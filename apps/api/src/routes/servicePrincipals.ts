import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db, type Database } from '../db';
import { servicePrincipalKeys, servicePrincipals } from '../db/schema';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { isValidIpOrCidr } from '../services/ipMatch';
import { PERMISSIONS } from '../services/permissions';
import {
  ServicePrincipalKeyError,
  issueServicePrincipalKey,
  rotateServicePrincipalKey,
} from '../services/servicePrincipalKeys';
import {
  DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES,
  type PartnerServicePrincipalScope,
  validatePartnerServicePrincipalScopes,
} from '../services/servicePrincipalScopes';

export const servicePrincipalRoutes = new Hono();

const PRINCIPAL_NAME_UNIQUE_CONSTRAINT = 'service_principals_partner_name_unique';

const partnerIdSchema = z.string().guid().optional();
const listSchema = z.object({ partnerId: partnerIdSchema });
const idSchema = z.object({ id: z.string().guid() });
const keyParamsSchema = z.object({ id: z.string().guid(), keyId: z.string().guid() });
const createSchema = z.object({
  partnerId: partnerIdSchema,
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullable().optional(),
  scopes: z.array(z.string()).default([...DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES]),
  expiresAt: z.string().datetime().nullable().optional(),
  sourceCidrs: z.array(z.string()).default([]),
});
const updateSchema = z.object({
  partnerId: partnerIdSchema,
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  sourceCidrs: z.array(z.string()).optional(),
});
const issueKeySchema = z.object({
  partnerId: partnerIdSchema,
  name: z.string().trim().min(1).max(255),
  expiresAt: z.string().datetime().nullable().optional(),
  rateLimit: z.number().int().min(1).max(10000).optional(),
});

type ManagementAuth = {
  scope: 'partner' | 'system' | 'organization';
  partnerId?: string | null;
  user: { id: string; email?: string };
};

function resolvePartnerId(
  c: any,
  requestedPartnerId?: string,
): { partnerId: string } | { response: Response } {
  const auth = c.get('auth') as ManagementAuth;
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return { response: c.json({ error: 'Partner context required' }, 403) };
    if (requestedPartnerId && requestedPartnerId !== auth.partnerId) {
      return { response: c.json({ error: 'Access to this partner denied' }, 403) };
    }
    return { partnerId: auth.partnerId };
  }
  if (auth.scope === 'system' && requestedPartnerId) return { partnerId: requestedPartnerId };
  return { response: c.json({ error: 'Partner context required' }, 403) };
}

function validatePrincipalFields(
  c: any,
  input: { scopes?: string[]; sourceCidrs?: string[]; expiresAt?: string | null },
): { scopes?: PartnerServicePrincipalScope[]; expiresAt?: Date | null } | { response: Response } {
  let scopes: PartnerServicePrincipalScope[] | undefined;
  if (input.scopes) {
    const validated = validatePartnerServicePrincipalScopes(input.scopes);
    if (!validated.ok) return { response: c.json({ error: validated.error, details: validated.details }, validated.status) };
    scopes = validated.scopes;
  }
  if (input.sourceCidrs?.some((entry) => !isValidIpOrCidr(entry))) {
    return { response: c.json({ error: 'Source CIDRs must contain valid IP addresses or CIDRs' }, 400) };
  }
  const expiresAt = input.expiresAt === undefined
    ? undefined
    : input.expiresAt === null ? null : new Date(input.expiresAt);
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return { response: c.json({ error: 'Expiry must be in the future' }, 400) };
  }
  return { scopes, expiresAt };
}

function keyError(c: any, error: unknown): Response {
  if (error instanceof ServicePrincipalKeyError) {
    return c.json({ error: error.message, code: error.code }, error.status as 400 | 404 | 409);
  }
  throw error;
}

function isPrincipalNameUniqueViolation(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; candidate && depth < 5; depth += 1) {
    if (typeof candidate !== 'object') break;
    const pg = candidate as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const constraint = pg.constraint_name ?? pg.constraint;
    if (pg.code === '23505' && constraint === PRINCIPAL_NAME_UNIQUE_CONSTRAINT) return true;
    if (typeof pg.message === 'string' && pg.message.includes(PRINCIPAL_NAME_UNIQUE_CONSTRAINT)) return true;
    candidate = pg.cause;
  }
  return false;
}

servicePrincipalRoutes.use('*', authMiddleware);

servicePrincipalRoutes.get(
  '/',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', listSchema),
  async (c) => {
    const resolved = resolvePartnerId(c, c.req.valid('query').partnerId);
    if ('response' in resolved) return resolved.response;

    const principals = await db
      .select({
        id: servicePrincipals.id,
        partnerId: servicePrincipals.partnerId,
        name: servicePrincipals.name,
        description: servicePrincipals.description,
        status: servicePrincipals.status,
        scopes: servicePrincipals.scopes,
        expiresAt: servicePrincipals.expiresAt,
        sourceCidrs: servicePrincipals.sourceCidrs,
        createdAt: servicePrincipals.createdAt,
        updatedAt: servicePrincipals.updatedAt,
      })
      .from(servicePrincipals)
      .where(eq(servicePrincipals.partnerId, resolved.partnerId))
      .orderBy(asc(servicePrincipals.name));

    const keys = await db
      .select({
        id: servicePrincipalKeys.id,
        servicePrincipalId: servicePrincipalKeys.servicePrincipalId,
        name: servicePrincipalKeys.name,
        keyPrefix: servicePrincipalKeys.keyPrefix,
        status: servicePrincipalKeys.status,
        expiresAt: servicePrincipalKeys.expiresAt,
        rateLimit: servicePrincipalKeys.rateLimit,
        lastUsedAt: servicePrincipalKeys.lastUsedAt,
        revokedAt: servicePrincipalKeys.revokedAt,
        rotatedFromId: servicePrincipalKeys.rotatedFromId,
        createdAt: servicePrincipalKeys.createdAt,
      })
      .from(servicePrincipalKeys)
      .where(eq(servicePrincipalKeys.partnerId, resolved.partnerId))
      .orderBy(asc(servicePrincipalKeys.createdAt));

    const keysByPrincipal = new Map<string, typeof keys>();
    for (const key of keys) {
      const list = keysByPrincipal.get(key.servicePrincipalId) ?? [];
      list.push(key);
      keysByPrincipal.set(key.servicePrincipalId, list);
    }
    return c.json({ data: principals.map((principal) => ({
      ...principal,
      keys: keysByPrincipal.get(principal.id) ?? [],
    })) });
  },
);

servicePrincipalRoutes.post(
  '/',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', createSchema),
  async (c) => {
    const auth = c.get('auth') as ManagementAuth;
    const input = c.req.valid('json');
    const resolved = resolvePartnerId(c, input.partnerId);
    if ('response' in resolved) return resolved.response;
    const validated = validatePrincipalFields(c, input);
    if ('response' in validated) return validated.response;

    const [duplicate] = await db
      .select({ id: servicePrincipals.id })
      .from(servicePrincipals)
      .where(and(
        eq(servicePrincipals.partnerId, resolved.partnerId),
        eq(servicePrincipals.name, input.name),
      ))
      .limit(1);
    if (duplicate) return c.json({ error: 'A service principal with this name already exists' }, 409);

    // Avoid raising 23505 inside authMiddleware's ambient transaction: a
    // statement-level error aborts that transaction even if caught by the
    // handler. Zero returned rows is the race-safe duplicate signal.
    const [created] = await db.insert(servicePrincipals)
      .values({
        partnerId: resolved.partnerId,
        name: input.name,
        description: input.description ?? null,
        scopes: validated.scopes!,
        expiresAt: validated.expiresAt ?? null,
        sourceCidrs: input.sourceCidrs,
        createdBy: auth.user.id,
        updatedBy: auth.user.id,
      })
      .onConflictDoNothing({ target: [servicePrincipals.partnerId, servicePrincipals.name] })
      .returning();
    if (!created) return c.json({ error: 'A service principal with this name already exists' }, 409);

    writeRouteAudit(c as any, {
      orgId: null,
      action: 'service_principal.create',
      resourceType: 'service_principal',
      resourceId: created.id,
      resourceName: created.name,
      details: { principalType: 'service_principal', partnerId: resolved.partnerId, scopes: created.scopes },
    });
    return c.json({ data: created }, 201);
  },
);

servicePrincipalRoutes.patch(
  '/:id',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idSchema),
  zValidator('json', updateSchema),
  async (c) => {
    const auth = c.get('auth') as ManagementAuth;
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const resolved = resolvePartnerId(c, input.partnerId);
    if ('response' in resolved) return resolved.response;
    const changed = Object.keys(input).filter((key) => key !== 'partnerId');
    if (changed.length === 0) return c.json({ error: 'No updates provided' }, 400);
    const validated = validatePrincipalFields(c, input);
    if ('response' in validated) return validated.response;

    if (input.name) {
      const [duplicate] = await db.select({ id: servicePrincipals.id }).from(servicePrincipals)
        .where(and(
          eq(servicePrincipals.partnerId, resolved.partnerId),
          eq(servicePrincipals.name, input.name),
        )).limit(1);
      if (duplicate && duplicate.id !== id) return c.json({ error: 'A service principal with this name already exists' }, 409);
    }

    const values: Record<string, unknown> = { updatedAt: new Date(), updatedBy: auth.user.id };
    if (input.name !== undefined) values.name = input.name;
    if (input.description !== undefined) values.description = input.description;
    if (input.status !== undefined) values.status = input.status;
    if (validated.scopes !== undefined) values.scopes = validated.scopes;
    if (validated.expiresAt !== undefined) values.expiresAt = validated.expiresAt;
    if (input.sourceCidrs !== undefined) values.sourceCidrs = input.sourceCidrs;

    let updated: typeof servicePrincipals.$inferSelect | undefined;
    try {
      // Under the ambient request transaction this nested transaction is a
      // savepoint. A concurrent rename collision can therefore roll back the
      // failed statement before we translate it, leaving the outer request
      // transaction usable for the 409 response.
      updated = await db.transaction(async (tx) => {
        const [row] = await tx.update(servicePrincipals).set(values).where(and(
          eq(servicePrincipals.id, id), eq(servicePrincipals.partnerId, resolved.partnerId),
        )).returning();
        return row;
      });
    } catch (error) {
      if (isPrincipalNameUniqueViolation(error)) {
        return c.json({ error: 'A service principal with this name already exists' }, 409);
      }
      throw error;
    }
    if (!updated) return c.json({ error: 'Service principal not found' }, 404);
    writeRouteAudit(c as any, {
      orgId: null, action: 'service_principal.update', resourceType: 'service_principal',
      resourceId: id, resourceName: updated.name,
      details: { principalType: 'service_principal', partnerId: resolved.partnerId, changedFields: changed },
    });
    return c.json({ data: updated });
  },
);

servicePrincipalRoutes.post(
  '/:id/keys',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idSchema),
  zValidator('json', issueKeySchema),
  async (c) => {
    const auth = c.get('auth') as ManagementAuth;
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const resolved = resolvePartnerId(c, input.partnerId);
    if ('response' in resolved) return resolved.response;
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) return c.json({ error: 'Expiry must be in the future' }, 400);
    try {
      const issued = await issueServicePrincipalKey(db, {
        servicePrincipalId: id, partnerId: resolved.partnerId, name: input.name,
        actorId: auth.user.id, expiresAt, rateLimit: input.rateLimit,
      });
      writeRouteAudit(c as any, {
        orgId: null, action: 'service_principal_key.issue', resourceType: 'service_principal_key',
        resourceId: issued.keyId, resourceName: input.name,
        details: { principalType: 'service_principal', partnerId: resolved.partnerId, servicePrincipalId: id, keyId: issued.keyId, keyPrefix: issued.keyPrefix },
      });
      return c.json({ keyId: issued.keyId, key: issued.rawKey, keyPrefix: issued.keyPrefix }, 201);
    } catch (error) {
      return keyError(c, error);
    }
  },
);

servicePrincipalRoutes.post(
  '/:id/keys/:keyId/rotate',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', keyParamsSchema),
  zValidator('query', listSchema),
  async (c) => {
    const auth = c.get('auth') as ManagementAuth;
    const { id, keyId } = c.req.valid('param');
    const resolved = resolvePartnerId(c, c.req.valid('query').partnerId);
    if ('response' in resolved) return resolved.response;
    try {
      const rotated = await db.transaction((tx) => rotateServicePrincipalKey(tx as unknown as Database, {
        servicePrincipalId: id, keyId, partnerId: resolved.partnerId, actorId: auth.user.id,
      }));
      writeRouteAudit(c as any, {
        orgId: null, action: 'service_principal_key.rotate', resourceType: 'service_principal_key',
        resourceId: rotated.keyId,
        details: { principalType: 'service_principal', partnerId: resolved.partnerId, servicePrincipalId: id, keyId: rotated.keyId, rotatedFromId: keyId, keyPrefix: rotated.keyPrefix },
      });
      return c.json({ keyId: rotated.keyId, key: rotated.rawKey, keyPrefix: rotated.keyPrefix });
    } catch (error) {
      return keyError(c, error);
    }
  },
);

servicePrincipalRoutes.delete(
  '/:id/keys/:keyId',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', keyParamsSchema),
  zValidator('query', listSchema),
  async (c) => {
    const { id, keyId } = c.req.valid('param');
    const resolved = resolvePartnerId(c, c.req.valid('query').partnerId);
    if ('response' in resolved) return resolved.response;
    const [existing] = await db.select({
      id: servicePrincipalKeys.id, name: servicePrincipalKeys.name,
      status: servicePrincipalKeys.status, keyPrefix: servicePrincipalKeys.keyPrefix,
    }).from(servicePrincipalKeys).where(and(
      eq(servicePrincipalKeys.id, keyId),
      eq(servicePrincipalKeys.servicePrincipalId, id),
      eq(servicePrincipalKeys.partnerId, resolved.partnerId),
    )).limit(1);
    if (!existing) return c.json({ error: 'Service principal key not found' }, 404);
    if (existing.status === 'revoked') return c.json({ success: true, alreadyRevoked: true });

    const [revoked] = await db.update(servicePrincipalKeys).set({ status: 'revoked', revokedAt: new Date() })
      .where(and(
        eq(servicePrincipalKeys.id, keyId),
        eq(servicePrincipalKeys.servicePrincipalId, id),
        eq(servicePrincipalKeys.partnerId, resolved.partnerId),
        eq(servicePrincipalKeys.status, 'active'),
      )).returning({ id: servicePrincipalKeys.id });
    if (!revoked) return c.json({ success: true, alreadyRevoked: true });
    writeRouteAudit(c as any, {
      orgId: null, action: 'service_principal_key.revoke', resourceType: 'service_principal_key',
      resourceId: keyId, resourceName: existing.name,
      details: { principalType: 'service_principal', partnerId: resolved.partnerId, servicePrincipalId: id, keyId, keyPrefix: existing.keyPrefix },
    });
    return c.json({ success: true, alreadyRevoked: false });
  },
);
