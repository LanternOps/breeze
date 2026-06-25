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
import { loadPartnerPolicy, validateRaiseOnly } from '../services/authenticatorPolicy';
import { readMobileDeviceId } from '../services/mobileDeviceBinding';
import { requireCurrentPasswordStepUp, writeAuthAudit } from './auth/helpers';
import { authenticatorPolicySchema, mobileHwKeyRegisterSchema } from '@breeze/shared';

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

// Mobile hardware-key registration — requires a current-password step-up.
// The phone POSTs its freshly generated Secure-Enclave / Keystore SPKI public
// key + a label, plus the account password to prove the caller controls the
// account (not merely a stolen access token). No registration-time signature —
// the key is stored PENDING (last_used_at null) and ACTIVATES on its first
// approval signature, which is verified in the assurance path.
//
// The wire body also carries client-asserted `kind` / `isPlatformBound`
// discriminators (the mobile client sends them); we tolerate but do NOT trust
// them — the server forces kind='mobile_hw_key' and is_platform_bound=true. The
// authoritative `publicKey` + `label` are re-validated through the shared
// `mobileHwKeyRegisterSchema` (`.strict()`) before insert; `currentPassword` is
// intentionally stripped prior to that parse so the strict schema doesn't reject
// the field.
const mobileRegisterSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    kind: z.literal('mobile_hw_key').optional(),
    isPlatformBound: z.boolean().optional(),
  })
  .passthrough();
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

// Mobile hardware-key registration — password step-up required, then deferred PoP.
// The phone POSTs its Secure-Enclave / Keystore public key plus the account
// password (step-up), which proves the caller controls the account and not merely
// a stolen access token. There is NO registration-time proof-of-possession
// signature — the row is inserted PENDING (`last_used_at` null) and is ACTIVATED
// on its first real approval signature, verified in
// `authenticatorAssurance.verifyMobileFactor` (which sets `last_used_at`). The
// deferred-PoP design means a registered-but-never-used key can never satisfy an
// approval until it has signed at least once.
authenticatorRoutes.post(
  '/devices',
  authMiddleware,
  zValidator('json', mobileRegisterSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    // Password step-up mirrors /devices/webauthn/options — registering an
    // approver device with a stolen access token is the attack this guards
    // against. The caller proves they know the account password before any SPKI
    // key is stored. `currentPassword` is validated by the outer
    // `mobileRegisterSchema` (required, non-empty) before reaching here.
    const passwordError = await requireCurrentPasswordStepUp(
      c,
      auth.user.id,
      body.currentPassword,
      'authenticator:pwd'
    );
    if (passwordError) return passwordError;

    // Re-validate the authoritative fields through the shared strict schema; the
    // client-asserted kind/isPlatformBound discriminators are ignored (the server
    // forces kind='mobile_hw_key' + is_platform_bound=true). A bad/missing
    // publicKey or label is a 400 here, never an insert.
    const parsed = mobileHwKeyRegisterSchema.safeParse({
      publicKey: (body as { publicKey?: unknown }).publicKey,
      label: (body as { label?: unknown }).label,
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid_registration', detail: parsed.error.issues }, 400);
    }
    const { publicKey, label } = parsed.data;

    // Per-install device id is a UX/migration hint only (client-controlled,
    // SR-001) — null when the header is absent.
    const mobileDeviceId = readMobileDeviceId(c);

    const [inserted] = await db
      .insert(authenticatorDevices)
      .values({
        userId: auth.user.id,
        kind: 'mobile_hw_key',
        label,
        publicKey,
        credentialId: null,
        signCount: 0,
        isPlatformBound: true,
        mobileDeviceId,
        // last_used_at intentionally left at its null default — the PENDING
        // marker. The first approval signature flips it active server-side.
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

    return c.json({ success: true, device: toPublicDevice(inserted) }, 201);
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
