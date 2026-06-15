import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { authenticatorDevices, authenticatorPolicies } from '../db/schema';
import { authMiddleware, requirePermission, requireMfa } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import {
  generateApproverRegistrationOptions,
  verifyApproverRegistration,
} from '../services/approverWebAuthn';
import {
  consumeMobileRegistrationNonce,
  issueMobileRegistrationNonce,
  verifyMobileSignature,
} from '../services/mobileHwKey';
import { loadPartnerPolicy, validateRaiseOnly } from '../services/authenticatorPolicy';
import { readMobileDeviceId } from '../services/mobileDeviceBinding';
import { requireCurrentPasswordStepUp, writeAuthAudit } from './auth/helpers';
import { authenticatorPolicySchema } from '@breeze/shared';

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

// Mobile hardware-key registration: the client proves possession of a freshly
// generated Secure Enclave / StrongBox key by signing the server-issued
// registration nonce (RSA-SHA256 over the consumed nonce).
const mobileRegisterVerifySchema = z.object({
  publicKey: z.string().min(1).max(4096), // SPKI DER, base64
  signature: z.string().min(1).max(4096), // RSA-SHA256 over the nonce, base64
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

// Mobile hardware-key registration mirrors the webauthn flow above: a
// password step-up gates `options` (which issues a single-use registration
// nonce), then `verify` proves possession by verifying an RSA-SHA256 signature
// over that consumed nonce before inserting the device.
authenticatorRoutes.post(
  '/devices/mobile-hw-key/options',
  authMiddleware,
  zValidator('json', registerOptionsSchema),
  async (c) => {
    const auth = c.get('auth');
    const { currentPassword } = c.req.valid('json');

    const passwordError = await requireCurrentPasswordStepUp(
      c,
      auth.user.id,
      currentPassword,
      'authenticator:pwd'
    );
    if (passwordError) return passwordError;

    const nonce = await issueMobileRegistrationNonce(auth.user.id);
    return c.json({ nonce });
  }
);

authenticatorRoutes.post(
  '/devices/mobile-hw-key/verify',
  authMiddleware,
  zValidator('json', mobileRegisterVerifySchema),
  async (c) => {
    const auth = c.get('auth');
    const { publicKey, signature, label } = c.req.valid('json');

    // Consume the single-use nonce first; a missing/expired nonce is a 400 and
    // the signature is never checked (no oracle).
    const nonce = await consumeMobileRegistrationNonce(auth.user.id);
    if (!nonce) {
      return c.json({ error: 'Registration challenge expired or missing' }, 400);
    }

    const verified = verifyMobileSignature({
      publicKeySpkiB64: publicKey,
      payload: nonce,
      signatureB64: signature,
    });
    if (!verified) {
      return c.json({ error: 'Proof-of-possession signature verification failed' }, 400);
    }

    // Per-install device id is a UX/migration hint only (client-controlled,
    // SR-001) — null when the header is absent.
    const mobileDeviceId = readMobileDeviceId(c);

    const [inserted] = await db
      .insert(authenticatorDevices)
      .values({
        userId: auth.user.id,
        kind: 'mobile_hw_key',
        label: label ?? 'This phone',
        publicKey,
        credentialId: null,
        signCount: 0,
        isPlatformBound: true,
        mobileDeviceId,
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
        kind: 'mobile_hw_key',
        isPlatformBound: true,
        mobileDeviceId,
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

// ============================================================
// Partner approval-security policy (Phase 4) — read/write the per-MSP
// enforcement floor. Partner-axis; gated by USERS_WRITE (managing the
// technicians' approval-security posture). Raise-only is re-validated here.
// ============================================================

const DEFAULT_POLICY = { floorOverrides: {}, requireEnrollment: false, enforceFrom: null as string | null };

authenticatorRoutes.get(
  '/policy',
  authMiddleware,
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const policy = await loadPartnerPolicy(auth.partnerId ?? null);
    if (!policy) return c.json({ policy: DEFAULT_POLICY });
    return c.json({
      policy: {
        floorOverrides: policy.floorOverrides ?? {},
        requireEnrollment: policy.requireEnrollment,
        enforceFrom: policy.enforceFrom ? policy.enforceFrom.toISOString() : null,
      },
    });
  },
);

authenticatorRoutes.put(
  '/policy',
  authMiddleware,
  requireMfa(), // this endpoint can weaken the partner's step-up enforcement — gate it like PAM mutations
  requirePermission(PERMISSIONS.USERS_WRITE.resource, PERMISSIONS.USERS_WRITE.action),
  zValidator('json', authenticatorPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.partnerId) {
      return c.json({ error: 'Approval-security policy is partner-scoped' }, 400);
    }
    const input = c.req.valid('json');
    // floorOverrides already infers as AssuranceFloorOverrides (literal levels in
    // the schema) — no cast needed.
    const floorOverrides = input.floorOverrides;

    // Raise-only: a partner may only strengthen the Breeze floor, never weaken it.
    try {
      validateRaiseOnly(floorOverrides);
    } catch (err) {
      return c.json({ error: 'invalid_policy', detail: err instanceof Error ? err.message : 'raise-only violation' }, 400);
    }

    const values = {
      partnerId: auth.partnerId,
      floorOverrides,
      requireEnrollment: input.requireEnrollment,
      enforceFrom: input.enforceFrom ? new Date(input.enforceFrom) : null,
      updatedByUserId: auth.user.id,
      updatedAt: new Date(),
    };
    await db
      .insert(authenticatorPolicies)
      .values(values)
      .onConflictDoUpdate({
        target: authenticatorPolicies.partnerId,
        set: {
          floorOverrides: values.floorOverrides,
          requireEnrollment: values.requireEnrollment,
          enforceFrom: values.enforceFrom,
          updatedByUserId: values.updatedByUserId,
          updatedAt: values.updatedAt,
        },
      });

    writeAuthAudit(c, {
      action: 'auth.authenticator.policy.update',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { partnerId: auth.partnerId, requireEnrollment: input.requireEnrollment, floorOverrides: input.floorOverrides },
    });

    return c.json({ success: true });
  },
);
