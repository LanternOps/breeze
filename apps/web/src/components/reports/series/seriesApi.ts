import { fetchWithAuth } from '../../../stores/auth';
import { runAction } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';
import type {
  ChildRecipientOverride,
  OrgContact,
  PartnerUserOption,
  RecipientChoice,
  SeriesCreateBody,
  SeriesDetail,
  SeriesRecipientPreview,
  SeriesRecipientRule,
  SeriesTargets,
  SeriesUpdateBody,
} from './types';

/**
 * The one client for multi-org report series (#<parent> W03). Every mutation
 * is lexically wrapped in runAction — this file is in the no-silent-mutations
 * TARGET_GLOBS. Series are partner-level: every /reports/series request skips
 * the switcher's ambient ?orgId=.
 */
const SERIES_ROOT = '/reports/series';
// Reads spell the options inline: the no-silent-mutations scanner reads a
// literal init without `method` as a GET, but cannot see through a variable.
const CROSS_ORG = { skipOrgIdInjection: true } as const;

export interface ActionMessages { errorFallback: string; successMessage?: string }

// Literal keys (not a template) so keyUsage can resolve each one.
const FRIENDLY_ERROR_KEYS: Readonly<Record<string, string>> = {
  series_type_unsupported: 'reports:reports.series.errors.seriesTypeUnsupported',
  series_config_org_specific: 'reports:reports.series.errors.seriesConfigOrgSpecific',
  series_managed: 'reports:reports.series.errors.seriesManaged',
  series_owner_ineligible: 'reports:reports.series.errors.seriesOwnerIneligible',
  series_not_found: 'reports:reports.series.errors.seriesNotFound',
  // W02 contract concern 4: tokens beyond the INDEX list.
  series_write_denied: 'reports:reports.series.errors.seriesWriteDenied',
  series_target_org_inaccessible: 'reports:reports.series.errors.seriesTargetOrgInaccessible',
  // Quick Support / the holding org are never a series target (400 on create and PUT /targets).
  series_target_org_hidden: 'reports:reports.series.errors.seriesTargetOrgHidden',
  report_not_series_child: 'reports:reports.series.errors.reportNotSeriesChild',
  recipient_mode_requires_series: 'reports:reports.series.errors.recipientModeRequiresSeries',
  recipients_need_export_and_mfa: 'reports:reports.series.errors.recipientsNeedExportAndMfa',
  // W02 final: transient owner-authority lookup failure (503).
  series_authority_unverifiable: 'reports:reports.series.errors.seriesAuthorityUnverifiable',
};

export function seriesFriendlyError(code: string): string | undefined {
  const key = FRIENDLY_ERROR_KEYS[code];
  return key ? i18n.t(/* i18n-dynamic */ key) : undefined;
}
const friendly = (code: string) => seriesFriendlyError(code);

async function readJson(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}

// ---------- reads ----------

/** null = the caller may not read series (403/404): the list simply has none. */
export async function fetchSeriesList(): Promise<SeriesDetail[] | null> {
  const res = await fetchWithAuth(SERIES_ROOT, { skipOrgIdInjection: true });
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${SERIES_ROOT} answered ${res.status}`);
  const body = (await readJson(res)) as { data?: unknown } | null;
  return Array.isArray(body?.data) ? (body!.data as SeriesDetail[]) : [];
}

/** null = the series does not exist (or is not visible). */
export async function fetchSeriesDetail(id: string): Promise<SeriesDetail | null> {
  const res = await fetchWithAuth(`${SERIES_ROOT}/${encodeURIComponent(id)}`, { skipOrgIdInjection: true });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${SERIES_ROOT}/${id} answered ${res.status}`);
  return (await readJson(res)) as SeriesDetail;
}

