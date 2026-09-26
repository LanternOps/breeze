import { useTranslation } from 'react-i18next';
import type { GraphResponse } from '@breeze/shared';
import { TOPOLOGY_COVERAGE_REASON_CODES } from '@breeze/shared/validators/topology';

const KNOWN = new Set<string>(TOPOLOGY_COVERAGE_REASON_CODES);

/**
 * Graph coverage with one localized line per distinct server reason (M2 D11).
 * A complete-empty scope, a timeout and an unmapped controller site never read
 * alike. A reason code this build does not know falls back to the server text.
 */
export default function PhysicalCoveragePanel({ coverage }: { coverage: GraphResponse['coverage'] }) {
  const { t } = useTranslation('topology');
  return <div data-testid="topology-coverage-panel" className="space-y-1 text-sm">
    <p role="status" data-testid="topology-coverage">{t('coverage', { state: t(/* i18n-dynamic */ `coveragePanel.state.${coverage.state}`) })}</p>
    {coverage.reasons.length > 0 && <ul className="list-inside list-disc text-muted-foreground" aria-label={t('coveragePanel.title')}>
      {coverage.reasons.map((reason) => <li key={reason.code} data-testid={`topology-coverage-reason-${reason.code}`} className="break-words">
        {KNOWN.has(reason.code) ? t(/* i18n-dynamic */ `coveragePanel.reasons.${reason.code}`) : reason.message}
        {reason.count !== undefined && <> {t('coveragePanel.scopeCount', { count: reason.count })}</>}
      </li>)}
    </ul>}
  </div>;
}
