import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import AccessDenied from '../shared/AccessDenied';

/**
 * Shown when a Sensitive Data endpoint answers 403 — typically a stale
 * persisted organization selection the caller can no longer reach (#9697).
 * A retry would 403 again, so this is deliberately not the generic error banner.
 */
export default function SensitiveDataAccessDenied() {
  const { t } = useTranslation('security');
  return (
    <AccessDenied
      testId="sensitive-data-access-denied"
      message={t('sensitiveDataAccess.noOrgAccess', {
        defaultValue: "You don't have access to this organization",
      })}
    />
  );
}
