import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { useOrgStore } from '../../stores/orgStore';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

export default function PartnerSettingsCard() {
  const { t } = useTranslation('settings');
  const { currentPartnerId, isLoading } = useOrgStore();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Don't render anything until we know the scope
  if (!mounted || isLoading || !currentPartnerId) {
    return null;
  }

  return (
    <a
      href="/settings/partner"
      className="col-span-full rounded-lg border-2 border-primary/20 bg-primary/5 p-6 shadow-xs transition hover:border-primary hover:shadow-md"
    >
      <div className="flex items-start gap-4">
        <div className="rounded-lg bg-primary/10 p-3">
          <Building2 className="h-6 w-6 text-primary" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t('partnerSettingsCard.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('partnerSettingsCard.description')}
          </p>
        </div>
      </div>
    </a>
  );
}
