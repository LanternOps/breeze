import { z } from 'zod';
import { envFlag } from '../../utils/envFlag';

// ============================================
// Feature flags
// ============================================

export const ENABLE_REGISTRATION = envFlag('ENABLE_REGISTRATION', true);
export const ENABLE_2FA = envFlag('ENABLE_2FA', true);

if (!ENABLE_2FA && process.env.NODE_ENV !== 'test') {
  console.warn('[auth] WARNING: MFA is disabled (ENABLE_2FA=false). All MFA endpoints return 404.');
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

export const mfaVerifySchema = z.object({
  code: z.string().length(6),
  tempToken: z.string().optional(),
  method: z.enum(['totp', 'sms']).optional()
});

export const phoneVerifySchema = z.object({
  phoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Invalid phone number. Use E.164 format (e.g. +14155551234)')
});

export const phoneConfirmSchema = z.object({
  phoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/),
  code: z.string().length(6)
});

export const smsSendSchema = z.object({
  tempToken: z.string()
});

export const forgotPasswordSchema = z.object({
  email: z.string().email()
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

export const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
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

export const REFRESH_COOKIE_NAME = 'breeze_refresh_token';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
export const REFRESH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const INVITE_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const CSRF_HEADER_NAME = 'x-breeze-csrf';
export const CSRF_COOKIE_NAME = 'breeze_csrf_token';
export const CSRF_COOKIE_PATH = '/';
export const ANONYMOUS_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
