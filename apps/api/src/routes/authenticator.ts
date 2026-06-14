import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { authenticatorDevices } from '../db/schema';
import { authMiddleware } from '../middleware/auth';
import {
  generateApproverRegistrationOptions,
  verifyApproverRegistration,
} from '../services/approverWebAuthn';
import { requireCurrentPasswordStepUp, writeAuthAudit } from './auth/helpers';

// Attestation payload is a large nested object validated structurally by
// @simplewebauthn at the service layer; here we only require a string `id` so a
// malformed body is rejected at validation (400) instead of falling through.
const attestationResponseSchema = z
  .any()
  .refine(
    (value): boolean => typeof value?.id === 'string' && value.id.length > 0,
    { message: 'response.id is required' }
  );

const deviceLabelSchema = z.string().trim().min(1).max(255);

const registerOptionsSchema = z.object({
  currentPassword: z.string().min(1).max(256),
});
const registerVerifySchema = z.object({
  response: attestationResponseSchema,
  label: deviceLabelSchema.optional(),
});
const revokeSchema = z.object({
  reason: z.string().trim().max(255).optional(),
});
const renameSchema = z.object({
  label: deviceLabelSchema,
});

type ApproverDeviceRow = typeof authenticatorDevices.$inferSelect;

function toPublicDevice(device: ApproverDeviceRow) {
  return {
    id: device.id,
    label: device.label,
    kind: device.kind,
    isPlatformBound: device.isPlatformBound,
    transports: device.transports ?? [],
    lastUsedAt: device.lastUsedAt?.toISOString() ?? null,
    createdAt: device.createdAt?.toISOString() ?? null,
  };
}

async function listActiveDevices(userId: string): Promise<ApproverDeviceRow[]> {
  // RLS already scopes authenticator_devices to the user; the explicit userId
  // predicate is defense-in-depth (see reference memory: admin-list IDOR).
  return db
    .select()
    .from(authenticatorDevices)
    .where(and(eq(authenticatorDevices.userId, userId), isNull(authenticatorDevices.disabledAt)))
    .limit(100);
}

function findOwnedDevice(id: string, userId: string): Promise<ApproverDeviceRow[]> {
  return db
    .select()
    .from(authenticatorDevices)
    .where(
      and(
        eq(authenticatorDevices.id, id),
        eq(authenticatorDevices.userId, userId),
        isNull(authenticatorDevices.disabledAt)
      )
    )
    .limit(1);
}

// Registration lives under /authenticator so it sits with the other
// device-registration flows; management of the caller's own devices lives under
// the /me/* group (mirrors users/me + auth/passkeys conventions).
export const authenticatorRoutes = new Hono();

authenticatorRoutes.post(
  '/devices/webauthn/options',
  authMiddleware,
  zValidator('json', registerOptionsSchema),
  async (c) => {
    const auth = c.get('auth');
    const { currentPassword } = c.req.valid('json');

    // Password step-up mirrors routes/auth/passkeys.ts — registering an approver
    // device is a security-sensitive action and must reconfirm the password.
    const passwordError = await requireCurrentPasswordStepUp(
      c,
      auth.user.id,
      currentPassword,
      'authenticator:pwd'
    );
    if (passwordError) return passwordError;

    const existing = await listActiveDevices(auth.user.id);
    const options = await generateApproverRegistrationOptions({
      user: {
        id: auth.user.id,
        name: auth.user.email,
        displayName: auth.user.name,
      },
      existing: existing
        .filter((d) => d.credentialId)
        .map((d) => ({ credentialId: d.credentialId!, transports: d.transports })),
    });

    return c.json({ options });
  }
);

authenticatorRoutes.post(
  '/devices/webauthn/verify',
  authMiddleware,
  zValidator('json', registerVerifySchema),
  async (c) => {
    const auth = c.get('auth');
    const { response, label } = c.req.valid('json');

    const fields = await verifyApproverRegistration({
      userId: auth.user.id,
      response,
    });

    const [inserted] = await db
      .insert(authenticatorDevices)
      .values({
        userId: auth.user.id,
        kind: 'webauthn_platform',
        label: label ?? 'This device',
        publicKey: fields.publicKey,
        credentialId: fields.credentialId,
        signCount: fields.counter,
        aaguid: fields.aaguid,
        transports: (fields.transports ?? undefined) as ApproverDeviceRow['transports'],
        isPlatformBound: fields.isPlatformBound,
      })
      .returning();

    if (!inserted) {
      throw new Error('Approver device insert returned no row');
    }

    writeAuthAudit(c, {
      orgId: auth.orgId ?? undefined,
      action: 'auth.authenticator.device.register',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: {
        deviceId: inserted.id,
        kind: 'webauthn_platform',
        isPlatformBound: fields.isPlatformBound,
      },
    });

    return c.json({ success: true, device: toPublicDevice(inserted) });
  }
);

export const approverDevicesRoutes = new Hono();

approverDevicesRoutes.get('/', authMiddleware, async (c) => {
  const auth = c.get('auth');
  const rows = await listActiveDevices(auth.user.id);
  return c.json({ devices: rows.map(toPublicDevice) });
});

approverDevicesRoutes.post(
  '/:id/revoke',
  authMiddleware,
  zValidator('json', revokeSchema),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id');
    const { reason } = c.req.valid('json');

    const [device] = await findOwnedDevice(id, auth.user.id);
    if (!device) {
      return c.json({ error: 'Approver device not found' }, 404);
    }

    await db
      .update(authenticatorDevices)
      .set({ disabledAt: new Date(), disabledReason: reason ?? 'user_revoked' })
      .where(eq(authenticatorDevices.id, id));

    writeAuthAudit(c, {
      orgId: auth.orgId ?? undefined,
      action: 'auth.authenticator.device.revoke',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { deviceId: id, reason: reason ?? 'user_revoked' },
    });

    return c.json({ success: true });
  }
);

approverDevicesRoutes.patch(
  '/:id',
  authMiddleware,
  zValidator('json', renameSchema),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id');
    const { label } = c.req.valid('json');

    const [device] = await findOwnedDevice(id, auth.user.id);
    if (!device) {
      return c.json({ error: 'Approver device not found' }, 404);
    }

    const [updated] = await db
      .update(authenticatorDevices)
      .set({ label })
      .where(eq(authenticatorDevices.id, id))
      .returning();

    return c.json({ success: true, device: toPublicDevice(updated ?? device) });
  }
);
