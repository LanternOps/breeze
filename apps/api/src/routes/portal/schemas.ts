import { PORTAL_TICKET_COMMENT_MAX_CHARS } from '@breeze/shared';
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
    /**
     * The CONTACT this login belongs to (#3258 W03), or null when it has none
     * (Entra SSO provisioning and the Outlook add-in's "create contact" both
     * mint logins without one).
     *
     * REQUIRED, not optional. Portal ticket ownership is
     * `submitted_by = me OR requester_contact_id = my contact`, so a context
     * built without this field does not fail — it silently narrows every read
     * back to login-only ownership and the customer stops seeing the tickets
     * they emailed in. Making it required means `portalAuthMiddleware` is the
     * only thing that can produce a PortalAuthContext, and every test double
     * has to state which case it is modelling.
     */
    contactId: string | null;
    receiveNotifications: boolean;
    status: string;
  };
  token: string;
  authMethod: 'bearer' | 'cookie';
  /**
   * Org -> partner -> UTC timezone chain, resolved once by
   * `portalAuthMiddleware` (`services/portal/timezone.ts`). Read models must
   * never resolve this themselves — they consume `auth.timezone`.
   */
  timezone: string;
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
export const PORTAL_SESSION_COOKIE_PATH = '/';
export const CSRF_HEADER_NAME = 'x-breeze-csrf';
export const PORTAL_CSRF_COOKIE_NAME = 'breeze_portal_csrf_token';
export const PORTAL_CSRF_COOKIE_PATH = '/';
export const RESET_TTL_SECONDS = Math.floor(RESET_TTL_MS / 1000);
export const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
export const INVITE_TTL_SECONDS = Math.floor(INVITE_TTL_MS / 1000);
export const PORTAL_INVITE_TOKEN_CAP = 20000;

export const PORTAL_USE_REDIS =
  process.env.PORTAL_STATE_BACKEND === 'redis' || process.env.NODE_ENV === 'production';

export const PORTAL_REDIS_KEYS = {
  session: (token: string) => `portal:session:${token}`,
  userSessions: (userId: string) => `portal:user-sessions:${userId}`,
  resetToken: (hash: string) => `portal:reset:${hash}`,
  inviteToken: (hash: string) => `portal:invite:${hash}`,
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
  orgId: z.string().guid().optional()
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
  orgId: z.string().guid().optional()
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8)
});

export const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
  name: z.string().min(1).max(255).optional()
});

export const listSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional()
});

export const supportUsageQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});

export const ticketPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

// Phase 2 (ticket intake forms): subject/description become optional when a
// formId is supplied — createTicket composes them from the form (title
// template + rendered responses). Portal keeps its OWN schema (does not
// import the shared createTicketSchema) per the Phase 2 plan's global
// constraints. `priority.default('normal')` is intentionally kept even though
// a form may carry its own defaultPriority: the portal UI has no per-form
// priority prefill yet, so the portal's explicit 'normal' wins over the
// form's default in Phase 2 — acceptable per the design brief; revisit if/when
// the portal form UI grows a priority prefill.
export const createTicketSchema = z
  .object({
    subject: z.string().min(1).max(255).optional(),
    description: z.string().min(1).optional(),
    priority: ticketPrioritySchema.optional().default('normal'),
    formId: z.string().guid().optional(),
    formResponses: z.record(z.string(), z.unknown()).optional()
  })
  .superRefine((v, ctx) => {
    if (!v.formId && (!v.subject || !v.subject.trim())) {
      ctx.addIssue({ code: 'custom', path: ['subject'], message: 'subject is required unless a formId is provided' });
    }
    if (!v.formId && (!v.description || !v.description.trim())) {
      ctx.addIssue({ code: 'custom', path: ['description'], message: 'description is required unless a formId is provided' });
    }
    if (v.formResponses && !v.formId) {
      ctx.addIssue({ code: 'custom', path: ['formResponses'], message: 'formResponses requires formId' });
    }
  });

export const ticketParamSchema = z.object({
  id: z.string().guid()
});

// W08 #3902 — portal attachment content route params.
export const portalAttachmentParamSchema = z.object({
  id: z.string().guid(),
  attachmentId: z.string().guid()
});

export const ticketCommentParamSchema = z.object({
  id: z.string().guid(),
  commentId: z.string().guid()
});

export const commentSchema = z.object({
  content: z.string().min(1).max(PORTAL_TICKET_COMMENT_MAX_CHARS)
});

export const assetParamSchema = z.object({
  id: z.string().guid()
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
