import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Mail, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CONTACT_ROLES, CONTACT_ROLE_LABEL_KEYS } from '@/lib/contactRoles';
import { previewSeriesRecipients } from './seriesApi';
import { isReportRecipientEmail } from './seriesConfig';
import type { SeriesRecipientPreview, SeriesRecipientRule, SeriesTargets } from './types';

export interface SeriesRecipientsValue { recipientRule: SeriesRecipientRule; internalCc: string[] }
export const PREVIEW_DEBOUNCE_MS = 400;
const MISSING_NAMES_SHOWN = 5;

type PreviewState = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * Series-mode recipients (spec §3.5, §3.7): the rule resolved in each org, the
 * fixed internal CC, and a live preview from POST /reports/series/recipients/
 * preview. Controlled; the host owns the value.
 */
export function SeriesRecipientsSection({
  value,
  onChange,
  targets,
}: {
  value: SeriesRecipientsValue;
  onChange: (next: SeriesRecipientsValue) => void;
  targets: SeriesTargets;
}) {
  const { t } = useTranslation('reports');
  const { t: tSettings } = useTranslation('settings');
  const [ccInput, setCcInput] = useState('');
  const [ccError, setCcError] = useState(false);
  const [preview, setPreview] = useState<SeriesRecipientPreview | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>('idle');
  const requestSeq = useRef(0);
  const { recipientRule, internalCc } = value;

  const orgIdsKey = targets.orgIds.join(',');
  const rolesKey = recipientRule.roles.join(',');
  const ccKey = internalCc.join(',');
  const noTargets = targets.targetMode === 'selected' && targets.orgIds.length === 0;

  useEffect(() => {
    // Every run invalidates older in-flight answers, so only the newest form
    // state can ever reach the screen (Review Focus 2).
    const mine = ++requestSeq.current;
    if (noTargets) {
      setPreview(null);
      setPreviewState('idle');
      return;
    }
    setPreviewState('loading');
    const body = { targetMode: targets.targetMode, orgIds: targets.orgIds, recipientRule, internalCc };
    const timer = setTimeout(() => {
      previewSeriesRecipients(body)
        .then((result) => {
          if (mine !== requestSeq.current) return;
          setPreview(result);
          setPreviewState('ready');
        })
        .catch((err: unknown) => {
          if (mine !== requestSeq.current) return;
          console.warn('[SeriesRecipientsSection] recipient preview failed', err);
          setPreview(null);
          setPreviewState('failed');
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // Keyed on the joined ids/roles: the arrays are rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.targetMode, orgIdsKey, recipientRule.primaryContact, rolesKey, ccKey, noTargets]);

  const setRule = (rule: SeriesRecipientRule) => onChange({ ...value, recipientRule: rule });
  const toggleRole = (role: string) =>
    setRule({
      ...recipientRule,
      roles: recipientRule.roles.includes(role)
        ? recipientRule.roles.filter((r) => r !== role)
        : [...recipientRule.roles, role],
    });

  const addCc = () => {
    const trimmed = ccInput.trim();
    if (!trimmed) return;
    if (!isReportRecipientEmail(trimmed)) {
      setCcError(true);
      return;
    }
    setCcError(false);
    setCcInput('');
    if (!internalCc.includes(trimmed)) onChange({ ...value, internalCc: [...internalCc, trimmed] });
  };

  const missing = preview?.orgsWithoutCustomerRecipient ?? [];
  const shownNames = missing.slice(0, MISSING_NAMES_SHOWN).map((o) => o.orgName).join(', ');
  const moreCount = missing.length - MISSING_NAMES_SHOWN;
  const noRule = !recipientRule.primaryContact && recipientRule.roles.length === 0;

  return (
    <fieldset data-testid="series-recipients" className="space-y-4 rounded-md border p-4">
      <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">{t('reports.series.recipients.legend')}</legend>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="series-rule-primary"
          checked={recipientRule.primaryContact}
          onChange={() => setRule({ ...recipientRule, primaryContact: !recipientRule.primaryContact })}
        />
        {t('reports.series.recipients.primaryContact')}
      </label>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t('reports.series.recipients.roles')}</p>
        <div className="flex flex-wrap gap-2">
          {CONTACT_ROLES.map((role) => (
            <label key={role} className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
              <input
                type="checkbox"
                data-testid={`series-rule-role-${role}`}
                checked={recipientRule.roles.includes(role)}
                onChange={() => toggleRole(role)}
              />
              {tSettings(/* i18n-dynamic */ CONTACT_ROLE_LABEL_KEYS[role])}
            </label>
          ))}
        </div>
      </div>

      {noRule && (
        <p data-testid="series-rule-none-warning" role="status" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          {t('reports.series.recipients.noRuleWarning')}
        </p>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <p className="text-xs font-medium text-muted-foreground">{t('reports.series.recipients.internalCc')}</p>
        </div>
        <p className="text-xs text-muted-foreground">{t('reports.series.recipients.internalCcHint')}</p>
        {internalCc.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {internalCc.map((email) => (
              <span key={email} data-testid={`series-cc-chip-${email}`} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                {email}
                <button
                  type="button"
                  aria-label={t('reports.series.recipients.ccRemove', { email })}
                  onClick={() => onChange({ ...value, internalCc: internalCc.filter((e) => e !== email) })}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="email"
            data-testid="series-cc-input"
            value={ccInput}
            placeholder={t('reports.series.recipients.ccPlaceholder')}
            onChange={(e) => setCcInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addCc();
              }
            }}
            className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
          />
          <button type="button" data-testid="series-cc-add" onClick={addCc} className="h-9 rounded-md border px-3 text-sm hover:bg-muted">
            {t('reports.series.recipients.ccAdd')}
          </button>
        </div>
        {ccError && <p data-testid="series-cc-error" className="text-xs text-destructive">{t('reports.series.recipients.ccInvalid')}</p>}
      </div>

      <div data-testid="series-recipient-preview" data-state={previewState} aria-live="polite" className="rounded-md bg-muted/40 px-3 py-2 text-xs">
        {previewState === 'idle' && t('reports.series.recipients.previewNoTargets')}
        {previewState === 'loading' && (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('reports.series.recipients.previewLoading')}
          </span>
        )}
        {previewState === 'failed' && t('reports.series.recipients.previewFailed')}
        {previewState === 'ready' && preview && (
          <>
            <span>
              {t('reports.series.recipients.previewContacts', { count: preview.totalCustomerRecipients })}{' '}
              {t('reports.series.recipients.previewOrgs', { count: preview.orgCount })}
            </span>
            {missing.length > 0 && (
              <p data-testid="series-recipient-preview-missing" className="mt-1 flex items-start gap-1 text-warning">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  {t('reports.series.recipients.previewMissing', { count: missing.length, names: shownNames })}
                  {moreCount > 0 && <> {t('reports.series.recipients.previewMore', { count: moreCount })}</>}
                </span>
              </p>
            )}
          </>
        )}
      </div>
    </fieldset>
  );
}
