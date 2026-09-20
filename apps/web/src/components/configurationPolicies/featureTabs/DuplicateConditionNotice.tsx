// DuplicateConditionNotice.tsx
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DuplicateHit } from './duplicateConditions';

export function DuplicateConditionNotice({ hits }: { hits: DuplicateHit[] }) {
  const { t } = useTranslation('policies');
  if (hits.length === 0) return null;
  const names = hits.map((h) => `${h.legacyLabel} ↔ ${h.monitorName}`).join(' · ');
  return (
    <div
      data-testid="duplicate-condition-notice"
      role="status"
      className="mb-4 flex gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>
        <p className="font-medium">{t('configurationPolicies.featureTabs.duplicate.title')}</p>
        <p>{t('configurationPolicies.featureTabs.duplicate.body', { names })}</p>
      </div>
    </div>
  );
}
