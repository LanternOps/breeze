import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { authenticatorDevices, authenticatorPolicies, mobileDevices } from '../db/schema';
import { authMiddleware, requirePermission, requireMfa } from '../middleware/auth';
import { userRateLimit } from '../middleware/userRateLimit';
import { PERMISSIONS } from '../services/permissions';
import {
  generateApproverRegistrationOptions,
  verifyApproverRegistration,
} from '../services/approverWebAuthn';
import { loadPartnerPolicy, validateRaiseOnly } from '../services/authenticatorPolicy';
import {
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  canManagePartnerWidePolicies,
} from '../services/partnerWideAccess';
import { readMobileDeviceId } from '../services/mobileDeviceBinding';
import { captureException } from '../services/sentry';
import { sha256CanonicalSpki, verifyMobileSignature } from '../services/mobileHwKey';
import {
  ATTEMPT_TTL_SECONDS,
  consumeRegistrationAttempt,
  issueRegistrationAttempt,
  registrationTranscript,
  verifyPlatformAttestation,
} from '../services/authenticatorAttestation';
import {
  requireCurrentPasswordStepUp,
  writeAuthAudit,
  enforceApproverRegisterStepUp,
  userHasStrongerReauthFactor,
} from './auth/helpers';
import { mintStepUpGrant } from '../services/mfaStepUpGrant';
import { getUserEpochs } from '../services';
import {
  authenticatorPolicySchema,
  mobileHwKeyRegisterSchema,
  mobileAttestationChallengeSchema,
  mobileAttestationVerifySchema,
} from '@breeze/shared';

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
// server forces kind='mobile_hw_key' and, since #1374, is_platform_bound=FALSE
// with platform_bound_basis='unattested' (this route verifies no platform
// attestation, so it may not claim one). publicKey + label are re-validated
// through the shared mobileHwKeyRegisterSchema (`.strict()`) before insert;
// registerGrantId is stripped prior to that parse.
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
    // #1374: the boolean alone is not the L4 gate, so the client is told WHY a
    // key counts as platform-bound. The mobile app needs this to tell an
    // attested enrolment from an unattested one after /devices/mobile/verify.
    platformBoundBasis: device.platformBoundBasis,
    transports: device.transports ?? [],
    lastUsedAt: device.lastUsedAt?.toISOString() ?? null,
    createdAt: device.createdAt?.toISOString() ?? null,
  };
}

/**
 * Resolve the `X-Breeze-Mobile-Device-Id` header to an OWNED, ACTIVE
 * `mobile_devices.id`. Shared by the legacy `POST /devices` route and the
 * attested `POST /devices/mobile/verify` route so the two cannot drift.
 *
 * Per-install device id is a UX/migration hint only (client-controlled, SR-001)
 * — null when the header is absent.
 *
 * The header carries `mobile_devices.device_id` — the VARCHAR per-install id
 * minted on the phone — NOT `mobile_devices.id`, the server-side uuid PK that
 * `authenticator_devices.mobile_device_id` FKs. Conflating the two shipped an
 * outage: the raw header went straight into the FK column and every mobile
 * registration 500'd (23503 for a uuid-shaped header, 22P02 for junk) —
 * Sentry BREEZE-12 / BREEZE-13.
 *
 * So: resolve, never trust. The lookup targets the varchar column (a junk
 * header is a miss, not a cast error) and carries an EXPLICIT ownership
 * predicate — RLS will not do that for us, because mobile_devices' SELECT
 * policy has an `OR EXISTS` branch that lets any same-tenant partner/org token
 * read a colleague's row (same reasoning as the SR-002 guard in
 * routes/mobile.ts). A miss degrades to null rather than failing the
 * registration; `mobile_device_id` is never read back anywhere in the API.
 *
 * Never links an approver key to a REVOKED phone (#2913): nothing reads the
 * column back today, so that is latent — but the moment anything joins through
 * it, a blocked device would become reachable again.
 */
