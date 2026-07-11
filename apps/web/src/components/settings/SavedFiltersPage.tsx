import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { SavedFilterList } from '../filters/SavedFilterList';

export default function SavedFiltersPage() {
  const { t } = useTranslation('settings');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('savedFiltersPage.savedFilters')}</h1>
        <p className="text-muted-foreground">
          {t('savedFiltersPage.createAndManageReusableFiltersForDevicesTheseFiltersCanB')}</p>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <SavedFilterList />
      </div>
    </div>
  );
}
