import { useTranslation } from 'react-i18next';
import TicketingSettingsTabs from './TicketingSettingsTabs';

/**
 * Standalone `/settings/ticketing` page (M0). The Partner hub's Ticketing tab
 * now links here instead of embedding TicketingSettingsTabs directly.
 */
export default function TicketingHubPage() {
  const { t } = useTranslation('settings');
  return (
    <div className="space-y-6" data-testid="ticketing-hub-page">
      <div>
        <h1 className="text-xl font-semibold">{t('ticketingHubPage.heading')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('ticketingHubPage.description')}</p>
      </div>
      <TicketingSettingsTabs />
    </div>
  );
}
