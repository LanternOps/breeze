import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Hourglass, Save } from 'lucide-react';
import {
  AI_APPROVAL_TIMEOUT_MAX_MINUTES,
  AI_APPROVAL_TIMEOUT_MIN_MINUTES,
  type AiApprovalSettings,
  type ResolvedAiApprovalTimeout,
} from '@breeze/shared';

const CANONICAL_MINUTES = [5, 10, 15, 20, 30, 45, 60];

type Props = {
  /** This org's own `settings.aiApprovals` block, straight off `orgDetails`. */
  initialData?: AiApprovalSettings;
  /**
   * The resolved value from `GET /orgs/organizations/:id/effective-settings`
   * (`aiApprovalTimeout`) — null while it hasn't loaded (or an older API
   * build doesn't send it), which hides the inherit label rather than
   * guessing at a source.
   */
  effective: ResolvedAiApprovalTimeout | null;
  /**
   * #6475: like every other tab on this page (Notifications, Security,
   * Branding), saving goes through the page's `handleSave(section, data)` →
   * `handleSaveSettings`, which PATCHes the FULL current `settings` object
   * with only this section replaced (`{...currentSettings, aiApprovals:
   * data}`) and refreshes `orgDetails` afterward — the single choke point
   * that keeps every tab's settings write wholesale-safe, in both
   * directions: this save can't drop an unrelated key, and a later save from
   * another tab can't drop this one (orgDetails is refetched, not patched
   * locally, after every save).
   */
  onSave: (data: AiApprovalSettings) => void;
};

export default function OrgAiApprovalTimeoutCard({ initialData, effective, onSave }: Props) {
  const { t } = useTranslation('settings');
  // '' means inherit. Re-seeded whenever the org's own saved value changes
  // (e.g. after a save round-trip refreshes orgDetails).
  const [draft, setDraft] = useState<string>(
    initialData?.interactiveTimeoutMinutes != null ? String(initialData.interactiveTimeoutMinutes) : '',
  );
  useEffect(() => {
    setDraft(initialData?.interactiveTimeoutMinutes != null ? String(initialData.interactiveTimeoutMinutes) : '');
  }, [initialData?.interactiveTimeoutMinutes]);

  const currentMinutes = initialData?.interactiveTimeoutMinutes;
  const options = currentMinutes != null && !CANONICAL_MINUTES.includes(currentMinutes)
    ? [...CANONICAL_MINUTES, currentMinutes].sort((a, b) => a - b)
    : CANONICAL_MINUTES;

  const inheritLabel = effective
    ? t('orgAiApprovalTimeout.inheritLabel', {
        minutes: effective.inheritedMinutes,
        source: effective.inheritedSource === 'partner'
          ? t('orgAiApprovalTimeout.sourcePartner')
          : t('orgAiApprovalTimeout.sourceDefault'),
      })
    : t('orgAiApprovalTimeout.inherit');

  const handleSave = () => {
    const minutes = draft === '' ? undefined : Number(draft);
    onSave(minutes != null ? { interactiveTimeoutMinutes: minutes } : {});
  };

  const isDirty = draft !== (currentMinutes != null ? String(currentMinutes) : '');

  return (
    <section
      className="mt-4 rounded-lg border bg-card p-6 shadow-xs"
      data-testid="org-ai-approval-timeout-card"
    >
      <div className="flex items-center gap-2">
        <Hourglass className="h-5 w-5" />
        <h2 className="text-lg font-semibold">{t('orgAiApprovalTimeout.title')}</h2>
      </div>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">{t('orgAiApprovalTimeout.description')}</p>

      <label className="block max-w-xs">
        <span className="text-sm text-muted-foreground">{t('orgAiApprovalTimeout.fieldLabel')}</span>
        <select
          data-testid="org-ai-approval-timeout-select"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          <option value="">{inheritLabel}</option>
          {options.map((minutes) => (
            <option key={minutes} value={minutes}>
              {t('orgDefaultsEditor.enrollment.capMinutes', { minutes })}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('orgAiApprovalTimeout.range', {
          min: AI_APPROVAL_TIMEOUT_MIN_MINUTES,
          max: AI_APPROVAL_TIMEOUT_MAX_MINUTES,
        })}
      </p>

      <div className="mt-4">
        <button
          type="button"
          data-testid="org-ai-approval-timeout-save"
          onClick={handleSave}
          disabled={!isDirty}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {t('orgAiApprovalTimeout.save')}
        </button>
      </div>
    </section>
  );
}
