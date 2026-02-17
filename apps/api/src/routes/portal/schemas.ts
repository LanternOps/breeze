import { z } from 'zod';

// ============================================
// Types
// ============================================

export type PortalSession = {
  token: string;
  portalUserId: string;
  orgId: string;
  createdAt: Date;
  expiresAt: Date;
};

export type PortalAuthContext = {
  user: {
    id: string;
    orgId: string;
    orgName?: string | null;
    email: string;
    name: string | null;
    receiveNotifications: boolean;
    status: string;
  };
  token: string;
  authMethod: 'bearer' | 'cookie';
};

declare module 'hono' {
  interface ContextVariableMap {
    portalAuth: PortalAuthContext;
  }
}

// ============================================
// Constants
// ============================================

export const SESSION_TTL_MS = 1000 * 60 * 60 * 24;
export const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
export const RESET_TTL_MS = 1000 * 60 * 60;
export const PORTAL_SESSION_CAP = 20000;
export const PORTAL_RESET_TOKEN_CAP = 20000;
export const PORTAL_RATE_BUCKET_CAP = 50000;
export const STATE_SWEEP_INTERVAL_MS = 60 * 1000;
export const RATE_LIMIT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const PORTAL_SESSION_COOKIE_NAME = 'breeze_portal_session';
export const PORTAL_SESSION_COOKIE_PATH = '/api/v1/portal';
export const CSRF_HEADER_NAME = 'x-breeze-csrf';
export const RESET_TTL_SECONDS = Math.floor(RESET_TTL_MS / 1000);

export const PORTAL_USE_REDIS =
  process.env.PORTAL_STATE_BACKEND === 'redis' || process.env.NODE_ENV === 'production';

export const PORTAL_REDIS_KEYS = {
  session: (token: string) => `portal:session:${token}`,
  userSessions: (userId: string) => `portal:user-sessions:${userId}`,
  resetToken: (hash: string) => `portal:reset:${hash}`,
  rlAttempts: (key: string) => `portal:rl:attempts:${key}`,
  rlBlock: (key: string) => `portal:rl:block:${key}`,
};

export const LOGIN_RATE_LIMIT = {
  windowMs: 5 * 60 * 1000,
  maxAttempts: 10,
  blockMs: 15 * 60 * 1000
} as const;

export const FORGOT_PASSWORD_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  blockMs: 30 * 60 * 1000
} as const;

export const RESET_PASSWORD_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000,
  maxAttempts: 10,
  blockMs: 30 * 60 * 1000
} as const;

// ============================================
// Zod Schemas
// ============================================

export const brandingParamSchema = z.object({
  domain: z.string().min(1)
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  orgId: z.string().uuid().optional()
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
  orgId: z.string().uuid().optional()
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8)
});

export const listSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional()
});

export const ticketPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

export const createTicketSchema = z.object({
  subject: z.string().min(1).max(255),
  description: z.string().min(1),
  priority: ticketPrioritySchema.optional().default('normal')
});

export const ticketParamSchema = z.object({
  id: z.string().uuid()
});

export const commentSchema = z.object({
  content: z.string().min(1).max(5000)
});

export const assetParamSchema = z.object({
  id: z.string().uuid()
});

export const checkoutSchema = z.object({
  expectedReturnAt: z.string().datetime().optional(),
  checkoutNotes: z.string().max(2000).optional(),
  condition: z.string().max(100).optional()
});

export const checkinSchema = z.object({
  checkinNotes: z.string().max(2000).optional(),
  condition: z.string().max(100).optional()
});

export const updateProfileSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  receiveNotifications: z.boolean().optional(),
  password: z.string().min(8).optional()
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8)
});
