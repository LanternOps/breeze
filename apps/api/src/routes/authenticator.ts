import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
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
import {
  requireCurrentPasswordStepUp,
  writeAuthAudit,
  enforceApproverRegisterStepUp,
  userHasStrongerReauthFactor,
} from './auth/helpers';
import { mintStepUpGrant } from '../services/mfaStepUpGrant';
import { getUserEpochs } from '../services';
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

// #2707: registration is grant-gated (enforceApproverRegisterStepUp), not
// re-validated password-by-password on every call. `registerGrantId` is
// optional at the wire/schema layer — same pattern as the existing
// `stepUpGrantId` fields (auth/passkeys.ts, auth/mfa.ts, auth/phone.ts) — so a
// missing grant still reaches the security helper and gets the uniform
// `register_step_up_required` 403 instead of a generic validation 400.
const registerGrantIdSchema = z.string().min(1).max(128).optional();

const registerOptionsSchema = z.object({
  registerGrantId: registerGrantIdSchema,
});
const registerVerifySchema = z.object({
  registerGrantId: registerGrantIdSchema,
  response: attestationResponseSchema,
  label: deviceLabelSchema.optional(),
});
const registerGrantMintSchema = z.object({
  currentPassword: z.string().min(1).max(256),
});

// Mobile hardware-key registration — requires a register_approver_device grant
// (minted at login, returned as authenticatorRegisterGrantId). The old
// client-asserted kind/isPlatformBound discriminators are ignored entirely; the
// server forces kind='mobile_hw_key' and is_platform_bound=true. publicKey +
// label are re-validated through the shared mobileHwKeyRegisterSchema
// (`.strict()`) before insert; registerGrantId is stripped prior to that parse.
const mobileRegisterSchema = z
  .object({
    registerGrantId: registerGrantIdSchema,
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

// #2707: password-fallback grant mint for the browser register flow. Gated:
// accounts holding a stronger factor (TOTP or a passkey) must mint via
// POST /auth/mfa/step-up instead — otherwise a stolen session + phished
// password could register an approver key on an MFA-protected account.
authenticatorRoutes.post(
  '/register-grant',
  authMiddleware,
  zValidator('json', registerGrantMintSchema),
  async (c) => {
    const auth = c.get('auth');
    const { currentPassword } = c.req.valid('json');

    if (await userHasStrongerReauthFactor(auth.user.id)) {
      writeAuthAudit(c, {
        orgId: auth.orgId ?? undefined,
        action: 'auth.authenticator.register_grant.denied',
        result: 'failure',
        reason: 'stronger_factor_required',
        userId: auth.user.id,
        email: auth.user.email,
      });
      return c.json({ error: 'stronger_factor_required' }, 403);
    }

    const passwordError = await requireCurrentPasswordStepUp(
      c,
      auth.user.id,
      currentPassword,
      'authenticator:pwd'
    );
    if (passwordError) return passwordError;

    const epochs = await getUserEpochs(auth.user.id);
    if (!epochs || !auth.token.sid) {
      writeAuthAudit(c, {
        orgId: auth.orgId ?? undefined,
        action: 'auth.authenticator.register_grant.mint_failed',
        result: 'failure',
        reason: 'epochs_unavailable',
        userId: auth.user.id,
        email: auth.user.email,
      });
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }
    const registerGrantId = await mintStepUpGrant({
      userId: auth.user.id,
      operation: 'register_approver_device',
      authEpoch: epochs.authEpoch,
      mfaEpoch: epochs.mfaEpoch,
      sid: auth.token.sid,
    });
    if (!registerGrantId) {
      writeAuthAudit(c, {
        orgId: auth.orgId ?? undefined,
        action: 'auth.authenticator.register_grant.mint_failed',
        result: 'failure',
        reason: 'mint_failed',
        userId: auth.user.id,
        email: auth.user.email,
      });
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }

    writeAuthAudit(c, {
      orgId: auth.orgId ?? undefined,
      action: 'auth.authenticator.register_grant.minted',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { method: 'password' },
    });

    return c.json({ registerGrantId });
  }
);

// Registration is grant-gated (#2707): the browser mints a register grant via
// POST /register-grant (password fallback) or POST /auth/mfa/step-up (stronger
// factor), then presents it here as registerGrantId. The SAME grant validated
// here (non-consuming) is consumed at /devices/webauthn/verify.
authenticatorRoutes.post(
  '/devices/webauthn/options',
  authMiddleware,
  zValidator('json', registerOptionsSchema),
  async (c) => {
    const auth = c.get('auth');
    const { registerGrantId } = c.req.valid('json');

    // Non-consuming validate — the SAME grant is consumed at /verify. A
    // missing/expired/mismatched grant 403s before any challenge is issued.
    const grantError = await enforceApproverRegisterStepUp(c, auth, registerGrantId, { consume: false });
    if (grantError) return grantError;

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
    const { registerGrantId, response, label } = c.req.valid('json');

    // Terminal write — consume the grant (single-use, closes the previously
    // unguarded verify step: pre-#2707 this route had NO step-up at all).
    const grantError = await enforceApproverRegisterStepUp(c, auth, registerGrantId, { consume: true });
    if (grantError) return grantError;

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

// Mobile hardware-key registration — register-grant required (minted at
// login), then deferred PoP. The phone POSTs its Secure-Enclave / Keystore
// public key plus the register_approver_device grant, which proves the caller
// completed the login-time step-up and not merely holds a stolen access
// token. There is NO registration-time proof-of-possession signature — the
// row is inserted PENDING (`last_used_at` null) and is ACTIVATED on its first
// real approval signature, verified in
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

    // Re-validate the authoritative fields through the shared strict schema
    // BEFORE consuming the single-use grant: the client-asserted
    // kind/isPlatformBound discriminators are ignored (the server forces
    // kind='mobile_hw_key' + is_platform_bound=true). A bad/missing publicKey
    // or label is a 400 here, never an insert — and parsing first means a
    // malformed payload never burns a caller's valid grant (unlike the
    // consume-first ordering, which is correct for /devices/webauthn/verify
    // because that route's body has no comparable pre-consume validation to
    // do — the WebAuthn response itself is verified cryptographically, not
    // schema-parsed).
    const parsed = mobileHwKeyRegisterSchema.safeParse({
      publicKey: (body as { publicKey?: unknown }).publicKey,
      label: (body as { label?: unknown }).label,
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid_registration', detail: parsed.error.issues }, 400);
    }
    const { publicKey, label } = parsed.data;

    const grantError = await enforceApproverRegisterStepUp(c, auth, body.registerGrantId, { consume: true });
    if (grantError) return grantError;

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
