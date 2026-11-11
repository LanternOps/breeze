import { z } from 'zod';

// Admin-writable subset of portal_branding: feature toggles, support contact,
// customCss (#5952), primaryColor (#9962), logoUrl and secondaryColor (#9673).
// faviconUrl, accentColor and customDomain/domainVerified are deliberately NOT
// writable here — they ship with the domain-verification project. `.strict()`
// is the enforcement: unknown keys are rejected.

export const PORTAL_CUSTOM_CSS_MAX_LENGTH = 65_536;

// Portal visibility flags that stay OUTSIDE the editor's "Enable all": each
// exposes a more sensitive tier and needs its own explicit opt-in. Lives here
// (not only in the API) so the web editor test and the API share one list;
// apps/api re-exports it from services/portal/portalFlags.ts. Waves 5 and 6 of
// the portal advanced visibility feature (#7730) add enablePatchDetail and
// enableVulnerabilityDetail.
// enableHourBlock (block hours W04) exposes a prepaid-hours balance.
// enablePatchDetail (visibility W05) exposes per-host missing/pending patches.
// enableVulnerabilityDetail (visibility W06) exposes per-host CVE findings.
// enablePhysicalPlacement (environment visibility W1) exposes rack and room.
export const PORTAL_SENSITIVE_FLAG_KEYS = ['enableNetworkAlerts', 'enableHourBlock', 'enablePatchDetail', 'enableVulnerabilityDetail', 'enablePhysicalPlacement'] as const;
export type PortalSensitiveFlag = typeof PORTAL_SENSITIVE_FLAG_KEYS[number];

// Portal flags that grant portal users a WRITE permission rather than a view.
// Never set by "Enable all", and not a visibility tier, so they are listed
// apart from both lists above. enableTrustPageEditing (Trust Center W3d) lets
// the org's admin contacts edit part of the trust page draft; the MSP still
// publishes.
export const PORTAL_PERMISSION_FLAG_KEYS = ['enableTrustPageEditing'] as const;
export type PortalPermissionFlag = typeof PORTAL_PERMISSION_FLAG_KEYS[number];

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

// Shared by both Custom CSS write paths: the org portal settings
// (updatePortalSettingsSchema below) and the partner's branding settings
// (PATCH /partners/me, #9674), whose CSS reaches every child org's portal.
export const portalCustomCssSchema = z
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

/** #rgb / #rrggbb — the only shape an org document accent may take (#9962). */
export const PORTAL_PRIMARY_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Matches MAX_LOGO_BYTES in the web logo encoder and the partner Branding cap. */
export const PORTAL_LOGO_MAX_LENGTH = 400_000;

const PORTAL_LOGO_DATA_URI = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const PORTAL_LOGO_HTTPS_URL = /^https:\/\/[^\s"'<>\\]+$/;

/**
 * Whether a value may be stored as an org logo (#9673): an uploaded PNG data
 * URI (the editor always encodes PNG, and PNG is the one format every renderer
 * embeds, report PDFs included), or an https URL so a customer's browser never
 * loads it insecurely (PDFs print the company name instead of a URL logo). The
 * value goes unchanged into `<img src>` on the portal and customer documents, so
 * anything else is refused at write.
 */
export function isPortalLogoUrl(value: string): boolean {
  if (value.length > PORTAL_LOGO_MAX_LENGTH) return false;
  if (PORTAL_LOGO_DATA_URI.test(value)) return true;
  if (!PORTAL_LOGO_HTTPS_URL.test(value)) return false;
  try {
    return new URL(value).hostname.length > 0;
  } catch {
    return false;
  }
}

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
  // Portal advanced visibility W01 (#7731): hardware health, fail closed.
  enableHardwareHealth: z.boolean().optional(),
  // Portal advanced visibility W02 (#7732): hardware inventory, fail closed.
  enableHardwareInventory: z.boolean().optional(),
  // Portal advanced visibility W03 (#7733): performance metrics, fail closed.
  enablePerformanceMetrics: z.boolean().optional(),
  // Portal advanced visibility W04 (#7734): software inventory, fail closed.
  enableSoftwareInventory: z.boolean().optional(),
  // Customer Portal Network Visibility (#5861): fail closed by default.
  enableNetworkVisibility: z.boolean().optional(),
  enableNetworkAlerts: z.boolean().optional(),
  // EDR provider framework W02 (#8166): managed endpoint protection, fail closed.
  // Strict but NOT sensitive: "Enable all" sets it.
  enableEdrVisibility: z.boolean().optional(),
  // Block hours W04 (#8179): fail closed, default false. NOT a visibility
  // flag ("Enable all" never sets it).
  enableHourBlock: z.boolean().optional(),
  // Portal advanced visibility W05 (#7735): patch detail, fail closed. Sensitive:
  // "Enable all" never sets it.
  enablePatchDetail: z.boolean().optional(),
  // Portal advanced visibility W06 (#7736): vulnerability detail, fail closed. Sensitive:
  // "Enable all" never sets it.
  enableVulnerabilityDetail: z.boolean().optional(),
  // Environment visibility W1 (#8775): physical placement, fail closed. Sensitive:
  // "Enable all" never sets it.
  enablePhysicalPlacement: z.boolean().optional(),
  // Trust Center W3d: a permission flag, fail closed. Org-scoped admin contacts
  // with a portal login may edit part of the trust page draft. Never in "Enable all".
  enableTrustPageEditing: z.boolean().optional(),
  supportEmail: z.string().email().max(255).nullable().optional(),
  supportPhone: z.string().max(50).nullable().optional(),
  welcomeMessage: z.string().max(2000).nullable().optional(),
  footerText: z.string().max(2000).nullable().optional(),
  // #9962: the org level of the one document-accent chain — partner Branding
  // colour → this org override (resolveDocumentBrand, partnerDocumentBrand.ts).
  // Written by the org Branding tab; null = inherit the partner colour. It is
  // emitted into a <style> element on customer documents, so only a strict
  // #rgb / #rrggbb hex is accepted.
  primaryColor: z
    .string()
    .regex(PORTAL_PRIMARY_COLOR_PATTERN, 'Primary color must be a hex colour such as #2563eb')
    .nullable()
    .optional(),
  // #9673: the org level of the secondary colour and logo in the same chain.
  // Null = inherit the partner's value.
  secondaryColor: z
    .string()
    .regex(PORTAL_PRIMARY_COLOR_PATTERN, 'Secondary color must be a hex colour such as #0f766e')
    .nullable()
    .optional(),
  logoUrl: z
    .string()
    .refine(isPortalLogoUrl, 'Logo must be a PNG image of at most 400 KB, or an https URL')
    .nullable()
    .optional(),
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
//
// `contactId` (portal registration W1, #11378): bind the login to THIS contact.
// The invite email must equal the contact's email (case-insensitive), because
// binding a contact grants its ticket history; the API refuses a mismatch.
export const invitePortalUserSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(255).optional(),
  message: z.string().max(1000).optional(),
  contactId: z.string().guid().optional()
}).strict();
export type InvitePortalUserInput = z.infer<typeof invitePortalUserSchema>;

