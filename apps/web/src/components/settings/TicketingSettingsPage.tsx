import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import TicketingSettingsTabs from './TicketingSettingsTabs';

export default function TicketingSettingsPage() {
  const { t } = useTranslation('settings');
  return (
    <div className="space-y-6" data-testid="ticketing-settings-page">
      <div>
        <h1 className="text-xl font-semibold">{t('ticketingSettingsPage.ticketingSettings')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('ticketingSettingsPage.configureTicketStatusesPrioritySLADefaultsCategoriesAndB')}</p>
      </div>

      <TicketingSettingsTabs />
    </div>
  );
}
