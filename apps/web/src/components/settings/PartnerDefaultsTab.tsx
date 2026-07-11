import type { InheritableDefaultSettings } from '@breeze/shared';
import { isValidMaintenanceWindow } from '@breeze/shared';
import AgentVersionPinSelectors, { type PinnableVersions } from './AgentVersionPinSelectors';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';

type Props = {
  data: InheritableDefaultSettings;
  onChange: (data: InheritableDefaultSettings) => void;
  pinnableVersions?: PinnableVersions | null;
};

export default function PartnerDefaultsTab({ data, onChange, pinnableVersions }: Props) {
  const { t } = useTranslation('settings');
  const set = (patch: Partial<InheritableDefaultSettings>) =>
    onChange({ ...data, ...patch });

  const autoEnrollment = data.autoEnrollment ?? { enabled: false, requireApproval: true, sendWelcome: true };

  const maintenanceWindow = data.maintenanceWindow ?? '';
  const maintenanceWindowInvalid = maintenanceWindow.trim() !== '' && !isValidMaintenanceWindow(maintenanceWindow);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerDefaults.updatePolicy')}</label>
          <select
            // Fold the legacy 'staged' value into 'auto' for display — they are
            // behaviourally identical (both maintenance-window gated; no real
            // staged rollout exists, see #1962). The backend still accepts
            // 'staged' for back-compat.
            value={data.agentUpdatePolicy === 'staged' ? 'auto' : (data.agentUpdatePolicy ?? '')}
            onChange={e => set({ agentUpdatePolicy: e.target.value || undefined })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{t('partnerDefaults.notSet')}</option>
            <option value="auto">{t('partnerDefaults.automatic')}</option>
            <option value="manual">{t('partnerDefaults.manual')}</option>
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerDefaults.maintenanceWindow')}</label>
          <input
            type="text"
            value={maintenanceWindow}
            onChange={e => set({ maintenanceWindow: e.target.value || undefined })}
            placeholder={t('partnerDefaults.maintenancePlaceholder')}
            aria-invalid={maintenanceWindowInvalid}
            className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${
              maintenanceWindowInvalid ? 'border-destructive' : ''
            }`}
          />
          {maintenanceWindowInvalid ? (
            <p className="text-xs text-destructive">
              <Trans i18nKey="partnerDefaults.maintenanceInvalid" t={t} components={{ first: <code />, second: <code />, always: <code /> }} />
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              <Trans i18nKey="partnerDefaults.maintenanceHelp" t={t} components={{ always: <code /> }} />
            </p>
          )}
        </div>

        <div className="space-y-2 sm:col-span-2">
          <AgentVersionPinSelectors
            context="partner"
            value={data.agentVersionPins ?? {}}
            onChange={(agentVersionPins) => set({ agentVersionPins })}
            pinnable={pinnableVersions ?? null}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerDefaults.deviceGroup')}</label>
          <input
            type="text"
            value={data.deviceGroup ?? ''}
            onChange={e => set({ deviceGroup: e.target.value || undefined })}
            placeholder={t('partnerDefaults.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerDefaults.alertThreshold')}</label>
          <input
            type="text"
            value={data.alertThreshold ?? ''}
            onChange={e => set({ alertThreshold: e.target.value || undefined })}
            placeholder={t('partnerDefaults.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>
      </div>

      {/* Auto-enrollment */}
      <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
        <p className="text-sm font-medium">{t('partnerDefaults.autoEnrollment.title')}</p>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoEnrollment.enabled}
              onChange={e =>
                set({ autoEnrollment: { ...autoEnrollment, enabled: e.target.checked } })
              }
              className="h-4 w-4 rounded border"
            />
            <label className="text-sm font-medium">{t('partnerDefaults.autoEnrollment.enable')}</label>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoEnrollment.requireApproval}
              onChange={e =>
                set({ autoEnrollment: { ...autoEnrollment, requireApproval: e.target.checked } })
              }
              className="h-4 w-4 rounded border"
            />
            <label className="text-sm font-medium">{t('partnerDefaults.autoEnrollment.requireApproval')}</label>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoEnrollment.sendWelcome}
              onChange={e =>
                set({ autoEnrollment: { ...autoEnrollment, sendWelcome: e.target.checked } })
              }
              className="h-4 w-4 rounded border"
            />
            <label className="text-sm font-medium">{t('partnerDefaults.autoEnrollment.sendWelcome')}</label>
          </div>
        </div>
      </div>
    </div>
  );
}
