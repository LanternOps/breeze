import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { Organization } from './OrganizationList';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { runAction, handleActionError } from '@/lib/runAction';

/** The three fixed-day presets the retention picker offers alongside "Never"
 *  and "Custom". Exported for the test. */
export const RETENTION_PRESET_DAYS = ['30', '90', '365'] as const;
export type RetentionPresetDays = (typeof RETENTION_PRESET_DAYS)[number];
export type RetentionOption = RetentionPresetDays | 'never' | 'custom';

/** Matches the API's `retentionDays: z.number().int().min(1).max(3650).nullable().optional()`
 *  (apps/api/src/routes/orgArchive.ts). */
export const MIN_CUSTOM_RETENTION_DAYS = 1;
export const MAX_CUSTOM_RETENTION_DAYS = 3650;

export const DEFAULT_RETENTION_OPTION: RetentionOption = '90';

/** Parses the custom-days text input. Returns `null` for anything that isn't
 *  a plain integer in range — empty string included, so an untouched input
 *  fails closed rather than silently defaulting to something submittable.
 *  Exported for the test. */
export function parseCustomRetentionDays(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const days = Number(trimmed);
  if (!Number.isInteger(days) || days < MIN_CUSTOM_RETENTION_DAYS || days > MAX_CUSTOM_RETENTION_DAYS) {
    return null;
  }
  return days;
}

/** Resolves the picker's current selection to the exact `retentionDays` value
 *  the archive POST body carries: `null` for Never, the parsed value for
 *  Custom (or `null` if it doesn't validate — callers must gate submission on
 *  this separately), or the preset number otherwise. Exported for the test. */
export function resolveRetentionDays(option: RetentionOption, customValue: string): number | null {
  if (option === 'never') return null;
  if (option === 'custom') return parseCustomRetentionDays(customValue);
  return Number(option);
}

interface ArchiveResult {
  status: 'offboarding' | 'archived';
  purgeAt: string | null;
}

export interface ArchiveOrgModalProps {
  org: Organization;
  /** Dismiss without archiving — the form phase's Cancel button. */
  onClose: () => void;
  /**
   * Fired exactly once, immediately after the archive POST returns 202.
   * List-state update ONLY (drop the org from the active list) — must NOT
   * close the modal, which stays open on its own `done` phase so the operator
   * can see the purge-date summary. Mirrors MergeOrgModal's `onMerged`.
   */
  onArchived: (orgId: string) => void;
  /** The done phase's explicit Close button. */
  onDoneClose: () => void;
}

type Phase = 'form' | 'done';