// Batch "Give portal access" from the Contacts tab. Each invite sends one
// email synchronously inside the request, so the batch is capped.
export const INVITE_CONTACTS_MAX = 100;
export const inviteContactsToPortalSchema = z.object({
  contactIds: z.array(z.string().guid()).min(1).max(INVITE_CONTACTS_MAX)
}).strict();
export type InviteContactsToPortalInput = z.infer<typeof inviteContactsToPortalSchema>;

// Per-contact outcome of a batch invite. Exactly these five: any further
// detail rides in `reason` / `emailSent`, never as a sixth outcome.
export const CONTACT_PORTAL_INVITE_OUTCOMES = [
  'invited',
  'already_has_access',
  'no_email',
  'email_bound_to_other_contact',
  'duplicate_email_in_batch'
] as const;
export type ContactPortalInviteOutcome = (typeof CONTACT_PORTAL_INVITE_OUTCOMES)[number];

/** Why a contact counts as `already_has_access` (or why a single invite was refused). */
export type AlreadyHasAccessReason = 'active' | 'disabled' | 'external_identity' | 'login_email_differs';

/** One contact's result, keyed on `outcome` so impossible combinations do not type-check. */
export type ContactPortalInviteResult =
  | {
      contactId: string;
      outcome: 'invited';
      portalUserId: string;
      /** false: the login exists but the email did not go out (use Resend). */
      emailSent: boolean;
    }
  | { contactId: string; outcome: 'already_has_access'; portalUserId: string; reason: AlreadyHasAccessReason }
  | { contactId: string; outcome: 'email_bound_to_other_contact'; portalUserId: string }
  | { contactId: string; outcome: 'no_email' | 'duplicate_email_in_batch' };

/** `POST …/portal-users/invite-contacts` response body. */
export type ContactPortalInviteResponse = {
  data: { results: ContactPortalInviteResult[]; counts: Record<ContactPortalInviteOutcome, number> };
};

/** Stable `code` values on invite refusals (`{ error, code }` bodies). */
export const PORTAL_INVITE_ERROR_CODES = {
  PORTAL_INVITE_CONTACT_NOT_FOUND: 'PORTAL_INVITE_CONTACT_NOT_FOUND',
  PORTAL_INVITE_CONTACT_NO_EMAIL: 'PORTAL_INVITE_CONTACT_NO_EMAIL',
  PORTAL_INVITE_EMAIL_MISMATCH: 'PORTAL_INVITE_EMAIL_MISMATCH',
  PORTAL_INVITE_CONTACT_CONFLICT: 'PORTAL_INVITE_CONTACT_CONFLICT',
  PORTAL_INVITE_LOGIN_EMAIL_DIFFERS: 'PORTAL_INVITE_LOGIN_EMAIL_DIFFERS',
  PORTAL_INVITE_ALREADY_ACTIVE: 'PORTAL_INVITE_ALREADY_ACTIVE',
  PORTAL_INVITE_USER_DISABLED: 'PORTAL_INVITE_USER_DISABLED',
  PORTAL_INVITE_EXTERNAL_IDENTITY: 'PORTAL_INVITE_EXTERNAL_IDENTITY'
} as const;
export type PortalInviteErrorCode = keyof typeof PORTAL_INVITE_ERROR_CODES;

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
