import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { InheritChoice, type InheritChoiceOption } from '../../shared/InheritChoice';
import InheritedField from '../../shared/InheritedField';
import type { PortalAccessPolicyField, PortalAccessPolicyValues, PortalAccessPolicyView } from '@breeze/shared';
import { draftHasSsoMethod, ownValue, withDraftField, type PortalAccessPolicyDraft } from './types';

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
  /** Rendered under the Microsoft row when it shows (W4: the org's tenant proof panel). */
  entraSlot?: ReactNode;
  /**
   * Whether a field holds typed text that is not a valid value (today: the
   * session length). The owner blocks its Save while true: the draft then
   * holds the saved value for that field, not what is on screen.
   */
  onInvalidChange?: (invalid: boolean) => void;
}

const ID = 'portal-access-policy';

/** `ssoSessionMaxHours` bounds (the shared patch schema: an integer, 1–168). */
export const SSO_SESSION_HOURS_MIN = 1;
export const SSO_SESSION_HOURS_MAX = 168;

/** A whole number of hours in range, or null for anything else. */
function parseSessionHours(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= SSO_SESSION_HOURS_MIN && n <= SSO_SESSION_HOURS_MAX ? n : null;
}

/** The fields the form renders a row for, given what the deployment can run (OD2). */
export function visiblePolicyFields(capabilities: PortalAccessPolicyView['capabilities']): PortalAccessPolicyField[] {
  const fields: PortalAccessPolicyField[] = [];
  if (capabilities.entra) fields.push('entraEnabled');
  if (capabilities.google) fields.push('googleEnabled');
  fields.push('passwordMode');
  if (capabilities.selfRegistration) fields.push('selfRegistrationMode');
  if (capabilities.entra || capabilities.google) fields.push('ssoNewPersonMode');
  if (capabilities.entra || capabilities.google) fields.push('ssoSessionMaxHours');
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
  entraSlot,
  onInvalidChange,
}: PortalAccessPolicyFormProps) {
  const { t } = useTranslation('settings');
  const { capabilities } = view;
  // The hours box keeps what was typed while it is not a valid value, so the
  // person can see and fix it; only a valid number (or blank = inherit) reaches
  // the draft. Reset whenever the owner hands in a new view (load or save).
  const [hoursText, setHoursText] = useState<string | null>(null);
  useEffect(() => {
    setHoursText(null);
    onInvalidChange?.(false);
    // Only a new view resets the box; the callback's identity is the owner's concern.
  }, [view]);
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
  const passwordOptions: InheritChoiceOption<PortalAccessPolicyValues['passwordMode']>[] = [
    { value: 'allowed', label: t('portalAccessPolicy.password.allowed'), testId: `${ID}-password-allowed` },
    {
      value: 'sso_only',
      label: t('portalAccessPolicy.password.ssoOnly'),
      testId: `${ID}-password-sso_only`,
      disabled: !ssoOn,
      hint: ssoOn ? undefined : t('portalAccessPolicy.password.ssoOnlyNeedsSso'),
    },
  ];
  const selfRegistrationOptions: InheritChoiceOption<PortalAccessPolicyValues['selfRegistrationMode']>[] = [
    { value: 'off', label: t('portalAccessPolicy.selfRegistration.off'), testId: `${ID}-self-registration-off` },
    { value: 'approval', label: t('portalAccessPolicy.selfRegistration.approval'), testId: `${ID}-self-registration-approval` },
    { value: 'instant', label: t('portalAccessPolicy.selfRegistration.instant'), testId: `${ID}-self-registration-instant` },
  ];
  const ssoNewPersonOptions: InheritChoiceOption<PortalAccessPolicyValues['ssoNewPersonMode']>[] = [
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
        {visible.has('entraEnabled') && (
          <div>
            {row('entraEnabled', 'microsoft', t('portalAccessPolicy.microsoft.label'), onOff('microsoft'))}
            {entraSlot}
          </div>
        )}
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
        {visible.has('ssoSessionMaxHours') && (() => {
          const own = ownValue(view, draft, 'ssoSessionMaxHours');
          const text = hoursText ?? (own === null ? '' : String(own));
          const invalid = hoursText !== null && hoursText.trim() !== '' && parseSessionHours(hoursText) === null;
          const error = invalid ? t('portalAccessPolicy.errors.sessionHours') : fieldErrors.ssoSessionMaxHours;
          return (
            <div>
              <InheritedField
                id={`${ID}-session-hours`}
                label={t('portalAccessPolicy.sessionHours.label')}
                type="number"
                min={SSO_SESSION_HOURS_MIN}
                max={SSO_SESSION_HOURS_MAX}
                step="1"
                value={text}
                inheritedValue={String(view.inherited.ssoSessionMaxHours.value)}
                inheritedSource={sourceLabel('ssoSessionMaxHours')}
                disabled={disabled}
                ariaInvalid={!!error}
                ariaDescribedBy={`${ID}-session-hours-help`}
                data-testid={`${ID}-session-hours`}
                onChange={(next) => {
                  setHoursText(next);
                  const hours = next.trim() === '' ? null : parseSessionHours(next);
                  const valid = next.trim() === '' || hours !== null;
                  onInvalidChange?.(!valid);
                  // Invalid text never stays in the draft: a valid prefix typed on the way
                  // ("20" on the way to "200") is replaced by the saved value.
                  onChange(withDraftField(view, draft, 'ssoSessionMaxHours', valid ? hours : view.values.ssoSessionMaxHours));
                }}
              />
              <p id={`${ID}-session-hours-help`} className="mt-1 text-xs text-muted-foreground">{t('portalAccessPolicy.sessionHours.help')}</p>
              {error && (
                <p data-testid={`${ID}-ssoSessionMaxHours-error`} className="mt-1 text-xs text-destructive">{error}</p>
              )}
            </div>
          );
        })()}
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