export default function ArchiveOrgModal({ org, onClose, onArchived, onDoneClose }: ArchiveOrgModalProps) {
  const { t } = useTranslation('settings');
  const [phase, setPhase] = useState<Phase>('form');
  const [option, setOption] = useState<RetentionOption>(DEFAULT_RETENTION_OPTION);
  const [customValue, setCustomValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ArchiveResult | null>(null);

  const customDays = option === 'custom' ? parseCustomRetentionDays(customValue) : null;
  const customInvalid = option === 'custom' && customValue.trim() !== '' && customDays === null;
  const canSubmit = !submitting && (option !== 'custom' || customDays !== null);

  const mfaFriendly = (code: string) =>
    code === 'MFA_REQUIRED' ? t('organizationsPage.archive.errors.mfaRequired') : undefined;

  const formatPurgeDate = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
  };

  const handleSubmit = async () => {
    const retentionDays = resolveRetentionDays(option, customValue);
    if (option === 'custom' && retentionDays === null) return; // canSubmit already guards this

    setSubmitting(true);
    try {
      const data = await runAction<ArchiveResult>({
        request: () =>
          fetchWithAuth(`/orgs/organizations/${org.id}/archive`, {
            method: 'POST',
            body: JSON.stringify({ retentionDays }),
          }),
        errorFallback: t('organizationsPage.archive.errors.archive'),
        friendly: mfaFriendly,
        onUnauthorized: handleSessionExpired,
      });
      setResult(data);
      setPhase('done');
      onArchived(org.id);
    } catch (err) {
      // runAction already toasted an ActionError (e.g. a 409 for a status that
      // can't be archived) — the modal simply stays on the form phase so the
      // operator can retry or cancel. onUnauthorized handles a 401 redirect.
      // Only a non-ActionError escape needs a fallback toast.
      handleActionError(err, t('organizationsPage.archive.errors.archive'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-lg border bg-card p-6 shadow-xs"
        data-testid="org-archive-modal"
      >
        {phase === 'form' && (
          <>
            <h2 className="text-lg font-semibold">{t('organizationsPage.archive.title')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('organizationsPage.archive.description', { name: org.name })}
            </p>

            <div
              data-testid="org-archive-consequences"
              className="mt-4 space-y-2 rounded-md border bg-muted/30 p-3 text-sm"
            >
              <p className="font-medium">{t('organizationsPage.archive.consequencesHeading')}</p>
              <ul className="list-disc space-y-1 pl-4">
                <li>{t('organizationsPage.archive.consequences.hidden')}</li>
                <li>{t('organizationsPage.archive.consequences.readOnly')}</li>
                <li>{t('organizationsPage.archive.consequences.agentsUninstalled')}</li>
                <li>{t('organizationsPage.archive.consequences.billingStops')}</li>
                <li data-testid="org-archive-purge-consequence">
                  {option === 'never'
                    ? t('organizationsPage.archive.consequences.purgeNever')
                    : t('organizationsPage.archive.consequences.purgeScheduled')}
                </li>
              </ul>
              <p className="text-muted-foreground">
                {t('organizationsPage.archive.restoreNote', { name: org.name })}
              </p>
            </div>

            <fieldset className="mt-4">
              <legend className="text-sm font-medium">{t('organizationsPage.archive.retentionLabel')}</legend>
              <div className="mt-2 space-y-2">
                {RETENTION_PRESET_DAYS.map((preset) => (
                  <label key={preset} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="org-archive-retention"
                      data-testid={`org-archive-retention-${preset}`}
                      checked={option === preset}
                      onChange={() => setOption(preset)}
                    />
                    {t(/* i18n-dynamic */ `organizationsPage.archive.retentionOptions.days${preset}`)}
                  </label>
                ))}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="org-archive-retention"
                    data-testid="org-archive-retention-never"
                    checked={option === 'never'}
                    onChange={() => setOption('never')}
                  />
                  {t('organizationsPage.archive.retentionOptions.never')}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="org-archive-retention"
                    data-testid="org-archive-retention-custom"
                    checked={option === 'custom'}
                    onChange={() => setOption('custom')}
                  />
                  {t('organizationsPage.archive.retentionOptions.custom')}
                </label>
                {option === 'custom' && (
                  <div className="pl-6">
                    <label htmlFor="org-archive-custom-days" className="block text-xs text-muted-foreground">
                      {t('organizationsPage.archive.customDaysLabel')}
                    </label>
                    <input
                      id="org-archive-custom-days"
                      data-testid="org-archive-custom-days-input"
                      // Deliberately `type="text"` rather than `number`: a number
                      // input silently coerces an out-of-pattern paste (e.g.
                      // "abc") to an empty string at the DOM level, which would
                      // let invalid input escape our own 1–3650 integer check
                      // (parseCustomRetentionDays) instead of surfacing it.
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={customValue}
                      onChange={(e) => setCustomValue(e.target.value)}
                      className="mt-1 h-9 w-32 rounded-md border bg-background px-2.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                    {customInvalid && (
                      <p data-testid="org-archive-custom-error" className="mt-1 text-xs text-destructive">
                        {t('organizationsPage.archive.customError')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </fieldset>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                data-testid="org-archive-cancel"
                onClick={onClose}
                disabled={submitting}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('organizationsPage.archive.cancel')}
              </button>
              <button
                type="button"
                data-testid="org-archive-submit"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? t('organizationsPage.archive.archiving') : t('organizationsPage.archive.confirmButton')}
              </button>
            </div>
          </>
        )}

        {phase === 'done' && result && (
          <div data-testid="org-archive-done" className="space-y-3">
            <p className="font-medium">
              {result.status === 'offboarding'
                ? t('organizationsPage.archive.doneOffboardingTitle')
                : t('organizationsPage.archive.doneArchivedTitle')}
            </p>
            <p className="text-sm">
              {result.status === 'offboarding'
                ? t('organizationsPage.archive.doneOffboardingDescription', { name: org.name })
                : t('organizationsPage.archive.doneArchivedDescription', { name: org.name })}
            </p>
            <p data-testid="org-archive-purge-summary" className="text-sm text-muted-foreground">
              {result.purgeAt
                ? t('organizationsPage.archive.donePurgeScheduled', { date: formatPurgeDate(result.purgeAt) })
                : t('organizationsPage.archive.donePurgeNever')}
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="org-archive-close"
                onClick={onDoneClose}
                className="h-10 rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
              >
                {t('organizationsPage.archive.close')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
