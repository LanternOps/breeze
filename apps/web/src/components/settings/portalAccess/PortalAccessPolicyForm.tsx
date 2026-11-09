import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { InheritChoice, type InheritChoiceOption } from '../../shared/InheritChoice';
import {
  draftHasSsoMethod,
  ownValue,
  withDraftField,
  type PortalAccessPolicyDraft,
  type PortalAccessPolicyField,
  type PortalAccessPolicyValues,
  type PortalAccessPolicyView,
  type PortalPasswordMode,
  type PortalSelfRegistrationMode,
  type PortalSsoNewPersonMode,
} from './types';

export interface PortalAccessPolicyFormProps {
  view: PortalAccessPolicyView;
  /** Unsaved edits relative to `view.values`. */
  draft: PortalAccessPolicyDraft;
  onChange: (next: PortalAccessPolicyDraft) => void;
  pendingRequestCount?: number;
  /** The count is the first page of a longer list: shown as "{n}+". */
  pendingRequestsHasMore?: boolean;
  onShowRequests?: () => void;
  /** Server validation errors keyed by field (a 400 `{ code, field }`). */
  fieldErrors?: Partial<Record<PortalAccessPolicyField, string>>;
}

const ID = 'portal-access-policy';

/** The fields the form renders a row for, given what the deployment can run (OD2). */
export function visiblePolicyFields(capabilities: PortalAccessPolicyView['capabilities']): PortalAccessPolicyField[] {
  const fields: PortalAccessPolicyField[] = [];
  if (capabilities.entra) fields.push('entraEnabled');
  if (capabilities.google) fields.push('googleEnabled');
  fields.push('passwordMode');
  if (capabilities.selfRegistration) fields.push('selfRegistrationMode');
  if (capabilities.entra || capabilities.google) fields.push('ssoNewPersonMode');
  return fields;
}

/**
 * The portal access policy form, shared by the org Sign-in & registration card
 * (org override) and the partner Customer portal tab (partner default).
 * Presentational: the owner loads, saves and holds the draft.
 *
 * Rows appear only when the deployment can run them (`view.capabilities`, OD2):
 * in W3 that is the Password row and the always-on invites row.
 */
