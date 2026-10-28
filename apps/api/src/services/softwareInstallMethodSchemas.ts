/**
 * Install-method request schemas and package-id validation, shared by
 * routes/softwareInstallMethods.ts and the `manage_software_catalog` AI tool
 * (full-control W12, #6782). Moved verbatim from the route.
 */
import { z } from 'zod';

export const WINGET_PACKAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const BREW_PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9+._/@-]{0,255}$/;

export function validatePackageIdForKind(kind: string, packageId: string): string | null {
  if (packageId.length > 256) return 'packageId exceeds 256 characters';
  if (kind === 'winget') {
    return WINGET_PACKAGE_ID_RE.test(packageId) ? null : 'Invalid winget package ID';
  }
  if (
    !BREW_PACKAGE_NAME_RE.test(packageId) ||
    packageId.startsWith('-') || packageId.startsWith('/') || packageId.includes('..')
  ) {
    return 'Invalid Homebrew package name';
  }
  return null;
}

export const installMethodBodySchema = z.object({
  platform: z.enum(['windows', 'macos']),
  kind: z.enum(['winget', 'homebrew_cask', 'homebrew_formula']),
  packageId: z.string().min(1).max(256),
  enabled: z.boolean().optional(),
}).superRefine((data, ctx) => {
  const platformOk =
    (data.kind === 'winget' && data.platform === 'windows') ||
    (data.kind !== 'winget' && data.platform === 'macos');
  if (!platformOk) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: 'kind does not match platform' });
  }
  const err = validatePackageIdForKind(data.kind, data.packageId);
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['packageId'], message: err });
});

export const installMethodPatchSchema = z.object({
  packageId: z.string().min(1).max(256).optional(),
  enabled: z.boolean().optional(),
}).refine(
  (data) => data.packageId !== undefined || data.enabled !== undefined,
  { message: 'At least one of packageId or enabled must be provided' },
);

export const importPackageSchema = z.object({
  name: z.string().min(1).max(200),
  vendor: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  homepageUrl: z.string().url().optional(),
  iconUrl: z.string().url().optional(),
  orgId: z.string().guid().optional(),
  methods: z.array(
    z.object({
      platform: z.enum(['windows', 'macos']),
      kind: z.enum(['winget', 'homebrew_cask', 'homebrew_formula']),
      packageId: z.string().min(1).max(256),
    })
  ).min(1).max(4),
}).superRefine((data, ctx) => {
  const seen = new Set<string>();
  data.methods.forEach((m, i) => {
    const key = `${m.platform}:${m.kind}`;
    if (seen.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['methods', i], message: 'Duplicate platform+kind' });
    }
    seen.add(key);
    const platformOk = (m.kind === 'winget') === (m.platform === 'windows');
    if (!platformOk) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['methods', i, 'kind'], message: 'kind does not match platform' });
    const err = validatePackageIdForKind(m.kind, m.packageId);
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['methods', i, 'packageId'], message: err });
  });
});
