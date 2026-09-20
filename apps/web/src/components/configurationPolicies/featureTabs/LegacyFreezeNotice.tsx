// LegacyFreezeNotice.tsx
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function LegacyFreezeNotice({ policyId }: { policyId: string }) {
  const { t } = useTranslation('policies');
  return (
    <div
      data-testid="legacy-freeze-notice"
      role="note"
      className="mb-4 flex gap-3 rounded-md border bg-muted/40 p-3 text-sm"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div>
        <p className="font-medium">{t('configurationPolicies.featureTabs.legacyFreeze.title')}</p>
        <p className="text-muted-foreground">{t('configurationPolicies.featureTabs.legacyFreeze.body')}</p>
        <a
          data-testid="legacy-freeze-link"
          className="mt-1 inline-block text-primary underline-offset-2 hover:underline"
          href={`/configuration-policies/${policyId}#monitors`}
        >
          {t('configurationPolicies.featureTabs.legacyFreeze.link')}
        </a>
      </div>
    </div>
  );
}
