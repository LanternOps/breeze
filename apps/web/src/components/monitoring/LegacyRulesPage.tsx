import { useTranslation } from 'react-i18next';
import AlertsTabStrip from '../alerts/AlertsTabStrip';
import LegacyRulesTable from './LegacyRulesTable';
import '../../lib/i18n';

export default function LegacyRulesPage() {
  const { t } = useTranslation(['monitoring', 'common']);
  return (
    <div className="space-y-6" data-testid="legacy-rules-page">
      <AlertsTabStrip currentPath="/alerts/rules" />
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('monitoring:legacy.title')}</h1>
        <p className="text-muted-foreground">{t('monitoring:legacy.description')}</p>
      </div>
      <LegacyRulesTable />
    </div>
  );
}
