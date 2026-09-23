import {
  AI_APPROVAL_TIMEOUT_DEFAULT_MINUTES,
  AI_APPROVAL_TIMEOUT_MAX_MINUTES,
  AI_APPROVAL_TIMEOUT_MIN_MINUTES,
  type AiApprovalSettings,
} from '@breeze/shared';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

type Props = {
  data: AiApprovalSettings;
  onChange: (data: AiApprovalSettings) => void;
};

// Canonical options, plus the current stored value if it's off this ladder
// (e.g. written by an older client, or hand-edited) so the select never
// silently discards it.
const CANONICAL_MINUTES = [5, 10, 15, 20, 30, 45, 60];

export default function PartnerAiApprovalsTab({ data, onChange }: Props) {
  const { t } = useTranslation('settings');
  const current = data.interactiveTimeoutMinutes;
  const options = current != null && !CANONICAL_MINUTES.includes(current)
    ? [...CANONICAL_MINUTES, current].sort((a, b) => a - b)
    : CANONICAL_MINUTES;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <label htmlFor="partner-ai-approvals-timeout" className="text-sm font-medium">
          {t('partnerAiApprovals.timeoutLabel')}
        </label>
        <select
          id="partner-ai-approvals-timeout"
          data-testid="partner-ai-approvals-timeout"
          value={current ?? ''}
          onChange={(e) =>
            onChange({
              ...data,
              interactiveTimeoutMinutes: e.target.value ? Number(e.target.value) : undefined,
            })
          }
          className="h-10 w-full max-w-xs rounded-md border bg-background px-3 text-sm"
        >
          <option value="">
            {t('partnerAiApprovals.productDefault', { minutes: AI_APPROVAL_TIMEOUT_DEFAULT_MINUTES })}
          </option>
          {options.map((minutes) => (
            <option key={minutes} value={minutes}>
              {t('partnerAiApprovals.minutesOption', { minutes })}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {t('partnerAiApprovals.range', {
            min: AI_APPROVAL_TIMEOUT_MIN_MINUTES,
            max: AI_APPROVAL_TIMEOUT_MAX_MINUTES,
          })}
        </p>
      </div>

      <p className="text-xs text-muted-foreground">{t('partnerAiApprovals.description')}</p>
      <p className="text-xs text-muted-foreground" data-testid="partner-ai-approvals-org-override-note">
        {t('partnerAiApprovals.orgOverrideNote')}
      </p>
      <p className="text-xs text-muted-foreground" data-testid="partner-ai-approvals-not-unattended-note">
        {t('partnerAiApprovals.notForUnattendedNote')}
      </p>
    </div>
  );
}