async function resolveOwnedMobileDeviceId(
  header: string | null,
  userId: string
): Promise<string | null> {
  if (!header) return null;
  const [owned] = await db
    .select({ id: mobileDevices.id })
    .from(mobileDevices)
    .where(
      and(
        eq(mobileDevices.deviceId, header),
        eq(mobileDevices.userId, userId),
        eq(mobileDevices.status, 'active')
      )
    )
    .limit(1);
  return owned?.id ?? null;
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
    if (!epochs || !auth.token?.sid) {
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
        // #1374: record WHY this key counts as platform-bound. The browser
        // basis is a documented weaker exception — `generateApproverRegistrationOptions`
        // requests `attestationType: 'none'`, so `fields.isPlatformBound` comes
        // from `singleDevice && !backedUp` (backup-eligibility flags), NOT a
        // hardware attestation. It is still L4-trusted (open question Q3), so
        // this MUST be set at registration: the migration only classified rows
        // that already existed, and defaulting a new passkey to 'unattested'
        // would silently strip L4 from every newly enrolled browser key.
        platformBoundBasis: fields.isPlatformBound
          ? ('webauthn_backup_flags' as const)
          : ('unattested' as const),
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
        platformBoundBasis: inserted.platformBoundBasis,
      },
    });

    return c.json({ success: true, device: toPublicDevice(inserted) });
  }
);

// Mobile hardware-key registration — register-grant required (minted at
// login), then deferred PoP. The phone POSTs its biometric-gated Keychain /
// Keystore public key plus the register_approver_device grant, which proves the caller
// completed the login-time step-up and not merely holds a stolen access
// token. There is NO registration-time proof-of-possession signature — the
// row is inserted PENDING (`last_used_at` null) and is ACTIVATED on its first
// real approval signature, verified in
// `authenticatorAssurance.verifyMobileFactor` (which sets `last_used_at`). The
// deferred-PoP design means a registered-but-never-used key can never satisfy an
// approval until it has signed at least once.
//
// #1374: this route performs NO platform attestation, so the key it registers
// is NOT platform-bound and cannot reach L4 (critical tier). The attested
// two-step protocol lands in W02+; until a device re-enrols through it, mobile
// approvals top out at L3 (high).
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
    // kind='mobile_hw_key' and, since #1374, is_platform_bound=FALSE with
    // platform_bound_basis='unattested'). A bad/missing publicKey
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

    // See resolveOwnedMobileDeviceId for why the header is resolved, never trusted.
    const mobileDeviceHeader = readMobileDeviceId(c);
    const mobileDeviceId = await resolveOwnedMobileDeviceId(mobileDeviceHeader, auth.user.id);

    const [inserted] = await db
      .insert(authenticatorDevices)
      .values({
        userId: auth.user.id,
        kind: 'mobile_hw_key',
        label,
        publicKey,
        credentialId: null,
        signCount: 0,
        // #1374: NEVER assert platform-binding for an unattested key. This
        // legacy endpoint performs no attestation of any kind, so the row
        // registers at L2/L3 only and can no longer reach L4 (critical tier).
        // An ATTESTED registration goes through the challenge/verify protocol
        // (POST /devices/mobile/challenge + /devices/mobile/verify, W02+).
        isPlatformBound: false,
        platformBoundBasis: 'unattested' as const,
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
        // The forensic record must report what was STORED (#1374), not the
        // historical hard-coded `true`.
        isPlatformBound: false,
        platformBoundBasis: 'unattested',
        // The RESOLVED mobile_devices.id (uuid PK), or null. The raw header is
        // recorded under a deliberately distinct key so the two can never be
        // conflated again.
        mobileDeviceId,
        ...(mobileDeviceHeader && !mobileDeviceId
          ? { mobileDeviceHeaderUnresolved: mobileDeviceHeader }
          : {}),
      },
    });

    return c.json({ success: true, device: toPublicDevice(inserted) }, 201);
  }
);


// ============================================================
// #1374 W02 — attested mobile registration (challenge/verify)
//
// The legacy single-POST /devices route above has nowhere to put a server
// challenge, and BOTH platform attestations are worthless without one: Apple
// App Attest binds a `clientDataHash` and Android Key Attestation binds an
// `attestationChallenge`, and a value the client picked proves nothing about
// freshness. So attested registration is two steps:
//
//   1. /devices/mobile/challenge — mint a single-use attempt (Redis, 5 min)
//   2. /devices/mobile/verify    — return the new key, an attestation bound to
//                                  that attempt, and a proof-of-possession
//                                  signature by the key itself
//
// While we are adding the round-trip, proof-of-possession moves INTO
// registration: the client signs the registration transcript under a biometric
// prompt and the server records `possession_verified_at`. `last_used_at` keeps
// its existing meaning (null = never used for a real approval), so the UI's
// "pending" badge still works.
//
// Both routes are per-user rate limited. Neither exists on the legacy route,
// but both mint or consume server-side state and are reachable with nothing
// more than a valid bearer token.
// ============================================================

