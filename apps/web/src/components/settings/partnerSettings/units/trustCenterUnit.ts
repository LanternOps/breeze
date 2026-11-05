import { TRUST_INTRO_MAX_CHARS, type TrustTemplateSettings as TemplateSettings } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { getTrustPageTemplate, updateTrustPageTemplate, type TrustTemplateState } from '@/lib/api/trustPageTemplate';
import { VALID_TAB, type TabValidity } from '../saveUnits';
import { saveSlice, useDraftSaveUnit, useDraftSlice, type Loader } from '../partnerSettingsDraftStore';

export const EMPTY_TEMPLATE: TemplateSettings = {
  introHtml: null, searchIndexable: null, showPercentages: null, showDeviceCount: null, showManagedBy: null,
  showHistory: null, hiddenControlIds: null, frameworkView: null,
};

/** What the Trust Center tab edits: the template draft plus the intro as typed. Revision lives on the slice. */
export type TrustCenterValue = {
  meta: Pick<TrustTemplateState, 'defaults' | 'frameworkOptions' | 'canManage'>;
  draft: TemplateSettings;
  intro: string;
};

/** The editor emits `<p></p>` for an empty document; on the template that is "no template intro" (null). */
export function isEmptyHtml(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').trim() === '' && !/<(img|table|hr)\b/i.test(html);
}

const tr = (key: string) => i18n.t(/* i18n-dynamic */ `organizations:orgRecord.trust.${key}`);
const toLogin = () => { void navigateTo('/login', { replace: true }); };

function valueFrom(meta: TrustCenterValue['meta'], template: TemplateSettings | null): TrustCenterValue {
  return { meta, draft: template ?? EMPTY_TEMPLATE, intro: template?.introHtml ?? '' };
}

export const loadTrustCenter: Loader<TrustCenterValue> = async () => {
  try {
    const loaded = await getTrustPageTemplate(fetchWithAuth);
    const { defaults, frameworkOptions, canManage } = loaded;
    return { value: valueFrom({ defaults, frameworkOptions, canManage }, loaded.template), revision: loaded.revision };
  } catch (err) {
    if (err instanceof ActionError && err.status === 401) toLogin();
    throw err;
  }
};

export function useTrustCenterDraft() {
  return useDraftSlice<TrustCenterValue>('trustCenter', loadTrustCenter);
}

export const TRUST_INTRO_FIELD_ID = 'trust-template-intro-wrap';

function validate(value: TrustCenterValue): TabValidity {
  return value.intro.length > TRUST_INTRO_MAX_CHARS
    ? { isValid: false, invalidCount: 1, firstInvalidFieldId: TRUST_INTRO_FIELD_ID }
    : VALID_TAB;
}

const save = () => saveSlice<TrustCenterValue>('trustCenter', async (value, revision) => {
  const body = { ...value.draft, introHtml: isEmptyHtml(value.intro) ? null : value.intro, expectedRevision: revision ?? 0 };
  const data = await runAction({
    request: () => updateTrustPageTemplate(fetchWithAuth, body),
    parseSuccess: (d) => (d as { data: { template: TemplateSettings; revision: number } }).data,
    // No successMessage: the header Save shows one aggregate success toast.
    errorFallback: tr('inheritance.template.saveFailed'),
    friendly: (code) => ({
      REVISION_MISMATCH: tr('inheritance.template.revisionMismatch'),
      PARTNER_WIDE_REQUIRED: tr('inheritance.template.readOnly'),
      MFA_REQUIRED: tr('inheritance.template.mfaRequired'),
      INTRO_TOO_LONG: tr('errors.introTooLong'),
    } as Record<string, string>)[code],
    onUnauthorized: toLogin,
  });
  return { revision: data.revision, value: valueFrom(value.meta, data.template) };
}, {
  // Another admin saved first. The draft and its stale revision stay; the tab
  // offers "Reload theirs" / "Keep editing" (Gate B 11: no auto-merge).
  classifyError: (err) => (err instanceof ActionError && err.code === 'REVISION_MISMATCH' ? 'conflict' : 'failed'),
  errorFallback: tr('inheritance.template.saveFailed'),
});

/** Partner Trust Center template (`PUT /trust-page-template`, revisioned) as a header-Save unit. */
export function useTrustCenterUnit() {
  return useDraftSaveUnit<TrustCenterValue>('trustCenter', save, { validate });
}
