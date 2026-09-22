import { z } from 'zod';

// Admin-writable subset of portal_branding (feature toggles + support contact,
// plus customCss as of #5952). Visual branding (logo, colors) and
// customDomain/domainVerified are deliberately NOT writable here — they ship
// with the domain-verification project. `.strict()` is the enforcement:
// unknown keys are rejected.

export const PORTAL_CUSTOM_CSS_MAX_LENGTH = 65_536;

// This CSS is served verbatim to end users of the customer portal (no
// authoring-time sandbox), so a handful of legacy attack vectors are rejected
// outright rather than silently stripped — a silent strip would leave the
// admin thinking they saved what they typed. `@import`/`url()` can exfiltrate
// via request side channels or load remote/local-file content; `expression()`
// and `-moz-binding`/`behavior:` are legacy script-execution vectors.
const CSS_DANGEROUS_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /@import\b/i, label: '@import' },
  { pattern: /expression\s*\(/i, label: 'expression(' },
  { pattern: /-moz-binding/i, label: '-moz-binding' },
  { pattern: /behavior\s*:/i, label: 'behavior:' }
];

// Matches url(...), with or without quotes, capturing the raw value.
const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

// CSS identifiers/at-keywords support backslash escapes (CSS Syntax Module
// §4.3.7): `\` + 1-6 hex digits (+ one optional trailing whitespace) decodes
// to that Unicode code point, and `\` + any other character decodes to that
// literal character. Browsers apply this BEFORE matching keywords like
// `@import` or `expression(`, so `@i\6d port` parses as `@import` — a
// well-known text-filter bypass. Decoding a copy before scanning (never the
// persisted value itself) closes that class of bypass for every pattern
// below, including inside url()'s scheme.
function decodeCssEscapes(css: string): string {
  return css.replace(
    /\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([^\r\n\f])/g,
    (_match, hex: string | undefined, literal: string | undefined) => {
      if (hex !== undefined) {
        const codePoint = parseInt(hex, 16);
        if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          return '�'; // invalid/surrogate code point per spec — never the intended keyword char
        }
        return String.fromCodePoint(codePoint);
      }
      return literal ?? '';
    }
  );
}

/**
 * Returns a human-readable label for the first disallowed pattern found in
 * `css`, or null if the CSS is clean. Exported so the API route can surface
 * a specific reason without re-implementing the scan. Scans a CSS-escape-
 * decoded copy (see decodeCssEscapes) so an escaped keyword can't slip past
 * the literal-text patterns below.
 */
export function findUnsafePortalCssPattern(css: string): string | null {
  const decoded = css.includes('\\') ? decodeCssEscapes(css) : css;

  for (const { pattern, label } of CSS_DANGEROUS_PATTERNS) {
    if (pattern.test(decoded)) return label;
  }

  CSS_URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CSS_URL_PATTERN.exec(decoded)) !== null) {
    const value = (match[2] ?? '').trim();
    if (!/^(https:|data:)/i.test(value)) {
      return value ? `url(${value})` : 'url()';
    }
  }

  return null;
}

const portalCustomCssSchema = z
  .string()
  .max(PORTAL_CUSTOM_CSS_MAX_LENGTH, `Custom CSS exceeds maximum size (${PORTAL_CUSTOM_CSS_MAX_LENGTH} characters)`)
  .nullable()
  .optional()
  .superRefine((value, ctx) => {
    if (!value) return;
    const unsafe = findUnsafePortalCssPattern(value);
    if (unsafe) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Custom CSS contains a disallowed pattern: ${unsafe}`
      });
    }
  });

export const updatePortalSettingsSchema = z.object({
  enableTickets: z.boolean().optional(),
  enableAssetCheckout: z.boolean().optional(),
  enableDevices: z.boolean().optional(),
  enableSelfService: z.boolean().optional(),
  enablePasswordReset: z.boolean().optional(),
  enableDashboard: z.boolean().optional(),
  enableSecurity: z.boolean().optional(),
  enableBackups: z.boolean().optional(),
  enableReports: z.boolean().optional(),
  enableSupportUsage: z.boolean().optional(),
  // Service deliverables W04 (spec §4.7): both fail closed, default false.
  enableService: z.boolean().optional(),
  enableDocuments: z.boolean().optional(),
  // Portal Hardware Lifecycle (#5719): fail closed, required alongside enableReports.
  enableLifecycle: z.boolean().optional(),
  // Customer Portal Network Visibility (#5861): fail closed by default.
  enableNetworkVisibility: z.boolean().optional(),
  supportEmail: z.string().email().max(255).nullable().optional(),
  supportPhone: z.string().max(50).nullable().optional(),
  welcomeMessage: z.string().max(2000).nullable().optional(),
  footerText: z.string().max(2000).nullable().optional(),
  // #5952: canonical write path for portal_branding.custom_css. Rejected
  // (not silently stripped) on a disallowed pattern — see
  // findUnsafePortalCssPattern above.
  customCss: portalCustomCssSchema
}).strict();

export type UpdatePortalSettingsInput = z.infer<typeof updatePortalSettingsSchema>;

// MSP-facing portal-user management (customer-portal onboarding). Invite a
// single portal user by email; bulk-invite a set of existing (pre-created)
// portal users by id; update a portal user's editable fields. `status` here
// is deliberately limited to active/disabled — 'invited' is a system-set
// state, not something an MSP can set directly via this endpoint.
export const invitePortalUserSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(255).optional(),
  message: z.string().max(1000).optional()
}).strict();
export type InvitePortalUserInput = z.infer<typeof invitePortalUserSchema>;

export const bulkInvitePortalUsersSchema = z.object({
  userIds: z.array(z.string().guid()).optional()
}).strict();
export type BulkInvitePortalUsersInput = z.infer<typeof bulkInvitePortalUsersSchema>;

export const updatePortalUserSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  receiveNotifications: z.boolean().optional(),
  status: z.enum(['active', 'disabled']).optional()
}).strict();
export type UpdatePortalUserInput = z.infer<typeof updatePortalUserSchema>;
