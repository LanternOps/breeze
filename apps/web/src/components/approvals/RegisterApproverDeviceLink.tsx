import '@/lib/i18n';
import { useTranslation } from 'react-i18next';

/**
 * The "Register device" action shown next to a missing-approver-device error.
 * Shared by the approvals inbox and the PAM respond modal so both surfaces
 * point at the same place with the same words.
 */
export function RegisterApproverDeviceLink() {
  const { t } = useTranslation('approvals');
  return (
    <a
      className="font-medium underline underline-offset-4"
      href="/settings/profile"
      data-testid="register-approver-device-link"
    >
      {t('registerDevice')}
    </a>
  );
}