export async function previewSeriesRecipients(
  // `internalCc` is W02's optional extension (its contract concern 5).
  body: SeriesTargets & { recipientRule: SeriesRecipientRule; internalCc: string[] },
): Promise<SeriesRecipientPreview> {
  // runaction-exempt: a read over POST (the body is the unsaved form). Failure renders inline under the form; a toast per debounced keystroke would be noise.
  const res = await fetchWithAuth(`${SERIES_ROOT}/recipients/preview`, {
    ...CROSS_ORG,
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`recipient preview answered ${res.status}`);
  return (await readJson(res)) as SeriesRecipientPreview;
}

/** Partner users who could own a series (spec §3.4): active, org_access 'all'.
 *  The server re-checks site scope (400 series_owner_ineligible). */
export async function fetchSeriesOwnerCandidates(): Promise<PartnerUserOption[] | 'forbidden'> {
  const res = await fetchWithAuth('/users', { skipOrgIdInjection: true });
  if (res.status === 403) return 'forbidden';
  if (!res.ok) throw new Error(`GET /users answered ${res.status}`);
  const body = (await readJson(res)) as { data?: Record<string, unknown>[] } | null;
  return (body?.data ?? [])
    .filter((u) => u.status === 'active' && u.orgAccess === 'all')
    .map((u) => ({ id: String(u.id), name: String(u.name ?? ''), email: String(u.email ?? '') }));
}

/** A child's own org contacts (max page — getPagination caps limit at 100). */
export async function fetchOrgContacts(orgId: string): Promise<OrgContact[]> {
  const res = await fetchWithAuth(`/orgs/organizations/${encodeURIComponent(orgId)}/contacts?limit=100`, { orgIdOverride: orgId });
  if (!res.ok) throw new Error(`contacts answered ${res.status}`);
  const body = (await readJson(res)) as { data?: OrgContact[] } | null;
  return (body?.data ?? []).filter((c) => Boolean(c.email));
}

export async function fetchChildOverrides(reportId: string): Promise<ChildRecipientOverride[]> {
  const res = await fetchWithAuth(`/reports/${encodeURIComponent(reportId)}/recipients`);
  if (!res.ok) throw new Error(`recipients answered ${res.status}`);
  const body = (await readJson(res)) as { data?: { contactId: string; mode?: string }[] } | null;
  return (body?.data ?? []).map((r) => ({ contactId: r.contactId, mode: r.mode === 'remove' ? 'remove' : 'add' }));
}

// ---------- mutations (every one runAction-wrapped) ----------

export function createSeries(body: SeriesCreateBody, msgs: ActionMessages): Promise<SeriesDetail> {
  return runAction<SeriesDetail>({
    request: () => fetchWithAuth(SERIES_ROOT, { ...CROSS_ORG, method: 'POST', body: JSON.stringify(body) }),
    errorFallback: msgs.errorFallback,
    successMessage: msgs.successMessage,
    friendly,
  });
}

export function updateSeries(id: string, body: SeriesUpdateBody, msgs: ActionMessages): Promise<SeriesDetail> {
  return runAction<SeriesDetail>({
    request: () => fetchWithAuth(`${SERIES_ROOT}/${encodeURIComponent(id)}`, { ...CROSS_ORG, method: 'PATCH', body: JSON.stringify(body) }),
    errorFallback: msgs.errorFallback,
    successMessage: msgs.successMessage,
    friendly,
  });
}

export function replaceSeriesTargets(id: string, targets: SeriesTargets, msgs: ActionMessages): Promise<SeriesDetail> {
  return runAction<SeriesDetail>({
    request: () => fetchWithAuth(`${SERIES_ROOT}/${encodeURIComponent(id)}/targets`, { ...CROSS_ORG, method: 'PUT', body: JSON.stringify(targets) }),
    errorFallback: msgs.errorFallback,
    successMessage: msgs.successMessage,
    friendly,
  });
}

export async function transferSeriesOwner(id: string, ownerUserId: string, msgs: ActionMessages): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`${SERIES_ROOT}/${encodeURIComponent(id)}/transfer-owner`, { ...CROSS_ORG, method: 'POST', body: JSON.stringify({ ownerUserId }) }),
    errorFallback: msgs.errorFallback,
    successMessage: msgs.successMessage,
    friendly,
  });
}

export async function deleteSeries(id: string, msgs: ActionMessages): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`${SERIES_ROOT}/${encodeURIComponent(id)}`, { ...CROSS_ORG, method: 'DELETE' }),
    errorFallback: msgs.errorFallback,
    successMessage: msgs.successMessage,
    friendly,
  });
}

export async function detachSeriesChild(reportId: string, msgs: ActionMessages): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`/reports/${encodeURIComponent(reportId)}/detach`, { method: 'POST' }),
    errorFallback: msgs.errorFallback,
    successMessage: msgs.successMessage,
    friendly,
  });
}

/** Run now (this org): the child is an ordinary org report, so the existing generate route. */
export async function generateSeriesChild(reportId: string, msgs: ActionMessages): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`/reports/${encodeURIComponent(reportId)}/generate`, { method: 'POST' }),
    errorFallback: msgs.errorFallback,
    successMessage: msgs.successMessage,
    friendly,
  });
}

/**
 * Move one contact between Follow rule / Always send / Never send on a child.
 * The uniqueness key is (report_id, contact_id), so a switch between add and
 * remove deletes the old row first (no reliance on an upsert). A failure after
 * the DELETE leaves the contact on "Follow rule"; the caller reloads.
 */
export async function setChildRecipientOverride(
  reportId: string,
  contactId: string,
  current: RecipientChoice,
  next: RecipientChoice,
  msgs: ActionMessages,
): Promise<void> {
  if (current === next) return;
  const base = `/reports/${encodeURIComponent(reportId)}/recipients`;
  // W02 upserts `mode` on (report_id, contact_id) for a series child, so an
  // add↔remove switch is ONE POST (no window where the contact is on the rule).
  if (current !== 'default' && next !== 'default') {
    await runAction({
      request: () => fetchWithAuth(base, { method: 'POST', body: JSON.stringify({ contactId, mode: next }) }),
      errorFallback: msgs.errorFallback,
      successMessage: msgs.successMessage,
      friendly,
    });
    return;
  }
  if (current !== 'default') {
    await runAction({
      request: () => fetchWithAuth(`${base}/${encodeURIComponent(contactId)}`, { method: 'DELETE' }),
      errorFallback: msgs.errorFallback,
      successMessage: next === 'default' ? msgs.successMessage : undefined,
      friendly,
    });
  }
  if (next !== 'default') {
    await runAction({
      request: () => fetchWithAuth(base, { method: 'POST', body: JSON.stringify({ contactId, mode: next }) }),
      errorFallback: msgs.errorFallback,
      successMessage: msgs.successMessage,
      friendly,
    });
  }
}