export function PortalAccessPolicyForm({
  view,
  draft,
  onChange,
  pendingRequestCount = 0,
  pendingRequestsHasMore = false,
  onShowRequests,
  fieldErrors = {},
}: PortalAccessPolicyFormProps) {
  const { t } = useTranslation('settings');
  const { capabilities } = view;
  const visible = new Set(visiblePolicyFields(capabilities));
  const disabled = !view.canEdit;
  const allowInherit = view.owner.kind === 'org';
  const sourceLabel = (field: PortalAccessPolicyField) =>
    view.inherited[field].source === 'partner'
      ? t('portalAccessPolicy.sources.partner')
      : t('portalAccessPolicy.sources.default');

  const row = <K extends PortalAccessPolicyField>(
    field: K,
    suffix: string,
    legend: string,
    options: InheritChoiceOption<PortalAccessPolicyValues[K] & (string | boolean)>[],
  ): ReactNode => (
    <div>
      <InheritChoice<PortalAccessPolicyValues[K] & (string | boolean)>
        id={`${ID}-${suffix}`}
        legend={legend}
        options={options}
        value={ownValue(view, draft, field) as (PortalAccessPolicyValues[K] & (string | boolean)) | null}
        inheritedValue={view.inherited[field].value as PortalAccessPolicyValues[K] & (string | boolean)}
        inheritedSourceLabel={sourceLabel(field)}
        allowInherit={allowInherit}
        disabled={disabled}
        onChange={(value) => onChange(withDraftField(view, draft, field, value as PortalAccessPolicyValues[K] | null))}
      />
      {fieldErrors[field] && (
        <p data-testid={`${ID}-${field}-error`} className="mt-1 text-xs text-destructive">{fieldErrors[field]}</p>
      )}
    </div>
  );

  const onOff = (suffix: string): InheritChoiceOption<boolean>[] => [
    { value: true, label: t('portalAccessPolicy.options.on'), testId: `${ID}-${suffix}-on` },
    { value: false, label: t('portalAccessPolicy.options.off'), testId: `${ID}-${suffix}-off` },
  ];

  const ssoOn = draftHasSsoMethod(view, draft);
  const passwordOptions: InheritChoiceOption<PortalPasswordMode>[] = [
    { value: 'allowed', label: t('portalAccessPolicy.password.allowed'), testId: `${ID}-password-allowed` },
    {
      value: 'sso_only',
      label: t('portalAccessPolicy.password.ssoOnly'),
      testId: `${ID}-password-sso_only`,
      disabled: !ssoOn,
      hint: ssoOn ? undefined : t('portalAccessPolicy.password.ssoOnlyNeedsSso'),
    },
  ];
  const selfRegistrationOptions: InheritChoiceOption<PortalSelfRegistrationMode>[] = [
    { value: 'off', label: t('portalAccessPolicy.selfRegistration.off'), testId: `${ID}-self-registration-off` },
    { value: 'approval', label: t('portalAccessPolicy.selfRegistration.approval'), testId: `${ID}-self-registration-approval` },
    { value: 'instant', label: t('portalAccessPolicy.selfRegistration.instant'), testId: `${ID}-self-registration-instant` },
  ];
  const ssoNewPersonOptions: InheritChoiceOption<PortalSsoNewPersonMode>[] = [
    { value: 'invited_only', label: t('portalAccessPolicy.ssoNewPerson.invitedOnly'), testId: `${ID}-sso-new-person-invited_only` },
    { value: 'approval', label: t('portalAccessPolicy.ssoNewPerson.approval'), testId: `${ID}-sso-new-person-approval` },
    { value: 'instant', label: t('portalAccessPolicy.ssoNewPerson.instant'), testId: `${ID}-sso-new-person-instant` },
  ];

  return (
    <div className="space-y-6" data-testid={`${ID}-form`}>
      {disabled && (
        <p data-testid={`${ID}-read-only`} className="text-xs text-muted-foreground">{t('portalAccessPolicy.readOnly')}</p>
      )}

      <section className="space-y-4" aria-labelledby={`${ID}-sign-in-heading`}>
        <h3 id={`${ID}-sign-in-heading`} className="text-sm font-semibold">{t('portalAccessPolicy.signIn.title')}</h3>
        {visible.has('entraEnabled') && row('entraEnabled', 'microsoft', t('portalAccessPolicy.microsoft.label'), onOff('microsoft'))}
        {visible.has('googleEnabled') && row('googleEnabled', 'google', t('portalAccessPolicy.google.label'), onOff('google'))}
        {row('passwordMode', 'password', t('portalAccessPolicy.password.label'), passwordOptions)}
        {view.passwordModeFallback && (
          <p
            role="status"
            data-testid={`${ID}-fallback`}
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          >
            {t('portalAccessPolicy.fallback')}
          </p>
        )}
      </section>

      <section className="space-y-4" aria-labelledby={`${ID}-new-people-heading`}>
        <div className="flex items-center justify-between gap-2">
          <h3 id={`${ID}-new-people-heading`} className="text-sm font-semibold">{t('portalAccessPolicy.newPeople.title')}</h3>
          {pendingRequestCount > 0 && onShowRequests && (
            <button
              type="button"
              data-testid={`${ID}-requests`}
              onClick={onShowRequests}
              className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted/50"
            >
              {t('portalAccessPolicy.requests', { count: pendingRequestsHasMore ? `${pendingRequestCount}+` : pendingRequestCount })}
            </button>
          )}
        </div>
        <div data-testid={`${ID}-invites`} className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <span className="font-medium">{t('portalAccessPolicy.invites.label')}</span>
          <span className="text-muted-foreground">{t('portalAccessPolicy.invites.value')}</span>
        </div>
        {visible.has('selfRegistrationMode')
          && row('selfRegistrationMode', 'self-registration', t('portalAccessPolicy.selfRegistration.label'), selfRegistrationOptions)}
        {visible.has('ssoNewPersonMode')
          && row('ssoNewPersonMode', 'sso-new-person', t('portalAccessPolicy.ssoNewPerson.label'), ssoNewPersonOptions)}
      </section>
    </div>
  );
}
