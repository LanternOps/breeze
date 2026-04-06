import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { storageEncryptionKeys } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import { createEncryptionKeySchema, rotateEncryptionKeySchema } from './schemas';

export const encryptionRoutes = new Hono();

const keyIdParamSchema = z.object({ id: z.string().uuid() });

// ── List active keys for the org ─────────────────────────────────────────────

encryptionRoutes.get('/keys', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const rows = await db
    .select()
    .from(storageEncryptionKeys)
    .where(
      and(
        eq(storageEncryptionKeys.orgId, orgId),
        eq(storageEncryptionKeys.isActive, true)
      )
    );

  const data = rows.map(toKeyResponse);
  return c.json({ data });
});

// ── Create a new encryption key ──────────────────────────────────────────────

encryptionRoutes.post(
  '/keys',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', createEncryptionKeySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');
    const now = new Date();

    const [row] = await db
      .insert(storageEncryptionKeys)
      .values({
        orgId,
        name: payload.name,
        keyType: payload.keyType,
        publicKeyPem: payload.publicKeyPem ?? null,
        keyHash: payload.keyHash,
        isActive: true,
        createdAt: now,
      })
      .returning();

    if (!row) {
      return c.json({ error: 'Failed to create encryption key' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.encryption_key.create',
      resourceType: 'encryption_key',
      resourceId: row.id,
      resourceName: row.name,
      details: { keyType: row.keyType },
    });

    return c.json(toKeyResponse(row), 201);
  }
);

// ── Get key metadata ─────────────────────────────────────────────────────────

encryptionRoutes.get(
  '/keys/:id',
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('param', keyIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id: keyId } = c.req.valid('param');
    const [row] = await db
      .select()
      .from(storageEncryptionKeys)
      .where(
        and(
          eq(storageEncryptionKeys.id, keyId),
          eq(storageEncryptionKeys.orgId, orgId)
        )
      )
      .limit(1);

    if (!row) {
      return c.json({ error: 'Encryption key not found' }, 404);
    }

    return c.json(toKeyResponse(row));
  }
);

// ── Deactivate key (soft delete) ─────────────────────────────────────────────

encryptionRoutes.delete(
  '/keys/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', keyIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id: keyId } = c.req.valid('param');
    const [row] = await db
      .update(storageEncryptionKeys)
      .set({ isActive: false })
      .where(
        and(
          eq(storageEncryptionKeys.id, keyId),
          eq(storageEncryptionKeys.orgId, orgId)
        )
      )
      .returning();

    if (!row) {
      return c.json({ error: 'Encryption key not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.encryption_key.deactivate',
      resourceType: 'encryption_key',
      resourceId: row.id,
      resourceName: row.name,
    });

    return c.json({ deactivated: true });
  }
);

// ── Rotate key (deactivate old, create new) ──────────────────────────────────

encryptionRoutes.post(
  '/keys/:id/rotate',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', keyIdParamSchema),
  zValidator('json', rotateEncryptionKeySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id: oldKeyId } = c.req.valid('param');
    const payload = c.req.valid('json');

    // Find the old key
    const [oldKey] = await db
      .select()
      .from(storageEncryptionKeys)
      .where(
        and(
          eq(storageEncryptionKeys.id, oldKeyId),
          eq(storageEncryptionKeys.orgId, orgId)
        )
      )
      .limit(1);

    if (!oldKey) {
      return c.json({ error: 'Encryption key not found' }, 404);
    }

    if (!oldKey.isActive) {
      return c.json({ error: 'Cannot rotate an inactive key' }, 400);
    }

    const now = new Date();

    // Deactivate old key and create new key atomically in a transaction.
    const [newKey] = await db.transaction(async (tx) => {
      await tx
        .update(storageEncryptionKeys)
        .set({ isActive: false, rotatedAt: now })
        .where(eq(storageEncryptionKeys.id, oldKeyId));

      return tx
        .insert(storageEncryptionKeys)
        .values({
          orgId,
          name: `${oldKey.name} (rotated)`,
          keyType: oldKey.keyType,
          publicKeyPem: payload.newPublicKeyPem ?? null,
          keyHash: payload.newKeyHash,
          isActive: true,
          createdAt: now,
        })
        .returning();
    });

    if (!newKey) {
      return c.json({ error: 'Failed to create rotated key' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.encryption_key.rotate',
      resourceType: 'encryption_key',
      resourceId: newKey.id,
      resourceName: newKey.name,
      details: { previousKeyId: oldKeyId },
    });

    return c.json({
      previousKeyId: oldKeyId,
      newKey: toKeyResponse(newKey),
    });
  }
);

// ── Response mapper (never exposes private key material) ─────────────────────

function toKeyResponse(row: typeof storageEncryptionKeys.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    keyType: row.keyType,
    keyHash: row.keyHash,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    // Never return publicKeyPem or encryptedPrivateKey in list/detail responses
  };
}