authenticatorRoutes.post(
  '/devices/mobile/challenge',
  authMiddleware,
  userRateLimit('authenticator-attest-challenge', 10, 300),
  zValidator('json', mobileAttestationChallengeSchema),
  async (c) => {
    const auth = c.get('auth');
    const { registerGrantId, platform } = c.req.valid('json');

    // Non-consuming validate — the SAME grant is consumed at /verify (the same
    // pattern as /devices/webauthn/options). A client whose attestation fails
    // must not have to redo the whole step-up to try again.
    const grantError = await enforceApproverRegisterStepUp(c, auth, registerGrantId, { consume: false });
    if (grantError) return grantError;

    const attempt = await issueRegistrationAttempt(auth.user.id, platform);
    return c.json({
      attemptId: attempt.attemptId,
      challenge: attempt.challenge,
      expiresAt: new Date(attempt.issuedAt + ATTEMPT_TTL_SECONDS * 1000).toISOString(),
    });
  }
);

// Step 2 of 2. The ORDER of the checks below is the security property, and each
// step is pinned by a test:
//   1. schema parse            -> 400, no side effects at all
//   2. consume the attempt     -> 400 on unknown/replayed, grant NOT burned
//   3. attempt ownership       -> 403, grant NOT burned
//   4. attempt platform match  -> 403, grant NOT burned
//   5. registration PoP        -> 401, grant NOT burned, nothing inserted
//   6. platform attestation    -> sets the basis (W03/W04; 'unattested' today)
//   7. consume the grant       -> single-use, only once everything else passed
//   8. insert
authenticatorRoutes.post(
  '/devices/mobile/verify',
  authMiddleware,
  userRateLimit('authenticator-attest-verify', 10, 300),
  zValidator('json', mobileAttestationVerifySchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const attempt = await consumeRegistrationAttempt(body.attemptId);
    if (!attempt) return c.json({ error: 'registration_attempt_expired' }, 400);

    if (attempt.userId !== auth.user.id) {
      writeAuthAudit(c, {
        orgId: auth.orgId ?? undefined,
        action: 'auth.authenticator.device.register.denied',
        result: 'failure',
        reason: 'attempt_user_mismatch',
        userId: auth.user.id,
        email: auth.user.email,
      });
      return c.json({ error: 'registration_attempt_invalid' }, 403);
    }

    // The attempt is bound to ONE platform. Without this a caller could request
    // an iOS challenge and satisfy it with an Android attestation (or vice
    // versa) once the verifiers land in W03/W04.
    if (attempt.platform !== body.attestation.platform) {
      writeAuthAudit(c, {
        orgId: auth.orgId ?? undefined,
        action: 'auth.authenticator.device.register.denied',
        result: 'failure',
        reason: 'attempt_platform_mismatch',
        userId: auth.user.id,
        email: auth.user.email,
      });
      return c.json({ error: 'registration_attempt_invalid' }, 403);
    }

    // Derived SERVER-SIDE from the consumed attempt — the body supplies the key
    // it is registering, never the challenge it is bound to.
    const transcript = registrationTranscript({
      attemptId: attempt.attemptId,
      challenge: attempt.challenge,
      publicKeyAlg: body.publicKeyAlg,
      publicKeySpkiB64: body.publicKey,
    });

    // Registration-time proof-of-possession. `publicKeyAlg` is inside the signed
    // transcript, so a client that lies about its algorithm cannot produce a
    // signature that verifies under the algorithm it declared.
    const popOk = verifyMobileSignature({
      publicKeySpkiB64: body.publicKey,
      payload: transcript.toString('base64'),
      signatureB64: body.popSignature,
      alg: body.publicKeyAlg,
    });
    if (!popOk) {
      writeAuthAudit(c, {
        orgId: auth.orgId ?? undefined,
        action: 'auth.authenticator.device.register.denied',
        result: 'failure',
        reason: 'pop_signature_invalid',
        userId: auth.user.id,
        email: auth.user.email,
      });
      return c.json({ error: 'registration_pop_invalid' }, 401);
    }

    // W03/W04 replace the stub behind this with the real per-platform verifier.
    // Until they land the device registers unattested — L2/L3 capable, never L4.
    const attested = await verifyPlatformAttestation({
      attestation: body.attestation,
      transcript,
      publicKeySpkiB64: body.publicKey,
      // The declared algorithm is inside the signed transcript and the PoP
      // above already verified under it, so by this point it is a proven
      // property of the key — which is what lets the iOS branch split
      // Secure-Enclave P-256 (L4-trusted) from Keychain RSA (not).
      publicKeyAlg: body.publicKeyAlg,
    });

    // A basis that claims a verified attestation MUST carry the digest of the
    // key that attestation bound — that is what stops an attestation verified
    // for key A from later reading as vouching for key B, and the DB CHECK
    // (authenticator_devices_attested_basis_chk) enforces it. If the digest
    // cannot be derived, downgrade to an honest unattested row rather than
    // 500ing on the constraint or storing a claim with nothing behind it.
    const attestedKeyDigest = attested.verifiedAt ? sha256CanonicalSpki(body.publicKey) : null;
    const attestationHolds = attested.verifiedAt !== null && attestedKeyDigest !== null;
    const basis = attestationHolds ? attested.basis : ('unattested' as const);

    if (attested.verifiedAt !== null && !attestationHolds) {
      // A verifier said "verified" for a key whose SPKI will not re-parse for
      // hashing — even though `verifyMobileSignature` parsed the very same bytes
      // moments ago to check the PoP. That combination is a BUG in the verifier
      // or in the key handling, not something a caller can provoke, and the row
      // that results is a safe but silent downgrade. It needs its own signal:
      // buried as a boolean in a `result: 'success'` audit row's details, nobody
      // would ever see it. Dead until W03/W04 wire a real verifier — which is
      // exactly when it starts to matter.
      captureException(
        new Error(`attestation verified but bound-key digest unavailable (basis=${attested.basis})`),
        c,
        { area: 'authenticator_attestation', basis: attested.basis },
      );
      writeAuthAudit(c, {
        orgId: auth.orgId ?? undefined,
        action: 'auth.authenticator.device.register.attestation_downgraded',
        result: 'failure',
        reason: 'attested_key_digest_unavailable',
        userId: auth.user.id,
        email: auth.user.email,
        details: { claimedBasis: attested.basis, storedBasis: 'unattested' },
      });
    }

    const grantError = await enforceApproverRegisterStepUp(c, auth, body.registerGrantId, { consume: true });
    if (grantError) return grantError;

    // See resolveOwnedMobileDeviceId for why the header is resolved, never trusted.
    const mobileDeviceHeader = readMobileDeviceId(c);
    const mobileDeviceId = await resolveOwnedMobileDeviceId(mobileDeviceHeader, auth.user.id);

    const [inserted] = await db
      .insert(authenticatorDevices)
      .values({
        userId: auth.user.id,
        kind: 'mobile_hw_key',
        label: body.label,
        publicKey: body.publicKey,
        publicKeyAlg: body.publicKeyAlg,
        credentialId: null,
        signCount: 0,
        // DERIVED from the server-side verification result, never from the body.
        isPlatformBound: basis !== 'unattested',
        platformBoundBasis: basis,
        attestationVerifiedAt: attestationHolds ? attested.verifiedAt : null,
        attestationKeyId: attestationHolds ? attested.keyId : null,
        attestedPublicKeySha256: attestationHolds ? attestedKeyDigest : null,
        attestationEvidence: attestationHolds ? attested.evidence : {},
        appIntegrityVerifiedAt: attestationHolds ? attested.appIntegrityVerifiedAt : null,
        possessionVerifiedAt: new Date(),
        mobileDeviceId,
        // last_used_at intentionally left at its null default. PoP at
        // registration is NOT an approval, and the UI's "pending" badge reads
        // this column.
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
        // The forensic record reports what was STORED, not what was claimed.
        isPlatformBound: basis !== 'unattested',
        platformBoundBasis: basis,
        publicKeyAlg: body.publicKeyAlg,
        attestationPlatform: body.attestation.platform,
        possessionVerified: true,
        // Visible when a verifier said "verified" but the bound-key digest could
        // not be derived, i.e. the downgrade path above fired.
        ...(attested.verifiedAt && !attestationHolds
          ? { attestationDowngraded: attested.basis }
          : {}),
        mobileDeviceId,
        ...(mobileDeviceHeader && !mobileDeviceId
          ? { mobileDeviceHeaderUnresolved: mobileDeviceHeader }
          : {}),
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
    // The approval-assurance floor applies to EVERY org under the partner, so
    // it is partner-wide state: capability gate, not just a partner context
    // (epic #2135; security review 2026-08-16 §1.1 #2). Without this an
    // `orgAccess: selected` user with users:write could rewrite the whole
    // MSP's step-up enforcement.
    if (!canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
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
