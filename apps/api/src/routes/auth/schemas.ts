import { z } from 'zod';
import { envFlag } from '../../utils/envFlag';

// ============================================
// Feature flags
// ============================================

export const ENABLE_REGISTRATION = envFlag('ENABLE_REGISTRATION', false);
export const ENABLE_2FA = envFlag('ENABLE_2FA', true);

if (!ENABLE_2FA && process.env.NODE_ENV !== 'test') {
  console.warn(
    '[auth] WARNING: ENABLE_2FA=false. This disables ALL requireMfa() step-up ' +
    'gates across the API (admin/abuse, tenant export/erasure, remote device ' +
    'control, sensitive-data, API keys, SSO, backups/DR) — not just the ' +
    '/auth/mfa endpoints. Do not use this configuration in production.',
  );
}

// ============================================
// Schemas
// ============================================

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(255)
});

export const registerPartnerSchema = z.object({
  companyName: z.string().min(2).max(255),
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(255),
  acceptTerms: z.boolean().refine(val => val === true, {
    message: 'You must accept the terms of service'
  })
});

// TOTP/SMS codes are 6 digits; recovery codes are `XXXX-XXXX` (8 [A-Z0-9]
// with a hyphen). Accept either shape here; the handler routes on `method`.
const totpOrSmsCode = /^\d{6}$/;
const recoveryCode = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i;
export const mfaVerifySchema = z.object({
  code: z.string().refine(
    (v) => totpOrSmsCode.test(v.trim()) || recoveryCode.test(v.trim()),
    { message: 'Invalid code format' },
  ),
  tempToken: z.string().optional(),
  method: z.enum(['totp', 'sms', 'recovery']).optional(),
  // SR2-20: presented on setup-confirm (Case 2 — no tempToken) so an
  // already-protected account's TOTP-add can satisfy the existing-factor
  // step-up gate. Ignored on Case 1 (login completion).
  stepUpGrantId: z.string().optional(),
});

export const phoneVerifySchema = z.object({
  phoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Invalid phone number. Use E.164 format (e.g. +14155551234)'),
  currentPassword: z.string().min(1).max(256)
});

export const phoneConfirmSchema = z.object({
  phoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/),
  code: z.string().length(6),
  currentPassword: z.string().min(1).max(256),
  // SR2-20/C1: an ALREADY-PROTECTED account cannot verify/replace its phone
  // with a password alone — that would let a stolen-token + phished-password
  // attacker swap in their own number and then pass the SMS step-up. Required
  // (via enforceExistingFactorStepUp) only when a factor already exists; initial
  // enrollment (no factor yet) still passes password-only.
  stepUpGrantId: z.string().optional()
});

export const smsMfaEnableSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  // SR2-20: existing-factor step-up grant required when the account is
  // already MFA-protected (see enforceExistingFactorStepUp in ./helpers).
  stepUpGrantId: z.string().optional()
});

export const smsSendSchema = z.object({
  tempToken: z.string()
});

export const forgotPasswordSchema = z.object({
  // SR2-22: trim before validating so a paste-padded address ("  a@b.com ")
  // reaches the handler and is normalized identically to every other address —
  // rather than 400ing pre-handler, which would itself be an input-shape oracle
  // distinct from the uniform accepted response.
  email: z.string().trim().email()
});

export const resetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(8)
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8)
});

export const mfaEnableSchema = z.object({
  code: z.string().length(6)
});

// SR2-20: `POST /auth/mfa/step-up` proof-of-existing-factor request. Accepts
// ALL factor types (not just the account's primary method) so a passkey-only
// user is never locked out of adding a second factor. The passkey assertion
// is shape-checked here only (`.passthrough()`) and cryptographically
// verified downstream by verifyPasskeyAuthentication (passkeys.ts) — this
// file deliberately does NOT import passkeys.ts's webAuthnCredentialSchema to
// avoid a schemas.ts <-> passkeys.ts import cycle.
const stepUpSixDigit = z.string().refine((v) => /^\d{6}$/.test(v.trim()), { message: 'Invalid code' });
const stepUpAssertion = z.object({ id: z.string().min(1) }).passthrough();
// Which grant the proven factor mints. Defaults to the original add_factor so
// existing clients are untouched; register_approver_device gates the
// /authenticator register routes (#2707).
const stepUpOperation = z
  .enum(['add_factor', 'register_approver_device'])
  .default('add_factor');
export const mfaStepUpSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('totp'), code: stepUpSixDigit, operation: stepUpOperation }),
  z.object({ method: z.literal('sms'), code: stepUpSixDigit, operation: stepUpOperation }),
  z.object({ method: z.literal('passkey'), credential: stepUpAssertion, operation: stepUpOperation }),
]);

export const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export const invitePreviewSchema = z.object({
  token: z.string().min(1),
});

// ============================================
// Types
// ============================================

export type PublicTokenPayload = {
  accessToken: string;
  expiresInSeconds: number;
};

export type UserTokenContext = {
  roleId: string | null;
  partnerId: string | null;
  orgId: string | null;
  scope: 'system' | 'partner' | 'organization';
};

// ============================================
// Constants
// ============================================

// SR2-21: the terms-of-service version recorded on a pending registration (and
// carried through to account creation at verification time). Bump when the ToS
// text materially changes so the accepted version is auditable per signup.
export const TERMS_VERSION = 'v1';

export const REFRESH_COOKIE_NAME = 'breeze_refresh_token';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
export const REFRESH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const INVITE_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const CSRF_HEADER_NAME = 'x-breeze-csrf';
export const CSRF_COOKIE_NAME = 'breeze_csrf_token';
export const CSRF_COOKIE_PATH = '/';
export const ANONYMOUS_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
