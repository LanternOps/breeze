import { apiGet, apiPost, apiPut, type ApiRequestConfig } from './api';

/**
 * Customer org-admin trust page editing (Trust Center W3d). The API answers 403
 * PORTAL_TRUST_EDITING_DISABLED (the MSP has not turned editing on) or
 * PORTAL_TRUST_EDITOR_REQUIRED (not an org admin contact, or the partner-home
 * page); both are policy, not load failures.
 */
export const PORTAL_TRUST_EDITOR_CODES = ['PORTAL_TRUST_EDITING_DISABLED', 'PORTAL_TRUST_EDITOR_REQUIRED'] as const;

/** What the portal may see of its org's trust page draft. Toggles are the effective values. */
export interface PortalTrustPageDraft {
  securityContactEmail: string | null;
  websiteUrl: string | null;
  hiddenControlIds: string[];
  showPercentages: boolean;
  showDeviceCount: boolean;
  publishedAt: string | null;
  publicationRevision: number;
  /** Portal-relative public URL path (`/trust/<partner>/<org>`); prefix with withBase. */
  publicPath: string | null;
}

export type PortalTrustDraftFields = Pick<
  PortalTrustPageDraft,
  'securityContactEmail' | 'websiteUrl' | 'hiddenControlIds' | 'showPercentages' | 'showDeviceCount'
>;
export type PortalTrustDraftPatch = Partial<PortalTrustDraftFields> & { expectedRevision: number };

type PageEnvelope = { data: { page: PortalTrustPageDraft | null } };

const ENDPOINT = '/portal/trust-page';

export const trustEditorApi = {
  get: (config: ApiRequestConfig = {}) => apiGet<PageEnvelope>(ENDPOINT, config),
  save: (patch: PortalTrustDraftPatch) => apiPut<PageEnvelope>(ENDPOINT, patch),
  previewToken: () =>
    apiPost<{ data: { token: string; expiresInSeconds: number; previewPath: string } }>(`${ENDPOINT}/preview-token`, {}),
  unpublish: () => apiPost<PageEnvelope>(`${ENDPOINT}/unpublish`, { confirm: true }),
};

const blankToNull = (v: string | null): string | null => {
  const t = v?.trim() ?? '';
  return t === '' ? null : t;
};

/** The fields that differ between the loaded page and the form; text is trimmed and blank means "clear". */
export function changedTrustDraftFields(loaded: PortalTrustDraftFields, form: PortalTrustDraftFields): Partial<PortalTrustDraftFields> {
  const out: Partial<PortalTrustDraftFields> = {};
  const email = blankToNull(form.securityContactEmail);
  if (email !== (loaded.securityContactEmail ?? null)) out.securityContactEmail = email;
  const website = blankToNull(form.websiteUrl);
  if (website !== (loaded.websiteUrl ?? null)) out.websiteUrl = website;
  const before = new Set(loaded.hiddenControlIds);
  const after = new Set(form.hiddenControlIds);
  if (before.size !== after.size || [...after].some((id) => !before.has(id))) out.hiddenControlIds = [...form.hiddenControlIds];
  if (form.showPercentages !== loaded.showPercentages) out.showPercentages = form.showPercentages;
  if (form.showDeviceCount !== loaded.showDeviceCount) out.showDeviceCount = form.showDeviceCount;
  return out;
}
